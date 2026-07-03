"""Scheduling integration tests: templates, generation, validation, publishing."""
from __future__ import annotations

from httpx import AsyncClient

from tests.helpers import create_employees, create_structure, next_monday


async def _template(client: AsyncClient, headers: dict, name: str = "Early") -> dict:
    resp = await client.post(
        "/api/v1/scheduling/templates", headers=headers,
        json={"name": name, "start_time": "08:00:00", "end_time": "16:30:00",
              "days_of_week": [0, 1, 2, 3, 4],
              "breaks": [{"offset_minutes": 240, "duration_minutes": 30,
                          "activity": "lunch"}]},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]


async def test_generate_validate_publish(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    ids = await create_structure(client, headers)
    await create_employees(client, headers, ids["team"]["id"], ids["lob"]["id"], count=4)
    template = await _template(client, headers)
    monday = next_monday()

    gen = await client.post(
        "/api/v1/scheduling/schedules/generate", headers=headers,
        json={"team_id": ids["team"]["id"], "week_start": monday.isoformat(),
              "template_ids": [template["id"]]},
    )
    assert gen.status_code == 201, gen.text
    schedule = gen.json()["data"]
    # 4 employees × 5 working days
    assert len(schedule["shifts"]) == 20
    assert schedule["shifts"][0]["activities"][0]["activity"] == "lunch"

    validation = await client.get(
        f"/api/v1/scheduling/schedules/{schedule['id']}/validate", headers=headers
    )
    assert validation.json()["data"]["valid"] is True

    published = await client.post(
        f"/api/v1/scheduling/schedules/{schedule['id']}/publish", headers=headers
    )
    assert published.json()["data"]["status"] == "published"

    # published schedules are immutable
    shift_id = schedule["shifts"][0]["id"]
    frozen = await client.patch(
        f"/api/v1/scheduling/shifts/{shift_id}", headers=headers,
        json={"activities": []},
    )
    assert frozen.status_code == 422


async def test_conflict_detection_blocks_publish(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    ids = await create_structure(client, headers)
    employees = await create_employees(
        client, headers, ids["team"]["id"], ids["lob"]["id"], count=1
    )
    template = await _template(client, headers)
    monday = next_monday()
    gen = await client.post(
        "/api/v1/scheduling/schedules/generate", headers=headers,
        json={"team_id": ids["team"]["id"], "week_start": monday.isoformat(),
              "template_ids": [template["id"]]},
    )
    schedule = gen.json()["data"]

    # add an overlapping second shift for the same employee on Monday
    overlap = await client.post(
        f"/api/v1/scheduling/schedules/{schedule['id']}/shifts", headers=headers,
        json={"employee_id": employees[0]["id"], "day": monday.isoformat(),
              "start_ts": f"{monday.isoformat()}T12:00:00Z",
              "end_ts": f"{monday.isoformat()}T20:00:00Z"},
    )
    assert overlap.status_code == 201

    validation = await client.get(
        f"/api/v1/scheduling/schedules/{schedule['id']}/validate", headers=headers
    )
    body = validation.json()["data"]
    assert body["valid"] is False
    assert body["conflicts"][0]["message"] == "Overlapping shifts"

    blocked = await client.post(
        f"/api/v1/scheduling/schedules/{schedule['id']}/publish", headers=headers
    )
    assert blocked.status_code == 422
