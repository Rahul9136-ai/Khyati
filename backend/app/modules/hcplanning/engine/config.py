"""Planning configuration — the tunable assumptions behind the capacity model.

Every value here is derived from the AGS Planning Framework workbook but is a
configurable business input, never a hard-coded constant in the calc functions.
Monthly overrides are supported (a dict keyed by ``YYYY-MM``); a scalar default
applies to any month not overridden.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# The agent Status values that count toward the monthly production categories,
# in the exact order the workbook's "Production Agents" sum uses (rows 11-19).
PRODUCTION_STATUSES: tuple[str, ...] = (
    "FTE", "Ramp", "Notice Period", "OJT", "Investment Bench", "Ops Bench",
    "Training", "Long Leave", "Maternity Leave",
)

# Denominator of Productive Utilization % — the workbook uses FTE + Ramp +
# Notice Period + Ops Bench (=SUM(C11:C13,C16)).
PRODUCTIVE_UTIL_STATUSES: tuple[str, ...] = ("FTE", "Ramp", "Notice Period", "Ops Bench")

# Statuses present in the roster that are deliberately NOT production capacity
# (support / QA / leadership). Kept for transparency; anything not in
# PRODUCTION_STATUSES is simply excluded from Production Agents.
NON_PRODUCTION_STATUSES: tuple[str, ...] = ("TTL&Above", "QA")


@dataclass(frozen=True)
class TenureBand:
    """A tenure bucket: agents with tenure <= ``months_to`` fall in ``bucket``.

    ``months_to`` of ``None`` is the open-ended final band (e.g. ">84 months").
    ``productivity`` is a 0..1 factor available for models that ramp partial
    productivity by tenure; the AGS workbook treats productive agents as 1.0.
    """

    bucket: str
    months_to: float | None
    label: str = ""
    productivity: float = 1.0


# Default tenure→bucket bands, exactly as the workbook's AGS Config table.
DEFAULT_TENURE_BANDS: tuple[TenureBand, ...] = (
    TenureBand("A", 6, "A. 0 - 6 mths"),
    TenureBand("B", 12, "B. 7 - 12 mths"),
    TenureBand("C", 24, "C. 13 - 24 mths"),
    TenureBand("D", 36, "D. 25 - 36 mths"),
    TenureBand("E", 48, "E. 37 - 48 mths"),
    TenureBand("F", 60, "F. 49 - 60 mths"),
    TenureBand("G", 72, "G. 61 - 72 mths"),
    TenureBand("H", 84, "H. 73 - 84 mths"),
    TenureBand("I", None, "I. > 84 mths"),
)


@dataclass
class PlanningConfig:
    """Assumptions for a capacity plan. Scalars are defaults; ``*_by_month``
    dicts override a specific month (``YYYY-MM`` → value)."""

    ooo_shrinkage: float = 0.04
    io_shrinkage: float = 0.04
    attrition: float = 0.0125
    weekly_hours: float = 40.0
    hiring_throughput: float = 0.90
    training_throughput: float = 0.95
    training_days: int = 21   # hire → nesting
    nesting_days: int = 9     # nesting → production (21 + 9 ≈ one month)

    ooo_by_month: dict[str, float] = field(default_factory=dict)
    io_by_month: dict[str, float] = field(default_factory=dict)
    attrition_by_month: dict[str, float] = field(default_factory=dict)

    # Months up to and including this ``YYYY-MM`` are treated as actuals: their
    # FTE/Ramp come straight from the roster. Later months are projected
    # (attrition decay + new-hire production). ``None`` ⇒ roster for all months.
    actuals_through: str | None = None

    tenure_bands: tuple[TenureBand, ...] = DEFAULT_TENURE_BANDS
    production_statuses: tuple[str, ...] = PRODUCTION_STATUSES
    productive_util_statuses: tuple[str, ...] = PRODUCTIVE_UTIL_STATUSES

    def ooo(self, month: str) -> float:
        return self.ooo_by_month.get(month, self.ooo_shrinkage)

    def io(self, month: str) -> float:
        return self.io_by_month.get(month, self.io_shrinkage)

    def attr(self, month: str) -> float:
        return self.attrition_by_month.get(month, self.attrition)

    def validate(self) -> None:
        """Guard against the degenerate shrinkage cases (§34)."""
        for name, v in (("ooo_shrinkage", self.ooo_shrinkage),
                        ("io_shrinkage", self.io_shrinkage)):
            if not 0 <= v < 1:
                raise ValueError(f"{name} must be in [0, 1); got {v}")
        for m, v in {**self.ooo_by_month, **self.io_by_month}.items():
            if not 0 <= v < 1:
                raise ValueError(f"shrinkage for {m} must be in [0, 1); got {v}")
