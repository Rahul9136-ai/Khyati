"""Capacity planning engine — the AGS Health CP calculation, as pure functions.

Every metric maps to a labelled function so the logic is testable in isolation
and self-documenting; no Excel cell references appear anywhere. The monthly
table applies the workbook's two regimes: actual months take FTE/Ramp from the
roster; projected months carry FTE/Ramp forward with attrition and add new-hire
production to Ramp.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from app.modules.hcplanning.engine.agents import (
    AgentRecord,
    category_counts,
    resource_mix,
)
from app.modules.hcplanning.engine.config import PlanningConfig
from app.modules.hcplanning.engine.dates import month_index


# --------------------------------------------------------------------------- #
# Scalar metric functions (labelled — the "how is this calculated" primitives)
# --------------------------------------------------------------------------- #
def required_hc(billable_fte: float, ooo_shrinkage: float, io_shrinkage: float) -> float:
    """Required HC = Billable FTE / ((1 - OOO) * (1 - IO))."""
    denom = (1 - ooo_shrinkage) * (1 - io_shrinkage)
    if denom <= 0:
        raise ValueError("Combined shrinkage must be < 100%")
    return billable_fte / denom


def whole_hc(value: float) -> int:
    """Round up to a whole number, away from zero (Excel ROUNDUP). The 1e-6 pre-round
    absorbs float noise so an exact 17.000000000000004 doesn't become 18."""
    return int(math.copysign(math.ceil(round(abs(value), 6)), value))


def production_agents(counts: dict[str, float], cfg: PlanningConfig) -> float:
    """Sum of the production-category counts (FTE + Ramp + … + Maternity)."""
    return sum(counts.get(s, 0.0) for s in cfg.production_statuses)


def capacity_pct(closing_hc: float, required: float) -> float | None:
    return closing_hc / required if required else None


def excess_deficit(closing_hc: float, required: float) -> float:
    return closing_hc - required


def ot_vto_hours(excess: float, weekly_hours: float) -> float:
    return excess * weekly_hours


def overall_utilization(billable: float, prod_agents: float) -> float | None:
    return billable / prod_agents if prod_agents else None


def productive_utilization(
    billable: float, counts: dict[str, float], fte: float, ramp: float, cfg: PlanningConfig
) -> float | None:
    # FTE + Ramp use the (possibly projected) values; Notice/Ops from roster.
    denom = fte + ramp
    for s in cfg.productive_util_statuses:
        if s not in ("FTE", "Ramp"):
            denom += counts.get(s, 0.0)
    return billable / denom if denom else None


def buffer_pct(prod_agents: float, billable: float) -> float | None:
    return prod_agents / billable - 1 if billable else None


# --------------------------------------------------------------------------- #
# Monthly result + table builder
# --------------------------------------------------------------------------- #
@dataclass
class MonthResult:
    month: str
    billable_fte: float
    required_hc: float
    production_agents: float
    fte_ramp: float
    closing_hc: float
    closing_overridden: bool
    capacity_pct: float | None
    excess_deficit: float
    ot_vto_hours: float
    # category breakdown
    fte: float
    ramp: float
    notice_period: float
    ojt: float
    investment_bench: float
    ops_bench: float
    training: float
    long_leave: float
    maternity_leave: float
    # KPIs
    overall_utilization: float | None
    productive_utilization: float | None
    buffer_pct: float | None
    headcount_vs_billable: float
    req_hc_vs_actual: float
    fresher_lt_1yr: float
    lateral_gt_1yr: float

    def as_dict(self) -> dict:
        return self.__dict__.copy()


_STATUS_TO_FIELD = {
    "FTE": "fte", "Ramp": "ramp", "Notice Period": "notice_period", "OJT": "ojt",
    "Investment Bench": "investment_bench", "Ops Bench": "ops_bench",
    "Training": "training", "Long Leave": "long_leave", "Maternity Leave": "maternity_leave",
}


@dataclass
class CapacityTable:
    lob: str
    months: list[str]
    results: list[MonthResult] = field(default_factory=list)

    def row(self, metric: str) -> list:
        return [getattr(r, metric) for r in self.results]

    def as_dict(self) -> dict:
        return {"lob": self.lob, "months": self.months,
                "results": [r.as_dict() for r in self.results]}


def build_capacity_table(
    agents: list[AgentRecord],
    lob: str,
    months: list[str],
    billable_by_month: dict[str, float],
    cfg: PlanningConfig,
    *,
    newhire_production_by_month: dict[str, float] | None = None,
    closing_overrides: dict[str, float] | None = None,
) -> CapacityTable:
    """Compute the full monthly capacity table for one LOB.

    ``newhire_production_by_month`` feeds the New Hire pipeline's productive
    output into Ramp for projected months. ``closing_overrides`` lets a planner
    pin Closing HC for a month (the workbook's editable Closing HC).
    """
    cfg.validate()
    newhire = newhire_production_by_month or {}
    overrides = closing_overrides or {}
    actuals_idx = month_index(cfg.actuals_through) if cfg.actuals_through else None

    table = CapacityTable(lob=lob, months=list(months))
    prev_fte: float | None = None
    prev_ramp: float | None = None

    for month in months:
        counts = category_counts(agents, lob, month, cfg)
        roster_fte = counts.get("FTE", 0.0)
        roster_ramp = counts.get("Ramp", 0.0)

        projected = (
            actuals_idx is not None
            and month_index(month) > actuals_idx
            and prev_fte is not None
        )
        if projected:
            attr = cfg.attr(month)
            fte = prev_fte * (1 - attr)
            ramp = prev_ramp * (1 - attr) + newhire.get(month, 0.0)
        else:
            fte, ramp = roster_fte, roster_ramp

        # category values (FTE/Ramp possibly projected; rest from roster)
        cat = {field: counts.get(status, 0.0) for status, field in _STATUS_TO_FIELD.items()}
        cat["fte"], cat["ramp"] = fte, ramp

        prod_agents = production_agents({**counts, "FTE": fte, "Ramp": ramp}, cfg)
        fte_ramp = fte + ramp
        override = overrides.get(month)
        closing = override if override is not None else fte_ramp

        billable = billable_by_month.get(month, 0.0)
        if cfg.whole_headcount:
            billable = whole_hc(billable)  # demand is planned in whole FTE; Required HC is derived from it
        req = required_hc(billable, cfg.ooo(month), cfg.io(month))
        util = overall_utilization(billable, prod_agents)
        prod_util = productive_utilization(billable, counts, fte, ramp, cfg)
        buf = buffer_pct(prod_agents, billable)
        hc_vs_billable = prod_agents - billable

        # Report whole people: round up at the output only (the projection above stays
        # unrounded so attrition compounds correctly). Everything derived from
        # Required / Closing — capacity %, excess/deficit, OT/VTO — uses the rounded
        # figures so the table reads consistently. Ratios (utilisation, buffer) come
        # from the raw counts.
        if cfg.whole_headcount:
            req, closing, prod_agents, fte_ramp = (whole_hc(x) for x in (req, closing, prod_agents, fte_ramp))
            hc_vs_billable = whole_hc(hc_vs_billable)
            cat = {k: whole_hc(v) for k, v in cat.items()}
        excess = excess_deficit(closing, req)
        ot_vto = ot_vto_hours(excess, cfg.weekly_hours)
        if cfg.whole_headcount:
            ot_vto = whole_hc(ot_vto)
        mix = resource_mix(agents, lob, month, cfg)

        table.results.append(MonthResult(
            month=month,
            billable_fte=billable,
            required_hc=req,
            production_agents=prod_agents,
            fte_ramp=fte_ramp,
            closing_hc=closing,
            closing_overridden=override is not None,
            capacity_pct=capacity_pct(closing, req),
            excess_deficit=excess,
            ot_vto_hours=ot_vto,
            overall_utilization=util,
            productive_utilization=prod_util,
            buffer_pct=buf,
            headcount_vs_billable=hc_vs_billable,
            req_hc_vs_actual=excess,
            fresher_lt_1yr=mix["fresher_lt_1yr"],
            lateral_gt_1yr=mix["lateral_gt_1yr"],
            **cat,
        ))
        prev_fte, prev_ramp = fte, ramp

    return table
