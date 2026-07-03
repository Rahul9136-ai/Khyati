"""Workforce services: tenant-scoped CRUD for org structure and employees."""
from __future__ import annotations

import uuid
from typing import Any, TypeVar

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.modules.identity.models import User
from app.modules.identity.service import record_audit
from app.modules.workforce.models import (
    BusinessUnit,
    Country,
    Employee,
    EmployeeSkill,
    Holiday,
    HolidayCalendar,
    Lob,
    Organization,
    Queue,
    Skill,
    Team,
)
from app.modules.workforce.schemas import (
    EmployeeIn,
    EmployeeSkillIn,
    EmployeeUpdate,
    HolidayCalendarIn,
)

T = TypeVar("T")


def org_scope(user: User) -> uuid.UUID:
    if user.organization_id is None:
        raise ValidationError("This account is not attached to an organization")
    return user.organization_id


async def get_or_404(db: AsyncSession, model: type[T], entity_id: uuid.UUID, name: str) -> T:
    obj = await db.get(model, entity_id)
    if obj is None:
        raise NotFoundError(f"{name} not found")
    return obj


# ------------------------------------------------------------- org structure


async def get_organization(db: AsyncSession, org_id: uuid.UUID) -> Organization:
    return await get_or_404(db, Organization, org_id, "Organization")


async def list_entities(db: AsyncSession, model: type[T], org_id: uuid.UUID) -> list[T]:
    rows = await db.execute(select(model).where(model.organization_id == org_id))  # type: ignore[attr-defined]
    return list(rows.scalars())


async def create_entity(
    db: AsyncSession,
    model: type[T],
    org_id: uuid.UUID,
    payload: dict[str, Any],
    *,
    actor: User,
    entity_name: str,
) -> T:
    obj = model(organization_id=org_id, **payload)  # type: ignore[call-arg]
    db.add(obj)
    await db.flush()
    await record_audit(
        db, actor=actor, action=f"{entity_name}.create", entity_type=entity_name,
        entity_id=obj.id, after=payload,  # type: ignore[attr-defined]
    )
    return obj


async def update_entity(
    db: AsyncSession,
    model: type[T],
    entity_id: uuid.UUID,
    payload: dict[str, Any],
    *,
    actor: User,
    entity_name: str,
) -> T:
    obj = await get_or_404(db, model, entity_id, entity_name)
    before = {k: getattr(obj, k) for k in payload}
    for key, value in payload.items():
        setattr(obj, key, value)
    await record_audit(
        db, actor=actor, action=f"{entity_name}.update", entity_type=entity_name,
        entity_id=entity_id, before={k: str(v) for k, v in before.items()},
        after={k: str(v) for k, v in payload.items()},
    )
    return obj


async def delete_entity(
    db: AsyncSession, model: type[T], entity_id: uuid.UUID, *, actor: User, entity_name: str
) -> None:
    obj = await get_or_404(db, model, entity_id, entity_name)
    await db.delete(obj)
    await record_audit(
        db, actor=actor, action=f"{entity_name}.delete", entity_type=entity_name,
        entity_id=entity_id,
    )


async def create_holiday_calendar(
    db: AsyncSession, org_id: uuid.UUID, payload: HolidayCalendarIn, *, actor: User
) -> HolidayCalendar:
    cal = HolidayCalendar(
        organization_id=org_id,
        name=payload.name,
        holidays=[Holiday(day=h.day, name=h.name) for h in payload.holidays],
    )
    db.add(cal)
    await db.flush()
    await record_audit(
        db, actor=actor, action="holiday_calendar.create", entity_type="holiday_calendar",
        entity_id=cal.id, after={"name": payload.name, "holidays": len(payload.holidays)},
    )
    return cal


# ----------------------------------------------------------------- employees


async def list_employees(
    db: AsyncSession,
    org_id: uuid.UUID,
    *,
    team_id: uuid.UUID | None = None,
    lob_id: uuid.UUID | None = None,
    status: str | None = None,
    search: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> tuple[list[Employee], int]:
    query = select(Employee).where(
        Employee.organization_id == org_id, Employee.deleted_at.is_(None)
    )
    if team_id:
        query = query.where(Employee.team_id == team_id)
    if lob_id:
        query = query.where(Employee.lob_id == lob_id)
    if status:
        query = query.where(Employee.status == status)
    if search:
        like = f"%{search.lower()}%"
        query = query.where(
            or_(
                func.lower(Employee.first_name).like(like),
                func.lower(Employee.last_name).like(like),
                func.lower(Employee.email).like(like),
                func.lower(Employee.employee_code).like(like),
            )
        )
    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    rows = await db.execute(
        query.order_by(Employee.employee_code).offset(offset).limit(limit)
    )
    return list(rows.scalars()), total


async def create_employee(
    db: AsyncSession, org_id: uuid.UUID, payload: EmployeeIn, *, actor: User
) -> Employee:
    dup = await db.execute(
        select(Employee).where(
            Employee.organization_id == org_id,
            Employee.employee_code == payload.employee_code,
        )
    )
    if dup.scalar_one_or_none():
        raise ConflictError(f"Employee code {payload.employee_code} already exists")
    # skills=[] initializes the collection so serializing the fresh instance
    # doesn't trigger a sync lazy-load inside the async session
    emp = Employee(organization_id=org_id, skills=[], **payload.model_dump())
    db.add(emp)
    await db.flush()
    await record_audit(
        db, actor=actor, action="employee.create", entity_type="employee", entity_id=emp.id,
        after={"employee_code": emp.employee_code, "email": emp.email},
    )
    return emp


async def update_employee(
    db: AsyncSession, employee_id: uuid.UUID, payload: EmployeeUpdate, *, actor: User
) -> Employee:
    emp = await get_or_404(db, Employee, employee_id, "Employee")
    changes = payload.model_dump(exclude_unset=True)
    before = {k: str(getattr(emp, k)) for k in changes}
    for key, value in changes.items():
        setattr(emp, key, value)
    await record_audit(
        db, actor=actor, action="employee.update", entity_type="employee", entity_id=emp.id,
        before=before, after={k: str(v) for k, v in changes.items()},
    )
    return emp


async def set_employee_skills(
    db: AsyncSession, employee_id: uuid.UUID, skills: list[EmployeeSkillIn], *, actor: User
) -> Employee:
    emp = await get_or_404(db, Employee, employee_id, "Employee")
    valid_skills = {
        s.id
        for s in (
            await db.execute(
                select(Skill).where(Skill.organization_id == emp.organization_id)
            )
        ).scalars()
    }
    unknown = [str(s.skill_id) for s in skills if s.skill_id not in valid_skills]
    if unknown:
        raise ValidationError(f"Unknown skills for this organization: {', '.join(unknown)}")
    emp.skills = [
        EmployeeSkill(skill_id=s.skill_id, proficiency=s.proficiency, priority=s.priority)
        for s in skills
    ]
    await record_audit(
        db, actor=actor, action="employee.set_skills", entity_type="employee",
        entity_id=emp.id, after={"skills": [str(s.skill_id) for s in skills]},
    )
    return emp


__all__ = [
    "BusinessUnit", "Country", "Employee", "Lob", "Queue", "Skill", "Team",
    "org_scope", "get_or_404",
]
