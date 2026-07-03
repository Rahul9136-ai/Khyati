"""Unit tests for the Erlang C/A engine against known reference values."""
from __future__ import annotations

import math

from app.modules.planning.erlang import (
    average_speed_of_answer,
    erlang_a_abandonment,
    erlang_c_wait_probability,
    occupancy,
    required_agents,
    service_level,
    staffing_curve,
)


def test_wait_probability_reference_value() -> None:
    # Classic textbook case: A = 10 erlangs, N = 11 agents → P(wait) ≈ 0.68
    pw = erlang_c_wait_probability(11, 10.0)
    assert 0.65 < pw < 0.71


def test_unstable_system_saturates() -> None:
    assert erlang_c_wait_probability(5, 10.0) == 1.0
    assert service_level(5, 10.0, 300, 30) == 0.0
    assert math.isinf(average_speed_of_answer(5, 10.0, 300))


def test_service_level_monotonic_in_agents() -> None:
    intensity = 20.0
    levels = [service_level(n, intensity, 300, 30) for n in range(21, 35)]
    assert all(b >= a for a, b in zip(levels, levels[1:]))
    assert levels[-1] > 0.99


def test_required_agents_meets_targets() -> None:
    result = required_agents(
        volume=100, aht_seconds=300, interval_seconds=1800,
        sla_target=0.8, sla_threshold_seconds=30, max_occupancy=0.9,
        shrinkage=0.3,
    )
    assert result.intensity_erlangs == round(100 * 300 / 1800, 3)  # ≈16.67
    assert result.service_level >= 0.8
    assert result.occupancy <= 0.9
    # shrinkage inflates scheduled bodies: ceil(agents / 0.7)
    assert result.agents_with_shrinkage == math.ceil(result.agents / 0.7)


def test_chat_concurrency_reduces_agents() -> None:
    voice = required_agents(volume=60, aht_seconds=480, concurrency=1.0)
    chat = required_agents(volume=60, aht_seconds=480, concurrency=2.0)
    assert chat.agents < voice.agents


def test_erlang_a_abandonment_bounds() -> None:
    ab = erlang_a_abandonment(18, 16.67, 300, patience_seconds=90)
    assert 0.0 <= ab < 1.0
    # infinitely patient callers never abandon (approaches zero)
    patient = erlang_a_abandonment(18, 16.67, 300, patience_seconds=1e9)
    assert patient < ab


def test_staffing_curve_shape() -> None:
    curve = staffing_curve(volume=100, aht_seconds=300)
    assert len(curve) >= 8
    assert curve[0]["agents"] == 17  # ceil(16.67)
    sls = [row["service_level"] for row in curve]
    assert sls == sorted(sls)


def test_occupancy_basic() -> None:
    assert occupancy(20, 10.0) == 0.5
    assert occupancy(10, 20.0) == 1.0
