"""Unit tests for the forecasting engine (cleaning, models, backtest)."""
from __future__ import annotations

import random
from datetime import date, timedelta

import pytest

from app.modules.forecasting.engine import (
    SeriesPoint,
    backtest,
    clean_series,
    distribute_to_intervals,
    generate_forecast,
    mape,
)


def _series(days: int = 84, base: float = 500.0) -> list[SeriesPoint]:
    rng = random.Random(7)
    weekday_mult = [1.2, 1.1, 1.0, 1.0, 1.05, 0.5, 0.35]
    start = date(2026, 1, 5)  # a Monday
    return [
        SeriesPoint(
            start + timedelta(days=i),
            base * weekday_mult[(start + timedelta(days=i)).weekday()]
            * rng.gauss(1.0, 0.04),
            aht=300,
        )
        for i in range(days)
    ]


def test_clean_fills_gaps_and_caps_outliers() -> None:
    points = _series(30)
    del points[10]  # gap
    points[5].volume = points[5].volume * 40  # massive outlier
    cleaned, report = clean_series(points)
    assert report.filled_gaps == 1
    assert report.outliers_capped >= 1
    assert len(cleaned) == 30
    days = [p.day for p in cleaned]
    assert days == sorted(days)  # continuous calendar


def test_auto_forecast_learns_weekly_seasonality() -> None:
    result = generate_forecast(_series(), horizon=14, model="auto")
    assert len(result.volumes) == 14
    assert result.model in result.backtest
    # weekend days must be forecast well below weekdays
    weekend = [v for d, v in zip(result.days, result.volumes) if d.weekday() >= 5]
    weekday = [v for d, v in zip(result.days, result.volumes) if d.weekday() < 5]
    assert max(weekend) < min(weekday)
    # confidence band brackets the point forecast
    assert all(lo <= v <= hi for lo, v, hi in
               zip(result.lower, result.volumes, result.upper))
    # a clean synthetic series should backtest well
    assert result.mape is not None and result.mape < 0.15


def test_backtest_scores_every_model() -> None:
    scores = backtest(_series())
    assert set(scores) == {
        "seasonal_naive", "moving_average", "exp_smoothing", "holt_winters", "regression"
    }
    assert all(score >= 0 for score in scores.values())


def test_holiday_damping_applied() -> None:
    points = _series()
    holiday = points[-1].day + timedelta(days=3)
    with_holiday = generate_forecast(points, 7, model="moving_average",
                                     holiday_days={holiday})
    without = generate_forecast(points, 7, model="moving_average")
    idx = [i for i, d in enumerate(without.days) if d == holiday][0]
    assert with_holiday.volumes[idx] == pytest.approx(without.volumes[idx] * 0.5, rel=0.01)


def test_short_history_rejected() -> None:
    with pytest.raises(ValueError):
        generate_forecast(_series(5), horizon=7)


def test_mape_ignores_zero_actuals() -> None:
    assert mape([0, 100], [50, 110]) == pytest.approx(0.1)


def test_interval_distribution_conserves_volume() -> None:
    for minutes, buckets in ((15, 96), (30, 48), (60, 24)):
        volumes = distribute_to_intervals(1000, minutes)
        assert len(volumes) == buckets
        assert sum(volumes) == pytest.approx(1000, rel=0.01)
