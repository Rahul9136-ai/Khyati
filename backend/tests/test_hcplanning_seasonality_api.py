"""Integration tests for the seasonality/promotions API: promotions CRUD, the
suggestion endpoint (last year's actuals x trend x promotions), and applying
suggestions back into demand/config the same way a human edit would."""
from __future__ import annotations

import uuid

from httpx import AsyncClient

from app.modules.hcplanning.models import HcDemand
from tests.conftest import TestSession
from tests.helpers import create_structure


async def _setup(client: AsyncClient, h: dict) -> str:
    struct = await create_structure(client, h)
    return struct["lob"]["id"]


async def test_promotions_crud(client: AsyncClient, admin: dict):
    h = admin["headers"]
    lob_id = await _setup(client, h)

    r = await client.post("/api/v1/hc-planning/promotions", headers=h, json={
        "lob_id": lob_id, "name": "Holiday Surge", "month_from": "2025-11",
        "month_to": "2025-12", "demand_impact_pct": 20.0, "recurring": True,
    })
    assert r.status_code == 201, r.text
    promo = r.json()["data"]
    assert promo["name"] == "Holiday Surge"

    r = await client.get(f"/api/v1/hc-planning/promotions?lob_id={lob_id}", headers=h)
    assert r.status_code == 200, r.text
    assert len(r.json()["data"]) == 1

    r = await client.put(f"/api/v1/hc-planning/promotions/{promo['id']}", headers=h,
                          json={"demand_impact_pct": 25.0})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["demand_impact_pct"] == 25.0

    r = await client.delete(f"/api/v1/hc-planning/promotions/{promo['id']}", headers=h)
    assert r.status_code == 204, r.text
    r = await client.get(f"/api/v1/hc-planning/promotions?lob_id={lob_id}", headers=h)
    assert r.json()["data"] == []


async def test_promotion_org_wide_applies_to_every_lob(client: AsyncClient, admin: dict):
    h = admin["headers"]
    lob_id = await _setup(client, h)
    r = await client.post("/api/v1/hc-planning/promotions", headers=h, json={
        "lob_id": None, "name": "Org-wide sale", "month_from": "2025-11",
        "month_to": "2025-11", "demand_impact_pct": 10.0, "recurring": True,
    })
    assert r.status_code == 201, r.text
    r = await client.get(f"/api/v1/hc-planning/promotions?lob_id={lob_id}", headers=h)
    names = [p["name"] for p in r.json()["data"]]
    assert "Org-wide sale" in names


async def test_seasonality_suggests_from_last_year_trend_and_promotion(
    client: AsyncClient, admin: dict,
):
    h = admin["headers"]
    lob_id = await _setup(client, h)

    # last year's actual (locked) + this year's editable target month
    r = await client.put("/api/v1/hc-planning/demand", headers=h, json={
        "lob_id": lob_id, "items": [{"month": "2026-11", "billable_fte": 10.0}],
    })
    assert r.status_code == 200, r.text

    r = await client.put("/api/v1/hc-planning/config", headers=h, json={
        "lob_id": lob_id, "yoy_growth_pct": 10.0,
    })
    assert r.status_code == 200, r.text

    r = await client.post("/api/v1/hc-planning/promotions", headers=h, json={
        "lob_id": lob_id, "name": "Holiday Surge", "month_from": "2025-11",
        "month_to": "2025-12", "demand_impact_pct": 20.0, "recurring": True,
    })
    assert r.status_code == 201, r.text

    # seed "last year" actual via the demand endpoint directly is enough to
    # drive the suggestion for 2026-11 (base_month = 2025-11)
    r = await client.put("/api/v1/hc-planning/demand", headers=h, json={
        "lob_id": lob_id, "items": [{"month": "2025-11", "billable_fte": 100.0}],
    })
    assert r.status_code == 200, r.text

    r = await client.get(
        f"/api/v1/hc-planning/seasonality?lob_id={lob_id}&from=2026-11&to=2026-11", headers=h,
    )
    assert r.status_code == 200, r.text
    months = r.json()["data"]["months"]
    assert len(months) == 1
    suggestion = months[0]["demand_suggestion"]
    assert suggestion["base_month"] == "2025-11"
    assert suggestion["base_value"] == 100.0
    assert suggestion["trended"] == 110.0  # 100 * 1.10
    assert suggestion["promotion_multiplier"] == 1.2
    assert suggestion["suggested"] == 132.0  # 110 * 1.2
    assert suggestion["matched_promotions"] == ["Holiday Surge"]


async def test_apply_seasonality_writes_demand_and_assumptions(client: AsyncClient, admin: dict):
    h = admin["headers"]
    lob_id = await _setup(client, h)

    await client.put("/api/v1/hc-planning/demand", headers=h, json={
        "lob_id": lob_id, "items": [
            {"month": "2025-06", "billable_fte": 50.0},
            {"month": "2026-06", "billable_fte": 1.0},
        ],
    })
    await client.put("/api/v1/hc-planning/config", headers=h, json={
        "lob_id": lob_id,
        "historical_assumptions": {"ooo": {"2025-06": 0.09}, "io": {}, "attrition": {}},
    })

    r = await client.post("/api/v1/hc-planning/seasonality/apply", headers=h, json={
        "lob_id": lob_id, "months": ["2026-06"], "apply_demand": True, "apply_assumptions": True,
    })
    assert r.status_code == 200, r.text
    body = r.json()["data"]
    assert body["applied_demand_months"] == 1
    assert body["applied_assumption_values"] == 1  # only ooo had history

    r = await client.get(f"/api/v1/hc-planning/demand?lob_id={lob_id}", headers=h)
    demand_by_month = {d["month"]: d["billable_fte"] for d in r.json()["data"]}
    assert demand_by_month["2026-06"] == 50.0  # last year's value, no growth/promo configured

    r = await client.get(f"/api/v1/hc-planning/config?lob_id={lob_id}", headers=h)
    assert r.json()["data"]["monthly_overrides"]["ooo"]["2026-06"] == 0.09


async def test_locked_history_does_not_extend_default_capacity_window(
    client: AsyncClient, admin: dict,
):
    """Regression: last-year `locked` demand rows (the seasonality engine's
    history — see engine/seasonality.py) must never silently widen the live
    plan's default month range. Only the seed script and direct DB access can
    set `locked`; the API's demand PUT always writes editable (unlocked) rows."""
    h = admin["headers"]
    lob_id = await _setup(client, h)

    await client.put("/api/v1/hc-planning/demand", headers=h, json={
        "lob_id": lob_id, "items": [{"month": "2026-03", "billable_fte": 5.0}],
    })
    async with TestSession() as db:
        db.add(HcDemand(
            organization_id=uuid.UUID(admin["org_id"]), lob_id=uuid.UUID(lob_id),
            month="2025-03", billable_fte=4.0, locked=True,
        ))
        await db.commit()

    r = await client.get(f"/api/v1/hc-planning/capacity?lob_id={lob_id}", headers=h)
    assert r.status_code == 200, r.text
    # the locked 2025-03 actual must not pull the default window back a year
    assert r.json()["data"]["months"] == ["2026-03"]
