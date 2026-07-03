"""Scheduling endpoints: /scheduling/templates, /scheduling/schedules."""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.deps import DbSession, require_permission
from app.modules.identity.models import User
from app.modules.scheduling import service
from app.modules.scheduling.models import ShiftTemplate
from app.modules.scheduling.schemas import (
    GenerateScheduleRequest,
    ScheduleDetailOut,
    ScheduleOut,
    ShiftIn,
    ShiftOut,
    ShiftTemplateIn,
    ShiftTemplateOut,
    ShiftUpdate,
    ValidationOut,
)
from app.modules.workforce.service import (
    create_entity,
    delete_entity,
    list_entities,
    org_scope,
    update_entity,
)
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/scheduling", tags=["scheduling"])

Reader = Annotated[User, Depends(require_permission("schedule:read"))]
Writer = Annotated[User, Depends(require_permission("schedule:write"))]
Publisher = Annotated[User, Depends(require_permission("schedule:publish"))]


# ---------------------------------------------------------------- templates

@router.get("/templates", response_model=ApiResponse[list[ShiftTemplateOut]])
async def list_templates(db: DbSession, user: Reader):
    rows = await list_entities(db, ShiftTemplate, org_scope(user))
    return ApiResponse(data=[ShiftTemplateOut.model_validate(t) for t in rows])


@router.post("/templates", response_model=ApiResponse[ShiftTemplateOut], status_code=201)
async def create_template(body: ShiftTemplateIn, db: DbSession, actor: Writer):
    obj = await create_entity(
        db, ShiftTemplate, org_scope(actor), body.model_dump(),
        actor=actor, entity_name="shift_template",
    )
    return ApiResponse(data=ShiftTemplateOut.model_validate(obj))


@router.patch("/templates/{template_id}", response_model=ApiResponse[ShiftTemplateOut])
async def update_template(
    template_id: uuid.UUID, body: ShiftTemplateIn, db: DbSession, actor: Writer
):
    obj = await update_entity(
        db, ShiftTemplate, template_id, body.model_dump(),
        actor=actor, entity_name="shift_template",
    )
    return ApiResponse(data=ShiftTemplateOut.model_validate(obj))


@router.delete("/templates/{template_id}", response_model=ApiResponse[dict])
async def delete_template(template_id: uuid.UUID, db: DbSession, actor: Writer):
    await delete_entity(db, ShiftTemplate, template_id, actor=actor,
                        entity_name="shift_template")
    return ApiResponse(data={"detail": "Template deleted"})


# ---------------------------------------------------------------- schedules

@router.post("/schedules/generate", response_model=ApiResponse[ScheduleDetailOut],
             status_code=201)
async def generate_schedule(body: GenerateScheduleRequest, db: DbSession, actor: Writer):
    schedule = await service.generate_schedule(db, org_scope(actor), body, actor=actor)
    return ApiResponse(data=ScheduleDetailOut.model_validate(schedule))


@router.get("/schedules", response_model=ApiResponse[list[ScheduleOut]])
async def list_schedules(
    db: DbSession, user: Reader, team_id: uuid.UUID | None = None, status: str | None = None
):
    rows = await service.list_schedules(db, org_scope(user), team_id=team_id, status=status)
    return ApiResponse(data=[ScheduleOut.model_validate(s) for s in rows])


@router.get("/schedules/{schedule_id}", response_model=ApiResponse[ScheduleDetailOut])
async def get_schedule(schedule_id: uuid.UUID, db: DbSession, user: Reader):
    schedule = await service.get_schedule(db, schedule_id)
    return ApiResponse(data=ScheduleDetailOut.model_validate(schedule))


@router.get("/schedules/{schedule_id}/validate", response_model=ApiResponse[ValidationOut])
async def validate_schedule(schedule_id: uuid.UUID, db: DbSession, user: Reader):
    schedule = await service.get_schedule(db, schedule_id)
    return ApiResponse(data=service.validate_schedule(schedule))


@router.post("/schedules/{schedule_id}/publish", response_model=ApiResponse[ScheduleOut])
async def publish_schedule(schedule_id: uuid.UUID, db: DbSession, actor: Publisher):
    schedule = await service.publish_schedule(db, schedule_id, actor=actor)
    return ApiResponse(data=ScheduleOut.model_validate(schedule))


@router.post("/schedules/{schedule_id}/shifts", response_model=ApiResponse[ShiftOut],
             status_code=201)
async def add_shift(schedule_id: uuid.UUID, body: ShiftIn, db: DbSession, actor: Writer):
    shift = await service.add_shift(db, schedule_id, body, actor=actor)
    return ApiResponse(data=ShiftOut.model_validate(shift))


@router.patch("/shifts/{shift_id}", response_model=ApiResponse[ShiftOut])
async def update_shift(shift_id: uuid.UUID, body: ShiftUpdate, db: DbSession, actor: Writer):
    shift = await service.update_shift(db, shift_id, body, actor=actor)
    return ApiResponse(data=ShiftOut.model_validate(shift))


@router.delete("/shifts/{shift_id}", response_model=ApiResponse[dict])
async def delete_shift(shift_id: uuid.UUID, db: DbSession, actor: Writer):
    await service.delete_shift(db, shift_id, actor=actor)
    return ApiResponse(data={"detail": "Shift deleted"})
