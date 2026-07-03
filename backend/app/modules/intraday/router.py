"""Intraday endpoints: /intraday/actuals, /intraday/status."""
from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.api.deps import DbSession, require_permission
from app.modules.identity.models import User
from app.modules.intraday import service
from app.modules.intraday.schemas import (
    ActualOut,
    BulkActualsIn,
    IntradayStatus,
)
from app.modules.workforce.service import org_scope
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/intraday", tags=["intraday"])

Reader = Annotated[User, Depends(require_permission("intraday:read"))]
Writer = Annotated[User, Depends(require_permission("intraday:write"))]


@router.post("/actuals", response_model=ApiResponse[list[ActualOut]], status_code=201)
async def post_actuals(body: BulkActualsIn, db: DbSession, actor: Writer):
    rows = await service.upsert_actuals(db, org_scope(actor), body.actuals)
    return ApiResponse(data=[ActualOut.model_validate(r) for r in rows])


@router.get("/actuals", response_model=ApiResponse[list[ActualOut]])
async def list_actuals(
    db: DbSession, user: Reader, queue_id: uuid.UUID = Query(...), day: date = Query(...)
):
    rows = await service.list_actuals(db, queue_id, day)
    return ApiResponse(data=[ActualOut.model_validate(r) for r in rows])


@router.get("/status", response_model=ApiResponse[IntradayStatus])
async def day_status(
    db: DbSession, user: Reader, queue_id: uuid.UUID = Query(...), day: date = Query(...)
):
    return ApiResponse(data=await service.day_status(db, org_scope(user), queue_id, day))
