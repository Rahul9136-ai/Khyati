"""Forecasting engine: cleaning, five models, backtesting, model selection.

Pure functions over (date, volume) daily series — no I/O, fully unit-testable.
Models (mirrors of the TypeScript engine already proven in the frontend):
  1. seasonal_naive     — last observed value for the same weekday
  2. moving_average     — trailing 28-day mean, weekday-indexed
  3. exp_smoothing      — simple exponential smoothing + weekday index
  4. holt_winters       — additive trend + weekly (7) seasonality
  5. regression         — OLS trend + weekday seasonality index
`auto` backtests every model on a holdout window and picks the lowest MAPE.
"""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field
from datetime import date, timedelta

SEASON = 7  # weekly seasonality on daily data


@dataclass
class SeriesPoint:
    day: date
    volume: float
    aht: float | None = None


@dataclass
class CleaningReport:
    filled_gaps: int = 0
    outliers_capped: int = 0
    holidays_flagged: list[str] = field(default_factory=list)


def clean_series(
    points: list[SeriesPoint], holiday_days: set[date] | None = None
) -> tuple[list[SeriesPoint], CleaningReport]:
    """Sort, fill calendar gaps (linear interpolation), cap MAD outliers.

    Holidays are flagged (not altered) so models can exclude them from the
    weekday index; the caller re-applies holiday dampening on the forecast.
    """
    report = CleaningReport()
    if not points:
        return [], report
    holiday_days = holiday_days or set()
    by_day = {p.day: p for p in sorted(points, key=lambda p: p.day)}
    days = sorted(by_day)
    full: list[SeriesPoint] = []
    cursor = days[0]
    while cursor <= days[-1]:
        if cursor in by_day:
            p = by_day[cursor]
            full.append(SeriesPoint(cursor, max(0.0, p.volume), p.aht))
        else:
            # linear interpolation between neighbours
            prev = full[-1].volume if full else 0.0
            nxt_day = next((d for d in days if d > cursor), None)
            nxt = by_day[nxt_day].volume if nxt_day else prev
            span = (nxt_day - cursor).days + 1 if nxt_day else 1
            full.append(SeriesPoint(cursor, prev + (nxt - prev) / max(span, 1)))
            report.filled_gaps += 1
        cursor += timedelta(days=1)

    volumes = [p.volume for p in full]
    med = statistics.median(volumes)
    mad = statistics.median([abs(v - med) for v in volumes]) or 1.0
    upper, lower = med + 5 * 1.4826 * mad, max(0.0, med - 5 * 1.4826 * mad)
    for p in full:
        if p.volume > upper or p.volume < lower:
            p.volume = min(max(p.volume, lower), upper)
            report.outliers_capped += 1
        if p.day in holiday_days:
            report.holidays_flagged.append(p.day.isoformat())
    return full, report


# ------------------------------------------------------------------ helpers


def _weekday_index(points: list[SeriesPoint]) -> list[float]:
    """Multiplicative index per weekday vs overall mean (1.0 = average day)."""
    overall = statistics.fmean([p.volume for p in points]) or 1.0
    idx = []
    for wd in range(7):
        vals = [p.volume for p in points if p.day.weekday() == wd]
        idx.append((statistics.fmean(vals) / overall) if vals else 1.0)
    return idx


def _future_days(last: date, horizon: int) -> list[date]:
    return [last + timedelta(days=i + 1) for i in range(horizon)]


# ------------------------------------------------------------------- models


def seasonal_naive(points: list[SeriesPoint], horizon: int) -> list[float]:
    last_by_wd: dict[int, float] = {}
    for p in points:
        last_by_wd[p.day.weekday()] = p.volume
    fallback = points[-1].volume
    return [last_by_wd.get(d.weekday(), fallback) for d in _future_days(points[-1].day, horizon)]


def moving_average(points: list[SeriesPoint], horizon: int, window: int = 28) -> list[float]:
    recent = points[-window:]
    base = statistics.fmean([p.volume for p in recent])
    idx = _weekday_index(points)
    return [base * idx[d.weekday()] for d in _future_days(points[-1].day, horizon)]


def exp_smoothing(points: list[SeriesPoint], horizon: int, alpha: float = 0.3) -> list[float]:
    idx = _weekday_index(points)
    level = points[0].volume / (idx[points[0].day.weekday()] or 1.0)
    for p in points[1:]:
        deseason = p.volume / (idx[p.day.weekday()] or 1.0)
        level = alpha * deseason + (1 - alpha) * level
    return [level * idx[d.weekday()] for d in _future_days(points[-1].day, horizon)]


def holt_winters(
    points: list[SeriesPoint], horizon: int, alpha: float = 0.25, beta: float = 0.05,
    gamma: float = 0.2,
) -> list[float]:
    """Additive Holt-Winters with weekly season; falls back if history < 2 seasons."""
    if len(points) < 2 * SEASON:
        return exp_smoothing(points, horizon)
    vals = [p.volume for p in points]
    season = [vals[i] - statistics.fmean(vals[:SEASON]) for i in range(SEASON)]
    level = statistics.fmean(vals[:SEASON])
    trend = (statistics.fmean(vals[SEASON : 2 * SEASON]) - level) / SEASON
    for i in range(SEASON, len(vals)):
        s = season[i % SEASON]
        last_level = level
        level = alpha * (vals[i] - s) + (1 - alpha) * (level + trend)
        trend = beta * (level - last_level) + (1 - beta) * trend
        season[i % SEASON] = gamma * (vals[i] - level) + (1 - gamma) * s
    n = len(vals)
    return [
        max(0.0, level + (h + 1) * trend + season[(n + h) % SEASON]) for h in range(horizon)
    ]


def regression(points: list[SeriesPoint], horizon: int) -> list[float]:
    """OLS linear trend on deseasonalised data, weekday index re-applied."""
    idx = _weekday_index(points)
    ys = [p.volume / (idx[p.day.weekday()] or 1.0) for p in points]
    n = len(ys)
    xs = list(range(n))
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    denom = sum((x - mx) ** 2 for x in xs) or 1.0
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom
    intercept = my - slope * mx
    return [
        max(0.0, (intercept + slope * (n + h)) * idx[d.weekday()])
        for h, d in enumerate(_future_days(points[-1].day, horizon))
    ]


MODELS = {
    "seasonal_naive": seasonal_naive,
    "moving_average": moving_average,
    "exp_smoothing": exp_smoothing,
    "holt_winters": holt_winters,
    "regression": regression,
}


# ------------------------------------------------------- backtest & generate


def mape(actual: list[float], predicted: list[float]) -> float:
    pairs = [(a, p) for a, p in zip(actual, predicted) if a > 0]
    if not pairs:
        return math.inf
    return sum(abs(a - p) / a for a, p in pairs) / len(pairs)


def backtest(points: list[SeriesPoint], holdout: int = 14) -> dict[str, float]:
    """MAPE per model on the last `holdout` days (needs 4+ weeks of history)."""
    holdout = min(holdout, max(1, len(points) // 4))
    train, test = points[:-holdout], points[-holdout:]
    if len(train) < 2 * SEASON:
        return dict.fromkeys(MODELS, math.inf)
    actual = [p.volume for p in test]
    return {name: mape(actual, fn(train, holdout)) for name, fn in MODELS.items()}


@dataclass
class ForecastResult:
    model: str
    mape: float | None                    # backtest MAPE of the chosen model
    backtest: dict[str, float]
    days: list[date]
    volumes: list[float]
    lower: list[float]
    upper: list[float]
    ahts: list[float]


def generate_forecast(
    points: list[SeriesPoint],
    horizon: int,
    model: str = "auto",
    holiday_days: set[date] | None = None,
    holiday_damping: float = 0.5,
) -> ForecastResult:
    if len(points) < SEASON:
        raise ValueError("Need at least 7 days of history to forecast")
    scores = backtest(points)
    if model == "auto":
        model = min(scores, key=lambda k: scores[k])
    if model not in MODELS:
        raise ValueError(f"Unknown model {model}; options: auto, {', '.join(MODELS)}")

    volumes = MODELS[model](points, horizon)
    days = _future_days(points[-1].day, horizon)

    # dampen known holidays in the horizon
    holiday_days = holiday_days or set()
    volumes = [
        v * holiday_damping if d in holiday_days else v for d, v in zip(days, volumes)
    ]

    # confidence band from in-sample residual spread (±1.96σ)
    fitted = MODELS[model](points[:-SEASON], SEASON) if len(points) > 2 * SEASON else volumes
    resid_base = [p.volume for p in points[-SEASON:]]
    sigma = (
        statistics.pstdev([a - f for a, f in zip(resid_base, fitted)])
        if len(fitted) == len(resid_base) and len(resid_base) > 1
        else statistics.pstdev([p.volume for p in points]) * 0.25
    )
    lower = [max(0.0, v - 1.96 * sigma) for v in volumes]
    upper = [v + 1.96 * sigma for v in volumes]

    # AHT forecast: trailing 28-day mean of provided AHTs (flat is standard)
    ahts_hist = [p.aht for p in points[-28:] if p.aht]
    aht = statistics.fmean(ahts_hist) if ahts_hist else 0.0
    score = scores.get(model)
    return ForecastResult(
        model=model,
        mape=None if score is None or math.isinf(score) else round(score, 4),
        backtest={k: (round(v, 4) if math.isfinite(v) else -1.0) for k, v in scores.items()},
        days=days,
        volumes=[round(v, 1) for v in volumes],
        lower=[round(v, 1) for v in lower],
        upper=[round(v, 1) for v in upper],
        ahts=[round(aht, 1)] * horizon,
    )


# ----------------------------------------------------- interval distribution

# Typical bimodal contact-centre arrival profile for a business day, one weight
# per half-hour from 00:00 to 23:30. Used to split daily volume into intervals.
_HALF_HOUR_PROFILE = [
    0.2, 0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.3, 0.4, 0.6,        # 00:00-04:30
    0.8, 1.0, 1.4, 1.8, 2.4, 3.2, 4.2, 5.0, 5.6, 5.8,        # 05:00-09:30
    5.9, 5.7, 5.2, 4.8, 4.4, 4.2, 4.3, 4.6, 5.0, 5.2,        # 10:00-14:30
    5.1, 4.8, 4.3, 3.7, 3.0, 2.4, 1.9, 1.5, 1.2, 1.0,        # 15:00-19:30
    0.8, 0.7, 0.5, 0.4, 0.3, 0.3, 0.2, 0.2,                  # 20:00-23:30
]


def distribute_to_intervals(daily_volume: float, interval_minutes: int = 30) -> list[float]:
    """Split one day's volume into 15/30/60-minute buckets using the profile."""
    total = sum(_HALF_HOUR_PROFILE)
    halves = [daily_volume * w / total for w in _HALF_HOUR_PROFILE]
    if interval_minutes == 30:
        return [round(v, 2) for v in halves]
    if interval_minutes == 60:
        return [round(halves[i] + halves[i + 1], 2) for i in range(0, 48, 2)]
    if interval_minutes == 15:
        return [round(v / 2, 2) for v in halves for _ in (0, 1)]
    raise ValueError("interval_minutes must be 15, 30 or 60")
