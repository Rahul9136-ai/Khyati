"""Attendance integration tests: codes, records, derived lateness, summary."""
from __future__ import annotations

from datetime import date, timedelta

from httpx import AsyncClient

from tests.helpers import create_employees, create_structure


async def test_attendance_flow(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    ids = await create_structure(client, headers)
    employees = await create_employees(
        client, headers, ids["team"]["id"], ids["lob"]["id"], count=2
    )

    present = (await client.post(
        "/api/v1/attendance/codes", headers=headers,
        json={"code": "PRS", "name": "Present", "category": "present"},
    )).json()["data"]
    late = (await client.post(
        "/api/v1/attendance/codes", headers=headers,
        json={"code": "LTE", "name": "Late", "category": "late"},
    )).json()["data"]
    sick = (await client.post(
        "/api/v1/attendance/codes", headers=headers,
        json={"code": "SIC", "name": "Sick", "category": "sick",
              "counts_as_shrinkage": True},
    )).json()["data"]

    day = date.today() - timedelta(days=1)
    record = await client.post(
        "/api/v1/attendance/records", headers=headers,
        json={"employee_id": employees[0]["id"], "code_id": late["id"],
              "day": day.isoformat(),
              "scheduled_start": f"{day}T08:00:00Z",
              "scheduled_end": f"{day}T16:30:00Z",
              "actual_start": f"{day}T08:22:00Z",
              "actual_end": f"{day}T16:00:00Z"},
    )
    assert record.status_code == 201, record.text
    body = record.json()["data"]
    assert body["minutes_late"] == 22
    assert body["minutes_early_logout"] == 30

    dup = await client.post(
        "/api/v1/attendance/records", headers=headers,
        json={"employee_id": employees[0]["id"], "code_id": late["id"],
              "day": day.isoformat()},
    )
    assert dup.status_code == 409

    bulk = await client.post(
        "/api/v1/attendance/records/bulk", headers=headers,
        json={"records": [
            {"employee_id": employees[1]["id"], "code_id": present["id"],
             "day": day.isoformat()},
            {"employee_id": employees[1]["id"], "code_id": sick["id"],
             "day": (day - timedelta(days=1)).isoformat()},
        ]},
    )
    assert bulk.status_code == 201

    summary = await client.get(
        "/api/v1/attendance/summary", headers=headers,
        params={"start": (day - timedelta(days=2)).isoformat(),
                "end": day.isoformat()},
    )
    data = summary.json()["data"]
    assert data["total_records"] == 3
    assert data["late_records"] == 1
    assert data["absent_records"] == 1  # sick counts toward absenteeism
    assert data["shrinkage_rate"] > 0
