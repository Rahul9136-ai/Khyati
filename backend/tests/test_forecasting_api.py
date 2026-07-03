"""Forecasting workflow integration tests: upload → forecast → approve → export."""
from __future__ import annotations

from httpx import AsyncClient

from tests.helpers import create_structure, history_payload


async def test_full_forecast_workflow(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    ids = await create_structure(client, headers)

    upload = await client.post(
        "/api/v1/forecasting/series", headers=headers,
        json=history_payload(ids["queue"]["id"]),
    )
    assert upload.status_code == 201, upload.text
    series = upload.json()["data"]
    assert series["cleaning_report"]["filled_gaps"] == 0

    run = await client.post(
        "/api/v1/forecasting/forecasts", headers=headers,
        json={"series_id": series["id"], "model": "auto", "horizon_days": 14},
    )
    assert run.status_code == 201, run.text
    forecast = run.json()["data"]
    assert forecast["status"] == "draft"
    assert len(forecast["points"]) == 14
    assert forecast["backtest"]  # all five models scored

    # workflow: draft → pending → approved; approving a draft directly fails
    premature = await client.post(
        f"/api/v1/forecasting/forecasts/{forecast['id']}/approve", headers=headers
    )
    assert premature.status_code == 422

    submitted = await client.post(
        f"/api/v1/forecasting/forecasts/{forecast['id']}/submit", headers=headers
    )
    assert submitted.json()["data"]["status"] == "pending_approval"
    approved = await client.post(
        f"/api/v1/forecasting/forecasts/{forecast['id']}/approve", headers=headers
    )
    assert approved.json()["data"]["status"] == "approved"

    # versioning: a new run with parent_id increments version
    version2 = await client.post(
        "/api/v1/forecasting/forecasts", headers=headers,
        json={"series_id": series["id"], "model": "holt_winters",
              "horizon_days": 14, "parent_id": forecast["id"]},
    )
    assert version2.json()["data"]["version"] == 2

    export = await client.get(
        f"/api/v1/forecasting/forecasts/{forecast['id']}/export", headers=headers
    )
    assert export.status_code == 200
    assert export.text.startswith("date,volume,lower,upper,aht")

    intervals = await client.get(
        f"/api/v1/forecasting/forecasts/{forecast['id']}/intervals",
        headers=headers,
        params={"day": forecast["points"][0]["day"], "interval_minutes": 30},
    )
    assert intervals.status_code == 200
    assert len(intervals.json()["data"]["volumes"]) == 48


async def test_csv_upload(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    payload = history_payload()
    csv_body = "date,volume,aht\n" + "\n".join(
        f"{p['day']},{p['volume']},{p['aht']}" for p in payload["points"]
    )
    resp = await client.post(
        "/api/v1/forecasting/series/upload-csv",
        headers=headers,
        files={"file": ("history.csv", csv_body.encode(), "text/csv")},
        data={"name": "CSV import"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["data"]["name"] == "CSV import"
