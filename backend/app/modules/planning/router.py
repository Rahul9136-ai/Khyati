"""Planning endpoints: /planning/plans, /planning/erlang."""
from __future__ import annotations

import uuid
from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.deps import DbSession, require_permission
from app.modules.identity.models import User
from app.modules.planning import erlang, service
from app.modules.planning.schemas import (
    ErlangRequirementRequest,
    ErlangRequirementResponse,
    ErlangServiceLevelRequest,
    ErlangServiceLevelResponse,
    PlanCreate,
    PlanDetailOut,
    PlanOut,
    PlanUpdate,
    PlanWeekOut,
    WhatIfRequest,
)
from app.modules.workforce.service import org_scope
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/planning", tags=["planning"])

Reader = Annotated[User, Depends(require_permission("plan:read"))]
Writer = Annotated[User, Depends(require_permission("plan:write"))]


@router.post("/plans", response_model=ApiResponse[PlanDetailOut], status_code=201)
async def create_plan(body: PlanCreate, db: DbSession, actor: Writer):
    plan = await service.create_plan(db, org_scope(actor), body, actor=actor)
    return ApiResponse(data=PlanDetailOut.model_validate(plan))


@router.get("/plans", response_model=ApiResponse[list[PlanOut]])
async def list_plans(db: DbSession, user: Reader):
    plans = await service.list_plans(db, org_scope(user))
    return ApiResponse(data=[PlanOut.model_validate(p) for p in plans])


@router.get("/plans/{plan_id}", response_model=ApiResponse[PlanDetailOut])
async def get_plan(plan_id: uuid.UUID, db: DbSession, user: Reader):
    plan = await service.get_plan(db, plan_id)
    return ApiResponse(data=PlanDetailOut.model_validate(plan))


@router.patch("/plans/{plan_id}", response_model=ApiResponse[PlanDetailOut])
async def update_plan(plan_id: uuid.UUID, body: PlanUpdate, db: DbSession, actor: Writer):
    plan = await service.update_plan(db, plan_id, body, actor=actor)
    return ApiResponse(data=PlanDetailOut.model_validate(plan))


@router.post("/plans/{plan_id}/what-if", response_model=ApiResponse[list[PlanWeekOut]])
async def what_if(plan_id: uuid.UUID, body: WhatIfRequest, db: DbSession, user: Reader):
    return ApiResponse(data=await service.what_if(db, plan_id, body.overrides))


# --------------------------------------------------------- erlang calculators


@router.post("/erlang/requirements", response_model=ApiResponse[ErlangRequirementResponse])
async def erlang_requirements(body: ErlangRequirementRequest, user: Reader):
    result = erlang.required_agents(**body.model_dump())
    return ApiResponse(data=ErlangRequirementResponse(**asdict(result)))


@router.post("/erlang/service-level", response_model=ApiResponse[ErlangServiceLevelResponse])
async def erlang_service_level(body: ErlangServiceLevelRequest, user: Reader):
    intensity = body.volume * body.aht_seconds / body.interval_seconds
    return ApiResponse(
        data=ErlangServiceLevelResponse(
            service_level=round(
                erlang.service_level(
                    body.agents, intensity, body.aht_seconds, body.sla_threshold_seconds
                ), 4,
            ),
            asa_seconds=round(
                min(erlang.average_speed_of_answer(body.agents, intensity, body.aht_seconds),
                    99999), 1,
            ),
            occupancy=round(erlang.occupancy(body.agents, intensity), 4),
            abandonment=round(
                erlang.erlang_a_abandonment(
                    body.agents, intensity, body.aht_seconds, body.patience_seconds
                ), 4,
            ),
            wait_probability=round(
                erlang.erlang_c_wait_probability(body.agents, intensity), 4
            ),
        )
    )


@router.post("/erlang/staffing-curve", response_model=ApiResponse[list[dict]])
async def erlang_staffing_curve(body: ErlangServiceLevelRequest, user: Reader):
    return ApiResponse(
        data=erlang.staffing_curve(
            volume=body.volume,
            aht_seconds=body.aht_seconds,
            interval_seconds=body.interval_seconds,
            sla_threshold_seconds=body.sla_threshold_seconds,
            patience_seconds=body.patience_seconds,
        )
    )
