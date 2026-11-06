"""Capacity Planning engine: parity with the browser engine + the §6 golden cases.

tests/fixtures/capacity_parity.json is written by the frontend test
frontend/src/lib/capacity/parity.test.ts from the TypeScript engine. Here the
Python engine runs the same inputs and every field must match, so the API and
the screens can never disagree.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from app.modules.capacity.calc import (
    base_fte_transaction,
    flat_ramp_production,
    hc_production,
    hc_qca,
    num,
    parse_month,
    safe_div,
    volume_based,
)
from app.modules.capacity.engine import run_engine

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "capacity_parity.json").read_text("utf-8")
)


def _close(a, b, path: str) -> None:  # noqa: ANN001
    if isinstance(a, dict) and isinstance(b, dict):
        assert set(a) == set(b), f"{path}: keys differ {set(a) ^ set(b)}"
        for k in a:
            _close(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list) and isinstance(b, list):
        assert len(a) == len(b), f"{path}: length {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b, strict=True)):
            _close(x, y, f"{path}[{i}]")
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        assert math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-9), f"{path}: python {a} != browser {b}"
    else:
        assert a == b, f"{path}: python {a!r} != browser {b!r}"


@pytest.mark.parametrize(
    "scenario", FIXTURE["scenarios"], ids=[s["name"] for s in FIXTURE["scenarios"]]
)
def test_python_engine_matches_browser_engine(scenario: dict) -> None:
    got = run_engine(scenario["dataset"], scenario["config"])
    exp = scenario["expected"]
    assert got["months"] == exp["months"]

    rows = {(r["key"], r["month"]): r for r in got["rows"]}
    assert len(rows) == len(exp["rows"])
    for e in exp["rows"]:
        g = rows[(e["key"], e["month"])]
        g = {**g, "tasks": [{k: v for k, v in t.items() if k != "sourceRows"} for t in g["tasks"]]}
        _close(g, e, f"{scenario['name']}:{e['key']}:{e['month']}")

    ex = sorted(
        (
            {"code": x["code"], "severity": x["severity"], "sheet": x["sheet"], "row": x["row"]}
            for x in got["exceptions"]
        ),
        key=lambda x: (x["code"], str(x["row"]), x["sheet"]),
    )
    want = sorted(exp["exceptions"], key=lambda x: (x["code"], str(x["row"]), x["sheet"]))
    assert ex == want


# ---------------------------------------------------------------- §6 golden cases


def _golden():
    base = base_fte_transaction(50000, 21, 24)
    prod = hc_production(
        base_fte=base,
        shrink_b=0.10,
        shrink_a=0.06,
        glide_b=0.06,
        glide_a=0.10,
        growth=0,
        actual_hc=90,
        attr_b=0.11,
        attr_a=0.15,
        snp=0.2,
        addition=10,
    )
    qca = hc_qca(
        budget_qca_pct=0.10,
        projected_prod_hc=prod["projectedHc"],
        actual_qa=10,
        attr_b=0.11,
        attr_a=0.15,
        snp=0.2,
        addition=1,
        mode="snp",
    )
    vol = volume_based(
        forecast_volume=50000,
        actual_hc=90,
        ramp_trainee=8,
        ramp_lateral=7,
        ramp_production=flat_ramp_production(15, 15, 21),
        peak=24,
        wdays=21,
        shrinkage_pct=0.06,
        sampling_pct=0.18,
        actual_qca=2,
        peak_qca=100,
    )
    return base, prod, qca, vol


@pytest.mark.parametrize(
    ("label", "get", "expected", "dp"),
    [
        ("Base FTE", lambda g: g[0], 99.2063, 4),
        ("Overall Buffer", lambda g: g[1]["overallBuffer"], 0.12, 4),
        ("Buffer HC", lambda g: g[1]["bufferHc"], 11.9048, 4),
        ("Req HC Prod", lambda g: g[1]["reqHcProd"], 111.1111, 4),
        ("Attrition HC", lambda g: g[1]["attritionHc"], 13.5, 4),
        ("Projected HC", lambda g: g[1]["projectedHc"], 86.5, 4),
        ("Capacity %", lambda g: g[1]["capacityPct"], 0.7785, 4),
        ("VA", lambda g: g[1]["va"], -24.6111, 4),
        ("Req QCA", lambda g: g[2]["reqQca"], 8.65, 4),
        ("QCA Attrition HC", lambda g: g[2]["attritionHc"], 2, 4),
        ("Projected QCA", lambda g: g[2]["projectedQca"], 9, 4),
        ("QCA Capacity %", lambda g: g[2]["capacityPct"], 1.0405, 4),
        ("QCA VA", lambda g: g[2]["va"], 0.35, 4),
        ("Ramp Production", lambda g: g[3]["rampProduction"], 4725, 4),
        ("BAU Production", lambda g: g[3]["bauProduction"], 37800, 4),
        ("Actual Productivity", lambda g: g[3]["actualProductivity"], 39973.5, 4),
        ("Volume Capacity %", lambda g: g[3]["capacityPct"], 0.79947, 5),
        ("VA units", lambda g: g[3]["vaUnits"], -10026.5, 4),
        ("VA HC", lambda g: g[3]["vaHc"], -19.8938, 4),
        ("To Be Audited", lambda g: g[3]["toBeAudited"], 7195.23, 4),
        ("QCA Production", lambda g: g[3]["qcaProduction"], 4200, 4),
        ("Volume QCA Capacity %", lambda g: g[3]["qcaCapacityPct"], 0.5837, 4),
    ],
)
def test_golden_cases(label: str, get, expected: float, dp: int) -> None:  # noqa: ANN001
    assert round(get(_golden()), dp) == pytest.approx(expected, abs=10**-dp / 2 + 1e-12), label


def test_division_by_zero_is_blank_not_infinity() -> None:
    assert safe_div(1, 0) is None
    out = hc_production(
        base_fte=0,
        shrink_b=0,
        shrink_a=0,
        glide_b=0,
        glide_a=None,
        growth=0,
        actual_hc=5,
        attr_b=0,
        attr_a=0,
        snp=0.2,
        addition=0,
    )
    assert out["capacityPct"] is None


def test_budget_ratio_rows() -> None:
    assert round(safe_div(11.727908070038632, 188.6890098379549), 6) == 0.062155
    assert round(safe_div(9.936049900447882, 181.18723143430796), 6) == 0.054839


def test_parsing_helpers() -> None:
    assert parse_month("Sep'26") == "2026-09"
    assert parse_month("Aug-2027") == "2027-08"
    assert parse_month(46266) == "2026-09"
    assert parse_month("Octember") is None
    assert num("12%") == pytest.approx(0.12)
    assert num("1,234.5") == 1234.5
    assert num("n/a") is None
    assert num("inf") is None
