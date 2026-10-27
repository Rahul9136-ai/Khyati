"""Auto-planned Phone/Chat/Email alignments for future days, held as drafts
until a scheduler publishes them.

The Scheduling page works out the alignment (phone covers the requirement
first, chat keeps its minimum, email takes the rest — see the frontend's
`channelPlanner.ts`) and saves the agent-days that change here. Nobody but
schedulers sees drafts. Publishing writes each draft into its day plan — unless
the day was edited after it was planned (`base_version`), which is skipped and
reported — publishes those days, and notifies agents and team leaders.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import UTC, date, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.modules.identity.models import User
from app.modules.identity.service import record_audit
from app.modules.scheduling import dayplan as dp
from app.modules.scheduling import dayplan_service as days
from app.modules.scheduling import events, schedule_notify
from app.modules.scheduling.models import ChannelPlanDraft, DaySchedulePlan
from app.modules.scheduling.schemas import ChannelDraftsIn, ChannelRangeIn


def _in_range(org_id: uuid.UUID, start: date, end: date):
    return (
        ChannelPlanDraft.organization_id == org_id,
        ChannelPlanDraft.plan_date >= start,
        ChannelPlanDraft.plan_date <= end,
    )


async def list_drafts(
    db: AsyncSession, org_id: uuid.UUID, start: date, end: date
) -> list[ChannelPlanDraft]:
    days.check_range(start, end)
    q = select(ChannelPlanDraft).where(*_in_range(org_id, start, end))
    order = (ChannelPlanDraft.plan_date, ChannelPlanDraft.agent_key)
    return list((await db.execute(q.order_by(*order))).scalars())


async def replace_drafts(
    db: AsyncSession, org_id: uuid.UUID, body: ChannelDraftsIn, *, actor: User
) -> list[ChannelPlanDraft]:
    """A fresh auto-plan for [start, end]: earlier drafts there are replaced.
    Each draft must fit its saved day (channels inside the shift, no overlaps)."""
    days.check_range(body.start, body.end)
    seen = {(i.plan_date, i.agent_key) for i in body.items}
    if len(seen) != len(body.items):
        raise ValidationError("Each agent may appear only once per date")
    by_date: dict[date, dict[str, DaySchedulePlan]] = {}
    problems: list[dict] = []
    for item in body.items:
        if not body.start <= item.plan_date <= body.end:
            raise ValidationError(f"{item.plan_date} is outside {body.start}–{body.end}")
        if item.plan_date not in by_date:
            rows = await days.list_day_plans(db, org_id, item.plan_date)
            by_date[item.plan_date] = {r.agent_key: r for r in rows}
        row = by_date[item.plan_date].get(item.agent_key)
        if row is None:
            problems.append(
                {
                    "plan_date": item.plan_date.isoformat(),
                    "agent_key": item.agent_key,
                    "errors": ["No saved schedule"],
                }
            )
            continue
        day = days.row_to_day(row)
        day.channels = [dp.ChannelSeg(c.id, c.channel, c.start, c.end) for c in item.channels]
        if errs := dp.validate_day(day):
            problems.append(
                {
                    "plan_date": item.plan_date.isoformat(),
                    "agent_key": item.agent_key,
                    "errors": errs,
                }
            )
    if problems:
        raise ValidationError(
            f"{len(problems)} planned day(s) don't fit their schedules", details=problems[:50]
        )

    await db.execute(delete(ChannelPlanDraft).where(*_in_range(org_id, body.start, body.end)))
    saved = []
    for item in body.items:
        d = ChannelPlanDraft(
            organization_id=org_id,
            plan_date=item.plan_date,
            agent_key=item.agent_key,
            agent_name=item.agent_name,
            base_version=item.base_version,
            summary=item.summary,
            channels=[c.model_dump() for c in item.channels],
            created_by=actor.id,
        )
        db.add(d)
        saved.append(d)
    await db.flush()
    await record_audit(
        db,
        actor=actor,
        action="channels.plan",
        entity_type="channel_plan_draft",
        entity_id=f"{body.start.isoformat()}..{body.end.isoformat()}",
        after={"drafts": len(saved), "days": len({i.plan_date for i in body.items})},
    )
    return saved


async def discard(db: AsyncSession, org_id: uuid.UUID, body: ChannelRangeIn, *, actor: User) -> int:
    days.check_range(body.start, body.end)
    gone = await list_drafts(db, org_id, body.start, body.end)
    await db.execute(delete(ChannelPlanDraft).where(*_in_range(org_id, body.start, body.end)))
    await record_audit(
        db,
        actor=actor,
        action="channels.discard",
        entity_type="channel_plan_draft",
        entity_id=f"{body.start.isoformat()}..{body.end.isoformat()}",
        after={"discarded": len(gone)},
    )
    return len(gone)


async def publish(
    db: AsyncSession, org_id: uuid.UUID, body: ChannelRangeIn, *, actor: User
) -> dict:
    """Write every draft in the range into its day and publish those days."""
    drafts = await list_drafts(db, org_id, body.start, body.end)
    by_date: dict[date, list[ChannelPlanDraft]] = defaultdict(list)
    for d in drafts:
        by_date[d.plan_date].append(d)
    applied = 0
    stale: list[dict] = []
    newly_published: list[DaySchedulePlan] = []
    now = datetime.now(UTC)
    for plan_date, items in sorted(by_date.items()):
        rows = {
            r.agent_key: r
            for r in await days.list_day_plans(db, org_id, plan_date, [d.agent_key for d in items])
        }
        fresh = {}
        for d in items:
            row = rows.get(d.agent_key)
            if row is None or row.version != d.base_version:
                stale.append(
                    {
                        "agent_key": d.agent_key,
                        "reason": f"{plan_date.isoformat()}: edited since it was planned",
                    }
                )
            else:
                fresh[d.agent_key] = [
                    dp.ChannelSeg(c["id"], c["channel"], c["start"], c["end"]) for c in d.channels
                ]
        if not fresh:
            continue

        def with_channels(_i: int, key: str, day: dp.AgentDay, fresh=fresh) -> dp.AgentDay:
            nxt = day.copy()
            nxt.channels = fresh[key]
            return nxt

        saved, skipped = await days.apply_each(
            db,
            org_id,
            plan_date,
            list(fresh),
            actor=actor,
            action="channels.publish",
            detail="Auto-planned Phone/Chat/Email published",
            fn=with_channels,
        )
        applied += len(saved)
        stale += [
            {"agent_key": s["agent_key"], "reason": f"{plan_date}: {s['reason']}"} for s in skipped
        ]
        for r in saved:
            if r.published_at is None:
                r.published_at, r.published_by = now, actor.id
                newly_published.append(r)
    await db.execute(delete(ChannelPlanDraft).where(*_in_range(org_id, body.start, body.end)))
    await db.flush()
    notified = await schedule_notify.notify_published(db, org_id, newly_published, actor=actor)
    await events.schedule_published(db, org_id, body.start, body.end, newly_published)
    await record_audit(
        db,
        actor=actor,
        action="channels.publish",
        entity_type="channel_plan_draft",
        entity_id=f"{body.start.isoformat()}..{body.end.isoformat()}",
        after={"applied": applied, "stale": len(stale), "published_days": len(newly_published)},
    )
    return {
        "applied": applied,
        "stale": stale,
        "published_days": len(newly_published),
        "notified": notified,
    }
