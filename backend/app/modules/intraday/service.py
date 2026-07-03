"""Intraday services: actuals ingestion + real-time status vs forecast.

The status endpoint aligns the day's approved forecast (split into intervals
by the arrival profile) against posted interval actuals, computes deviation,
produces an intraday reforecast (remaining forecast scaled by the observed
volume ratio) and rule-based recommendations for the RTA.
"""
from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.modules.forecasting.engine import distribute_to_intervals
from app.modules.forecasting.models import Forecast, ForecastPoint
from app.modules.intraday.models import IntervalActual
from app.modules.intraday.schemas import ActualIn, IntervalStatus, IntradayStatus
from app.modules.planning.erlang import required_agents
from app.modules.workforce.models import Queue


def _key(dt: datetime) -> datetime:
    """Normalize to naive UTC — SQLite returns naive datetimes, Postgres aware."""
    if dt.tzinfo is not None:
        return dt.astimezone(UTC).replace(tzinfo=None)
    return dt


async def upsert_actuals(
    db: AsyncSession, org_id: uuid.UUID, actuals: list[ActualIn]
) -> list[IntervalActual]:
    out = []
    for item in actuals:
        existing = (
            await db.execute(
                select(IntervalActual).where(
                    IntervalActual.queue_id == item.queue_id,
                    IntervalActual.ts == item.ts,
                )
            )
        ).scalar_one_or_none()
        if existing:
            for key, value in item.model_dump(exclude={"queue_id", "ts"}).items():
                setattr(existing, key, value)
            out.append(existing)
        else:
            row = IntervalActual(organization_id=org_id, **item.model_dump())
            db.add(row)
            out.append(row)
    await db.flush()
    return out


async def list_actuals(
    db: AsyncSession, queue_id: uuid.UUID, day: date
) -> list[IntervalActual]:
    start = datetime.combine(day, time.min, tzinfo=UTC)
    end = start + timedelta(days=1)
    rows = await db.execute(
        select(IntervalActual)
        .where(
            IntervalActual.queue_id == queue_id,
            IntervalActual.ts >= start,
            IntervalActual.ts < end,
        )
        .order_by(IntervalActual.ts)
    )
    return list(rows.scalars())


async def _forecast_for_day(
    db: AsyncSession, queue_id: uuid.UUID, day: date
) -> tuple[Forecast | None, float]:
    """Latest approved forecast covering the day (falls back to any status)."""
    for status_filter in ("approved", None):
        query = (
            select(Forecast, ForecastPoint)
            .join(ForecastPoint, ForecastPoint.forecast_id == Forecast.id)
            .where(Forecast.queue_id == queue_id, ForecastPoint.day == day)
            .order_by(Forecast.created_at.desc())
        )
        if status_filter:
            query = query.where(Forecast.status == status_filter)
        row = (await db.execute(query.limit(1))).first()
        if row:
            return row[0], row[1].volume
    return None, 0.0


def _recommendations(
    deviation_pct: float | None, sl: float | None, sla_target: float, occ: float | None
) -> list[str]:
    recs: list[str] = []
    if deviation_pct is not None and deviation_pct > 10:
        recs.append(
            f"Volume is running {deviation_pct:.0f}% above forecast — consider OT, "
            "postponing offline work, or pulling agents from back-office queues."
        )
    if deviation_pct is not None and deviation_pct < -10:
        recs.append(
            f"Volume is {abs(deviation_pct):.0f}% below forecast — good window for "
            "VTO, training, coaching or one-on-ones."
        )
    if sl is not None and sl < sla_target:
        recs.append(
            f"Service level {sl:.0%} is below the {sla_target:.0%} target — "
            "prioritise availability and defer non-productive activities."
        )
    if occ is not None and occ > 0.92:
        recs.append(
            f"Occupancy {occ:.0%} exceeds burnout threshold (92%) — add staff or "
            "rotate breaks to protect agents."
        )
    if not recs:
        recs.append("Queue is tracking to plan — no action needed.")
    return recs


async def day_status(
    db: AsyncSession, org_id: uuid.UUID, queue_id: uuid.UUID, day: date
) -> IntradayStatus:
    queue = await db.get(Queue, queue_id)
    if queue is None or queue.organization_id != org_id:
        raise NotFoundError("Queue not found")

    forecast, day_volume = await _forecast_for_day(db, queue_id, day)
    interval_minutes = queue.interval_minutes
    slots = distribute_to_intervals(day_volume, interval_minutes) if day_volume else []
    actuals = {_key(a.ts): a for a in await list_actuals(db, queue_id, day)}

    intervals: list[IntervalStatus] = []
    actual_sum = forecast_sum_so_far = 0.0
    sl_num = sl_den = 0.0
    day_start = datetime.combine(day, time.min, tzinfo=UTC)
    for i, fv in enumerate(slots):
        ts = day_start + timedelta(minutes=i * interval_minutes)
        actual = actuals.get(_key(ts))
        deviation = None
        if actual is not None:
            actual_sum += actual.offered
            forecast_sum_so_far += fv
            if fv > 0:
                deviation = round((actual.offered - fv) / fv * 100, 1)
            if actual.service_level is not None and actual.offered > 0:
                sl_num += actual.service_level * actual.offered
                sl_den += actual.offered
        req = None
        if fv > 0:
            req = required_agents(
                volume=actual.offered if actual else fv,
                aht_seconds=(actual.aht_seconds if actual and actual.aht_seconds
                             else queue.default_aht_seconds),
                interval_seconds=interval_minutes * 60,
                sla_target=queue.sla_target_pct,
                sla_threshold_seconds=queue.sla_threshold_seconds,
                max_occupancy=queue.target_occupancy,
                concurrency=queue.concurrency,
            ).agents
        intervals.append(
            IntervalStatus(
                label=ts.strftime("%H:%M"),
                forecast_volume=fv,
                actual_volume=actual.offered if actual else None,
                deviation_pct=deviation,
                service_level=actual.service_level if actual else None,
                occupancy=actual.occupancy if actual else None,
                staffed=actual.staffed if actual else None,
                required_agents=req,
            )
        )

    deviation_pct = (
        round((actual_sum - forecast_sum_so_far) / forecast_sum_so_far * 100, 1)
        if forecast_sum_so_far > 0
        else None
    )
    reforecast = None
    if forecast_sum_so_far > 0 and day_volume:
        ratio = actual_sum / forecast_sum_so_far
        remaining = day_volume - forecast_sum_so_far
        reforecast = round(actual_sum + remaining * ratio, 1)
    sl_attained = round(sl_num / sl_den, 4) if sl_den else None
    occs = [a.occupancy for a in actuals.values() if a.occupancy is not None]
    avg_occ = sum(occs) / len(occs) if occs else None

    return IntradayStatus(
        queue_id=queue_id,
        day=day,
        forecast_id=forecast.id if forecast else None,
        forecast_total=round(day_volume, 1),
        actual_so_far=round(actual_sum, 1),
        forecast_so_far=round(forecast_sum_so_far, 1),
        deviation_pct=deviation_pct,
        reforecast_total=reforecast,
        sl_attained=sl_attained,
        intervals=intervals,
        recommendations=_recommendations(
            deviation_pct, sl_attained, queue.sla_target_pct, avg_occ
        ),
    )
