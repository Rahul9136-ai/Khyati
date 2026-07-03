"""Workforce endpoints: /org/*, /skills, /queues, /employees."""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import ValidationError as PydanticValidationError

from app.api.deps import DbSession, get_current_user, require_permission
from app.core.exceptions import ValidationError
from app.modules.identity.models import User
from app.modules.workforce import service
from app.modules.workforce.models import (
    BusinessUnit,
    Country,
    Employee,
    HolidayCalendar,
    Lob,
    Queue,
    Skill,
    Team,
)
from app.modules.workforce.schemas import (
    BusinessUnitIn,
    BusinessUnitOut,
    CountryIn,
    CountryOut,
    EmployeeIn,
    EmployeeOut,
    EmployeeSkillIn,
    EmployeeUpdate,
    HolidayCalendarIn,
    HolidayCalendarOut,
    LobIn,
    LobOut,
    OrganizationOut,
    QueueIn,
    QueueOut,
    SkillIn,
    SkillOut,
    TeamIn,
    TeamOut,
)
from app.schemas.common import ApiResponse, Page

org_router = APIRouter(prefix="/org", tags=["organization"])
employees_router = APIRouter(prefix="/employees", tags=["employees"])

AnyUser = Annotated[User, Depends(get_current_user)]
OrgAdmin = Annotated[User, Depends(require_permission("admin:org"))]
EmpReader = Annotated[User, Depends(require_permission("employee:read"))]
EmpWriter = Annotated[User, Depends(require_permission("employee:write"))]


@org_router.get("", response_model=ApiResponse[OrganizationOut])
async def my_organization(db: DbSession, user: AnyUser):
    org = await service.get_organization(db, service.org_scope(user))
    return ApiResponse(data=OrganizationOut.model_validate(org))


def _crud(path: str, model, in_schema, out_schema, entity_name: str):
    """Register list/create/update/delete for one org-structure entity.

    The body arrives as a plain JSON dict and is validated against `in_schema`
    explicitly — a closure variable cannot be used as a parameter annotation
    (PEP 563 string annotations resolve against module globals only).
    """

    def _validate(body: dict):
        try:
            return in_schema.model_validate(body)
        except PydanticValidationError as exc:
            raise ValidationError(
                f"Invalid {entity_name} payload",
                details=exc.errors(include_url=False, include_context=False,
                                   include_input=False),
            ) from exc

    @org_router.get(path, response_model=ApiResponse[list[out_schema]], name=f"list_{entity_name}s")
    async def _list(db: DbSession, user: AnyUser):
        rows = await service.list_entities(db, model, service.org_scope(user))
        return ApiResponse(data=[out_schema.model_validate(r) for r in rows])

    @org_router.post(path, response_model=ApiResponse[out_schema], status_code=201,
                     name=f"create_{entity_name}")
    async def _create(body: dict, db: DbSession, actor: OrgAdmin):
        obj = await service.create_entity(
            db, model, service.org_scope(actor), _validate(body).model_dump(),
            actor=actor, entity_name=entity_name,
        )
        return ApiResponse(data=out_schema.model_validate(obj))

    @org_router.patch(path + "/{entity_id}", response_model=ApiResponse[out_schema],
                      name=f"update_{entity_name}")
    async def _update(entity_id: uuid.UUID, body: dict, db: DbSession, actor: OrgAdmin):
        obj = await service.update_entity(
            db, model, entity_id, _validate(body).model_dump(),
            actor=actor, entity_name=entity_name,
        )
        return ApiResponse(data=out_schema.model_validate(obj))

    @org_router.delete(path + "/{entity_id}", response_model=ApiResponse[dict],
                       name=f"delete_{entity_name}")
    async def _delete(entity_id: uuid.UUID, db: DbSession, actor: OrgAdmin):
        await service.delete_entity(db, model, entity_id, actor=actor, entity_name=entity_name)
        return ApiResponse(data={"detail": f"{entity_name} deleted"})


_crud("/countries", Country, CountryIn, CountryOut, "country")
_crud("/business-units", BusinessUnit, BusinessUnitIn, BusinessUnitOut, "business_unit")
_crud("/lobs", Lob, LobIn, LobOut, "lob")
_crud("/teams", Team, TeamIn, TeamOut, "team")
_crud("/skills", Skill, SkillIn, SkillOut, "skill")
_crud("/queues", Queue, QueueIn, QueueOut, "queue")


@org_router.get("/holiday-calendars", response_model=ApiResponse[list[HolidayCalendarOut]])
async def list_holiday_calendars(db: DbSession, user: AnyUser):
    rows = await service.list_entities(db, HolidayCalendar, service.org_scope(user))
    return ApiResponse(data=[HolidayCalendarOut.model_validate(r) for r in rows])


@org_router.post("/holiday-calendars", response_model=ApiResponse[HolidayCalendarOut],
                 status_code=201)
async def create_holiday_calendar(body: HolidayCalendarIn, db: DbSession, actor: OrgAdmin):
    cal = await service.create_holiday_calendar(db, service.org_scope(actor), body, actor=actor)
    return ApiResponse(data=HolidayCalendarOut.model_validate(cal))


# ----------------------------------------------------------------- employees


@employees_router.get("", response_model=ApiResponse[Page[EmployeeOut]])
async def list_employees(
    db: DbSession,
    user: EmpReader,
    team_id: uuid.UUID | None = None,
    lob_id: uuid.UUID | None = None,
    status: str | None = None,
    search: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
):
    rows, total = await service.list_employees(
        db, service.org_scope(user), team_id=team_id, lob_id=lob_id, status=status,
        search=search, offset=(page - 1) * size, limit=size,
    )
    return ApiResponse(
        data=Page(items=[EmployeeOut.model_validate(e) for e in rows],
                  total=total, page=page, size=size)
    )


@employees_router.get("/{employee_id}", response_model=ApiResponse[EmployeeOut])
async def get_employee(employee_id: uuid.UUID, db: DbSession, user: EmpReader):
    emp = await service.get_or_404(db, Employee, employee_id, "Employee")
    return ApiResponse(data=EmployeeOut.model_validate(emp))


@employees_router.post("", response_model=ApiResponse[EmployeeOut], status_code=201)
async def create_employee(body: EmployeeIn, db: DbSession, actor: EmpWriter):
    emp = await service.create_employee(db, service.org_scope(actor), body, actor=actor)
    return ApiResponse(data=EmployeeOut.model_validate(emp))


@employees_router.patch("/{employee_id}", response_model=ApiResponse[EmployeeOut])
async def update_employee(
    employee_id: uuid.UUID, body: EmployeeUpdate, db: DbSession, actor: EmpWriter
):
    emp = await service.update_employee(db, employee_id, body, actor=actor)
    return ApiResponse(data=EmployeeOut.model_validate(emp))


@employees_router.put("/{employee_id}/skills", response_model=ApiResponse[EmployeeOut])
async def set_employee_skills(
    employee_id: uuid.UUID, body: list[EmployeeSkillIn], db: DbSession, actor: EmpWriter
):
    emp = await service.set_employee_skills(db, employee_id, body, actor=actor)
    return ApiResponse(data=EmployeeOut.model_validate(emp))
