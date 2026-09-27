"""Seasonality & promotions — derive next-year demand/assumption suggestions
from last year's actuals (the business's own peak/non-peak shape) and known
fixed promotion windows, instead of a planner typing every month by hand.

Pure functions only: nothing here mutates a stored plan. `service.
apply_seasonality` writes an accepted suggestion through the same
`upsert_demand` / `monthly_overrides` paths a human edit would use.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.modules.hcplanning.engine.dates import add_months


@dataclass
class PromotionWindow:
    name: str
    month_from: str  # "YYYY-MM" — the reference occurrence
    month_to: str
    demand_impact_pct: float  # +20 = +20% demand
    recurring: bool = True


def _month_num(key: str) -> int:
    return int(key[5:7])


def covers(promotion: PromotionWindow, month: str) -> bool:
    """Whether `promotion` applies to `month`.

    A recurring promotion matches by calendar month only (year-agnostic), so
    "Nov-Dec every year" keeps applying in every future year; a one-off
    matches the literal YYYY-MM range. Recurring ranges may wrap the year end
    (e.g. Nov(11) -> Jan(1) for a holiday season that runs into January).
    """
    if not promotion.recurring:
        return promotion.month_from <= month <= promotion.month_to
    lo, hi, mm = _month_num(promotion.month_from), _month_num(promotion.month_to), _month_num(month)
    if lo <= hi:
        return lo <= mm <= hi
    return mm >= lo or mm <= hi


def promotion_multiplier(promotions: list[PromotionWindow], month: str) -> tuple[float, list[str]]:
    """Compound impact of every promotion covering `month` — impacts compound
    multiplicatively (two +20%s aren't +40%), matching how the frontend's
    Scenario Studio events compound."""
    mult = 1.0
    matched: list[str] = []
    for p in promotions:
        if covers(p, month):
            mult *= 1 + p.demand_impact_pct / 100
            matched.append(p.name)
    return mult, matched


def suggest_demand(
    last_year_actuals: dict[str, float],
    target_month: str,
    yoy_growth_pct: float,
    promotions: list[PromotionWindow],
) -> dict:
    """Suggested Billable FTE for `target_month` = last year's same month ×
    (1 + YoY growth) × compounded promotion impact — with a breakdown so the
    planner sees *why*, not just a number."""
    base_month = add_months(target_month, -12)
    base = last_year_actuals.get(base_month)
    if base is None:
        return {
            "suggested": None, "base_month": base_month, "base_value": None,
            "yoy_growth_pct": yoy_growth_pct, "trended": None,
            "promotion_multiplier": 1.0, "matched_promotions": [],
            "reason": f"No actuals recorded for {base_month} (last year) to project from.",
        }
    trended = base * (1 + yoy_growth_pct / 100)
    mult, matched = promotion_multiplier(promotions, target_month)
    suggested = trended * mult
    return {
        "suggested": round(suggested, 2),
        "base_month": base_month, "base_value": round(base, 2),
        "yoy_growth_pct": yoy_growth_pct, "trended": round(trended, 2),
        "promotion_multiplier": round(mult, 4), "matched_promotions": matched,
        "reason": None,
    }


def suggest_assumption(last_year_by_month: dict[str, float], target_month: str) -> dict:
    """Suggested shrinkage/attrition/OOO/IO for `target_month` — carries
    forward last year's same-month value (the seasonal shape repeats; there's
    no YoY-growth concept for a rate). `suggested` is None when there's no
    history for that month yet."""
    base_month = add_months(target_month, -12)
    value = last_year_by_month.get(base_month)
    return {"suggested": value, "base_month": base_month}
