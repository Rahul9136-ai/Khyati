"""Inbound updates from connected tools: leave / absence / week off / other
activities for an agent over a date range, written into their saved days the
same way the app does (so agents, team leaders and webhooks see the change)."""

from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.modules.connect.schemas import InboundTimeOffIn
from app.modules.identity.models import User
from app.modules.scheduling import dayplan as dp
from app.modules.scheduling import dayplan_service as days

MAX_DAYS = 92


def _mins(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


async def time_off(
    db: AsyncSession, org_id: uuid.UUID, body: InboundTimeOffIn, *, actor: User
) -> dict:
    if body.end_date < body.start_date:
        raise ValidationError("end_date is before start_date")
    span = (body.end_date - body.start_date).days + 1
    if span > MAX_DAYS:
        raise ValidationError(f"At most {MAX_DAYS} days per call")
    if (body.start is None) != (body.end is None):
        raise ValidationError("Give both start and end, or neither for the whole shift")
    full = body.start is None
    window = None if full else (_mins(body.start or ""), _mins(body.end or ""))
    if not full and _mins(body.end) <= _mins(body.start):  # type: ignore[arg-type]
        raise ValidationError("end must be after start")
    label = dp.ACTIVITIES[body.type]["label"]
    verb = "Removed" if body.action == "remove" else "Marked"
    applied, skipped = [], []
    for i in range(span):
        d = body.start_date + timedelta(days=i)
        rows = await days.list_day_plans(db, org_id, d, [body.agent_key])
        if not rows:
            skipped.append({"date": d, "reason": "No schedule saved for that day yet"})
            continue
        seg_id = (
            f"ext-{body.external_id}-{d.isoformat()}"
            if body.external_id
            else f"ext-{uuid.uuid4().hex[:10]}"
        )

        def change(_i: int, _k: str, day: dp.AgentDay, seg_id: str = seg_id) -> dp.AgentDay | str:
            day = day.copy()
            day.activities = [a for a in day.activities if a.id != seg_id]  # same record → update
            if body.action == "remove":
                return day
            s, e = (day.shift_start, day.shift_end) if window is None else window
            if body.replace:
                day.activities = [a for a in day.activities if a.end <= s or a.start >= e]
            return dp.mark_aux(day, body.type, s, e - s, full, seg_id, body.note or label)

        saved, skip = await days.apply_each(
            db,
            org_id,
            d,
            [body.agent_key],
            actor=actor,
            action="connect.time_off",
            detail=f"{verb} {label} from a connected tool",
            fn=change,
        )
        if saved:
            applied.append(d)
        else:
            skipped += [{"date": d, "reason": s["reason"]} for s in skip]
    return {"applied": applied, "skipped": skipped}
