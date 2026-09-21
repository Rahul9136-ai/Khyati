"""Integration tests for the HC planning API (config, demand, profiles, capacity)."""
from __future__ import annotations

from httpx import AsyncClient

from tests.helpers import create_employees, create_structure


async def _setup(client: AsyncClient, h: dict):
    struct = await create_structure(client, h)
    lob_id = struct["lob"]["id"]
    emps = await create_employees(client, h, struct["team"]["id"], lob_id, count=4)
    # give each a planning profile: productive from 2026-01, mostly FTE + one Ramp
    statuses = ["FTE", "FTE", "FTE", "Ramp"]
    for emp, st in zip(emps, statuses):
        r = await client.put(
            f"/api/v1/hc-planning/employees/{emp['id']}/profile", headers=h,
            json={"planning_status": st, "dop": "2025-06-01", "experience_type": "Lateral"},
        )
        assert r.status_code == 200, r.text
    return lob_id


async def test_config_demand_and_capacity_flow(client: AsyncClient, admin: dict):
    h = admin["headers"]
    lob_id = await _setup(client, h)

    # demand for 3 months
    r = await client.put("/api/v1/hc-planning/demand", headers=h, json={
        "lob_id": lob_id,
        "items": [
            {"month": "2026-01", "billable_fte": 3.0},
            {"month": "2026-02", "billable_fte": 3.2},
            {"month": "2026-03", "billable_fte": 3.4},
        ],
    })
    assert r.status_code == 200, r.text
    assert len(r.json()["data"]) == 3

    # config with 4% / 4% shrinkage
    r = await client.put("/api/v1/hc-planning/config", headers=h, json={
        "lob_id": lob_id, "ooo_shrinkage": 0.04, "io_shrinkage": 0.04,
        "attrition": 0.0125, "actuals_through": "2026-03",
    })
    assert r.status_code == 200, r.text

    # capacity over the demand window
    r = await client.get("/api/v1/hc-planning/capacity", headers=h, params={
        "lob_id": lob_id, "from": "2026-01", "to": "2026-03",
    })
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["agent_count"] == 4
    assert [x["month"] for x in data["results"]] == ["2026-01", "2026-02", "2026-03"]

    jan = data["results"][0]
    # 4 productive agents (3 FTE + 1 Ramp) → Production Agents 4, FTE+Ramp 4
    assert jan["fte"] == 3 and jan["ramp"] == 1
    assert jan["production_agents"] == 4
    assert jan["fte_ramp"] == 4 and jan["closing_hc"] == 4
    # Required HC = 3 / (0.96*0.96) = 3.255…
    assert abs(jan["required_hc"] - 3.0 / (0.96 * 0.96)) < 1e-6
    # Excess/Deficit = Closing - Required ; OT/VTO = excess * 40
    assert abs(jan["excess_deficit"] - (4 - jan["required_hc"])) < 1e-6
    assert abs(jan["ot_vto_hours"] - jan["excess_deficit"] * 40) < 1e-6


async def test_closing_override_applies(client: AsyncClient, admin: dict):
    h = admin["headers"]
    lob_id = await _setup(client, h)
    await client.put("/api/v1/hc-planning/demand", headers=h, json={
        "lob_id": lob_id, "items": [{"month": "2026-01", "billable_fte": 2.0}]})
    await client.put("/api/v1/hc-planning/config", headers=h, json={
        "lob_id": lob_id, "closing_overrides": {"2026-01": 9}})

    r = await client.get("/api/v1/hc-planning/capacity", headers=h,
                         params={"lob_id": lob_id, "from": "2026-01", "to": "2026-01"})
    jan = r.json()["data"]["results"][0]
    assert jan["closing_hc"] == 9 and jan["closing_overridden"] is True
    assert jan["fte_ramp"] == 4  # calculated value still exposed


async def test_capacity_requires_valid_lob(client: AsyncClient, admin: dict):
    h = admin["headers"]
    import uuid
    r = await client.get("/api/v1/hc-planning/capacity", headers=h,
                         params={"lob_id": str(uuid.uuid4()), "from": "2026-01", "to": "2026-01"})
    assert r.status_code == 404
