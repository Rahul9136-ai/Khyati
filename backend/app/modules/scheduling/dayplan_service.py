"""Day-plan services: persistence, optimistic concurrency, server-side operations.

The Scheduling UI computes most edits client-side and saves the resulting days
in bulk (`save_day_plans`). The operation endpoints (`apply_edit`, `mark_aux`,
`add_overtime`, `move`, `resize_shift`, `unmark`) perform the same edits on the
server with identical rules (`dayplan.py`) for API / integration callers.
Every write bumps the row's `version` and records an audit entry.
"""

from __future__ import annotations

import csv
import io
import uuid
from collections.abc import Callable
from dataclasses import asdict
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.modules.identity.models import User
from app.modules.identity.service import record_audit
from app.modules.scheduling import dayplan as dp
from app.modules.scheduling import labour_law
from app.modules.scheduling.models import DaySchedulePlan, SchedulingPolicy
from app.modules.scheduling.schemas import (
    DayAddOvertimeIn,
    DayApplyEditIn,
    DayMarkAuxIn,
    DayMoveIn,
    DayPlanBulkIn,
    DayPlanIn,
    DayResizeShiftIn,
    DayUnmarkIn,
    LabourLawPolicyIn,
)
from app.modules.workforce.models import Employee

# ------------------------------------------------------------- row <-> domain


def _row_to_day(row: DaySchedulePlan) -> dp.AgentDay:
    return dp.AgentDay(
        row.shift_start,
        row.shift_end,
        [
            dp.BreakSeg(
                b["id"],
                b["type"],
                b.get("label") or ("Lunch" if b["type"] == "lunch" else "Break"),
                b["start"],
                b["end"],
            )
            for b in row.breaks
        ],
        [dp.ChannelSeg(c["id"], c["channel"], c["start"], c["end"]) for c in row.channels],
        [dp.ChannelSeg(o["id"], o["channel"], o["start"], o["end"]) for o in row.overtime],
        [
            dp.ActivitySeg(a["id"], a["type"], a["start"], a["end"], a.get("note"))
            for a in row.activities
        ],
    ).sorted()


def _in_to_day(item: DayPlanIn) -> dp.AgentDay:
    return dp.AgentDay(
        item.shift_start,
        item.shift_end,
        [
            dp.BreakSeg(
                b.id, b.type, b.label or ("Lunch" if b.type == "lunch" else "Break"), b.start, b.end
            )
            for b in item.breaks
        ],
        [dp.ChannelSeg(c.id, c.channel, c.start, c.end) for c in item.channels],
        [dp.ChannelSeg(o.id, o.channel, o.start, o.end) for o in item.overtime],
        [dp.ActivitySeg(a.id, a.type, a.start, a.end, a.note) for a in item.activities],
    ).sorted()


def _write_day(row: DaySchedulePlan, day: dp.AgentDay, actor: User) -> None:
    def strip(d: dict) -> dict:
        return {k: v for k, v in d.items() if v is not None}

    day = day.sorted()
    row.shift_start, row.shift_end = day.shift_start, day.shift_end
    row.breaks = [asdict(b) for b in day.breaks]
    row.channels = [asdict(c) for c in day.channels]
    row.overtime = [asdict(o) for o in day.ot]
    row.activities = [strip(asdict(a)) for a in day.activities]
    row.version = (row.version or 0) + 1
    row.updated_by = actor.id


# ------------------------------------------------------------------- queries


async def list_day_plans(
    db: AsyncSession, org_id: uuid.UUID, plan_date: date, agent_keys: list[str] | None = None
) -> list[DaySchedulePlan]:
    q = select(DaySchedulePlan).where(
        DaySchedulePlan.organization_id == org_id, DaySchedulePlan.plan_date == plan_date
    )
    if agent_keys:
        q = q.where(DaySchedulePlan.agent_key.in_(agent_keys))
    return list((await db.execute(q.order_by(DaySchedulePlan.agent_key))).scalars())


async def _rows_by_key(
    db: AsyncSession, org_id: uuid.UUID, plan_date: date, keys: list[str], *, require_all: bool
) -> dict[str, DaySchedulePlan]:
    rows = {r.agent_key: r for r in await list_day_plans(db, org_id, plan_date, keys)}
    missing = [k for k in keys if k not in rows]
    if require_all and missing:
        raise NotFoundError(
            f"No day plan for {len(missing)} agent(s) on {plan_date.isoformat()} — save their "
            "schedules first",
            details={"missing": missing},
        )
    return rows


async def _employee_ids_by_code(
    db: AsyncSession, org_id: uuid.UUID, keys: list[str]
) -> dict[str, uuid.UUID]:
    if not keys:
        return {}
    lowered = {k.lower(): k for k in keys}
    rows = await db.execute(
        select(Employee.id, Employee.employee_code).where(
            Employee.organization_id == org_id,
            Employee.deleted_at.is_(None),
            func.lower(Employee.employee_code).in_(list(lowered)),
        )
    )
    return {lowered[code.lower()]: emp_id for emp_id, code in rows.all()}


# --------------------------------------------------------------------- writes


async def save_day_plans(
    db: AsyncSession, org_id: uuid.UUID, plan_date: date, payload: DayPlanBulkIn, *, actor: User
) -> list[DaySchedulePlan]:
    """Upsert many agents' days, all-or-nothing. Every day is validated with the
    same rules as the UI; a stale `base_version` raises 409 with the server rows."""
    keys = [i.agent_key for i in payload.items]
    if len(keys) != len(set(keys)):
        raise ValidationError("Each agent may appear only once per save")

    days = {i.agent_key: _in_to_day(i) for i in payload.items}
    problems = {k: errs for k, d in days.items() if (errs := dp.validate_day(d))}
    if problems:
        raise ValidationError(
            f"{len(problems)} schedule(s) break scheduling rules",
            details=[{"agent_key": k, "errors": v} for k, v in problems.items()],
        )

    existing = await _rows_by_key(db, org_id, plan_date, keys, require_all=False)
    stale = [
        i.agent_key
        for i in payload.items
        if i.base_version is not None
        and (row := existing.get(i.agent_key)) is not None
        and row.version != i.base_version
    ]
    if stale:
        raise ConflictError(
            f"{len(stale)} schedule(s) were changed by someone else — reload and retry",
            details={"stale": stale},
        )

    employee_ids = await _employee_ids_by_code(db, org_id, [k for k in keys if k not in existing])
    saved: list[DaySchedulePlan] = []
    for item in payload.items:
        row = existing.get(item.agent_key)
        if row is None:
            row = DaySchedulePlan(
                organization_id=org_id,
                plan_date=plan_date,
                agent_key=item.agent_key,
                employee_id=employee_ids.get(item.agent_key),
                version=0,
            )
            db.add(row)
        row.agent_name = item.agent_name or row.agent_name
        row.team = item.team or row.team
        _write_day(row, days[item.agent_key], actor)
        saved.append(row)
    await db.flush()
    await _refresh(db, saved)
    await record_audit(
        db,
        actor=actor,
        action="dayplan.save",
        entity_type="day_schedule_plan",
        entity_id=plan_date.isoformat(),
        after={"agents": keys, "count": len(keys)},
        note=payload.detail or None,
    )
    return saved


async def reset_day_plan(
    db: AsyncSession, org_id: uuid.UUID, plan_date: date, agent_key: str, *, actor: User
) -> None:
    rows = await _rows_by_key(db, org_id, plan_date, [agent_key], require_all=True)
    await db.delete(rows[agent_key])
    await record_audit(
        db,
        actor=actor,
        action="dayplan.reset",
        entity_type="day_schedule_plan",
        entity_id=f"{plan_date.isoformat()}/{agent_key}",
    )


async def _apply_each(
    db: AsyncSession,
    org_id: uuid.UUID,
    plan_date: date,
    keys: list[str],
    *,
    actor: User,
    action: str,
    detail: str,
    fn: Callable[[int, str, dp.AgentDay], dp.AgentDay | str],
) -> tuple[list[DaySchedulePlan], list[dict]]:
    """Run `fn(index, key, day)` over each agent's current day. A string result
    skips that agent with a reason; otherwise the new day is validated + saved."""
    rows = await _rows_by_key(db, org_id, plan_date, keys, require_all=True)
    saved, skipped = [], []
    for i, key in enumerate(dict.fromkeys(keys)):  # de-duplicate, keep order
        row = rows[key]
        result = fn(i, key, _row_to_day(row))
        if isinstance(result, str):
            skipped.append({"agent_key": key, "reason": result})
            continue
        if errs := dp.validate_day(result):
            skipped.append({"agent_key": key, "reason": "; ".join(errs)})
            continue
        _write_day(row, result, actor)
        saved.append(row)
    await db.flush()
    await _refresh(db, saved)
    await record_audit(
        db,
        actor=actor,
        action=action,
        entity_type="day_schedule_plan",
        entity_id=plan_date.isoformat(),
        after={"saved": [r.agent_key for r in saved], "skipped": skipped},
        note=detail,
    )
    return saved, skipped


async def _refresh(db: AsyncSession, rows: list[DaySchedulePlan]) -> None:
    """`updated_at` is DB-generated (onupdate) and expires on flush; reload it now
    so serialising the response doesn't trigger lazy IO outside the session."""
    for row in rows:
        await db.refresh(row, ["updated_at"])


def _new_id(prefix: str) -> str:
    return f"{prefix}{uuid.uuid4().hex[:10]}"


async def apply_edit(
    db: AsyncSession, org_id: uuid.UUID, plan_date: date, body: DayApplyEditIn, *, actor: User
) -> tuple[list[DaySchedulePlan], list[dict]]:
    op = dp.EditOp(body.op.kind, body.op.seg_id, body.op.edge)
    if op.kind != "shift-resize" and not op.seg_id:
        raise ValidationError("seg_id is required for this operation")
    if op.kind not in ("aux-move", "activity-move") and op.edge is None:
        raise ValidationError("edge is required for resize operations")
    keys = [body.agent_key, *[f for f in body.followers if f != body.agent_key]]
    rows = await _rows_by_key(db, org_id, plan_date, keys, require_all=True)
    source = _row_to_day(rows[body.agent_key])
    if op.kind != "shift-resize" and dp.find_block(source, op) is None:
        raise NotFoundError(f"Block '{op.seg_id}' not found on {body.agent_key}'s day")
    delta = body.value - dp.edit_value(source, op)
    after_main = dp.apply_edit(source, op, body.value)
    detail = dp.describe_edit(source, after_main, op)

    def fn(_: int, key: str, day: dp.AgentDay) -> dp.AgentDay | str:
        if key == body.agent_key:
            return after_main
        eq = dp.equivalent_op(source, op, day)
        if eq is None:
            return "No matching block on this schedule"
        return dp.apply_edit(day, eq, dp.edit_value(day, eq) + delta)

    return await _apply_each(
        db,
        org_id,
        plan_date,
        keys,
        actor=actor,
        action="dayplan.edit",
        detail=detail + (" (applied to all selected)" if len(keys) > 1 else ""),
        fn=fn,
    )


async def move(
    db: AsyncSession, org_id: uuid.UUID, plan_date: date, body: DayMoveIn, *, actor: User
):
    word = "earlier" if body.delta < 0 else "later"
    return await _apply_each(
        db,
        org_id,
        plan_date,
        body.agent_keys,
        actor=actor,
        action="dayplan.move",
        detail=f"moved {abs(body.delta)} min {word}",
        fn=lambda _i, _k, d: dp.move_day(d, body.delta),
    )


async def resize_shift(
    db: AsyncSession, org_id: uuid.UUID, plan_date: date, body: DayResizeShiftIn, *, actor: User
):
    op = dp.EditOp("shift-resize", edge=body.edge)
    return await _apply_each(
        db,
        org_id,
        plan_date,
        body.agent_keys,
        actor=actor,
        action="dayplan.resize_shift",
        detail=f"shift {body.edge} {'+' if body.delta > 0 else '−'}{abs(body.delta)} min",
        fn=lambda _i, _k, d: dp.apply_edit(d, op, dp.edit_value(d, op) + body.delta),
    )


async def mark_aux(
    db: AsyncSession, org_id: uuid.UUID, plan_date: date, body: DayMarkAuxIn, *, actor: User
):
    seg_id = _new_id("mk")  # shared across agents so a later bulk drag can match it
    full = body.full_shift

    def fn(i: int, _k: str, day: dp.AgentDay) -> dp.AgentDay | str:
        start = body.start
        if body.stagger and not full:
            start, _ = dp.staggered_window(
                i, body.start, body.length, body.stagger.group_size, body.stagger.every
            )
        return dp.mark_aux(day, body.kind, start, body.length, full, seg_id, body.note)

    label = dp.ACTIVITIES[body.kind]["label"] if body.kind in dp.ACTIVITIES else body.kind.title()
    when = (
        "full shift" if full else f"{dp.fmt_hm(body.start)}–{dp.fmt_hm(body.start + body.length)}"
    )
    return await _apply_each(
        db,
        org_id,
        plan_date,
        body.agent_keys,
        actor=actor,
        action="dayplan.mark_aux",
        detail=f"Marked {label} {when}",
        fn=fn,
    )


async def unmark(
    db: AsyncSession, org_id: uuid.UUID, plan_date: date, body: DayUnmarkIn, *, actor: User
):
    return await _apply_each(
        db,
        org_id,
        plan_date,
        body.agent_keys,
        actor=actor,
        action="dayplan.unmark",
        detail=f"Removed activities at {dp.fmt_hm(body.at)}",
        fn=lambda _i, _k, d: dp.unmark_activities_at(d, body.at),
    )


async def add_overtime(
    db: AsyncSession, org_id: uuid.UUID, plan_date: date, body: DayAddOvertimeIn, *, actor: User
):
    def fn(_i: int, _k: str, day: dp.AgentDay) -> dp.AgentDay | str:
        placed = dp.propose_overtime(
            day, body.channel, body.timing, body.duration, body.start, body.end
        )
        if isinstance(placed, str):
            return placed
        return dp.with_overtime_added(day, dp.ChannelSeg(_new_id("ot"), body.channel, *placed))

    when = (
        f"{dp.fmt_hm(body.start or 0)}–{dp.fmt_hm(body.end or 0)}"
        if body.timing == "custom"
        else f"{body.duration} min {body.timing} shift"
    )
    return await _apply_each(
        db,
        org_id,
        plan_date,
        body.agent_keys,
        actor=actor,
        action="dayplan.add_ot",
        detail=f"{dp.CHANNELS[body.channel]['label']} OT · {when}",
        fn=fn,
    )


# ------------------------------------------------------- coverage & export


def _export_agents(rows: list[DaySchedulePlan]) -> list[dp.ExportAgent]:
    return [
        dp.ExportAgent(r.agent_key, r.agent_name or r.agent_key, r.team, _row_to_day(r))
        for r in rows
    ]


def coverage(rows: list[DaySchedulePlan]) -> list[dict]:
    days = [_row_to_day(r) for r in rows]
    return dp.coverage([dp.day_timeline(d) for d in days], dp.timeline_window(days))


def export_sheets(rows: list[DaySchedulePlan], law: dict | None = None) -> dict[str, list[dict]]:
    """The five schedule sheets, plus compliance + rules sheets when a labour law applies."""
    agents = _export_agents(rows)
    sheets = dp.export_sheets(agents)
    if law:
        sheets.update(labour_law.compliance_sheets(agents, law))
    return sheets


def export_csv(rows: list[DaySchedulePlan], law: dict | None = None) -> str:
    """All sheets in one CSV, sectioned like the frontend's CSV export."""
    out = io.StringIO()
    for name, sheet in export_sheets(rows, law).items():
        if not sheet:
            continue
        out.write(f"=== {name} ===\n")
        cols = list(dict.fromkeys(k for r in sheet for k in r))
        writer = csv.DictWriter(out, fieldnames=cols, lineterminator="\n")
        writer.writeheader()
        writer.writerows(sheet)
        out.write("\n")
    return out.getvalue()


# ------------------------------------------------------ country labour law


async def get_policy(db: AsyncSession, org_id: uuid.UUID) -> SchedulingPolicy | None:
    return (
        await db.execute(select(SchedulingPolicy).where(SchedulingPolicy.organization_id == org_id))
    ).scalar_one_or_none()


def policy_out(policy: SchedulingPolicy | None) -> dict:
    code = policy.country_code if policy else None
    overrides = dict(policy.overrides or {}) if policy else {}
    return {
        "country_code": code,
        "overrides": overrides,
        "version": policy.version if policy else 0,
        "effective": labour_law.effective_law(code, overrides),
        "disclaimer": labour_law.disclaimer(),
    }


async def set_policy(
    db: AsyncSession, org_id: uuid.UUID, body: LabourLawPolicyIn, *, actor: User
) -> SchedulingPolicy:
    if body.country_code is not None and labour_law.preset(body.country_code) is None:
        raise ValidationError(
            f"Unknown country '{body.country_code}'",
            details={"known": [law["code"] for law in labour_law.presets()]},
        )
    policy = await get_policy(db, org_id)
    before = policy_out(policy)
    if policy is None:
        policy = SchedulingPolicy(organization_id=org_id, version=0)
        db.add(policy)
    policy.country_code = body.country_code
    # Overrides only make sense against a country's statute.
    policy.overrides = body.overrides.model_dump(exclude_unset=True) if body.country_code else {}
    policy.version = (policy.version or 0) + 1
    policy.updated_by = actor.id
    await db.flush()
    await db.refresh(policy, ["updated_at"])
    await record_audit(
        db, actor=actor, action="scheduling_policy.labour_law", entity_type="scheduling_policy",
        entity_id=policy.id,
        before={"country_code": before["country_code"], "overrides": before["overrides"]},
        after={"country_code": policy.country_code, "overrides": policy.overrides},
    )
    return policy


async def org_law(db: AsyncSession, org_id: uuid.UUID, country: str | None = None) -> dict | None:
    """The law to check against: an explicit `country` preset, else the org policy."""
    if country:
        law = labour_law.effective_law(country)
        if law is None:
            raise ValidationError(f"Unknown country '{country}'")
        return law
    policy = await get_policy(db, org_id)
    return labour_law.effective_law(policy.country_code, policy.overrides) if policy else None


def compliance(rows: list[DaySchedulePlan], law: dict | None) -> dict:
    agents = []
    for r in rows:
        day = _row_to_day(r)
        issues = labour_law.check_compliance(day, law) if law else []
        agents.append({
            "agent_key": r.agent_key, "agent_name": r.agent_name or r.agent_key,
            "worked_minutes": labour_law.worked_minutes(day),
            "compliant": not issues, "issues": issues,
        })
    return {
        "country_code": law["code"] if law else None, "law": law,
        "disclaimer": labour_law.disclaimer(), "agents": agents,
    }
