"""Per-agent monthly status logic.

An agent contributes to a planning category (FTE, Ramp, …) in a given month
when: it belongs to the selected LOB that month, it is productive that month
(its Date of Production has been reached and it is not yet inactive), and its
Status maps to that category. This reproduces the workbook's per-agent monthly
cell — the ``LEFT(cell,1)`` productive flag and the Status/LOB match in the
SUMPRODUCT — but derives it dynamically instead of reading precomputed cells.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from app.modules.hcplanning.engine.config import PlanningConfig, TenureBand
from app.modules.hcplanning.engine.dates import (
    month_first_day,
    month_index,
    tenure_months,
)


@dataclass
class AgentRecord:
    """The planning-relevant projection of an agent (from Employee + profile)."""

    status: str
    lob: str
    location: str | None = None
    experience: str | None = None  # "Fresher" | "Lateral"
    dop: date | None = None         # Date of Production
    inactive: date | None = None    # Inactive / termination date
    move_out: date | None = None    # leaves current LOB on/after this date
    move_in: date | None = None     # joins target LOB on/after this date
    target_lob: str | None = None   # LOB joined on move_in
    name: str = ""


def effective_lob(agent: AgentRecord, month: str) -> str | None:
    """The LOB the agent counts against in a month, honouring planned movement.

    Before a move-out it is the home LOB; from the move-in month it is the
    target LOB; between move-out and move-in the agent is in transition and
    counts against no LOB.
    """
    mi = month_index(month)
    if agent.move_out and mi >= month_index(_mk(agent.move_out)):
        if agent.move_in and mi >= month_index(_mk(agent.move_in)):
            return agent.target_lob or agent.lob
        return None  # in transition
    return agent.lob


def is_productive(agent: AgentRecord, month: str) -> bool:
    """True when the agent is live production headcount in ``month``.

    Productive from the month containing its DOP, up to (but not including) the
    month it goes inactive. Missing DOP ⇒ never productive (§34 edge case).
    """
    if agent.dop is None:
        return False
    mi = month_index(month)
    if mi < month_index(_mk(agent.dop)):
        return False
    if agent.inactive is not None and mi >= month_index(_mk(agent.inactive)):
        return False
    return True


def tenure_bucket(months: float, bands: tuple[TenureBand, ...]) -> str:
    for band in bands:
        if band.months_to is None or months <= band.months_to:
            return band.bucket
    return bands[-1].bucket if bands else "?"


def agent_tenure_months(agent: AgentRecord, month: str) -> float | None:
    if agent.dop is None:
        return None
    return tenure_months(agent.dop, month)


def is_fresher(agent: AgentRecord, month: str) -> bool | None:
    """Tenure-based fresher (<1 yr) vs lateral (>1 yr) — the workbook's
    ``<1`` / ``>1`` tag. Measured at month granularity (whole months elapsed
    since the DOP month), matching how the workbook flips the tag on the
    12-month boundary."""
    if agent.dop is None:
        return None
    return (month_index(month) - month_index(_mk(agent.dop))) < 12


def category_counts(
    agents: list[AgentRecord], lob: str, month: str, cfg: PlanningConfig
) -> dict[str, float]:
    """Roster count per production Status for one LOB and month (the SUMPRODUCT).

    Returns a dict keyed by Status; every production status is present (0 when
    no agent matches) so downstream sums are stable.
    """
    counts: dict[str, float] = dict.fromkeys(cfg.production_statuses, 0.0)
    for a in agents:
        if effective_lob(a, month) != lob:
            continue
        if not is_productive(a, month):
            continue
        if a.status in counts:
            counts[a.status] += 1.0
    return counts


def _mk(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def resource_mix(
    agents: list[AgentRecord], lob: str, month: str, cfg: PlanningConfig
) -> dict[str, float]:
    """Fresher (<1 yr) vs Lateral (>1 yr) productive headcount for the month."""
    fresher = lateral = 0.0
    for a in agents:
        if effective_lob(a, month) != lob or not is_productive(a, month):
            continue
        f = is_fresher(a, month)
        if f is True:
            fresher += 1
        elif f is False:
            lateral += 1
    return {"fresher_lt_1yr": fresher, "lateral_gt_1yr": lateral}


# re-export month_first_day for callers that build tenure tables
__all__ = [
    "AgentRecord", "effective_lob", "is_productive", "tenure_bucket",
    "agent_tenure_months", "is_fresher", "category_counts", "resource_mix",
    "month_first_day",
]
