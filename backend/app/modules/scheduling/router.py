"""Scheduling endpoints: /scheduling/templates, /scheduling/schedules."""
from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response

from app.api.deps import DbSession, require_permission
from app.modules.identity.models import User
from app.modules.scheduling import dayplan_service, service
from app.modules.scheduling.models import ShiftTemplate
from app.modules.scheduling.schemas import (
    DayAddOvertimeIn,
    DayApplyEditIn,
    DayCoverageSlot,
    DayMarkAuxIn,
    DayMoveIn,
    DayOpResult,
    DayPlanBulkIn,
    DayPlanOut,
    DayResizeShiftIn,
    DaySkipped,
    DayUnmarkIn,
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


# --------------------------------------------- omni-channel day plans (timeline)
# The Scheduling timeline's server copy: one row per agent per date with the
# shift, breaks/lunch, Phone/Chat/Email blocks, OT and overlay activities.


def _result(saved, skipped) -> ApiResponse[DayOpResult]:
    return ApiResponse(data=DayOpResult(
        saved=[DayPlanOut.model_validate(r) for r in saved],
        skipped=[DaySkipped(**s) for s in skipped],
    ))


@router.get("/day-plans/{plan_date}", response_model=ApiResponse[list[DayPlanOut]])
async def list_day_plans(
    plan_date: date, db: DbSession, user: Reader,
    agent_keys: Annotated[list[str] | None, Query()] = None,
):
    rows = await dayplan_service.list_day_plans(db, org_scope(user), plan_date, agent_keys)
    return ApiResponse(data=[DayPlanOut.model_validate(r) for r in rows])


@router.put("/day-plans/{plan_date}", response_model=ApiResponse[list[DayPlanOut]])
async def save_day_plans(plan_date: date, body: DayPlanBulkIn, db: DbSession, actor: Writer):
    """Upsert many agents' days at once (all-or-nothing, same rules as the UI)."""
    rows = await dayplan_service.save_day_plans(db, org_scope(actor), plan_date, body, actor=actor)
    return ApiResponse(data=[DayPlanOut.model_validate(r) for r in rows])


@router.delete("/day-plans/{plan_date}/{agent_key}", response_model=ApiResponse[dict])
async def reset_day_plan(plan_date: date, agent_key: str, db: DbSession, actor: Writer):
    await dayplan_service.reset_day_plan(db, org_scope(actor), plan_date, agent_key, actor=actor)
    return ApiResponse(data={"detail": "Day plan reset to default"})


@router.post("/day-plans/{plan_date}/edit", response_model=ApiResponse[DayOpResult])
async def edit_day_plan(plan_date: date, body: DayApplyEditIn, db: DbSession, actor: Writer):
    """Move/resize a break, activity, channel or OT block, or a shift edge —
    optionally on every follower's matching block too (bulk drag)."""
    org = org_scope(actor)
    return _result(*await dayplan_service.apply_edit(db, org, plan_date, body, actor=actor))


@router.post("/day-plans/{plan_date}/move", response_model=ApiResponse[DayOpResult])
async def move_day_plans(plan_date: date, body: DayMoveIn, db: DbSession, actor: Writer):
    """Move whole schedules earlier/later (Ctrl+←/→ in the UI)."""
    return _result(*await dayplan_service.move(db, org_scope(actor), plan_date, body, actor=actor))


@router.post("/day-plans/{plan_date}/resize-shift", response_model=ApiResponse[DayOpResult])
async def resize_day_plan_shifts(
    plan_date: date, body: DayResizeShiftIn, db: DbSession, actor: Writer
):
    org = org_scope(actor)
    return _result(*await dayplan_service.resize_shift(db, org, plan_date, body, actor=actor))


@router.post("/day-plans/{plan_date}/mark-aux", response_model=ApiResponse[DayOpResult])
async def mark_aux(plan_date: date, body: DayMarkAuxIn, db: DbSession, actor: Writer):
    """Mark any AUX (break, lunch, meeting, training, coaching, LOA, absence,
    other) on many agents, optionally staggered in waves."""
    org = org_scope(actor)
    return _result(*await dayplan_service.mark_aux(db, org, plan_date, body, actor=actor))


@router.post("/day-plans/{plan_date}/unmark", response_model=ApiResponse[DayOpResult])
async def unmark_activities(plan_date: date, body: DayUnmarkIn, db: DbSession, actor: Writer):
    org = org_scope(actor)
    return _result(*await dayplan_service.unmark(db, org, plan_date, body, actor=actor))


@router.post("/day-plans/{plan_date}/overtime", response_model=ApiResponse[DayOpResult])
async def add_overtime(plan_date: date, body: DayAddOvertimeIn, db: DbSession, actor: Writer):
    """Add OT on a channel (after / before shift, or set times) for many agents."""
    org = org_scope(actor)
    return _result(*await dayplan_service.add_overtime(db, org, plan_date, body, actor=actor))


@router.get("/day-plans/{plan_date}/coverage", response_model=ApiResponse[list[DayCoverageSlot]])
async def day_plan_coverage(plan_date: date, db: DbSession, user: Reader):
    rows = await dayplan_service.list_day_plans(db, org_scope(user), plan_date)
    return ApiResponse(data=[DayCoverageSlot(**s) for s in dayplan_service.coverage(rows)])


@router.get("/day-plans/{plan_date}/export")
async def export_day_plans(
    plan_date: date, db: DbSession, user: Reader,
    format: Literal["json", "csv"] = "json",
    agent_keys: Annotated[list[str] | None, Query()] = None,
):
    """Same five sheets as the UI export (segments, agent summary, 15-min grid,
    channel coverage, legend) as JSON or a sectioned CSV."""
    rows = await dayplan_service.list_day_plans(db, org_scope(user), plan_date, agent_keys)
    if format == "csv":
        filename = f"schedules-{plan_date.isoformat()}.csv"
        return Response(
            dayplan_service.export_csv(rows), media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    return ApiResponse(data=dayplan_service.export_sheets(rows))
