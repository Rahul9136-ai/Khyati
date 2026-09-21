"""New Hire pipeline engine (the New Hire Plotter logic).

A hiring batch flows Hiring → Training → Nesting → Production. The productive
output is throttled by hiring and training throughput and rounded like the
workbook (``ROUND(x, 0)``), then lands in the month the batch reaches
production (hire date + training days + nesting days). That monthly production
series feeds Ramp in the capacity engine.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from app.modules.hcplanning.engine.dates import month_key


@dataclass
class HiringBatch:
    """A planned intake: ``planned_hires`` recruited on ``hire_date``."""

    hire_date: date
    planned_hires: float
    # optional per-batch overrides; fall back to config when None
    hiring_throughput: float | None = None
    training_throughput: float | None = None
    training_days: int | None = None
    nesting_days: int | None = None
    label: str = ""


@dataclass
class BatchStages:
    hire_date: date
    training_start: date
    nesting_start: date
    production_date: date
    planned_hires: float
    successful_hires: float      # after hiring throughput
    entering_training: float     # after training throughput
    production: float            # productive agents reaching the floor
    production_month: str


def _round0(x: float) -> float:
    """Excel ROUND(x, 0) — round half away from zero (banker's rounding differs)."""
    import math
    return math.floor(x + 0.5) if x >= 0 else math.ceil(x - 0.5)


def batch_stages(
    batch: HiringBatch,
    *,
    hiring_throughput: float,
    training_throughput: float,
    training_days: int,
    nesting_days: int,
) -> BatchStages:
    ht = batch.hiring_throughput if batch.hiring_throughput is not None else hiring_throughput
    tt = (batch.training_throughput if batch.training_throughput is not None
          else training_throughput)
    td = batch.training_days if batch.training_days is not None else training_days
    nd = batch.nesting_days if batch.nesting_days is not None else nesting_days

    successful = _round0(batch.planned_hires * ht)
    entering_training = _round0(successful * tt)
    # production = planned × hiring × training throughput, rounded (workbook parity)
    production = _round0(batch.planned_hires * ht * tt)

    training_start = batch.hire_date
    nesting_start = training_start + timedelta(days=td)
    production_date = nesting_start + timedelta(days=nd)
    return BatchStages(
        hire_date=batch.hire_date,
        training_start=training_start,
        nesting_start=nesting_start,
        production_date=production_date,
        planned_hires=batch.planned_hires,
        successful_hires=successful,
        entering_training=entering_training,
        production=production,
        production_month=month_key(production_date),
    )


def production_by_month(
    batches: list[HiringBatch],
    *,
    hiring_throughput: float,
    training_throughput: float,
    training_days: int,
    nesting_days: int,
) -> dict[str, float]:
    """Total productive new-hire output per production month (feeds Ramp)."""
    out: dict[str, float] = {}
    for b in batches:
        s = batch_stages(
            b, hiring_throughput=hiring_throughput, training_throughput=training_throughput,
            training_days=training_days, nesting_days=nesting_days,
        )
        out[s.production_month] = out.get(s.production_month, 0.0) + s.production
    return out


def pipeline(
    batches: list[HiringBatch],
    *,
    hiring_throughput: float,
    training_throughput: float,
    training_days: int,
    nesting_days: int,
) -> list[BatchStages]:
    return [
        batch_stages(
            b, hiring_throughput=hiring_throughput, training_throughput=training_throughput,
            training_days=training_days, nesting_days=nesting_days,
        )
        for b in batches
    ]
