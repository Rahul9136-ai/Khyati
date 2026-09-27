"""Unit tests for the seasonality/promotions engine (pure functions) — trend +
last-year-actuals demand suggestion, promotion-window matching (including the
year-end wrap), and assumption carry-forward."""
from __future__ import annotations

from app.modules.hcplanning.engine.seasonality import (
    PromotionWindow,
    covers,
    promotion_multiplier,
    suggest_assumption,
    suggest_demand,
)


def test_suggest_demand_projects_from_last_year_with_growth():
    last_year = {"2025-11": 100.0}
    out = suggest_demand(last_year, "2026-11", yoy_growth_pct=10.0, promotions=[])
    assert out["base_month"] == "2025-11"
    assert out["base_value"] == 100.0
    assert out["trended"] == 110.0
    assert out["suggested"] == 110.0
    assert out["reason"] is None


def test_suggest_demand_none_when_no_history():
    out = suggest_demand({}, "2026-11", yoy_growth_pct=0.0, promotions=[])
    assert out["suggested"] is None
    assert "2025-11" in out["reason"]


def test_suggest_demand_applies_promotion_on_top_of_trend():
    last_year = {"2025-12": 100.0}
    promo = PromotionWindow(name="Holiday surge", month_from="2025-11", month_to="2025-12",
                             demand_impact_pct=20.0, recurring=True)
    out = suggest_demand(last_year, "2026-12", yoy_growth_pct=0.0, promotions=[promo])
    assert out["trended"] == 100.0
    assert out["promotion_multiplier"] == 1.2
    assert out["suggested"] == 120.0
    assert out["matched_promotions"] == ["Holiday surge"]


def test_covers_recurring_non_wrapping_range():
    promo = PromotionWindow(name="Tax season", month_from="2025-02", month_to="2025-04",
                             demand_impact_pct=15.0, recurring=True)
    assert covers(promo, "2026-03")  # March, any year
    assert covers(promo, "2099-02")
    assert not covers(promo, "2026-05")
    assert not covers(promo, "2026-01")


def test_covers_recurring_wraps_year_end():
    promo = PromotionWindow(name="Holiday season", month_from="2025-11", month_to="2026-01",
                             demand_impact_pct=25.0, recurring=True)
    assert covers(promo, "2027-12")  # December, wraps toward January
    assert covers(promo, "2027-01")
    assert covers(promo, "2027-11")
    assert not covers(promo, "2027-06")


def test_covers_one_off_matches_literal_range_only():
    promo = PromotionWindow(name="One-time launch", month_from="2026-03", month_to="2026-04",
                             demand_impact_pct=30.0, recurring=False)
    assert covers(promo, "2026-03")
    assert covers(promo, "2026-04")
    assert not covers(promo, "2027-03")  # does NOT recur


def test_promotion_multiplier_compounds_not_adds():
    promos = [
        PromotionWindow(name="A", month_from="2025-11", month_to="2025-11",
                         demand_impact_pct=20.0, recurring=True),
        PromotionWindow(name="B", month_from="2025-11", month_to="2025-11",
                         demand_impact_pct=20.0, recurring=True),
    ]
    mult, matched = promotion_multiplier(promos, "2026-11")
    assert mult == 1.2 * 1.2  # 1.44, not 1.4
    assert matched == ["A", "B"]


def test_suggest_assumption_carries_forward_last_year_same_month():
    hist = {"2025-12": 0.06}
    out = suggest_assumption(hist, "2026-12")
    assert out["suggested"] == 0.06
    assert out["base_month"] == "2025-12"


def test_suggest_assumption_none_when_no_history():
    out = suggest_assumption({}, "2026-12")
    assert out["suggested"] is None
