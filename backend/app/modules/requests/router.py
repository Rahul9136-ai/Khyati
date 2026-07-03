"""Change request endpoints: /requests."""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.api.deps import DbSession, require_permission
from app.modules.identity.models import User
from app.modules.requests import service
from app.modules.requests.schemas import (
    CommentIn,
    CommentOut,
    DecisionIn,
    RequestCreate,
    RequestDetailOut,
    RequestOut,
)
from app.modules.workforce.service import org_scope
from app.schemas.common import ApiResponse, Page

router = APIRouter(prefix="/requests", tags=["change requests"])

Reader = Annotated[User, Depends(require_permission("request:read"))]
Creator = Annotated[User, Depends(require_permission("request:create"))]
ManagerApprover = Annotated[User, Depends(require_permission("request:approve_manager"))]
WfmApprover = Annotated[User, Depends(require_permission("request:approve_wfm"))]


@router.post("", response_model=ApiResponse[RequestOut], status_code=201)
async def create_request(body: RequestCreate, db: DbSession, actor: Creator):
    request = await service.create_request(db, org_scope(actor), body, actor=actor)
    return ApiResponse(data=RequestOut.model_validate(request))


@router.get("", response_model=ApiResponse[Page[RequestOut]])
async def list_requests(
    db: DbSession,
    user: Reader,
    status: str | None = None,
    category: str | None = None,
    employee_id: uuid.UUID | None = None,
    overdue_only: bool = False,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
):
    rows, total = await service.list_requests(
        db, org_scope(user), status=status, category=category, employee_id=employee_id,
        overdue_only=overdue_only, offset=(page - 1) * size, limit=size,
    )
    return ApiResponse(
        data=Page(items=[RequestOut.model_validate(r) for r in rows],
                  total=total, page=page, size=size)
    )


@router.get("/{request_id}", response_model=ApiResponse[RequestDetailOut])
async def get_request(request_id: uuid.UUID, db: DbSession, user: Reader):
    request = await service.get_request(db, request_id)
    return ApiResponse(data=RequestDetailOut.model_validate(request))


@router.post("/{request_id}/manager-decision", response_model=ApiResponse[RequestOut])
async def manager_decision(
    request_id: uuid.UUID, body: DecisionIn, db: DbSession, actor: ManagerApprover
):
    request = await service.decide(db, request_id, "manager", body, actor=actor)
    return ApiResponse(data=RequestOut.model_validate(request))


@router.post("/{request_id}/wfm-decision", response_model=ApiResponse[RequestOut])
async def wfm_decision(
    request_id: uuid.UUID, body: DecisionIn, db: DbSession, actor: WfmApprover
):
    request = await service.decide(db, request_id, "wfm", body, actor=actor)
    return ApiResponse(data=RequestOut.model_validate(request))


@router.post("/{request_id}/cancel", response_model=ApiResponse[RequestOut])
async def cancel_request(request_id: uuid.UUID, db: DbSession, actor: Creator):
    request = await service.cancel_request(db, request_id, actor=actor)
    return ApiResponse(data=RequestOut.model_validate(request))


@router.post("/{request_id}/comments", response_model=ApiResponse[CommentOut],
             status_code=201)
async def add_comment(
    request_id: uuid.UUID, body: CommentIn, db: DbSession, actor: Reader
):
    comment = await service.add_comment(db, request_id, body, actor=actor)
    return ApiResponse(data=CommentOut.model_validate(comment))
