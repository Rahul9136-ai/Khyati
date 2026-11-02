"""Recorded data behind the Performance reports: attendance per person, actuals per queue."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

from httpx import AsyncClient

from app.modules.attendance.models import AttendanceCode, AttendanceRecord
from app.modules.intraday.models import IntervalActual
from app.modules.workforce.models import BusinessUnit, Employee, Lob, Queue, Team
from tests.conftest import TestSession, login

URL = "/api/v1/reports/performance-actuals"
DAY = date(2026, 10, 5)


async def seed(org: str) -> None:
    org_id = uuid.UUID(org)
    async with TestSession() as db:
        bu = BusinessUnit(organization_id=org_id, name="Ops", code="OPS")
        db.add(bu)
        await db.flush()
        lob = Lob(organization_id=org_id, business_unit_id=bu.id, name="Sales", code="S")
        db.add(lob)
        await db.flush()
        team = Team(organization_id=org_id, lob_id=lob.id, name="Alpha")
        queue = Queue(organization_id=org_id, lob_id=lob.id, name="Sales Voice", sla_target_pct=0.8)
        db.add_all([team, queue])
        await db.flush()
        emp = Employee(
            organization_id=org_id,
            employee_code="a01",
            first_name="Ava",
            last_name="Mendez",
            email="ava@x.dev",
            team_id=team.id,
        )
        late = AttendanceCode(organization_id=org_id, code="LT", name="Late", category="late")
        db.add_all([emp, late])
        await db.flush()
        db.add(
            AttendanceRecord(
                organization_id=org_id,
                employee_id=emp.id,
                code_id=late.id,
                day=DAY,
                minutes_late=12,
                minutes_early_logout=3,
            )
        )
        for hour, offered, handled, aht, sl in ((9, 100, 90, 300, 0.9), (10, 300, 270, 200, 0.7)):
            db.add(
                IntervalActual(
                    organization_id=org_id,
                    queue_id=queue.id,
                    ts=datetime(2026, 10, 5, hour, tzinfo=UTC),
                    offered=offered,
                    handled=handled,
                    aht_seconds=aht,
                    service_level=sl,
                    occupancy=0.8,
                )
            )
        await db.commit()


async def test_returns_recorded_attendance_and_queue_results(
    client: AsyncClient, admin: dict
) -> None:
    await seed(admin["org_id"])
    r = await client.get(URL, headers=admin["headers"], params={"start": DAY, "end": DAY})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["attendance"] == [
        {
            "employee_code": "a01",
            "employee_name": "Ava Mendez",
            "team": "Alpha",
            "lob": "Sales",
            "date": "2026-10-05",
            "code": "Late",
            "category": "late",
            "minutes_late": 12,
            "minutes_early_logout": 3,
        }
    ]
    q = data["queues"][0]
    assert (q["lob"], q["queue"], q["offered"], q["handled"]) == ("Sales", "Sales Voice", 400, 360)
    assert q["service_level_pct"] == 75.0  # weighted by volume, not a plain average
    assert q["aht_seconds"] == 225  # weighted by handled
    assert q["sl_target_pct"] == 80.0

    other = await client.get(
        URL, headers=admin["headers"], params={"start": "2026-10-06", "end": "2026-10-06"}
    )
    assert other.json()["data"] == {
        "start": "2026-10-06",
        "end": "2026-10-06",
        "attendance": [],
        "queues": [],
    }


async def test_validates_range_and_needs_permission(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    bad = await client.get(URL, headers=h, params={"start": "2026-10-06", "end": "2026-10-05"})
    assert bad.status_code == 422
    long = await client.get(URL, headers=h, params={"start": "2026-01-01", "end": "2026-12-31"})
    assert long.status_code == 422
    assert (await client.get(URL, params={"start": DAY, "end": DAY})).status_code == 401
    created = await client.post(
        "/api/v1/users",
        headers=h,
        json={
            "email": "emp@test.dev",
            "password": "Passw0rd!x",
            "full_name": "E",
            "role_names": ["Employee"],
        },
    )
    assert created.status_code == 201, created.text
    emp = await login(client, "emp@test.dev", "Passw0rd!x")
    assert (
        await client.get(URL, headers=emp, params={"start": DAY, "end": DAY})
    ).status_code == 403
