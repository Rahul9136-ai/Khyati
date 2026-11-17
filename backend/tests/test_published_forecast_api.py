"""The published forecast feed: the Forecasting page saves `publishedForecasts`
to the workspace; BI tools read it flat at GET /forecasting/published (JSON or
CSV, with an API key), and a `forecast.published` webhook goes out on each publish."""

from __future__ import annotations

from httpx import AsyncClient

from tests.test_connect import Receiver, dispatch
from tests.test_connect import receiver as receiver  # noqa: F401  (pytest fixture)

WS = "/api/v1/workspace/data/publishedForecasts"
FEED = "/api/v1/forecasting/published"


def _day(date: str, volume: int) -> dict:
    return {
        "date": date, "volume": volume, "aht": 300, "required": 80.5, "fte": 10.06,
        "scheduled": 76.0, "variance": -4.5, "projSL": 0.8123, "occupancy": 0.85,
    }


PUBLISHED = {
    "sales": {
        "queueId": "sales", "queueName": "Sales", "start": "2026-07-01", "end": "2026-07-02",
        "methodId": "holt", "methodName": "Holt-Winters", "mape": 0.061, "publishedAt": 1782864000000,
        "publishedBy": "Priya Nair", "totals": {"volume": 2100},
        "days": [_day("2026-07-01", 1000), _day("2026-07-02", 1100)],
    },
    "support": {
        "queueId": "support", "queueName": "Support", "start": "2026-07-01", "end": "2026-07-01",
        "methodId": "prophet", "methodName": "Prophet", "mape": 0.05, "publishedAt": 1782864000000,
        "publishedBy": "Priya Nair", "totals": {"volume": 500}, "days": [_day("2026-07-01", 500)],
    },
}


async def test_feed_is_empty_until_something_is_published(client: AsyncClient, admin: dict) -> None:
    r = await client.get(FEED, headers=admin["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["data"]["rows"] == [] and r.json()["data"]["version"] == 0


async def test_feed_flattens_every_queue_and_filters(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    r = await client.put(WS, headers=h, json={"value": PUBLISHED, "base_version": 0})
    assert r.status_code == 200, r.text

    data = (await client.get(FEED, headers=h)).json()["data"]
    assert len(data["rows"]) == 3 and data["version"] == 1
    first = data["rows"][0]
    assert first["queue_id"] == "sales" and first["date"] == "2026-07-01"
    assert first["volume"] == 1000 and first["required_fte"] == 10.06 and first["model"] == "Holt-Winters"
    assert first["published_at"].startswith("2026-")

    only = (await client.get(FEED, headers=h, params={"queue": "Sales", "start": "2026-07-02"})).json()["data"]
    assert [(x["queue_id"], x["date"]) for x in only["rows"]] == [("sales", "2026-07-02")]

    csv = await client.get(FEED, headers=h, params={"format": "csv"})
    assert csv.headers["content-type"].startswith("text/csv")
    lines = csv.text.strip().splitlines()
    assert lines[0].startswith("queue_id,queue,date,volume,aht_sec") and len(lines) == 4

    assert (await client.get(FEED, headers=h, params={"format": "xml"})).status_code == 422


async def test_publishing_sends_forecast_published(
    client: AsyncClient, admin: dict, receiver: Receiver  # noqa: F811
) -> None:
    h = admin["headers"]
    await client.post(
        "/api/v1/connect/webhooks",
        headers=h,
        json={"url": "https://bi.example/hook", "events": ["forecast.published"]},
    )
    await client.put(WS, headers=h, json={"value": PUBLISHED})
    await dispatch()
    ev = receiver.events()[0]
    assert ev["type"] == "forecast.published"
    assert {q["queueId"] for q in ev["data"]["queues"]} == {"sales", "support"}
    assert ev["data"]["queues"][0]["totals"]["volume"] in (2100, 500)
