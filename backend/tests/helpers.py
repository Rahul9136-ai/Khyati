"""Shared test helpers: build org structure / employees / history via the API."""
from __future__ import annotations

from datetime import date, timedelta

from httpx import AsyncClient


async def _post(client: AsyncClient, url: str, headers: dict, payload: dict) -> dict:
    resp = await client.post(url, headers=headers, json=payload)
    assert resp.status_code == 201, f"{url} -> {resp.status_code}: {resp.text}"
    return resp.json()["data"]


async def create_structure(client: AsyncClient, headers: dict) -> dict:
    bu = await _post(client, "/api/v1/org/business-units", headers,
                     {"name": "Care", "code": "CARE"})
    lob = await _post(client, "/api/v1/org/lobs", headers,
                      {"business_unit_id": bu["id"], "name": "Support", "code": "SUP"})
    team = await _post(client, "/api/v1/org/teams", headers,
                       {"lob_id": lob["id"], "name": "Alpha"})
    queue = await _post(client, "/api/v1/org/queues", headers,
                        {"lob_id": lob["id"], "name": "Voice", "channel": "voice"})
    return {"bu": bu, "lob": lob, "team": team, "queue": queue}


async def create_employees(
    client: AsyncClient, headers: dict, team_id: str, lob_id: str, count: int = 4
) -> list[dict]:
    out = []
    for i in range(count):
        resp = await client.post(
            "/api/v1/employees", headers=headers,
            json={"employee_code": f"E{i:03d}", "first_name": f"Emp{i}",
                  "last_name": "Test", "email": f"emp{i}@test.dev",
                  "team_id": team_id, "lob_id": lob_id},
        )
        assert resp.status_code == 201, resp.text
        out.append(resp.json()["data"])
    return out


def history_payload(queue_id: str | None = None, days: int = 60) -> dict:
    start = date.today() - timedelta(days=days)
    weekday_mult = [1.2, 1.1, 1.0, 1.0, 1.05, 0.5, 0.35]
    points = []
    for i in range(days):
        day = start + timedelta(days=i)
        points.append({"day": day.isoformat(),
                       "volume": round(400 * weekday_mult[day.weekday()], 1),
                       "aht": 300})
    payload = {"name": "Test history", "points": points}
    if queue_id:
        payload["queue_id"] = queue_id
    return payload


def next_monday() -> date:
    today = date.today()
    return today + timedelta(days=(7 - today.weekday()) % 7 or 7)
