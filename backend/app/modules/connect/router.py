"""/connect — API keys and webhooks for CRMs and other tools.

Managing keys and webhooks needs `integration:manage`. A connected tool then
calls the normal REST API with its key (`X-API-Key: wfm_…`), and receives
signed events on its webhook URL.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.api.deps import DbSession, require_permission
from app.core.exceptions import NotFoundError, ValidationError
from app.modules.connect import inbound, keys, webhooks
from app.modules.connect.models import ApiKey, WebhookDelivery, WebhookSubscription
from app.modules.connect.schemas import (
    ApiKeyCreate,
    ApiKeyCreated,
    ApiKeyOut,
    DeliveryOut,
    EventTypeOut,
    InboundResultOut,
    InboundTimeOffIn,
    ScopeOut,
    WebhookIn,
    WebhookOut,
    WebhookPatch,
)
from app.modules.identity.models import User
from app.modules.identity.rbac import PERMISSIONS
from app.modules.identity.service import record_audit
from app.modules.workforce.service import org_scope
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/connect", tags=["connect"])

Manager = Annotated[User, Depends(require_permission("integration:manage"))]
ScheduleWriter = Annotated[User, Depends(require_permission("schedule:write"))]


def _secret() -> str:
    return "whsec_" + secrets.token_urlsafe(24)


# ------------------------------------------------------------------ catalogue


@router.get("/events", response_model=ApiResponse[list[EventTypeOut]])
async def list_events(user: Manager):
    return ApiResponse(
        data=[EventTypeOut(type=t, description=d) for t, d in webhooks.EVENTS.items()]
    )


@router.get("/scopes", response_model=ApiResponse[list[ScopeOut]])
async def list_scopes(user: Manager):
    """Permissions you can give a key (never more than you have yourself)."""
    return ApiResponse(
        data=[ScopeOut(code=c, description=PERMISSIONS[c]) for c in keys.allowed_scopes(user)]
    )


# ------------------------------------------------------------------ API keys


@router.get("/api-keys", response_model=ApiResponse[list[ApiKeyOut]])
async def list_api_keys(db: DbSession, user: Manager):
    rows = (
        await db.execute(
            select(ApiKey)
            .where(ApiKey.organization_id == org_scope(user))
            .order_by(ApiKey.created_at.desc())
        )
    ).scalars()
    return ApiResponse(data=[ApiKeyOut.model_validate(r) for r in rows])


@router.post("/api-keys", response_model=ApiResponse[ApiKeyCreated], status_code=201)
async def create_api_key(body: ApiKeyCreate, db: DbSession, actor: Manager):
    """Create a key for a tool. The full key is returned once — store it safely."""
    if getattr(actor, "api_key_id", None):
        raise ValidationError("API keys can't create other API keys — sign in to the app")
    allowed = set(keys.allowed_scopes(actor))
    extra = sorted(set(body.scopes) - allowed)
    if extra:
        raise ValidationError(
            f"You can't give a key permissions you don't have: {', '.join(extra)}"
        )
    raw, prefix, digest = keys.generate_key()
    row = ApiKey(
        organization_id=org_scope(actor),
        name=body.name.strip(),
        prefix=prefix,
        key_hash=digest,
        scopes=sorted(set(body.scopes)),
        created_by=actor.id,
        created_by_email=actor.email,
        expires_at=datetime.now(UTC) + timedelta(days=body.expires_in_days)
        if body.expires_in_days
        else None,
    )
    db.add(row)
    await db.flush()
    await db.refresh(row, ["created_at", "updated_at"])
    await record_audit(
        db,
        actor=actor,
        action="apikey.create",
        entity_type="api_key",
        entity_id=row.id,
        after={"name": row.name, "scopes": row.scopes},
    )
    return ApiResponse(data=ApiKeyCreated(**ApiKeyOut.model_validate(row).model_dump(), key=raw))


@router.delete("/api-keys/{key_id}", response_model=ApiResponse[ApiKeyOut])
async def revoke_api_key(key_id: uuid.UUID, db: DbSession, actor: Manager):
    row = await db.get(ApiKey, key_id)
    if row is None or row.organization_id != org_scope(actor):
        raise NotFoundError("API key not found")
    if row.revoked_at is None:
        row.revoked_at = datetime.now(UTC)
        await db.flush()
        await record_audit(
            db,
            actor=actor,
            action="apikey.revoke",
            entity_type="api_key",
            entity_id=row.id,
            after={"name": row.name},
        )
    return ApiResponse(data=ApiKeyOut.model_validate(row))


# ------------------------------------------------------------------ webhooks


async def _sub(db: DbSession, actor: User, sub_id: uuid.UUID) -> WebhookSubscription:
    sub = await db.get(WebhookSubscription, sub_id)
    if sub is None or sub.organization_id != org_scope(actor):
        raise NotFoundError("Webhook not found")
    return sub


@router.get("/webhooks", response_model=ApiResponse[list[WebhookOut]])
async def list_webhooks(db: DbSession, user: Manager):
    rows = (
        await db.execute(
            select(WebhookSubscription)
            .where(WebhookSubscription.organization_id == org_scope(user))
            .order_by(WebhookSubscription.created_at)
        )
    ).scalars()
    return ApiResponse(data=[WebhookOut.model_validate(r) for r in rows])


@router.post("/webhooks", response_model=ApiResponse[WebhookOut], status_code=201)
async def create_webhook(body: WebhookIn, db: DbSession, actor: Manager):
    if reason := await webhooks.blocked_url_reason(body.url):
        raise ValidationError(reason)
    sub = WebhookSubscription(
        organization_id=org_scope(actor),
        url=body.url,
        description=body.description,
        events=body.events,
        active=body.active,
        secret=_secret(),
        created_by_email=actor.email,
    )
    db.add(sub)
    await db.flush()
    await db.refresh(sub, ["created_at", "updated_at"])
    await record_audit(
        db,
        actor=actor,
        action="webhook.create",
        entity_type="webhook",
        entity_id=sub.id,
        after={"url": sub.url, "events": sub.events},
    )
    return ApiResponse(data=WebhookOut.model_validate(sub))


@router.patch("/webhooks/{sub_id}", response_model=ApiResponse[WebhookOut])
async def update_webhook(sub_id: uuid.UUID, body: WebhookPatch, db: DbSession, actor: Manager):
    sub = await _sub(db, actor, sub_id)
    if body.url and (reason := await webhooks.blocked_url_reason(body.url)):
        raise ValidationError(reason)
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(sub, field, value)
    if body.active:
        sub.consecutive_failures = 0
    await db.flush()
    await db.refresh(sub, ["updated_at"])
    await record_audit(
        db,
        actor=actor,
        action="webhook.update",
        entity_type="webhook",
        entity_id=sub.id,
        after=body.model_dump(exclude_none=True),
    )
    if sub.active:
        webhooks.kick()  # anything queued while it was paused goes out now
    return ApiResponse(data=WebhookOut.model_validate(sub))


@router.delete("/webhooks/{sub_id}", response_model=ApiResponse[dict])
async def delete_webhook(sub_id: uuid.UUID, db: DbSession, actor: Manager):
    sub = await _sub(db, actor, sub_id)
    await db.delete(sub)
    await record_audit(
        db,
        actor=actor,
        action="webhook.delete",
        entity_type="webhook",
        entity_id=sub_id,
        after={"url": sub.url},
    )
    return ApiResponse(data={"detail": "Webhook removed"})


@router.post("/webhooks/{sub_id}/rotate-secret", response_model=ApiResponse[WebhookOut])
async def rotate_secret(sub_id: uuid.UUID, db: DbSession, actor: Manager):
    sub = await _sub(db, actor, sub_id)
    sub.secret = _secret()
    await db.flush()
    await db.refresh(sub, ["updated_at"])
    await record_audit(
        db, actor=actor, action="webhook.rotate_secret", entity_type="webhook", entity_id=sub.id
    )
    return ApiResponse(data=WebhookOut.model_validate(sub))


@router.post("/webhooks/{sub_id}/test", response_model=ApiResponse[DeliveryOut])
async def test_webhook(sub_id: uuid.UUID, db: DbSession, actor: Manager):
    """Send a `ping` event to this URL right now and return what happened."""
    sub = await _sub(db, actor, sub_id)
    [delivery] = await webhooks.emit(
        db,
        sub.organization_id,
        "ping",
        {
            "message": "Test event from Purvi.AI WFM",
            "sent_by": actor.email,
        },
        only=sub,
    )
    await db.flush()
    await webhooks.deliver(db, delivery, sub)
    await db.refresh(delivery, ["created_at"])
    return ApiResponse(data=DeliveryOut.model_validate(delivery))


@router.get("/webhooks/{sub_id}/deliveries", response_model=ApiResponse[list[DeliveryOut]])
async def list_deliveries(
    sub_id: uuid.UUID,
    db: DbSession,
    user: Manager,
    status: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    sub = await _sub(db, user, sub_id)
    q = select(WebhookDelivery).where(WebhookDelivery.subscription_id == sub.id)
    if status:
        q = q.where(WebhookDelivery.status == status)
    rows = (await db.execute(q.order_by(WebhookDelivery.created_at.desc()).limit(limit))).scalars()
    return ApiResponse(data=[DeliveryOut.model_validate(r) for r in rows])


@router.post("/deliveries/{delivery_id}/redeliver", response_model=ApiResponse[DeliveryOut])
async def redeliver(delivery_id: uuid.UUID, db: DbSession, actor: Manager):
    """Send a delivery again now (e.g. after fixing the receiving end)."""
    delivery = await db.get(WebhookDelivery, delivery_id)
    if delivery is None or delivery.organization_id != org_scope(actor):
        raise NotFoundError("Delivery not found")
    sub = await _sub(db, actor, delivery.subscription_id)
    await webhooks.deliver(db, delivery, sub)
    return ApiResponse(data=DeliveryOut.model_validate(delivery))


# ------------------------------------------------------------------ inbound


@router.post("/inbound/time-off", response_model=ApiResponse[InboundResultOut])
async def inbound_time_off(body: InboundTimeOffIn, db: DbSession, actor: ScheduleWriter):
    """Mark leave / absence / week off (or a meeting, training…) for an agent over
    a date range — for a CRM or HR tool. Send the same `external_id` again to
    update it, or with `"action": "remove"` to take it off. Days with no saved
    schedule are reported in `skipped`."""
    return ApiResponse(
        data=InboundResultOut(**await inbound.time_off(db, org_scope(actor), body, actor=actor))
    )
