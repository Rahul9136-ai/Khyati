"""Attendance services: records, lateness derivation, summaries."""
from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError
from app.modules.attendance.models import AttendanceCode, AttendanceRecord
from app.modules.attendance.schemas import AttendanceSummary, RecordIn, RecordUpdate
from app.modules.identity.models import User
from app.modules.identity.service import record_audit


def _derive_minutes(record: AttendanceRecord) -> None:
    record.minutes_late = 0
    record.minutes_early_logout = 0
    if (record.scheduled_start and record.actual_start
            and record.actual_start > record.scheduled_start):
        record.minutes_late = int(
            (record.actual_start - record.scheduled_start).total_seconds() // 60
        )
    if record.scheduled_end and record.actual_end and record.actual_end < record.scheduled_end:
        record.minutes_early_logout = int(
            (record.scheduled_end - record.actual_end).total_seconds() // 60
        )


async def create_record(
    db: AsyncSession, org_id: uuid.UUID, payload: RecordIn, *, actor: User,
    source: str = "manual",
) -> AttendanceRecord:
    code = await db.get(AttendanceCode, payload.code_id)
    if code is None or code.organization_id != org_id:
        raise NotFoundError("Attendance code not found")
    dup = await db.execute(
        select(AttendanceRecord).where(
            AttendanceRecord.employee_id == payload.employee_id,
            AttendanceRecord.day == payload.day,
            AttendanceRecord.code_id == payload.code_id,
        )
    )
    if dup.scalar_one_or_none():
        raise ConflictError("This attendance code is already recorded for that day")
    record = AttendanceRecord(organization_id=org_id, source=source, **payload.model_dump())
    record.code = code  # pre-populate so serialization needs no lazy load
    _derive_minutes(record)
    db.add(record)
    await db.flush()
    await record_audit(
        db, actor=actor, action="attendance.create", entity_type="attendance_record",
        entity_id=record.id,
        after={"employee": str(payload.employee_id), "day": payload.day.isoformat(),
               "code": code.code},
    )
    return record


async def bulk_create(
    db: AsyncSession, org_id: uuid.UUID, records: list[RecordIn], *, actor: User
) -> list[AttendanceRecord]:
    created = []
    for record_in in records:
        created.append(
            await create_record(db, org_id, record_in, actor=actor, source="bulk")
        )
    return created


async def update_record(
    db: AsyncSession, record_id: uuid.UUID, payload: RecordUpdate, *, actor: User
) -> AttendanceRecord:
    record = await db.get(AttendanceRecord, record_id)
    if record is None:
        raise NotFoundError("Attendance record not found")
    changes = payload.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(record, key, value)
    if "code_id" in changes:
        new_code = await db.get(AttendanceCode, record.code_id)
        if new_code is None:
            raise NotFoundError("Attendance code not found")
        record.code = new_code
    _derive_minutes(record)
    await record_audit(
        db, actor=actor, action="attendance.update", entity_type="attendance_record",
        entity_id=record.id, after={k: str(v) for k, v in changes.items()},
    )
    return record


async def list_records(
    db: AsyncSession,
    org_id: uuid.UUID,
    *,
    employee_id: uuid.UUID | None = None,
    start: date | None = None,
    end: date | None = None,
    offset: int = 0,
    limit: int = 100,
) -> tuple[list[AttendanceRecord], int]:
    query = select(AttendanceRecord).where(AttendanceRecord.organization_id == org_id)
    if employee_id:
        query = query.where(AttendanceRecord.employee_id == employee_id)
    if start:
        query = query.where(AttendanceRecord.day >= start)
    if end:
        query = query.where(AttendanceRecord.day <= end)
    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    rows = await db.execute(
        query.order_by(AttendanceRecord.day.desc()).offset(offset).limit(limit)
    )
    return list(rows.scalars()), total


async def summarize(
    db: AsyncSession, org_id: uuid.UUID, start: date, end: date
) -> AttendanceSummary:
    rows, _ = await list_records(db, org_id, start=start, end=end, limit=100_000)
    total = len(rows)
    by_category: dict[str, int] = {}
    absent = late = shrink = 0
    for r in rows:
        by_category[r.code.category] = by_category.get(r.code.category, 0) + 1
        if r.code.category in ("absent", "sick"):
            absent += 1
        if r.code.category == "late" or r.minutes_late > 0:
            late += 1
        if r.code.counts_as_shrinkage:
            shrink += 1
    return AttendanceSummary(
        start=start,
        end=end,
        total_records=total,
        absent_records=absent,
        late_records=late,
        absenteeism_rate=round(absent / total, 4) if total else 0.0,
        late_rate=round(late / total, 4) if total else 0.0,
        shrinkage_rate=round(shrink / total, 4) if total else 0.0,
        by_category=by_category,
    )
