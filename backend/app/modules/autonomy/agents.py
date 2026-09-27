"""Specialist agents.

Each agent is a pure *observer/decider*: given a context it reads live platform
data through the existing domain services and returns a list of `Proposal`s with
a grounded rationale and a calibrated confidence. Agents never mutate state —
the orchestrator decides whether a proposal is applied (see service.apply_action).
"""
from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.ai.service import detect_anomalies
from app.modules.forecasting.models import Forecast, ForecastPoint
from app.modules.intraday.service import day_status
from app.modules.planning.models import CapacityPlan, CapacityPlanWeek
from app.modules.reporting.service import _daily_actuals, dashboard
from app.modules.workforce.models import Queue


def _clamp(value: float, low: float = 0.5, high: float = 0.98) -> float:
    return round(max(low, min(high, value)), 3)


@dataclass
class Proposal:
    agent: str
    action_type: str
    title: str
    rationale: str
    confidence: float
    severity: str  # info | warning | critical
    # tactical: this week/interval's execution fix (overtime, VTO, retrain…),
    # routed to the people who run the floor. strategic: "this keeps recurring
    # under the current plan — the plan itself should change," routed to the
    # people who own that plan (see autonomy/service._notify_stakeholders).
    tier: str = "tactical"
    target_type: str | None = None
    target_id: uuid.UUID | None = None
    target_label: str | None = None
    payload: dict = field(default_factory=dict)


@dataclass
class AgentContext:
    db: AsyncSession
    org_id: uuid.UUID
    today: date


async def _queues(ctx: AgentContext) -> list[Queue]:
    rows = await ctx.db.execute(
        select(Queue).where(Queue.organization_id == ctx.org_id).order_by(Queue.name)
    )
    return list(rows.scalars())


# --------------------------------------------------------------------- intraday
async def intraday_agent(ctx: AgentContext) -> list[Proposal]:
    """Watch every queue's live SLA vs plan and recommend an intraday action."""
    out: list[Proposal] = []
    for queue in await _queues(ctx):
        status = await day_status(ctx.db, ctx.org_id, queue.id, ctx.today)
        sl, dev, target = status.sl_attained, status.deviation_pct, queue.sla_target_pct
        base = {
            "queue": queue.name,
            "service_level": sl,
            "sla_target": target,
            "deviation_pct": dev,
            "reforecast_total": status.reforecast_total,
        }
        if sl is not None and sl < target - 0.03:
            gap = target - sl
            severity = "critical" if sl < target - 0.15 else "warning"
            out.append(
                Proposal(
                    agent="intraday",
                    action_type="offer_overtime",
                    title=f"{queue.name}: protect SLA — offer overtime / defer offline work",
                    rationale=(
                        f"Service level is {sl:.0%} against a {target:.0%} target"
                        + (f" while volume runs {dev:+.0f}% vs forecast" if dev else "")
                        + ". Offering overtime to skilled agents and deferring "
                        "non-productive AUX recovers the interval."
                    ),
                    confidence=_clamp(0.62 + gap * 2.2),
                    severity=severity,
                    target_type="queue",
                    target_id=queue.id,
                    target_label=queue.name,
                    payload={**base, "recommended": "offer_overtime + defer_offline"},
                )
            )
        elif dev is not None and dev <= -20:
            out.append(
                Proposal(
                    agent="intraday",
                    action_type="offer_vto",
                    title=f"{queue.name}: overstaffed — offer VTO / pull into training",
                    rationale=(
                        f"Volume is running {dev:.0f}% below forecast and SLA is healthy — "
                        "a good window to offer voluntary time off or move agents into "
                        "coaching/training to reduce cost."
                    ),
                    confidence=_clamp(0.6 + abs(dev) / 200),
                    severity="info",
                    target_type="queue",
                    target_id=queue.id,
                    target_label=queue.name,
                    payload={**base, "recommended": "offer_vto"},
                )
            )
        elif dev is not None and dev >= 20:
            out.append(
                Proposal(
                    agent="intraday",
                    action_type="offer_overtime",
                    title=f"{queue.name}: volume surge — add capacity before SLA breaches",
                    rationale=(
                        f"Volume is {dev:.0f}% above forecast. Acting now — overtime, "
                        "cross-skilling idle agents — prevents an SLA breach later in the day."
                    ),
                    confidence=_clamp(0.58 + dev / 200),
                    severity="warning",
                    target_type="queue",
                    target_id=queue.id,
                    target_label=queue.name,
                    payload={**base, "recommended": "offer_overtime + cross_skill"},
                )
            )
    return out


# --------------------------------------------------------------------- forecast
async def _live_drift(
    ctx: AgentContext, queue_id: uuid.UUID, forecast_id: uuid.UUID
) -> tuple[float | None, int]:
    """Compare recent forecast points against posted actuals → live MAPE."""
    start = ctx.today - timedelta(days=28)
    points = (
        await ctx.db.execute(
            select(ForecastPoint).where(
                ForecastPoint.forecast_id == forecast_id,
                ForecastPoint.day >= start,
                ForecastPoint.day <= ctx.today,
            )
        )
    ).scalars()
    predicted = {p.day: p.volume for p in points}
    if len(predicted) < 5:
        return None, 0
    actuals = await _daily_actuals(ctx.db, queue_id, start, ctx.today)
    errors = [
        abs(predicted[day] - agg["volume"]) / agg["volume"]
        for day, agg in actuals.items()
        if day in predicted and agg["volume"] > 0
    ]
    if len(errors) < 5:
        return None, len(errors)
    return sum(errors) / len(errors), len(errors)


async def forecast_agent(ctx: AgentContext) -> list[Proposal]:
    """Detect forecast drift / staleness and recommend a retrain."""
    rows = await ctx.db.execute(
        select(Forecast)
        .where(Forecast.organization_id == ctx.org_id, Forecast.queue_id.is_not(None))
        .order_by(Forecast.created_at.desc())
    )
    out: list[Proposal] = []
    seen: set[uuid.UUID] = set()
    for fc in rows.scalars():
        if fc.queue_id in seen:  # only the newest forecast per queue
            continue
        seen.add(fc.queue_id)
        age_days = (ctx.today - fc.created_at.date()).days
        backtest_mape = fc.mape
        live_mape, n = await _live_drift(ctx, fc.queue_id, fc.id)

        reasons: list[str] = []
        confidence = 0.0
        if live_mape is not None and (
            live_mape > 0.15 and (backtest_mape is None or live_mape > backtest_mape * 1.5)
        ):
            reasons.append(
                f"live error {live_mape:.0%} over the last {n} days has drifted well past "
                f"the {backtest_mape:.0%} seen in backtesting"
                if backtest_mape
                else f"live error {live_mape:.0%} over the last {n} days exceeds tolerance"
            )
            confidence = max(confidence, 0.6 + min(0.3, (live_mape - 0.15)))
        if backtest_mape is not None and backtest_mape > 0.18:
            reasons.append(f"its own backtest MAPE is {backtest_mape:.0%}")
            confidence = max(confidence, 0.55 + min(0.25, backtest_mape - 0.18))
        if age_days >= 21:
            reasons.append(f"it is {age_days} days old and hasn't been refreshed")
            confidence = max(confidence, 0.55 + min(0.2, age_days / 200))

        if not reasons:
            continue
        out.append(
            Proposal(
                agent="forecast",
                action_type="retrain_forecast",
                title=f"Retrain forecast '{fc.name}' — drift detected",
                rationale=(
                    f"Forecast '{fc.name}' ({fc.model}) should be retrained because "
                    + "; ".join(reasons)
                    + ". A fresh version is generated from the latest history."
                ),
                confidence=_clamp(confidence),
                severity="warning" if confidence >= 0.7 else "info",
                target_type="forecast",
                target_id=fc.id,
                target_label=fc.name,
                payload={
                    "forecast_id": str(fc.id),
                    "series_id": str(fc.series_id) if fc.series_id else None,
                    "horizon_days": fc.horizon_days,
                    "backtest_mape": backtest_mape,
                    "live_mape": round(live_mape, 4) if live_mape is not None else None,
                    "age_days": age_days,
                },
            )
        )
    return out


# --------------------------------------------------------------------- planning
async def planning_agent(ctx: AgentContext) -> list[Proposal]:
    """Spot the worst upcoming capacity shortfall and recommend a remedy."""
    horizon_start = ctx.today - timedelta(days=7)
    rows = await ctx.db.execute(
        select(CapacityPlanWeek, CapacityPlan.name)
        .join(CapacityPlan, CapacityPlanWeek.plan_id == CapacityPlan.id)
        .where(
            CapacityPlan.organization_id == ctx.org_id,
            CapacityPlanWeek.week_start >= horizon_start,
        )
        .order_by(CapacityPlanWeek.gap.asc())
    )
    worst = rows.first()
    if worst is None:
        return []
    week, plan_name = worst
    if week.gap >= -0.5:  # gap = available - required; negative means short
        return []

    weeks_out = max(0, (week.week_start - ctx.today).days // 7)
    short = abs(week.gap)
    ratio = short / week.required_fte if week.required_fte else 0.0
    if weeks_out <= 3:
        action_type, tier = "offer_overtime", "tactical"
        remedy = "overtime and reprioritised shrinkage"
        title = f"Near-term shortfall in '{plan_name}' — cover with overtime"
    else:
        # Enough lead time that this isn't "patch this week" — it's a call on the
        # hiring plan itself, so it goes to whoever owns that plan, not the floor.
        action_type, tier = "raise_hiring", "strategic"
        remedy = "an incremental hiring / cross-training plan"
        title = f"Capacity shortfall in '{plan_name}' — raise a hiring plan"
    return [
        Proposal(
            agent="planning",
            action_type=action_type,
            title=title,
            rationale=(
                f"Week of {week.week_start.isoformat()} is short {short:.1f} FTE "
                f"({ratio:.0%} of the {week.required_fte:.1f} required). With {weeks_out} "
                f"week(s) of lead time, close the gap with {remedy}."
            ),
            confidence=_clamp(0.6 + min(0.3, ratio)),
            severity="critical" if ratio >= 0.15 else "warning",
            tier=tier,
            target_type="plan",
            target_id=week.plan_id,
            target_label=plan_name,
            payload={
                "week_start": week.week_start.isoformat(),
                "required_fte": week.required_fte,
                "available_hc": week.available_hc,
                "gap_fte": week.gap,
                "weeks_lead_time": weeks_out,
            },
        )
    ]


# ------------------------------------------------------------------- root cause
async def root_cause_agent(ctx: AgentContext) -> list[Proposal]:
    """When headline KPIs breach thresholds, rank the likely drivers."""
    kpis = await dashboard(ctx.db, ctx.org_id)
    drivers: list[tuple[str, float, str]] = []  # (label, magnitude, detail)
    if (ab := kpis.get("absenteeism_rate_28d")) and ab > 0.08:
        drivers.append(("Absenteeism", ab, f"absenteeism at {ab:.1%} (28d) inflates shrinkage"))
    if (sh := kpis.get("shrinkage_rate_28d")) and sh > 0.30:
        drivers.append(("Shrinkage", sh, f"shrinkage at {sh:.1%} erodes available capacity"))
    if (la := kpis.get("late_rate_28d")) and la > 0.08:
        drivers.append(("Lateness", la, f"lateness at {la:.1%} hurts early-interval coverage"))
    mape = kpis.get("avg_forecast_mape_pct")
    if mape and mape > 15:
        drivers.append(("Forecast accuracy", mape / 100, f"avg forecast MAPE {mape:.0f}%"))
    gap = kpis.get("staffing_gap_latest_week")
    if gap is not None and gap < -0.5:
        drivers.append(("Staffing gap", abs(gap), f"latest plan week short {abs(gap):.1f} FTE"))

    if not drivers:
        return []
    drivers.sort(key=lambda d: d[1], reverse=True)
    top = drivers[0]
    return [
        Proposal(
            agent="root_cause",
            action_type="root_cause",
            title=f"Root-cause: {top[0]} is the top driver of KPI pressure",
            rationale=(
                "Ranked drivers behind current performance — "
                + "; ".join(f"{i + 1}) {d[2]}" for i, d in enumerate(drivers[:3]))
                + "."
            ),
            confidence=_clamp(0.65 + min(0.2, top[1])),
            severity="warning",
            tier="strategic",  # leadership-level synthesis, not a floor fix
            target_type="org",
            target_id=None,
            target_label="Organization KPIs",
            payload={"drivers": [{"label": d[0], "detail": d[2]} for d in drivers], "kpis": kpis},
        )
    ]


# ----------------------------------------------------------------- data quality
async def data_quality_agent(ctx: AgentContext) -> list[Proposal]:
    """Scan each queue's recent actuals for anomalies that warrant repair."""
    out: list[Proposal] = []
    for queue in await _queues(ctx):
        result = await detect_anomalies(
            ctx.db, queue.id, ctx.today - timedelta(days=28), ctx.today
        )
        anomalies = result.get("anomalies", [])
        if not anomalies:
            continue
        worst = max(anomalies, key=lambda a: abs(a["z_score"]))
        out.append(
            Proposal(
                agent="data_quality",
                action_type="data_repair",
                title=f"{queue.name}: {len(anomalies)} anomalous day(s) need review",
                rationale=(
                    f"{len(anomalies)} day(s) in the last 28 deviate >2σ from the mean "
                    f"(largest: {worst['direction']} on {worst['date']}, z={worst['z_score']}). "
                    "Left uncorrected these outliers bias the next forecast — flag for "
                    "normalisation before the next training run."
                ),
                confidence=_clamp(0.55 + min(0.3, 0.05 * len(anomalies))),
                severity="warning" if len(anomalies) >= 3 else "info",
                target_type="queue",
                target_id=queue.id,
                target_label=queue.name,
                payload={"anomalies": anomalies, "days_analyzed": result.get("days_analyzed")},
            )
        )
    return out


# ------------------------------------------------------------------- strategy
async def strategy_agent(ctx: AgentContext) -> list[Proposal]:
    """Looks across weeks/versions, not a single snapshot, for a *persistent*
    pattern the tactical agents keep re-flagging one interval at a time — and
    escalates it as a strategy-level call ("I'm anticipating this keeps
    happening under the current plan, so the plan should change") rather than
    another one-off fix. Always tier="strategic"; never auto-applies (see
    AgentSpec.default_auto_apply below) — a plan/strategy change is a human
    call, however confident the pattern is.
    """
    out: list[Proposal] = []

    # 1) Structural staffing shortfall: short most weeks for two months running,
    #    regardless of overtime patched in week by week — the hiring pace or
    #    target buffer is wrong, not this week's execution.
    lookback_start = ctx.today - timedelta(weeks=8)
    rows = await ctx.db.execute(
        select(CapacityPlanWeek, CapacityPlan.name)
        .join(CapacityPlan, CapacityPlanWeek.plan_id == CapacityPlan.id)
        .where(
            CapacityPlan.organization_id == ctx.org_id,
            CapacityPlanWeek.week_start >= lookback_start,
            CapacityPlanWeek.week_start <= ctx.today,
        )
    )
    by_plan: dict[uuid.UUID, list[CapacityPlanWeek]] = {}
    plan_names: dict[uuid.UUID, str] = {}
    for week, name in rows.all():
        by_plan.setdefault(week.plan_id, []).append(week)
        plan_names[week.plan_id] = name

    for plan_id, weeks in by_plan.items():
        if len(weeks) < 4:  # not enough elapsed history to call it a pattern yet
            continue
        short_weeks = [
            w for w in weeks
            if w.gap < 0 and w.required_fte and abs(w.gap) / w.required_fte >= 0.08
        ]
        ratio = len(short_weeks) / len(weeks)
        if ratio < 0.6:  # occasional shortfalls are normal; this is about persistence
            continue
        avg_short = sum(abs(w.gap) for w in short_weeks) / len(short_weeks)
        out.append(
            Proposal(
                agent="strategy",
                action_type="strategy_change",
                title=f"'{plan_names[plan_id]}' keeps running short — change the staffing strategy",
                rationale=(
                    f"{len(short_weeks)} of the last {len(weeks)} weeks in '{plan_names[plan_id]}' "
                    f"were understaffed by {avg_short:.1f} FTE on average. Covering each week with "
                    "overtime treats the symptom — I'm anticipating this keeps recurring under "
                    "the current hiring pace and target buffer, so the strategy itself (hiring "
                    "lead time, target buffer %, or shift mix) needs to change, not just this "
                    "week's fix."
                ),
                confidence=_clamp(0.55 + ratio * 0.35),
                severity="critical" if ratio >= 0.8 else "warning",
                tier="strategic",
                target_type="plan",
                target_id=plan_id,
                target_label=plan_names[plan_id],
                payload={
                    "weeks_examined": len(weeks),
                    "short_weeks": len(short_weeks),
                    "shortfall_ratio": round(ratio, 3),
                    "avg_shortfall_fte": round(avg_short, 2),
                },
            )
        )

    # 2) Forecasting strategy not working: repeated retrains, no real improvement.
    #    (The Forecast Agent already retrains on drift — this catches the case
    #    where retraining itself isn't the fix.)
    rows2 = await ctx.db.execute(
        select(Forecast)
        .where(Forecast.organization_id == ctx.org_id, Forecast.queue_id.is_not(None))
        .order_by(Forecast.queue_id, Forecast.version.desc())
    )
    by_queue: dict[uuid.UUID, list[Forecast]] = {}
    for fc in rows2.scalars():
        by_queue.setdefault(fc.queue_id, []).append(fc)

    for versions in by_queue.values():
        recent = sorted(versions, key=lambda f: f.version)[-3:]
        if len(recent) < 3 or any(v.mape is None for v in recent):
            continue
        mapes = [v.mape for v in recent]
        if mapes[-1] <= 0.15 or mapes[-1] < mapes[0] * 0.9:
            continue  # either it's fine now, or genuinely trending down — leave it
        latest = recent[-1]
        out.append(
            Proposal(
                agent="strategy",
                action_type="strategy_change",
                title=(
                    f"Forecast '{latest.name}' keeps missing after {len(recent)} retrains — "
                    "change the forecasting strategy"
                ),
                rationale=(
                    f"The last {len(recent)} retrains gave MAPE "
                    + ", ".join(f"{m:.0%}" for m in mapes)
                    + " — no real improvement version over version. Retraining the same model on "
                    "the same assumptions won't fix a structural miss; I'm anticipating it keeps "
                    "missing target, so it's worth trying a different model family or checking "
                    "whether an unlogged event (see Scenario Studio) is driving the gap, rather "
                    "than another retrain."
                ),
                confidence=_clamp(0.55 + min(0.3, mapes[-1] - 0.15)),
                severity="warning",
                tier="strategic",
                target_type="forecast",
                target_id=latest.id,
                target_label=latest.name,
                payload={"versions": [{"version": v.version, "mape": v.mape} for v in recent]},
            )
        )
    return out


@dataclass
class AgentSpec:
    key: str
    label: str
    description: str
    default_auto_apply: bool
    fn: Callable[[AgentContext], Awaitable[list[Proposal]]]


AGENT_SPECS: list[AgentSpec] = [
    AgentSpec(
        "intraday", "Intraday Agent",
        "Monitors live SLA vs plan on every queue and recommends overtime, VTO or "
        "cross-skilling before targets breach.",
        default_auto_apply=True, fn=intraday_agent,
    ),
    AgentSpec(
        "forecast", "Forecast Agent",
        "Detects forecast drift and staleness by comparing live actuals to predictions, "
        "and retrains the model automatically.",
        default_auto_apply=True, fn=forecast_agent,
    ),
    AgentSpec(
        "planning", "Planning Agent",
        "Finds upcoming capacity shortfalls and recommends overtime or a hiring plan "
        "based on available lead time.",
        default_auto_apply=False, fn=planning_agent,
    ),
    AgentSpec(
        "root_cause", "Root-Cause Agent",
        "When headline KPIs breach thresholds, ranks the most likely drivers for leadership.",
        default_auto_apply=False, fn=root_cause_agent,
    ),
    AgentSpec(
        "data_quality", "Data-Quality Agent",
        "Scans recent actuals for outliers and schema issues that would bias the next "
        "forecast, flagging them for repair.",
        default_auto_apply=False, fn=data_quality_agent,
    ),
    AgentSpec(
        "strategy", "Strategy Agent",
        "Looks across weeks/versions for a persistent pattern — a plan running short "
        "most weeks, or retrains that never improve — and recommends changing the "
        "strategy itself (hiring pace, buffer, model family), not another one-off fix. "
        "Always routed to plan owners; never auto-applies.",
        default_auto_apply=False, fn=strategy_agent,
    ),
]

AGENTS_BY_KEY: dict[str, AgentSpec] = {spec.key: spec for spec in AGENT_SPECS}
