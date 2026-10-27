"""Outbound webhooks: emit events, sign and deliver them, retry with backoff.

`emit()` is called by the modules that change things (scheduling, offers,
settings) *inside* their transaction: it writes one `WebhookDelivery` row per
matching subscription, so an event is only ever sent for a change that was
actually committed. The dispatcher (`run_dispatcher`, started with the app)
sends pending rows within a few seconds; failures are retried after 30 s,
2 min, 10 min, 1 h and 6 h, then marked failed (they can be redelivered by
hand from the API / Integrations screen).

Every request carries:
  X-WFM-Event, X-WFM-Delivery (unique id), X-WFM-Timestamp (unix seconds) and
  X-WFM-Signature: sha256=<hex HMAC-SHA256 of "{timestamp}.{raw body}" keyed
  by the subscription's secret>.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.logging import get_logger
from app.modules.connect.models import WebhookDelivery, WebhookSubscription

log = get_logger(__name__)

EVENTS: dict[str, str] = {
    "schedule.updated": (
        "An agent's day was created, changed or reset — shift, breaks, channels, OT or "
        "activities (leave, absence, week off…)."
    ),
    "schedule.published": (
        "Schedules were published for a date range; agents and team leaders can see them."
    ),
    "slot.opened": "VTO / PTO / overtime / leave slots were opened, resized, closed or reopened.",
    "slot.claimed": "An agent took a VTO / PTO / overtime / leave slot.",
    "slot.released": "A slot was given back or a claim was cancelled.",
    "settings.updated": (
        "Work rules, compliance limits, shift patterns or agents' rules / week offs changed."
    ),
    "ping": "Test event sent from the Integrations screen.",
}

#: Seconds to wait before each retry; after the last one the delivery fails.
BACKOFF = [30, 120, 600, 3600, 21600]
MAX_ATTEMPTS = len(BACKOFF) + 1
TIMEOUT_SECONDS = 10

#: Tests swap in an httpx.MockTransport.
_transport: httpx.AsyncBaseTransport | None = None
_kick: asyncio.Event | None = None


def sign(secret: str, timestamp: str, body: bytes) -> str:
    digest = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def verify(secret: str, timestamp: str, body: bytes, signature: str) -> bool:
    """What a receiver does — exposed for tests and as a reference."""
    return hmac.compare_digest(sign(secret, timestamp, body), signature)


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def envelope(org_id: uuid.UUID, event_type: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"evt_{uuid.uuid4().hex}",
        "type": event_type,
        "created_at": _now().isoformat(),
        "organization_id": str(org_id),
        "data": data,
    }


async def emit(
    db: AsyncSession,
    org_id: uuid.UUID,
    event_type: str,
    data: dict[str, Any],
    *,
    only: WebhookSubscription | None = None,
) -> list[WebhookDelivery]:
    """Queue an event for every active subscription that wants it."""
    if only is not None:
        subs = [only]
    else:
        subs = list(
            (
                await db.execute(
                    select(WebhookSubscription).where(
                        WebhookSubscription.organization_id == org_id,
                        WebhookSubscription.active.is_(True),
                    )
                )
            ).scalars()
        )
        subs = [s for s in subs if "*" in (s.events or []) or event_type in (s.events or [])]
    if not subs:
        return []
    event = envelope(org_id, event_type, data)
    rows = [
        WebhookDelivery(
            organization_id=org_id,
            subscription_id=s.id,
            event_id=event["id"],
            event_type=event_type,
            payload=event,
            status="pending",
            next_attempt_at=_now(),
        )
        for s in subs
    ]
    db.add_all(rows)
    kick()
    return rows


def kick() -> None:
    """Wake the dispatcher (it also polls every few seconds)."""
    if _kick is not None:
        _kick.set()


async def deliver(db: AsyncSession, delivery: WebhookDelivery, sub: WebhookSubscription) -> None:
    """Send one delivery now and record the outcome."""
    body = json.dumps(delivery.payload, separators=(",", ":"), default=str).encode()
    ts = str(int(time.time()))
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "PurviWFM-Webhooks/1.0",
        "X-WFM-Event": delivery.event_type,
        "X-WFM-Delivery": str(delivery.id),
        "X-WFM-Timestamp": ts,
        "X-WFM-Signature": sign(sub.secret, ts, body),
    }
    started = time.monotonic()
    delivery.attempts += 1
    delivery.last_attempt_at = _now()
    ok = False
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS, transport=_transport) as client:
            resp = await client.post(sub.url, content=body, headers=headers)
        delivery.response_status = resp.status_code
        delivery.response_body = resp.text[:1000]
        delivery.error = ""
        ok = 200 <= resp.status_code < 300
        if not ok:
            delivery.error = f"HTTP {resp.status_code}"
    except httpx.HTTPError as exc:
        delivery.response_status = None
        delivery.response_body = ""
        delivery.error = f"{type(exc).__name__}: {exc}"[:500]
    delivery.duration_ms = int((time.monotonic() - started) * 1000)

    if ok:
        delivery.status = "delivered"
        sub.last_success_at = delivery.last_attempt_at
        sub.consecutive_failures = 0
    else:
        sub.last_failure_at = delivery.last_attempt_at
        sub.consecutive_failures += 1
        if delivery.attempts >= MAX_ATTEMPTS:
            delivery.status = "failed"
        else:
            delivery.status = "retrying"
            delivery.next_attempt_at = _now() + timedelta(seconds=BACKOFF[delivery.attempts - 1])
    await db.flush()


async def dispatch_pending(db: AsyncSession, *, limit: int = 100) -> int:
    """Send every delivery that's due. Returns how many were attempted."""
    due = (
        await db.execute(
            select(WebhookDelivery, WebhookSubscription)
            .join(WebhookSubscription, WebhookSubscription.id == WebhookDelivery.subscription_id)
            .where(
                or_(WebhookDelivery.status == "pending", WebhookDelivery.status == "retrying"),
                WebhookDelivery.next_attempt_at <= _now(),
            )
            .order_by(WebhookDelivery.created_at)
            .limit(limit)
        )
    ).all()
    for delivery, sub in due:
        if not sub.active:
            continue  # paused — keep it queued until the subscription is turned back on
        await deliver(db, delivery, sub)
    return len(due)


async def run_dispatcher(
    session_factory: async_sessionmaker[AsyncSession], interval: float = 5.0
) -> None:
    """Background loop started with the app: send due deliveries every few
    seconds, or right after an event is emitted."""
    global _kick
    _kick = asyncio.Event()
    while True:
        try:
            await asyncio.wait_for(_kick.wait(), timeout=interval)
            await asyncio.sleep(0.5)  # let the request that emitted it commit first
        except TimeoutError:
            pass
        _kick.clear()
        try:
            async with session_factory() as db:
                await dispatch_pending(db)
                await db.commit()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - keep the loop alive; it retries next tick
            log.exception("webhooks.dispatch_failed")
