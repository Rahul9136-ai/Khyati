"""Forecasting services: series ingestion, forecast runs, approval workflow."""
from __future__ import annotations

import csv
import io
import uuid
from dataclasses import asdict
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.forecasting import engine
from app.modules.forecasting.models import (
    Forecast,
    ForecastPoint,
    HistoricalPoint,
    HistoricalSeries,
)
from app.modules.forecasting.schemas import ForecastRequest, PointIn, SeriesUpload
from app.modules.identity.models import User
from app.modules.identity.service import record_audit
from app.modules.workforce.models import HolidayCalendar


async def create_series(
    db: AsyncSession, org_id: uuid.UUID, payload: SeriesUpload, *, actor: User,
    source: str = "upload",
) -> HistoricalSeries:
    cleaned, report = engine.clean_series(
        [engine.SeriesPoint(p.day, p.volume, p.aht) for p in payload.points]
    )
    series = HistoricalSeries(
        organization_id=org_id,
        queue_id=payload.queue_id,
        name=payload.name,
        source=source,
        created_by=actor.id,
        cleaning_report=asdict(report),
        points=[HistoricalPoint(day=p.day, volume=p.volume, aht=p.aht) for p in cleaned],
    )
    db.add(series)
    await db.flush()
    await record_audit(
        db, actor=actor, action="series.upload", entity_type="historical_series",
        entity_id=series.id,
        after={"name": payload.name, "points": len(cleaned), **asdict(report)},
    )
    return series


def parse_csv_upload(name: str, content: bytes) -> SeriesUpload:
    """CSV columns: date,volume[,aht] — header row optional."""
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValidationError("File must be UTF-8 encoded CSV") from exc
    points: list[PointIn] = []
    for row in csv.reader(io.StringIO(text)):
        if not row or not row[0].strip():
            continue
        first = row[0].strip().lower()
        if first in ("date", "day"):  # header
            continue
        try:
            points.append(
                PointIn(
                    day=first,  # pydantic parses ISO dates
                    volume=float(row[1]),
                    aht=float(row[2]) if len(row) > 2 and row[2].strip() else None,
                )
            )
        except (ValueError, IndexError) as exc:
            raise ValidationError(f"Bad CSV row: {row}") from exc
    if len(points) < 7:
        raise ValidationError("CSV must contain at least 7 daily rows (date,volume[,aht])")
    return SeriesUpload(name=name, points=points)


async def list_series(db: AsyncSession, org_id: uuid.UUID) -> list[HistoricalSeries]:
    rows = await db.execute(
        select(HistoricalSeries)
        .where(HistoricalSeries.organization_id == org_id)
        .order_by(HistoricalSeries.created_at.desc())
    )
    return list(rows.scalars())


async def get_series_points(db: AsyncSession, series_id: uuid.UUID) -> list[HistoricalPoint]:
    series = await db.get(
        HistoricalSeries, series_id, options=[selectinload(HistoricalSeries.points)]
    )
    if series is None:
        raise NotFoundError("Series not found")
    return series.points


async def _holiday_days(db: AsyncSession, calendar_id: uuid.UUID | None) -> set:
    if calendar_id is None:
        return set()
    cal = await db.get(HolidayCalendar, calendar_id)
    if cal is None:
        raise NotFoundError("Holiday calendar not found")
    return {h.day for h in cal.holidays}


async def run_forecast(
    db: AsyncSession, org_id: uuid.UUID, payload: ForecastRequest, *, actor: User
) -> Forecast:
    series = await db.get(
        HistoricalSeries, payload.series_id, options=[selectinload(HistoricalSeries.points)]
    )
    if series is None or series.organization_id != org_id:
        raise NotFoundError("Series not found")

    version, parent = 1, None
    if payload.parent_id:
        parent = await db.get(Forecast, payload.parent_id)
        if parent is None:
            raise NotFoundError("Parent forecast not found")
        version = parent.version + 1

    result = engine.generate_forecast(
        [engine.SeriesPoint(p.day, p.volume, p.aht) for p in series.points],
        horizon=payload.horizon_days,
        model=payload.model,
        holiday_days=await _holiday_days(db, payload.holiday_calendar_id),
    )
    forecast = Forecast(
        organization_id=org_id,
        queue_id=series.queue_id,
        series_id=series.id,
        parent_id=payload.parent_id,
        name=payload.name or f"{series.name} +{payload.horizon_days}d",
        model=result.model,
        horizon_days=payload.horizon_days,
        version=version,
        mape=result.mape,
        backtest=result.backtest,
        params={"requested_model": payload.model},
        created_by=actor.id,
        points=[
            ForecastPoint(day=d, volume=v, lower=lo, upper=up, aht=a)
            for d, v, lo, up, a in zip(
                result.days, result.volumes, result.lower, result.upper, result.ahts
            )
        ],
    )
    db.add(forecast)
    await db.flush()
    await record_audit(
        db, actor=actor, action="forecast.create", entity_type="forecast",
        entity_id=forecast.id,
        after={"model": result.model, "mape": result.mape, "version": version},
    )
    return forecast


async def list_forecasts(
    db: AsyncSession, org_id: uuid.UUID, status: str | None = None
) -> list[Forecast]:
    query = select(Forecast).where(Forecast.organization_id == org_id)
    if status:
        query = query.where(Forecast.status == status)
    rows = await db.execute(query.order_by(Forecast.created_at.desc()))
    return list(rows.scalars())


async def get_forecast(db: AsyncSession, forecast_id: uuid.UUID) -> Forecast:
    forecast = await db.get(Forecast, forecast_id, options=[selectinload(Forecast.points)])
    if forecast is None:
        raise NotFoundError("Forecast not found")
    return forecast


_TRANSITIONS = {
    "submit": ("draft", "pending_approval"),
    "approve": ("pending_approval", "approved"),
    "reject": ("pending_approval", "rejected"),
}


async def transition_forecast(
    db: AsyncSession, forecast_id: uuid.UUID, action: str, *, actor: User,
    reason: str | None = None,
) -> Forecast:
    forecast = await get_forecast(db, forecast_id)
    expected, target = _TRANSITIONS[action]
    if forecast.status != expected:
        raise ValidationError(
            f"Cannot {action} a forecast in status '{forecast.status}' (needs '{expected}')"
        )
    forecast.status = target
    now = datetime.now(UTC)
    if action == "submit":
        forecast.submitted_at = now
    else:
        forecast.approved_by = actor.id
        forecast.approved_at = now
        if action == "reject":
            forecast.rejection_reason = reason
    await record_audit(
        db, actor=actor, action=f"forecast.{action}", entity_type="forecast",
        entity_id=forecast.id, note=reason,
    )
    return forecast


def forecast_to_csv(forecast: Forecast) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["date", "volume", "lower", "upper", "aht"])
    for p in forecast.points:
        writer.writerow([p.day.isoformat(), p.volume, p.lower, p.upper, p.aht])
    return buf.getvalue()
