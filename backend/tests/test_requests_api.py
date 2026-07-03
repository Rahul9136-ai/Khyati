"""Change-request workflow integration tests."""
from __future__ import annotations

from httpx import AsyncClient

from tests.helpers import create_employees, create_structure


async def _request(client: AsyncClient, headers: dict, employee_id: str,
                   category: str = "shift_change") -> dict:
    resp = await client.post(
        "/api/v1/requests", headers=headers,
        json={"employee_id": employee_id, "category": category,
              "reason": "Doctor appointment on Wednesday",
              "payload": {"date": "2026-07-15", "from": "08:00", "to": "12:00"}},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]


async def test_two_stage_approval(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    ids = await create_structure(client, headers)
    employees = await create_employees(
        client, headers, ids["team"]["id"], ids["lob"]["id"], count=1
    )
    request = await _request(client, headers, employees[0]["id"])
    assert request["status"] == "pending_manager"
    assert request["sla_due_at"] is not None

    # WFM cannot decide before the manager stage
    early = await client.post(
        f"/api/v1/requests/{request['id']}/wfm-decision", headers=headers,
        json={"approve": True},
    )
    assert early.status_code == 422

    manager = await client.post(
        f"/api/v1/requests/{request['id']}/manager-decision", headers=headers,
        json={"approve": True, "note": "OK with coverage"},
    )
    assert manager.json()["data"]["status"] == "pending_wfm"

    wfm = await client.post(
        f"/api/v1/requests/{request['id']}/wfm-decision", headers=headers,
        json={"approve": True},
    )
    assert wfm.json()["data"]["status"] == "approved"


async def test_attendance_coding_skips_manager(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    ids = await create_structure(client, headers)
    employees = await create_employees(
        client, headers, ids["team"]["id"], ids["lob"]["id"], count=1
    )
    request = await _request(client, headers, employees[0]["id"], "attendance_coding")
    assert request["status"] == "pending_wfm"


async def test_reject_cancel_and_comments(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    ids = await create_structure(client, headers)
    employees = await create_employees(
        client, headers, ids["team"]["id"], ids["lob"]["id"], count=1
    )
    request = await _request(client, headers, employees[0]["id"], "vto")
    rejected = await client.post(
        f"/api/v1/requests/{request['id']}/manager-decision", headers=headers,
        json={"approve": False, "note": "Understaffed that day"},
    )
    assert rejected.json()["data"]["status"] == "rejected"

    second = await _request(client, headers, employees[0]["id"], "leave")
    comment = await client.post(
        f"/api/v1/requests/{second['id']}/comments", headers=headers,
        json={"body": "Attaching leave certificate"},
    )
    assert comment.status_code == 201

    cancelled = await client.post(
        f"/api/v1/requests/{second['id']}/cancel", headers=headers
    )
    assert cancelled.json()["data"]["status"] == "cancelled"

    detail = await client.get(f"/api/v1/requests/{second['id']}", headers=headers)
    assert len(detail.json()["data"]["comments"]) == 1

    invalid = await client.post(
        "/api/v1/requests", headers=headers,
        json={"employee_id": employees[0]["id"], "category": "not_a_category",
              "reason": "x y z"},
    )
    assert invalid.status_code == 422
