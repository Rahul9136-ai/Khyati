"""Forecasting endpoints: /forecasting/series, /forecasting/forecasts."""
from __future__ import annotations

import csv
import io
import uuid
from datetime import UTC, date, datetime, time
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import PlainTextResponse

from app.api.deps import DbSession, require_permission
from app.core.exceptions import NotFoundError
from app.modules.forecasting import service
from app.modules.forecasting.engine import distribute_to_intervals
from app.modules.forecasting.schemas import (
    ForecastDetailOut,
    ForecastOut,
    ForecastRequest,
    IntervalBreakdown,
    PointOut,
    RejectRequest,
    SeriesOut,
    SeriesUpload,
)
from app.modules.identity.models import User
from app.modules.workforce.service import org_scope
from app.modules.workspace import service as workspace_service
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/forecasting", tags=["forecasting"])

Reader = Annotated[User, Depends(require_permission("forecast:read"))]
Writer = Annotated[User, Depends(require_permission("forecast:write"))]
Approver = Annotated[User, Depends(require_permission("forecast:approve"))]


# ---------------------------------------------------------------- published

#: Columns of the flat feed, in order (one row per queue per day).
PUBLISHED_COLUMNS = [
    "queue_id", "queue", "date", "volume", "aht_sec", "required_hours", "required_fte",
    "scheduled_hours", "over_under_hours", "service_level", "occupancy", "model", "mape",
    "published_at", "published_by",
]


def _published_rows(value: object, queue: str | None, start: date | None, end: date | None) -> list[dict]:
    rows: list[dict] = []
    if not isinstance(value, dict):
        return rows
    for p in value.values():
        if not isinstance(p, dict):
            continue
        if queue and queue not in (p.get("queueId"), p.get("queueName")):
            continue
        published_at = p.get("publishedAt")
        stamp = (
            datetime.fromtimestamp(published_at / 1000, UTC).isoformat()
            if isinstance(published_at, (int, float))
            else ""
        )
        for d in p.get("days") or []:
            day = str(d.get("date", ""))
            if start and day < start.isoformat():
                continue
            if end and day > end.isoformat():
                continue
            rows.append({
                "queue_id": p.get("queueId"),
                "queue": p.get("queueName"),
                "date": day,
                "volume": d.get("volume"),
                "aht_sec": d.get("aht"),
                "required_hours": d.get("required"),
                "required_fte": d.get("fte"),
                "scheduled_hours": d.get("scheduled"),
                "over_under_hours": d.get("variance"),
                "service_level": d.get("projSL"),
                "occupancy": d.get("occupancy"),
                "model": p.get("methodName"),
                "mape": p.get("mape"),
                "published_at": stamp,
                "published_by": p.get("publishedBy"),
            })
    rows.sort(key=lambda r: (str(r["queue_id"]), r["date"]))
    return rows


@router.get("/published")
async def published_forecast(
    db: DbSession,
    user: Reader,
    queue: Annotated[str | None, Query(description="Queue id or name; all queues if omitted")] = None,
    start: Annotated[date | None, Query(description="First day to include")] = None,
    end: Annotated[date | None, Query(description="Last day to include")] = None,
    format: Annotated[str, Query(pattern="^(json|csv)$")] = "json",  # noqa: A002 - query name
):
    """The forecast published from the Forecasting page, one row per queue per day with
    every target. Point Power BI / Tableau / Looker / Grafana / Excel at it with an API key
    (scope `forecast:read`); `format=csv` returns a plain CSV."""
    try:
        row = await workspace_service.get(db, org_scope(user), "publishedForecasts")
        value, version = row.value, row.version
    except NotFoundError:
        value, version = {}, 0
    rows = _published_rows(value, queue, start, end)
    if format == "csv":
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=PUBLISHED_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
        return PlainTextResponse(buf.getvalue(), media_type="text/csv")
    return ApiResponse(data={"version": version, "columns": PUBLISHED_COLUMNS, "rows": rows})


# ------------------------------------------------------------------- series

@router.post("/series", response_model=ApiResponse[SeriesOut], status_code=201)
async def upload_series(body: SeriesUpload, db: DbSession, actor: Writer):
    series = await service.create_series(db, org_scope(actor), body, actor=actor)
    return ApiResponse(data=SeriesOut.model_validate(series))


@router.post("/series/upload-csv", response_model=ApiResponse[SeriesOut], status_code=201)
async def upload_series_csv(
    db: DbSession,
    actor: Writer,
    file: Annotated[UploadFile, File()],
    name: Annotated[str, Form()] = "Uploaded series",
    queue_id: Annotated[uuid.UUID | None, Form()] = None,
):
    payload = service.parse_csv_upload(name, await file.read())
    payload.queue_id = queue_id
    series = await service.create_series(db, org_scope(actor), payload, actor=actor)
    return ApiResponse(data=SeriesOut.model_validate(series))


@router.get("/series", response_model=ApiResponse[list[SeriesOut]])
async def list_series(db: DbSession, user: Reader):
    rows = await service.list_series(db, org_scope(user))
    return ApiResponse(data=[SeriesOut.model_validate(s) for s in rows])


@router.get("/series/{series_id}/points", response_model=ApiResponse[list[PointOut]])
async def series_points(series_id: uuid.UUID, db: DbSession, user: Reader):
    points = await service.get_series_points(db, series_id)
    return ApiResponse(data=[PointOut.model_validate(p) for p in points])


# ---------------------------------------------------------------- forecasts

@router.post("/forecasts", response_model=ApiResponse[ForecastDetailOut], status_code=201)
async def run_forecast(body: ForecastRequest, db: DbSession, actor: Writer):
    forecast = await service.run_forecast(db, org_scope(actor), body, actor=actor)
    return ApiResponse(data=ForecastDetailOut.model_validate(forecast))


@router.get("/forecasts", response_model=ApiResponse[list[ForecastOut]])
async def list_forecasts(db: DbSession, user: Reader, status: str | None = None):
    rows = await service.list_forecasts(db, org_scope(user), status)
    return ApiResponse(data=[ForecastOut.model_validate(f) for f in rows])


@router.get("/forecasts/{forecast_id}", response_model=ApiResponse[ForecastDetailOut])
async def get_forecast(forecast_id: uuid.UUID, db: DbSession, user: Reader):
    forecast = await service.get_forecast(db, forecast_id)
    return ApiResponse(data=ForecastDetailOut.model_validate(forecast))


@router.post("/forecasts/{forecast_id}/submit", response_model=ApiResponse[ForecastOut])
async def submit_forecast(forecast_id: uuid.UUID, db: DbSession, actor: Writer):
    forecast = await service.transition_forecast(db, forecast_id, "submit", actor=actor)
    return ApiResponse(data=ForecastOut.model_validate(forecast))


@router.post("/forecasts/{forecast_id}/approve", response_model=ApiResponse[ForecastOut])
async def approve_forecast(forecast_id: uuid.UUID, db: DbSession, actor: Approver):
    forecast = await service.transition_forecast(db, forecast_id, "approve", actor=actor)
    return ApiResponse(data=ForecastOut.model_validate(forecast))


@router.post("/forecasts/{forecast_id}/reject", response_model=ApiResponse[ForecastOut])
async def reject_forecast(
    forecast_id: uuid.UUID, body: RejectRequest, db: DbSession, actor: Approver
):
    forecast = await service.transition_forecast(
        db, forecast_id, "reject", actor=actor, reason=body.reason
    )
    return ApiResponse(data=ForecastOut.model_validate(forecast))


@router.get("/forecasts/{forecast_id}/export", response_class=PlainTextResponse)
async def export_forecast(forecast_id: uuid.UUID, db: DbSession, user: Reader):
    forecast = await service.get_forecast(db, forecast_id)
    return PlainTextResponse(
        service.forecast_to_csv(forecast),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="forecast-{forecast_id}.csv"'},
    )


@router.get(
    "/forecasts/{forecast_id}/intervals", response_model=ApiResponse[IntervalBreakdown]
)
async def forecast_intervals(
    forecast_id: uuid.UUID,
    db: DbSession,
    user: Reader,
    day: date = Query(...),
    interval_minutes: int = Query(30, ge=15, le=60),
):
    """Split one forecast day into 15/30/60-minute interval volumes."""
    forecast = await service.get_forecast(db, forecast_id)
    point = next((p for p in forecast.points if p.day == day), None)
    if point is None:
        from app.core.exceptions import NotFoundError

        raise NotFoundError(f"Forecast has no point for {day}")
    volumes = distribute_to_intervals(point.volume, interval_minutes)
    labels = [
        (
            (time(hour=0, minute=0).replace(hour=(i * interval_minutes) // 60,
                                            minute=(i * interval_minutes) % 60)).strftime("%H:%M")
        )
        for i in range(len(volumes))
    ]
    return ApiResponse(
        data=IntervalBreakdown(
            day=day, interval_minutes=interval_minutes, labels=labels, volumes=volumes
        )
    )
