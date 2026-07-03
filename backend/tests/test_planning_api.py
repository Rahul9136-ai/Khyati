"""Planning integration tests: capacity plan math, what-if, Erlang endpoints."""
from __future__ import annotations

from datetime import timedelta

from httpx import AsyncClient

from tests.helpers import next_monday


async def test_capacity_plan_and_what_if(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    monday = next_monday()
    create = await client.post(
        "/api/v1/planning/plans", headers=headers,
        json={
            "name": "Q3 plan",
            "starting_headcount": 30,
            "assumptions": {"aht_seconds": 300, "shrinkage": 0.3, "occupancy": 0.85,
                            "weekly_hours": 40, "attrition_weekly_pct": 0.01,
                            "buffer_pct": 0.0, "concurrency": 1.0},
            "weeks": [
                {"week_start": monday.isoformat(), "volume": 7000, "new_hires": 0},
                {"week_start": (monday + timedelta(days=7)).isoformat(),
                 "volume": 7000, "new_hires": 5},
            ],
        },
    )
    assert create.status_code == 201, create.text
    plan = create.json()["data"]
    week1, week2 = plan["weeks"]
    # workload = 7000*300/3600 ≈ 583.3h; productive = 40*0.7*0.85 = 23.8h
    assert abs(week1["workload_hours"] - 583.3) < 0.5
    assert abs(week1["required_fte"] - 583.3 / 23.8) < 0.1
    assert week1["available_hc"] == 30
    # week 2: attrition 1% then +5 hires
    assert abs(week2["available_hc"] - (30 * 0.99 + 5)) < 0.01

    what_if = await client.post(
        f"/api/v1/planning/plans/{plan['id']}/what-if", headers=headers,
        json={"overrides": {"aht_seconds": 300, "shrinkage": 0.4, "occupancy": 0.85,
                            "weekly_hours": 40, "attrition_weekly_pct": 0.01,
                            "buffer_pct": 0.0, "concurrency": 1.0}},
    )
    assert what_if.status_code == 200
    # higher shrinkage ⇒ more FTE needed than the saved plan
    assert what_if.json()["data"][0]["required_fte"] > week1["required_fte"]
    # what-if does not persist
    saved = await client.get(f"/api/v1/planning/plans/{plan['id']}", headers=headers)
    assert saved.json()["data"]["weeks"][0]["required_fte"] == week1["required_fte"]


async def test_erlang_endpoints(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    req = await client.post(
        "/api/v1/planning/erlang/requirements", headers=headers,
        json={"volume": 100, "aht_seconds": 300, "interval_seconds": 1800,
              "sla_target": 0.8, "sla_threshold_seconds": 30, "shrinkage": 0.3},
    )
    assert req.status_code == 200
    data = req.json()["data"]
    assert data["service_level"] >= 0.8
    assert data["agents_with_shrinkage"] > data["agents"]

    sl = await client.post(
        "/api/v1/planning/erlang/service-level", headers=headers,
        json={"agents": data["agents"], "volume": 100, "aht_seconds": 300},
    )
    assert sl.status_code == 200
    assert sl.json()["data"]["service_level"] >= 0.8

    curve = await client.post(
        "/api/v1/planning/erlang/staffing-curve", headers=headers,
        json={"agents": 1, "volume": 100, "aht_seconds": 300},
    )
    assert curve.status_code == 200
    assert len(curve.json()["data"]) >= 8
