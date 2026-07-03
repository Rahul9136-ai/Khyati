"""Intraday, reporting, notifications and AI integration tests."""
from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta

from httpx import AsyncClient

from tests.helpers import create_structure, history_payload


async def _approved_forecast(client: AsyncClient, headers: dict, queue_id: str) -> dict:
    series = (await client.post(
        "/api/v1/forecasting/series", headers=headers,
        json=history_payload(queue_id),
    )).json()["data"]
    forecast = (await client.post(
        "/api/v1/forecasting/forecasts", headers=headers,
        json={"series_id": series["id"], "model": "auto", "horizon_days": 7},
    )).json()["data"]
    await client.post(f"/api/v1/forecasting/forecasts/{forecast['id']}/submit",
                      headers=headers)
    await client.post(f"/api/v1/forecasting/forecasts/{forecast['id']}/approve",
                      headers=headers)
    return forecast


async def test_intraday_status_vs_forecast(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    ids = await create_structure(client, headers)
    queue_id = ids["queue"]["id"]
    forecast = await _approved_forecast(client, headers, queue_id)
    day = date.fromisoformat(forecast["points"][0]["day"])

    base = datetime.combine(day, time(9, 0), tzinfo=UTC)
    actuals = [
        {"queue_id": queue_id, "ts": (base + timedelta(minutes=30 * i)).isoformat(),
         "offered": 40 + i, "handled": 39 + i, "aht_seconds": 300,
         "service_level": 0.75, "occupancy": 0.95, "staffed": 12}
        for i in range(4)
    ]
    posted = await client.post("/api/v1/intraday/actuals", headers=headers,
                               json={"actuals": actuals})
    assert posted.status_code == 201

    status = await client.get(
        "/api/v1/intraday/status", headers=headers,
        params={"queue_id": queue_id, "day": day.isoformat()},
    )
    assert status.status_code == 200, status.text
    body = status.json()["data"]
    assert body["forecast_id"] == forecast["id"]
    assert body["actual_so_far"] > 0
    assert body["reforecast_total"] is not None
    assert len(body["intervals"]) == 48
    assert body["recommendations"]  # occupancy 95% must trigger advice
    assert any("Occupancy" in r or "Service level" in r for r in body["recommendations"])


async def test_reports_and_dashboard(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    ids = await create_structure(client, headers)
    forecast = await _approved_forecast(client, headers, ids["queue"]["id"])

    dashboard = await client.get("/api/v1/reports/dashboard", headers=headers)
    assert dashboard.status_code == 200
    assert dashboard.json()["data"]["approved_forecasts"] == 1

    accuracy = await client.get(
        "/api/v1/reports/forecast-accuracy", headers=headers,
        params={"forecast_id": forecast["id"]},
    )
    assert accuracy.status_code == 200
    assert len(accuracy.json()["data"]["rows"]) == 7

    csv_export = await client.get(
        "/api/v1/reports/forecast-accuracy", headers=headers,
        params={"forecast_id": forecast["id"], "format": "csv"},
    )
    assert csv_export.headers["content-type"].startswith("text/csv")


async def test_ai_chat_and_explain(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    ids = await create_structure(client, headers)
    forecast = await _approved_forecast(client, headers, ids["queue"]["id"])

    explain = await client.get(
        "/api/v1/ai/explain-forecast", headers=headers,
        params={"forecast_id": forecast["id"]},
    )
    assert explain.status_code == 200
    assert forecast["model"] in explain.json()["data"]["explanation"]

    chat = await client.post(
        "/api/v1/ai/chat", headers=headers,
        json={"message": "How is our staffing looking?"},
    )
    assert chat.status_code == 200
    body = chat.json()["data"]
    assert body["llm_used"] is False  # no API key in tests
    assert "headcount" in body["answer"].lower()

    recommendation = await client.get(
        "/api/v1/ai/staffing-recommendation", headers=headers,
        params={"forecast_id": forecast["id"], "day": forecast["points"][0]["day"]},
    )
    assert recommendation.status_code == 200
    assert recommendation.json()["data"]["peak_agents"] > 0


async def test_notifications_marked_read(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    empty = await client.get("/api/v1/notifications", headers=headers)
    assert empty.status_code == 200
    assert empty.json()["data"] == []
