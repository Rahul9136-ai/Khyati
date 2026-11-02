"""Reporting services: cross-module aggregations (read-only).

Every report returns a list of plain dict rows plus headline metrics, so the
router can serve JSON or stream CSV from the same result.
"""
from __future__ import annotations

import csv
import io
import uuid
from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.attendance.models import AttendanceRecord
from app.modules.attendance.service import summarize as attendance_summary
from app.modules.forecasting.models import Forecast, ForecastPoint
from app.modules.identity.models import User
from app.modules.intraday.models import IntervalActual
from app.modules.planning.models import CapacityPlan, CapacityPlanWeek
from app.modules.requests.models import ChangeRequest
from app.modules.scheduling.models import Schedule, ScheduleShift
from app.modules.workforce.models import Employee, Lob, Queue, Team

MAX_REPORT_DAYS = 190


def rows_to_csv(rows: list[dict]) -> str:
    if not rows:
        return ""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue()


async def _daily_actuals(
    db: AsyncSession, queue_id: uuid.UUID, start: date, end: date
) -> dict[date, dict]:
    """Aggregate interval actuals to daily volume / weighted SL / occupancy."""
    start_ts = datetime.combine(start, time.min, tzinfo=UTC)
    end_ts = datetime.combine(end + timedelta(days=1), time.min, tzinfo=UTC)
    rows = await db.execute(
        select(IntervalActual).where(
            IntervalActual.queue_id == queue_id,
            IntervalActual.ts >= start_ts,
            IntervalActual.ts < end_ts,
        )
    )
    out: dict[date, dict] = {}
    for actual in rows.scalars():
        day = actual.ts.date()
        agg = out.setdefault(day, {"volume": 0.0, "sl_num": 0.0, "sl_den": 0.0,
                                   "occ_sum": 0.0, "occ_n": 0})
        agg["volume"] += actual.offered
        if actual.service_level is not None and actual.offered > 0:
            agg["sl_num"] += actual.service_level * actual.offered
            agg["sl_den"] += actual.offered
        if actual.occupancy is not None:
            agg["occ_sum"] += actual.occupancy
            agg["occ_n"] += 1
    return out


async def forecast_accuracy(db: AsyncSession, forecast_id: uuid.UUID) -> dict:
    forecast = await db.get(Forecast, forecast_id)
    if forecast is None:
        raise NotFoundError("Forecast not found")
    points = list(
        (
            await db.execute(
                select(ForecastPoint)
                .where(ForecastPoint.forecast_id == forecast_id)
                .order_by(ForecastPoint.day)
            )
        ).scalars()
    )
    actuals: dict[date, dict] = {}
    if forecast.queue_id and points:
        actuals = await _daily_actuals(
            db, forecast.queue_id, points[0].day, points[-1].day
        )
    rows, ape_sum, err_sum, abs_err_sum, act_sum, n = [], 0.0, 0.0, 0.0, 0.0, 0
    for p in points:
        actual = actuals.get(p.day, {}).get("volume")
        row = {"date": p.day.isoformat(), "forecast": p.volume, "actual": actual,
               "error": None, "ape_pct": None}
        if actual and actual > 0:
            err = p.volume - actual
            row["error"] = round(err, 1)
            row["ape_pct"] = round(abs(err) / actual * 100, 2)
            ape_sum += abs(err) / actual
            err_sum += err
            abs_err_sum += abs(err)
            act_sum += actual
            n += 1
        rows.append(row)
    return {
        "forecast_id": str(forecast_id),
        "model": forecast.model,
        "days_compared": n,
        "mape_pct": round(ape_sum / n * 100, 2) if n else None,
        "wape_pct": round(abs_err_sum / act_sum * 100, 2) if act_sum else None,
        "bias": round(err_sum / n, 2) if n else None,
        "rows": rows,
    }


async def adherence(
    db: AsyncSession, org_id: uuid.UUID, start: date, end: date,
    team_id: uuid.UUID | None = None,
) -> dict:
    """Schedule adherence: attended minutes inside scheduled window / scheduled."""
    shift_query = (
        select(ScheduleShift, Schedule)
        .join(Schedule, ScheduleShift.schedule_id == Schedule.id)
        .where(
            Schedule.organization_id == org_id,
            Schedule.status == "published",
            ScheduleShift.day >= start,
            ScheduleShift.day <= end,
        )
    )
    if team_id:
        shift_query = shift_query.where(Schedule.team_id == team_id)
    shifts = [row[0] for row in (await db.execute(shift_query)).all()]

    att_rows = await db.execute(
        select(AttendanceRecord).where(
            AttendanceRecord.organization_id == org_id,
            AttendanceRecord.day >= start,
            AttendanceRecord.day <= end,
        )
    )
    attendance: dict[tuple[uuid.UUID, date], AttendanceRecord] = {}
    for record in att_rows.scalars():
        attendance.setdefault((record.employee_id, record.day), record)

    per_emp: dict[uuid.UUID, dict] = {}
    for shift in shifts:
        sched_min = (shift.end_ts - shift.start_ts).total_seconds() / 60
        att_record = attendance.get((shift.employee_id, shift.day))
        attended = 0.0
        if att_record and att_record.actual_start and att_record.actual_end:
            overlap_start = max(att_record.actual_start, shift.start_ts)
            overlap_end = min(att_record.actual_end, shift.end_ts)
            attended = max(0.0, (overlap_end - overlap_start).total_seconds() / 60)
        agg = per_emp.setdefault(
            shift.employee_id, {"scheduled_min": 0.0, "attended_min": 0.0, "shifts": 0}
        )
        agg["scheduled_min"] += sched_min
        agg["attended_min"] += attended
        agg["shifts"] += 1

    rows = [
        {
            "employee_id": str(emp_id),
            "shifts": agg["shifts"],
            "scheduled_hours": round(agg["scheduled_min"] / 60, 1),
            "attended_hours": round(agg["attended_min"] / 60, 1),
            "adherence_pct": round(agg["attended_min"] / agg["scheduled_min"] * 100, 1)
            if agg["scheduled_min"]
            else 0.0,
        }
        for emp_id, agg in per_emp.items()
    ]
    total_sched = sum(a["scheduled_min"] for a in per_emp.values())
    total_att = sum(a["attended_min"] for a in per_emp.values())
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "overall_adherence_pct": round(total_att / total_sched * 100, 1) if total_sched else None,
        "rows": sorted(rows, key=lambda r: r["adherence_pct"]),
    }


async def sla_report(
    db: AsyncSession, queue_id: uuid.UUID, start: date, end: date
) -> dict:
    daily = await _daily_actuals(db, queue_id, start, end)
    rows = []
    for day in sorted(daily):
        agg = daily[day]
        rows.append(
            {
                "date": day.isoformat(),
                "volume": round(agg["volume"], 1),
                "service_level_pct": round(agg["sl_num"] / agg["sl_den"] * 100, 1)
                if agg["sl_den"]
                else None,
                "avg_occupancy_pct": round(agg["occ_sum"] / agg["occ_n"] * 100, 1)
                if agg["occ_n"]
                else None,
            }
        )
    return {"queue_id": str(queue_id), "rows": rows}


async def agent_performance(
    db: AsyncSession, org_id: uuid.UUID, start: date, end: date
) -> dict:
    rows = await db.execute(
        select(
            AttendanceRecord.employee_id,
            func.count(AttendanceRecord.id),
            func.sum(AttendanceRecord.minutes_late),
            func.sum(AttendanceRecord.minutes_early_logout),
        )
        .where(
            AttendanceRecord.organization_id == org_id,
            AttendanceRecord.day >= start,
            AttendanceRecord.day <= end,
        )
        .group_by(AttendanceRecord.employee_id)
    )
    out = [
        {
            "employee_id": str(emp_id),
            "attendance_days": days,
            "minutes_late_total": int(late or 0),
            "minutes_early_logout_total": int(early or 0),
        }
        for emp_id, days, late, early in rows.all()
    ]
    return {"start": start.isoformat(), "end": end.isoformat(), "rows": out}


async def performance_actuals(
    db: AsyncSession, org_id: uuid.UUID, start: date, end: date
) -> dict:
    """Recorded (not forecast) performance data for the Performance reports:
    attendance per employee-day and contact-centre actuals per queue-day."""
    if end < start:
        raise ValidationError("end must be on or after start")
    if (end - start).days + 1 > MAX_REPORT_DAYS:
        raise ValidationError(f"A report can cover at most {MAX_REPORT_DAYS} days")
    lobs = {
        lob.id: lob.name
        for lob in (await db.execute(select(Lob).where(Lob.organization_id == org_id))).scalars()
    }
    team_rows = await db.execute(select(Team).where(Team.organization_id == org_id))
    teams = {t.id: t for t in team_rows.scalars()}
    records = await db.execute(
        select(AttendanceRecord, Employee)
        .join(Employee, AttendanceRecord.employee_id == Employee.id)
        .where(
            AttendanceRecord.organization_id == org_id,
            AttendanceRecord.day >= start,
            AttendanceRecord.day <= end,
        )
        .order_by(AttendanceRecord.day)
    )
    attendance = []
    for rec, emp in records.all():
        team = teams.get(emp.team_id) if emp.team_id else None
        attendance.append(
            {
                "employee_code": emp.employee_code,
                "employee_name": emp.full_name,
                "team": team.name if team else "",
                "lob": lobs.get(emp.lob_id or (team.lob_id if team else None), ""),
                "date": rec.day.isoformat(),
                "code": rec.code.name,
                "category": rec.code.category,
                "minutes_late": rec.minutes_late,
                "minutes_early_logout": rec.minutes_early_logout,
            }
        )
    start_ts = datetime.combine(start, time.min, tzinfo=UTC)
    end_ts = datetime.combine(end + timedelta(days=1), time.min, tzinfo=UTC)
    intervals = await db.execute(
        select(IntervalActual, Queue)
        .join(Queue, IntervalActual.queue_id == Queue.id)
        .where(
            IntervalActual.organization_id == org_id,
            IntervalActual.ts >= start_ts,
            IntervalActual.ts < end_ts,
        )
    )
    days: dict[tuple[uuid.UUID, date], dict] = {}
    for act, queue in intervals.all():
        agg = days.setdefault(
            (queue.id, act.ts.date()),
            {"queue": queue, "offered": 0.0, "handled": 0.0, "aht": 0.0,
             "sl": 0.0, "sl_n": 0.0, "occ": 0.0, "occ_n": 0},
        )
        agg["offered"] += act.offered
        agg["handled"] += act.handled
        agg["aht"] += act.aht_seconds * act.handled
        if act.service_level is not None and act.offered > 0:
            agg["sl"] += act.service_level * act.offered
            agg["sl_n"] += act.offered
        if act.occupancy is not None:
            agg["occ"] += act.occupancy
            agg["occ_n"] += 1
    queues = [
        {
            "lob": lobs.get(a["queue"].lob_id, ""),
            "queue": a["queue"].name,
            "channel": a["queue"].channel,
            "date": day.isoformat(),
            "offered": round(a["offered"], 1),
            "handled": round(a["handled"], 1),
            "aht_seconds": round(a["aht"] / a["handled"]) if a["handled"] else None,
            "service_level_pct": round(a["sl"] / a["sl_n"] * 100, 1) if a["sl_n"] else None,
            "sl_target_pct": round(a["queue"].sla_target_pct * 100, 1),
            "occupancy_pct": round(a["occ"] / a["occ_n"] * 100, 1) if a["occ_n"] else None,
        }
        for (_, day), a in sorted(days.items(), key=lambda kv: (kv[0][1], kv[1]["queue"].name))
    ]
    return {"start": start.isoformat(), "end": end.isoformat(),
            "attendance": attendance, "queues": queues}


async def my_attendance(db: AsyncSession, user: User, start: date, end: date) -> dict:
    """The signed-in person's own attendance: never anyone else's, by construction."""
    if end < start:
        raise ValidationError("end must be on or after start")
    if (end - start).days + 1 > MAX_REPORT_DAYS:
        raise ValidationError(f"A report can cover at most {MAX_REPORT_DAYS} days")
    rows: list[dict] = []
    emp = await db.get(Employee, user.employee_id) if user.employee_id else None
    if emp is not None:
        records = await db.execute(
            select(AttendanceRecord)
            .where(
                AttendanceRecord.employee_id == emp.id,
                AttendanceRecord.day >= start,
                AttendanceRecord.day <= end,
            )
            .order_by(AttendanceRecord.day)
        )
        rows = [
            {
                "employee_code": emp.employee_code,
                "employee_name": emp.full_name,
                "date": r.day.isoformat(),
                "code": r.code.name,
                "category": r.code.category,
                "minutes_late": r.minutes_late,
                "minutes_early_logout": r.minutes_early_logout,
            }
            for r in records.scalars()
        ]
    return {"start": start.isoformat(), "end": end.isoformat(), "attendance": rows}


async def dashboard(db: AsyncSession, org_id: uuid.UUID) -> dict:
    """Executive KPI snapshot assembled from whatever data exists."""
    today = datetime.now(UTC).date()
    month_ago = today - timedelta(days=28)

    headcount = (
        await db.execute(
            select(func.count()).select_from(Employee).where(
                Employee.organization_id == org_id,
                Employee.status == "active",
                Employee.deleted_at.is_(None),
            )
        )
    ).scalar_one()

    pending_requests = (
        await db.execute(
            select(func.count()).select_from(ChangeRequest).where(
                ChangeRequest.organization_id == org_id,
                ChangeRequest.status.in_(["pending_manager", "pending_wfm"]),
            )
        )
    ).scalar_one()

    latest_plan_week = (
        await db.execute(
            select(CapacityPlanWeek)
            .join(CapacityPlan, CapacityPlanWeek.plan_id == CapacityPlan.id)
            .where(CapacityPlan.organization_id == org_id)
            .order_by(CapacityPlanWeek.week_start.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    approved_forecasts = (
        await db.execute(
            select(func.count()).select_from(Forecast).where(
                Forecast.organization_id == org_id, Forecast.status == "approved"
            )
        )
    ).scalar_one()
    avg_mape = (
        await db.execute(
            select(func.avg(Forecast.mape)).where(
                Forecast.organization_id == org_id, Forecast.mape.is_not(None)
            )
        )
    ).scalar_one()

    att = await attendance_summary(db, org_id, month_ago, today)

    return {
        "as_of": today.isoformat(),
        "active_headcount": headcount,
        "required_fte_latest_week": latest_plan_week.required_fte if latest_plan_week else None,
        "staffing_gap_latest_week": latest_plan_week.gap if latest_plan_week else None,
        "approved_forecasts": approved_forecasts,
        "avg_forecast_mape_pct": round(avg_mape * 100, 2) if avg_mape else None,
        "pending_requests": pending_requests,
        "absenteeism_rate_28d": att.absenteeism_rate,
        "late_rate_28d": att.late_rate,
        "shrinkage_rate_28d": att.shrinkage_rate,
    }
