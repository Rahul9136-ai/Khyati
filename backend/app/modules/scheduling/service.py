"""Scheduling services: template CRUD, auto-generation, validation, publishing.

Auto-generation strategy (deterministic, availability-aware):
  employees of the team are dealt round-robin across the given templates;
  each employee gets one shift per template working day, skipped when the
  employee's availability excludes that weekday or the weekly-hours cap is
  reached. Break/lunch blocks come from the template.
"""
from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.identity.models import User
from app.modules.identity.service import record_audit
from app.modules.scheduling.models import Schedule, ScheduleShift, ShiftTemplate
from app.modules.scheduling.schemas import (
    ConflictOut,
    GenerateScheduleRequest,
    ShiftIn,
    ShiftUpdate,
    ValidationOut,
)
from app.modules.workforce.models import Employee, Team

_WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _combine(day: date, t: time) -> datetime:
    return datetime.combine(day, t, tzinfo=UTC)


def _shift_bounds(day: date, template: ShiftTemplate) -> tuple[datetime, datetime]:
    start = _combine(day, template.start_time)
    end = _combine(day, template.end_time)
    if end <= start:  # night shift wrapping midnight
        end += timedelta(days=1)
    return start, end


def _available(employee: Employee, weekday: int) -> bool:
    if not employee.availability:
        return True
    slot = employee.availability.get(_WEEKDAY_KEYS[weekday], "missing")
    return slot not in (None, [], "off")


async def generate_schedule(
    db: AsyncSession, org_id: uuid.UUID, payload: GenerateScheduleRequest, *, actor: User
) -> Schedule:
    team = await db.get(Team, payload.team_id)
    if team is None or team.organization_id != org_id:
        raise NotFoundError("Team not found")
    if payload.week_start.weekday() != 0:
        raise ValidationError("week_start must be a Monday")

    templates = list(
        (
            await db.execute(
                select(ShiftTemplate).where(ShiftTemplate.id.in_(payload.template_ids))
            )
        ).scalars()
    )
    if len(templates) != len(payload.template_ids):
        raise NotFoundError("One or more shift templates not found")

    employees = list(
        (
            await db.execute(
                select(Employee).where(
                    Employee.team_id == team.id,
                    Employee.status == "active",
                    Employee.deleted_at.is_(None),
                )
            )
        ).scalars()
    )
    if not employees:
        raise ValidationError("Team has no active employees to schedule")

    schedule = Schedule(
        organization_id=org_id,
        name=payload.name or f"{team.name} — week of {payload.week_start.isoformat()}",
        team_id=team.id,
        lob_id=team.lob_id,
        week_start=payload.week_start,
        created_by=actor.id,
    )
    for i, emp in enumerate(employees):
        template = templates[i % len(templates)]
        # weekly-hours cap counts PAID time: lunches are unpaid, breaks are paid
        unpaid_minutes = sum(
            b["duration_minutes"] for b in template.breaks if b["activity"] == "lunch"
        )
        shift_hours = 0.0
        for weekday in sorted(template.days_of_week):
            day = payload.week_start + timedelta(days=weekday)
            if not _available(emp, weekday):
                continue
            start, end = _shift_bounds(day, template)
            hours = (end - start).total_seconds() / 3600 - unpaid_minutes / 60
            if shift_hours + hours > emp.weekly_hours + 1e-6:
                break
            shift_hours += hours
            schedule.shifts.append(
                ScheduleShift(
                    employee_id=emp.id,
                    template_id=template.id,
                    day=day,
                    start_ts=start,
                    end_ts=end,
                    activities=list(template.breaks),
                )
            )
    db.add(schedule)
    await db.flush()
    await record_audit(
        db, actor=actor, action="schedule.generate", entity_type="schedule",
        entity_id=schedule.id,
        after={"team": str(team.id), "week": payload.week_start.isoformat(),
               "shifts": len(schedule.shifts)},
    )
    return schedule


async def get_schedule(db: AsyncSession, schedule_id: uuid.UUID) -> Schedule:
    schedule = await db.get(Schedule, schedule_id, options=[selectinload(Schedule.shifts)])
    if schedule is None:
        raise NotFoundError("Schedule not found")
    return schedule


async def list_schedules(
    db: AsyncSession, org_id: uuid.UUID, *, team_id: uuid.UUID | None = None,
    status: str | None = None,
) -> list[Schedule]:
    query = select(Schedule).where(Schedule.organization_id == org_id)
    if team_id:
        query = query.where(Schedule.team_id == team_id)
    if status:
        query = query.where(Schedule.status == status)
    rows = await db.execute(query.order_by(Schedule.week_start.desc()))
    return list(rows.scalars())


def _require_draft(schedule: Schedule) -> None:
    if schedule.status != "draft":
        raise ValidationError("Published schedules are immutable; create a new draft version")


async def add_shift(
    db: AsyncSession, schedule_id: uuid.UUID, payload: ShiftIn, *, actor: User
) -> ScheduleShift:
    schedule = await get_schedule(db, schedule_id)
    _require_draft(schedule)
    if payload.end_ts <= payload.start_ts:
        raise ValidationError("Shift end must be after start")
    shift = ScheduleShift(schedule_id=schedule.id, **payload.model_dump())
    db.add(shift)
    await db.flush()
    await record_audit(
        db, actor=actor, action="shift.create", entity_type="schedule_shift",
        entity_id=shift.id,
    )
    return shift


async def update_shift(
    db: AsyncSession, shift_id: uuid.UUID, payload: ShiftUpdate, *, actor: User
) -> ScheduleShift:
    shift = await db.get(ScheduleShift, shift_id)
    if shift is None:
        raise NotFoundError("Shift not found")
    schedule = await get_schedule(db, shift.schedule_id)
    _require_draft(schedule)
    changes = payload.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(shift, key, value)
    if shift.end_ts <= shift.start_ts:
        raise ValidationError("Shift end must be after start")
    await record_audit(
        db, actor=actor, action="shift.update", entity_type="schedule_shift",
        entity_id=shift.id, after={k: str(v) for k, v in changes.items()},
    )
    return shift


async def delete_shift(db: AsyncSession, shift_id: uuid.UUID, *, actor: User) -> None:
    shift = await db.get(ScheduleShift, shift_id)
    if shift is None:
        raise NotFoundError("Shift not found")
    schedule = await get_schedule(db, shift.schedule_id)
    _require_draft(schedule)
    await db.delete(shift)
    await record_audit(
        db, actor=actor, action="shift.delete", entity_type="schedule_shift",
        entity_id=shift_id,
    )


def validate_schedule(schedule: Schedule) -> ValidationOut:
    """Detect overlapping shifts per employee + structural warnings."""
    conflicts: list[ConflictOut] = []
    warnings: list[str] = []
    by_emp: dict[uuid.UUID, list[ScheduleShift]] = {}
    for shift in schedule.shifts:
        by_emp.setdefault(shift.employee_id, []).append(shift)
    for emp_id, shifts in by_emp.items():
        shifts.sort(key=lambda s: s.start_ts)
        for a, b in zip(shifts, shifts[1:]):
            if b.start_ts < a.end_ts:
                conflicts.append(
                    ConflictOut(
                        employee_id=emp_id,
                        day=a.day,
                        shift_ids=[a.id, b.id],
                        message="Overlapping shifts",
                    )
                )
        week_hours = sum((s.end_ts - s.start_ts).total_seconds() / 3600 for s in shifts)
        if week_hours > 60:
            warnings.append(f"Employee {emp_id} is scheduled {week_hours:.1f}h this week")
    if not schedule.shifts:
        warnings.append("Schedule has no shifts")
    return ValidationOut(valid=not conflicts, conflicts=conflicts, warnings=warnings)


async def publish_schedule(db: AsyncSession, schedule_id: uuid.UUID, *, actor: User) -> Schedule:
    schedule = await get_schedule(db, schedule_id)
    _require_draft(schedule)
    validation = validate_schedule(schedule)
    if not validation.valid:
        raise ValidationError(
            "Schedule has conflicts; resolve them before publishing",
            details=[c.model_dump(mode="json") for c in validation.conflicts],
        )
    schedule.status = "published"
    schedule.published_by = actor.id
    schedule.published_at = datetime.now(UTC)

    # notify scheduled employees (in-app)
    from app.modules.notifications.service import notify_employees

    await notify_employees(
        db,
        schedule.organization_id,
        {s.employee_id for s in schedule.shifts},
        title="New schedule published",
        body=f"Schedule '{schedule.name}' for week {schedule.week_start.isoformat()} is live.",
        kind="schedule_published",
    )
    await record_audit(
        db, actor=actor, action="schedule.publish", entity_type="schedule",
        entity_id=schedule.id,
    )
    return schedule
