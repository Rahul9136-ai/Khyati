"""Excel-validation + unit tests for the HC planning engine.

`test_matches_ags_health_cp` is the mandatory validation (§33): it drives the
pure engine with the agent population extracted from the AGS Planning Framework
workbook and asserts every AGS Health CP metric, for all 14 months, matches the
workbook's own results within a floating-point tolerance.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from app.modules.hcplanning.engine.agents import AgentRecord, is_productive
from app.modules.hcplanning.engine.capacity import (
    build_capacity_table,
    required_hc,
)
from app.modules.hcplanning.engine.config import PlanningConfig

FIXTURE = Path(__file__).parent / "fixtures" / "ags_health_cp.json"
TOL = 0.05  # headcount tolerance; percentages compared at 3dp below


def _load():
    return json.loads(FIXTURE.read_text())


def _date(s):
    return date.fromisoformat(s) if s else None


def _agents(data):
    return [
        AgentRecord(
            status=a["status"], lob=a["lob"], location=a["location"],
            experience=a["experience"], dop=_date(a["dop"]), inactive=_date(a["inactive"]),
            move_out=_date(a["move_out"]), move_in=_date(a["move_in"]), name=a["name"],
        )
        for a in data["agents"] if a["status"]
    ]


def test_matches_ags_health_cp():
    data = _load()
    months = [m["key"] for m in data["months"]]
    agents = _agents(data)
    exp = data["expected"]
    billable = {m: exp["billable"][i] for i, m in enumerate(months)}

    cfg = PlanningConfig(
        ooo_shrinkage=0.04, io_shrinkage=0.04, attrition=0.0125,
        weekly_hours=40, actuals_through=months[4],
    )
    # New-hire production feeding Ramp, per the New Hire Plotter (20→17, 30→26).
    newhire = {months[6]: 17.0, months[12]: 26.0}
    table = build_capacity_table(
        agents, "Credit Balance", months, billable, cfg,
        newhire_production_by_month=newhire,
    )

    checks = {
        "required_hc": "required_hc", "production_agents": "production_agents",
        "fte": "fte", "ramp": "ramp", "fte_ramp": "fte_ramp", "closing_hc": "closing_hc",
        "capacity_pct": "capacity_pct", "excess_deficit": "excess_deficit",
        "ot_vto": "ot_vto_hours", "notice": "notice_period", "ojt": "ojt",
        "maternity_leave": "maternity_leave", "overall_util": "overall_utilization",
        "productive_util": "productive_utilization", "buffer": "buffer_pct",
        "fresher_lt_1yr": "fresher_lt_1yr", "lateral_gt_1yr": "lateral_gt_1yr",
    }
    for exp_key, field in checks.items():
        got = table.row(field)
        want = exp[exp_key]
        for i, (g, w) in enumerate(zip(got, want)):
            if g is None and w is None:
                continue
            g = g or 0.0
            w = w or 0.0
            assert abs(g - w) <= TOL, (
                f"{exp_key} @ {months[i]}: engine={g:.4f} workbook={w:.4f}"
            )


def test_required_hc_formula():
    # 190 / ((1-0.04)(1-0.04)) = 206.163…
    assert required_hc(190, 0.04, 0.04) == pytest.approx(206.16, abs=0.01)
    # zero shrinkage ⇒ Required HC == Billable
    assert required_hc(100, 0.0, 0.0) == 100


def test_required_hc_rejects_full_shrinkage():
    with pytest.raises(ValueError):
        required_hc(100, 1.0, 0.0)


def test_config_validate_rejects_bad_shrinkage():
    with pytest.raises(ValueError):
        PlanningConfig(ooo_shrinkage=1.0).validate()
    with pytest.raises(ValueError):
        PlanningConfig(io_shrinkage=-0.1).validate()


def test_empty_population_is_zero_not_error():
    months = ["2026-01", "2026-02"]
    cfg = PlanningConfig()
    table = build_capacity_table([], "X", months, {"2026-01": 0, "2026-02": 0}, cfg)
    for r in table.results:
        assert r.production_agents == 0
        assert r.fte_ramp == 0
        assert r.capacity_pct is None  # required HC is 0 → guarded, no divide-by-zero


def test_missing_dop_agent_never_productive():
    a = AgentRecord(status="FTE", lob="X", dop=None)
    assert is_productive(a, "2026-05") is False


def test_future_dop_not_productive_until_reached():
    a = AgentRecord(status="FTE", lob="X", dop=date(2026, 6, 1))
    assert is_productive(a, "2026-05") is False
    assert is_productive(a, "2026-06") is True


def test_inactive_agent_drops_out():
    a = AgentRecord(status="FTE", lob="X", dop=date(2025, 1, 1), inactive=date(2026, 4, 15))
    assert is_productive(a, "2026-03") is True
    assert is_productive(a, "2026-04") is False


def test_closing_hc_override_and_flag():
    months = ["2026-01"]
    agents = [AgentRecord(status="FTE", lob="X", dop=date(2020, 1, 1))]
    cfg = PlanningConfig()
    table = build_capacity_table(agents, "X", months, {"2026-01": 1}, cfg,
                                 closing_overrides={"2026-01": 5})
    r = table.results[0]
    assert r.closing_hc == 5 and r.closing_overridden is True
    assert r.fte_ramp == 1  # calculated value preserved alongside the override
