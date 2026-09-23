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


# Same gate as raising an approval: whoever can raise a real-time / scheduling change
# can parse the request that becomes one.
ScheduleRequester = Annotated[User, Depends(require_permission("intraday:write", "schedule:write"))]


class ParseScheduleRequestIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    # the app's "today" (the UI's anchored date); defaults to the server date
    current_date: date | None = None


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


@router.post("/parse-schedule-request")
async def parse_schedule_request(body: ParseScheduleRequestIn, db: DbSession, user: ScheduleRequester):
    return ApiResponse(
        data=await service.parse_schedule_request(db, org_scope(user), body.message, body.current_date)
    )
