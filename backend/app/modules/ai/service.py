"""AI assistant services.

Every feature is grounded in real platform data and works deterministically
offline; when ANTHROPIC_API_KEY is configured, the same grounded facts are
handed to Claude to produce a conversational narration instead of templates.
"""
from __future__ import annotations

import statistics
import uuid
from datetime import date, timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import NotFoundError
from app.modules.forecasting.engine import distribute_to_intervals
from app.modules.forecasting.models import Forecast, ForecastPoint
from app.modules.planning.erlang import required_agents
from app.modules.reporting.service import _daily_actuals, dashboard
from app.modules.workforce.models import Queue

_MODEL_BLURBS = {
    "seasonal_naive": "repeats the most recent value seen on the same weekday",
    "moving_average": "projects the trailing 28-day average shaped by weekday seasonality",
    "exp_smoothing": "exponentially weights recent days over older ones, with weekday shaping",
    "holt_winters": "models level, trend and weekly seasonality simultaneously",
    "regression": "fits a linear trend and re-applies weekday seasonality",
}


async def staffing_recommendation(
    db: AsyncSession, forecast_id: uuid.UUID, day: date
) -> dict:
    forecast = await db.get(Forecast, forecast_id)
    if forecast is None:
        raise NotFoundError("Forecast not found")
    point = (
        await db.execute(
            select(ForecastPoint).where(
                ForecastPoint.forecast_id == forecast_id, ForecastPoint.day == day
            )
        )
    ).scalar_one_or_none()
    if point is None:
        raise NotFoundError(f"Forecast has no point for {day}")

    queue = await db.get(Queue, forecast.queue_id) if forecast.queue_id else None
    interval_minutes = queue.interval_minutes if queue else 30
    aht = point.aht or (queue.default_aht_seconds if queue else 300)
    volumes = distribute_to_intervals(point.volume, interval_minutes)
    intervals, peak_agents, total_agent_intervals = [], 0, 0
    for i, volume in enumerate(volumes):
        if volume <= 0:
            continue
        result = required_agents(
            volume=volume,
            aht_seconds=aht,
            interval_seconds=interval_minutes * 60,
            sla_target=queue.sla_target_pct if queue else 0.8,
            sla_threshold_seconds=queue.sla_threshold_seconds if queue else 30,
            max_occupancy=queue.target_occupancy if queue else 0.9,
            concurrency=queue.concurrency if queue else 1.0,
        )
        hour, minute = (i * interval_minutes) // 60, (i * interval_minutes) % 60
        intervals.append(
            {"label": f"{hour:02d}:{minute:02d}", "volume": volume,
             "agents": result.agents, "service_level": result.service_level,
             "occupancy": result.occupancy}
        )
        peak_agents = max(peak_agents, result.agents)
        total_agent_intervals += result.agents
    summary = (
        f"For {day.isoformat()} the plan needs a peak of {peak_agents} concurrent agents; "
        f"roughly {total_agent_intervals * interval_minutes / 60:.0f} paid agent-hours "
        f"cover the forecast {point.volume:.0f} contacts at AHT {aht:.0f}s."
    )
    return {"day": day.isoformat(), "peak_agents": peak_agents, "summary": summary,
            "intervals": intervals}


async def detect_anomalies(
    db: AsyncSession, queue_id: uuid.UUID, start: date, end: date
) -> dict:
    daily = await _daily_actuals(db, queue_id, start, end)
    volumes = [agg["volume"] for agg in daily.values()]
    anomalies = []
    if len(volumes) >= 7:
        mean = statistics.fmean(volumes)
        stdev = statistics.pstdev(volumes) or 1.0
        for day in sorted(daily):
            z = (daily[day]["volume"] - mean) / stdev
            if abs(z) >= 2:
                anomalies.append(
                    {
                        "date": day.isoformat(),
                        "volume": round(daily[day]["volume"], 1),
                        "z_score": round(z, 2),
                        "direction": "spike" if z > 0 else "drop",
                    }
                )
    return {
        "queue_id": str(queue_id),
        "days_analyzed": len(volumes),
        "anomalies": anomalies,
        "summary": (
            f"Found {len(anomalies)} anomalous day(s) out of {len(volumes)} analysed."
            if volumes
            else "No actuals available in the selected window."
        ),
    }


async def explain_forecast(db: AsyncSession, forecast_id: uuid.UUID) -> dict:
    forecast = await db.get(Forecast, forecast_id)
    if forecast is None:
        raise NotFoundError("Forecast not found")
    blurb = _MODEL_BLURBS.get(forecast.model, "a statistical projection")
    lines = [
        f"'{forecast.name}' (v{forecast.version}) uses the {forecast.model} model, which "
        f"{blurb}.",
    ]
    if forecast.mape is not None:
        lines.append(
            f"In backtesting it missed actuals by {forecast.mape * 100:.1f}% on average "
            "(MAPE) over the holdout window."
        )
    if forecast.backtest:
        ranked = sorted(
            ((k, v) for k, v in forecast.backtest.items() if v >= 0),
            key=lambda item: item[1],
        )
        if len(ranked) > 1:
            runner = ranked[1]
            lines.append(
                f"It beat the runner-up ({runner[0]}, {runner[1] * 100:.1f}% MAPE) in the "
                "model bake-off."
            )
    lines.append(f"Current workflow status: {forecast.status.replace('_', ' ')}.")
    return {"forecast_id": str(forecast_id), "explanation": " ".join(lines),
            "backtest": forecast.backtest}


async def _llm_narrate(question: str, facts: dict) -> str | None:
    """Optional Claude narration over grounded facts; None if not configured."""
    if not settings.ANTHROPIC_API_KEY:
        return None
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": settings.ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                },
                json={
                    "model": settings.ANTHROPIC_MODEL,
                    "max_tokens": 500,
                    "system": (
                        "You are a workforce-management analyst. Answer the user's "
                        "question using ONLY the grounded facts provided; be concise."
                    ),
                    "messages": [
                        {"role": "user",
                         "content": f"Question: {question}\n\nGrounded facts: {facts}"}
                    ],
                },
            )
            response.raise_for_status()
            return response.json()["content"][0]["text"]
    except (httpx.HTTPError, KeyError, IndexError):
        return None  # degrade gracefully to the deterministic answer


async def chat(
    db: AsyncSession, org_id: uuid.UUID, message: str, queue_id: uuid.UUID | None = None
) -> dict:
    """Keyword-routed natural-language assistant over live platform data."""
    lower = message.lower()
    today = date.today()
    facts: dict = {}
    answer: str

    if any(word in lower for word in ("anomal", "spike", "unusual", "outlier")) and queue_id:
        facts = await detect_anomalies(db, queue_id, today - timedelta(days=28), today)
        answer = facts["summary"]
        if facts["anomalies"]:
            worst = max(facts["anomalies"], key=lambda a: abs(a["z_score"]))
            answer += (
                f" Largest deviation: {worst['direction']} on {worst['date']} "
                f"(z={worst['z_score']})."
            )
    elif any(word in lower for word in ("staff", "agents", "headcount", "fte", "hire")):
        kpis = await dashboard(db, org_id)
        facts = kpis
        gap = kpis.get("staffing_gap_latest_week")
        answer = f"Active headcount is {kpis['active_headcount']}."
        if kpis.get("required_fte_latest_week") is not None:
            answer += (
                f" The latest capacity-plan week needs {kpis['required_fte_latest_week']} FTE"
                + (f", leaving a gap of {gap} FTE." if gap is not None else ".")
            )
    elif any(word in lower for word in ("shrink", "absen", "attend", "late")):
        kpis = await dashboard(db, org_id)
        facts = kpis
        answer = (
            f"Over the last 28 days: absenteeism {kpis['absenteeism_rate_28d']:.1%}, "
            f"lateness {kpis['late_rate_28d']:.1%}, shrinkage "
            f"{kpis['shrinkage_rate_28d']:.1%}."
        )
    elif any(word in lower for word in ("forecast", "volume", "demand")):
        rows = await db.execute(
            select(Forecast)
            .where(Forecast.organization_id == org_id)
            .order_by(Forecast.created_at.desc())
            .limit(3)
        )
        recent = list(rows.scalars())
        facts = {
            "recent_forecasts": [
                {"name": f.name, "model": f.model, "status": f.status,
                 "mape": f.mape} for f in recent
            ]
        }
        if recent:
            best = recent[0]
            answer = (
                f"Most recent forecast is '{best.name}' ({best.model}, status "
                f"{best.status}"
                + (f", backtest MAPE {best.mape * 100:.1f}%" if best.mape else "")
                + "). Ask me to explain any forecast for details."
            )
        else:
            answer = "No forecasts exist yet — upload history and run one from Forecasting."
    else:
        kpis = await dashboard(db, org_id)
        facts = kpis
        answer = (
            f"Snapshot {kpis['as_of']}: headcount {kpis['active_headcount']}, "
            f"pending requests {kpis['pending_requests']}, absenteeism "
            f"{kpis['absenteeism_rate_28d']:.1%}. Ask about staffing, forecasts, "
            "shrinkage or anomalies."
        )

    narrated = await _llm_narrate(message, facts)
    return {"answer": narrated or answer, "grounded": facts,
            "llm_used": narrated is not None}
