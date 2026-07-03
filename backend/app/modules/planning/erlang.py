"""Erlang C / Erlang A staffing mathematics (pure functions, no I/O).

All formulas work on one interval at a time:
  intensity (erlangs) A = volume * AHT / interval_seconds
Erlang C gives P(wait); service level and ASA follow analytically.
Erlang A adds exponentially distributed caller patience (abandonment) using
the standard Palm approximation. Probabilities are computed iteratively to
stay numerically stable at high agent counts (500+ erlangs).
"""
from __future__ import annotations

import math
from dataclasses import dataclass


def erlang_c_wait_probability(agents: int, intensity: float) -> float:
    """P(wait > 0) for an M/M/N queue. Returns 1.0 when the system is unstable."""
    if agents <= 0:
        return 1.0
    if intensity <= 0:
        return 0.0
    if agents <= intensity:
        return 1.0
    # Iteratively build the Erlang B blocking probability, then convert to C.
    b = 1.0
    for k in range(1, agents + 1):
        b = (intensity * b) / (k + intensity * b)
    rho = intensity / agents
    return b / (1 - rho + rho * b)


def service_level(
    agents: int, intensity: float, aht_seconds: float, threshold_seconds: float
) -> float:
    """Fraction of contacts answered within the threshold."""
    if agents <= intensity:
        return 0.0
    pw = erlang_c_wait_probability(agents, intensity)
    exponent = -(agents - intensity) * threshold_seconds / aht_seconds
    return max(0.0, min(1.0, 1 - pw * math.exp(exponent)))


def average_speed_of_answer(agents: int, intensity: float, aht_seconds: float) -> float:
    """ASA in seconds (infinite when unstable)."""
    if agents <= intensity:
        return float("inf")
    pw = erlang_c_wait_probability(agents, intensity)
    return pw * aht_seconds / (agents - intensity)


def occupancy(agents: int, intensity: float) -> float:
    if agents <= 0:
        return 1.0
    return min(1.0, intensity / agents)


def erlang_a_abandonment(
    agents: int, intensity: float, aht_seconds: float, patience_seconds: float
) -> float:
    """Approximate abandonment rate with exponential patience (Erlang A).

    Uses P(abandon) ≈ P(wait) * (1 - patience/(patience + expected_wait_factor)),
    a first-order Palm approximation adequate for planning purposes.
    """
    if agents <= 0:
        return 1.0
    pw = erlang_c_wait_probability(agents, intensity)
    if agents <= intensity:
        return min(1.0, pw)
    expected_wait = pw * aht_seconds / (agents - intensity)
    if patience_seconds <= 0:
        return pw
    return pw * expected_wait / (expected_wait + patience_seconds)


@dataclass
class StaffingResult:
    agents: int                # bodies needed in-chair for the interval
    agents_with_shrinkage: int  # scheduled bodies once shrinkage is applied
    intensity_erlangs: float
    service_level: float
    asa_seconds: float
    occupancy: float
    abandonment: float


def required_agents(
    *,
    volume: float,
    aht_seconds: float,
    interval_seconds: int = 1800,
    sla_target: float = 0.8,
    sla_threshold_seconds: float = 30,
    max_occupancy: float = 0.9,
    shrinkage: float = 0.0,
    concurrency: float = 1.0,
    patience_seconds: float = 90,
) -> StaffingResult:
    """Smallest agent count meeting the SLA target and the occupancy cap.

    `concurrency` > 1 (chat) divides effective AHT. `shrinkage` inflates the
    scheduled requirement, it does not change queue mathematics.
    """
    effective_aht = aht_seconds / max(concurrency, 1e-9)
    intensity = volume * effective_aht / interval_seconds
    if intensity <= 0:
        return StaffingResult(0, 0, 0.0, 1.0, 0.0, 0.0, 0.0)

    agents = max(1, math.ceil(intensity))
    for _ in range(100_000):
        sl = service_level(agents, intensity, effective_aht, sla_threshold_seconds)
        occ = occupancy(agents, intensity)
        if sl >= sla_target and occ <= max_occupancy:
            break
        agents += 1

    scheduled = math.ceil(agents / max(1e-9, 1 - min(shrinkage, 0.99)))
    return StaffingResult(
        agents=agents,
        agents_with_shrinkage=scheduled,
        intensity_erlangs=round(intensity, 3),
        service_level=round(
            service_level(agents, intensity, effective_aht, sla_threshold_seconds), 4
        ),
        asa_seconds=round(average_speed_of_answer(agents, intensity, effective_aht), 1),
        occupancy=round(occupancy(agents, intensity), 4),
        abandonment=round(
            erlang_a_abandonment(agents, intensity, effective_aht, patience_seconds), 4
        ),
    )


def staffing_curve(
    *,
    volume: float,
    aht_seconds: float,
    interval_seconds: int = 1800,
    sla_threshold_seconds: float = 30,
    patience_seconds: float = 90,
    span: int = 8,
) -> list[dict]:
    """SL/ASA/occupancy for agent counts around the stability point (for charts)."""
    intensity = volume * aht_seconds / interval_seconds
    start = max(1, math.ceil(intensity))
    curve = []
    for n in range(start, start + span + 1):
        curve.append(
            {
                "agents": n,
                "service_level": round(
                    service_level(n, intensity, aht_seconds, sla_threshold_seconds), 4
                ),
                "asa_seconds": round(
                    min(average_speed_of_answer(n, intensity, aht_seconds), 9999), 1
                ),
                "occupancy": round(occupancy(n, intensity), 4),
                "abandonment": round(
                    erlang_a_abandonment(n, intensity, aht_seconds, patience_seconds), 4
                ),
            }
        )
    return curve
