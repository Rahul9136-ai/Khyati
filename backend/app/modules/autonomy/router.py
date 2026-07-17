"""Autonomous agent endpoints: /autonomy/*."""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.api.deps import DbSession, require_permission
from app.modules.autonomy import service
from app.modules.autonomy.schemas import (
    ActionOut,
    DecisionRequest,
    PolicyOut,
    PolicyUpdate,
    RunRequest,
    RunResult,
)
from app.modules.identity.models import User
from app.modules.workforce.service import org_scope
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/autonomy", tags=["autonomy"])

Reader = Annotated[User, Depends(require_permission("agent:read"))]
Manager = Annotated[User, Depends(require_permission("agent:manage"))]


@router.get("/agents")
async def list_agents(db: DbSession, user: Reader) -> ApiResponse[list]:
    policy = await service.get_or_create_policy(db, org_scope(user))
    return ApiResponse(data=service.list_agents(policy))


@router.get("/policy")
async def get_policy(db: DbSession, user: Reader) -> ApiResponse[PolicyOut]:
    policy = await service.get_or_create_policy(db, org_scope(user))
    return ApiResponse(
        data=PolicyOut(
            autonomy_level=policy.autonomy_level,  # type: ignore[arg-type]
            auto_apply_threshold=policy.auto_apply_threshold,
            agents=service.list_agents(policy),
        )
    )


@router.put("/policy")
async def update_policy(body: PolicyUpdate, db: DbSession, user: Manager) -> ApiResponse[PolicyOut]:
    policy = await service.update_policy(db, org_scope(user), user, body)
    return ApiResponse(
        data=PolicyOut(
            autonomy_level=policy.autonomy_level,  # type: ignore[arg-type]
            auto_apply_threshold=policy.auto_apply_threshold,
            agents=service.list_agents(policy),
        )
    )


@router.post("/run")
async def run(body: RunRequest, db: DbSession, user: Manager) -> ApiResponse[RunResult]:
    result = await service.run_orchestrator(
        db, org_scope(user), user, dry_run=body.dry_run, only=body.agents
    )
    return ApiResponse(
        data=RunResult(
            run_id=result["run_id"],
            dry_run=result["dry_run"],
            autonomy_level=result["autonomy_level"],
            auto_apply_threshold=result["auto_apply_threshold"],
            proposed=result["proposed"],
            auto_applied=result["auto_applied"],
            pending_review=result["pending_review"],
            actions=[ActionOut.model_validate(a) for a in result["actions"]],
        )
    )


@router.get("/actions")
async def list_actions(
    db: DbSession, user: Reader,
    status: str | None = Query(None),
    agent: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
) -> ApiResponse[list[ActionOut]]:
    actions = await service.list_actions(
        db, org_scope(user), status=status, agent=agent, limit=limit
    )
    return ApiResponse(data=[ActionOut.model_validate(a) for a in actions])


@router.post("/actions/{action_id}/approve")
async def approve(
    action_id: uuid.UUID, body: DecisionRequest, db: DbSession, user: Manager
) -> ApiResponse[ActionOut]:
    action = await service.approve_action(db, org_scope(user), user, action_id, body.note)
    return ApiResponse(data=ActionOut.model_validate(action))


@router.post("/actions/{action_id}/reject")
async def reject(
    action_id: uuid.UUID, body: DecisionRequest, db: DbSession, user: Manager
) -> ApiResponse[ActionOut]:
    action = await service.reject_action(db, org_scope(user), user, action_id, body.note)
    return ApiResponse(data=ActionOut.model_validate(action))
