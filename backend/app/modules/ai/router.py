"""AI assistant endpoints: /ai/*."""
from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from app.api.deps import DbSession, require_permission
from app.modules.ai import service
from app.modules.identity.models import User
from app.modules.workforce.service import org_scope
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/ai", tags=["ai"])

AiUser = Annotated[User, Depends(require_permission("ai:use"))]


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    queue_id: uuid.UUID | None = None


@router.get("/staffing-recommendation")
async def staffing_recommendation(
    db: DbSession, user: AiUser,
    forecast_id: uuid.UUID = Query(...), day: date = Query(...),
):
    return ApiResponse(data=await service.staffing_recommendation(db, forecast_id, day))


@router.get("/anomalies")
async def anomalies(
    db: DbSession, user: AiUser,
    queue_id: uuid.UUID = Query(...),
    start: date = Query(...), end: date = Query(...),
):
    return ApiResponse(data=await service.detect_anomalies(db, queue_id, start, end))


@router.get("/explain-forecast")
async def explain_forecast(
    db: DbSession, user: AiUser, forecast_id: uuid.UUID = Query(...)
):
    return ApiResponse(data=await service.explain_forecast(db, forecast_id))


@router.post("/chat")
async def chat(body: ChatIn, db: DbSession, user: AiUser):
    return ApiResponse(
        data=await service.chat(db, org_scope(user), body.message, body.queue_id)
    )
