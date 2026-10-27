"""Webhook events raised by scheduling (see app/modules/connect/webhooks.py).

Times in payloads are "HH:MM" (local to the organisation) alongside the plan
date, so a CRM can use them as they are. `schedule.updated` carries each
changed agent-day in full; `schedule.published` lists who was published on
which dates (fetch the days with GET /scheduling/day-plans/range).
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Iterable
from datetime import date
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.connect import webhooks
from app.modules.scheduling.dayplan import fmt_hm
from app.modules.scheduling.models import DaySchedulePlan


def _t(mins: int) -> str:
    return fmt_hm(int(mins))


def _blocks(items: list[dict], *extra: str) -> list[dict]:
    return [
        {
            "id": b.get("id"),
            **{k: b.get(k) for k in extra if b.get(k) is not None},
            "start": _t(b["start"]),
            "end": _t(b["end"]),
        }
        for b in sorted(items or [], key=lambda x: x["start"])
    ]


def day_json(row: DaySchedulePlan) -> dict[str, Any]:
    activities = _blocks(row.activities, "type", "note")
    return {
        "date": row.plan_date.isoformat(),
        "agent_key": row.agent_key,
        "agent_name": row.agent_name,
        "team": row.team,
        "team_lead": row.team_lead or "",
        "shift": {"start": _t(row.shift_start), "end": _t(row.shift_end)},
        # A whole-day leave / absence / week off is what most tools want first.
        "day_status": next(
            (
                a["type"]
                for a in activities
                if a["type"] in ("absence", "leave", "loa", "off")
                and a["start"] <= _t(row.shift_start)
                and a["end"] >= _t(row.shift_end)
            ),
            "working",
        ),
        "breaks": _blocks(row.breaks, "type", "label"),
        "channels": _blocks(row.channels, "channel"),
        "overtime": _blocks(row.overtime, "channel"),
        "activities": activities,
        "published": row.published_at is not None,
        "version": row.version,
    }


async def schedule_updated(
    db: AsyncSession,
    org_id: uuid.UUID,
    rows: Iterable[DaySchedulePlan],
    *,
    action: str,
    deleted: Iterable[tuple[date, str]] = (),
) -> None:
    """One event per date with every agent-day that changed on it."""
    by_date: dict[date, list[dict]] = defaultdict(list)
    for r in rows:
        by_date[r.plan_date].append(day_json(r))
    gone: dict[date, list[str]] = defaultdict(list)
    for d, key in deleted:
        gone[d].append(key)
    for d in sorted(set(by_date) | set(gone)):
        await webhooks.emit(
            db,
            org_id,
            "schedule.updated",
            {
                "date": d.isoformat(),
                "action": action,
                "agents": by_date.get(d, []),
                "reset_agents": gone.get(d, []),
            },
        )


def slot_json(offer: Any) -> dict[str, Any]:
    active = [c for c in offer.claims if c.status == "filled"]
    return {
        "id": str(offer.id),
        "date": offer.plan_date.isoformat(),
        "kind": offer.kind,
        "queue": offer.queue_name or offer.queue_key,
        "queue_key": offer.queue_key,
        "start": _t(offer.start_min),
        "end": _t(offer.end_min),
        "channel": offer.channel,
        "capacity": offer.capacity,
        "filled": len(active),
        "left": max(0, offer.capacity - len(active)),
        "status": offer.status,
        "note": offer.note or "",
    }


async def slots_opened(
    db: AsyncSession, org_id: uuid.UUID, offers: list[Any], *, action: str
) -> None:
    if offers:
        await webhooks.emit(
            db, org_id, "slot.opened", {"action": action, "slots": [slot_json(o) for o in offers]}
        )


async def slot_claim(
    db: AsyncSession, org_id: uuid.UUID, event_type: str, offer: Any, claim: Any
) -> None:
    await webhooks.emit(
        db,
        org_id,
        event_type,
        {
            "slot": slot_json(offer),
            "claim": {
                "id": str(claim.id),
                "agent_key": claim.agent_key,
                "agent_name": claim.agent_name,
                "start": _t(claim.start_min),
                "end": _t(claim.end_min),
                "status": claim.status,
            },
        },
    )


async def schedule_published(
    db: AsyncSession, org_id: uuid.UUID, start: date, end: date, rows: list[DaySchedulePlan]
) -> None:
    if not rows:
        return
    by_date: dict[date, list[str]] = defaultdict(list)
    for r in rows:
        by_date[r.plan_date].append(r.agent_key)
    await webhooks.emit(
        db,
        org_id,
        "schedule.published",
        {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "published": len(rows),
            "days": [
                {"date": d.isoformat(), "agents": sorted(k)} for d, k in sorted(by_date.items())
            ],
        },
    )
