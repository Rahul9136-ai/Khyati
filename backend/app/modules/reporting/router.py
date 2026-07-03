"""Reporting endpoints: /reports/*  (add ?format=csv to any row-based report)."""
from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.responses import PlainTextResponse

from app.api.deps import DbSession, require_permission
from app.modules.attendance.service import summarize as attendance_summarize
from app.modules.identity.models import User
from app.modules.reporting import service
from app.modules.workforce.service import org_scope
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/reports", tags=["reports"])

Reader = Annotated[User, Depends(require_permission("report:read"))]
Exporter = Annotated[User, Depends(require_permission("report:export"))]


def _respond(result: dict, fmt: str):
    if fmt == "csv":
        return PlainTextResponse(
            service.rows_to_csv(result.get("rows", [])),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="report.csv"'},
        )
    return ApiResponse(data=result)


@router.get("/dashboard")
async def dashboard(db: DbSession, user: Reader):
    return ApiResponse(data=await service.dashboard(db, org_scope(user)))


@router.get("/forecast-accuracy")
async def forecast_accuracy(
    db: DbSession, user: Reader, forecast_id: uuid.UUID = Query(...),
    format: str = Query("json", pattern="^(json|csv)$"),
):
    return _respond(await service.forecast_accuracy(db, forecast_id), format)


@router.get("/adherence")
async def adherence(
    db: DbSession, user: Reader,
    start: date = Query(...), end: date = Query(...),
    team_id: uuid.UUID | None = None,
    format: str = Query("json", pattern="^(json|csv)$"),
):
    return _respond(await service.adherence(db, org_scope(user), start, end, team_id), format)


@router.get("/shrinkage")
async def shrinkage(
    db: DbSession, user: Reader, start: date = Query(...), end: date = Query(...)
):
    summary = await attendance_summarize(db, org_scope(user), start, end)
    return ApiResponse(data=summary)


@router.get("/sla")
async def sla(
    db: DbSession, user: Reader,
    queue_id: uuid.UUID = Query(...),
    start: date = Query(...), end: date = Query(...),
    format: str = Query("json", pattern="^(json|csv)$"),
):
    return _respond(await service.sla_report(db, queue_id, start, end), format)


@router.get("/agent-performance")
async def agent_performance(
    db: DbSession, user: Reader,
    start: date = Query(...), end: date = Query(...),
    format: str = Query("json", pattern="^(json|csv)$"),
):
    return _respond(await service.agent_performance(db, org_scope(user), start, end), format)
