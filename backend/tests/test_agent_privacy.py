"""Agents see only their own records, on every endpoint their permissions reach."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

from httpx import AsyncClient

from app.modules.attendance.models import AttendanceCode, AttendanceRecord
from app.modules.integrations.models import ApprovalRequest
from app.modules.scheduling.models import Schedule, ScheduleShift
from app.modules.workforce.models import Employee
from tests.conftest import TestSession, login

API = "/api/v1"
DAY = date(2026, 10, 5)
P = {"start": DAY.isoformat(), "end": DAY.isoformat()}


async def people(client: AsyncClient, admin: dict) -> dict:
    """Ava (agent login) and Liam (a colleague), each with a late attendance record."""
    org = uuid.UUID(admin["org_id"])
    async with TestSession() as db:
        ava = Employee(organization_id=org, employee_code="a01", first_name="Ava", email="a@x.dev")
        liam = Employee(
            organization_id=org, employee_code="a02", first_name="Liam", email="l@x.dev"
        )
        code = AttendanceCode(organization_id=org, code="LT", name="Late", category="late")
        db.add_all([ava, liam, code])
        await db.flush()
        for emp, mins in ((ava, 5), (liam, 50)):
            db.add(
                AttendanceRecord(
                    organization_id=org,
                    employee_id=emp.id,
                    code_id=code.id,
                    day=DAY,
                    minutes_late=mins,
                )
            )
        ids = {"ava": ava.id, "liam": liam.id, "org": org}
        await db.commit()
    r = await client.post(
        f"{API}/users",
        headers=admin["headers"],
        json={
            "email": "ava@test.dev",
            "password": "Passw0rd!x",
            "full_name": "Ava",
            "role_names": ["Employee"],
            "employee_id": str(ids["ava"]),
        },
    )
    assert r.status_code == 201, r.text
    ids["h"] = await login(client, "ava@test.dev", "Passw0rd!x")
    me = (await client.get(f"{API}/auth/me", headers=ids["h"])).json()["data"]
    ids["user"] = uuid.UUID(me["id"])
    assert me.get("employee_id") in (str(ids["ava"]), None)
    return ids


async def test_attendance_is_own_only(client: AsyncClient, admin: dict) -> None:
    who = await people(client, admin)
    h = who["h"]
    rows = (await client.get(f"{API}/attendance/records", headers=h)).json()["data"]["items"]
    assert [str(r["employee_id"]) for r in rows] == [str(who["ava"])]
    # Asking for a colleague by id still returns only Ava's.
    other = await client.get(
        f"{API}/attendance/records", headers=h, params={"employee_id": str(who["liam"])}
    )
    assert [str(r["employee_id"]) for r in other.json()["data"]["items"]] == [str(who["ava"])]
    s = (await client.get(f"{API}/attendance/summary", headers=h, params=P)).json()["data"]
    assert s["total_records"] == 1
    # Staff still see everyone.
    staff = (await client.get(f"{API}/attendance/records", headers=admin["headers"])).json()
    assert len(staff["data"]["items"]) == 2


async def test_my_performance_is_only_ever_me(client: AsyncClient, admin: dict) -> None:
    who = await people(client, admin)
    h = who["h"]
    # An extra employee parameter changes nothing: there's no way to ask for someone else.
    r = await client.get(
        f"{API}/reports/my-performance",
        headers=h,
        params={**P, "employee_id": str(who["liam"]), "agent_key": "a02"},
    )
    assert r.status_code == 200, r.text
    rows = r.json()["data"]["attendance"]
    assert [(x["employee_code"], x["minutes_late"]) for x in rows] == [("a01", 5)]
    bad = await client.get(
        f"{API}/reports/my-performance",
        headers=h,
        params={"start": "2026-10-06", "end": "2026-10-05"},
    )
    assert bad.status_code == 422
    # Team and centre reports stay closed to agents.
    for path, q in (
        ("/reports/performance-actuals", P),
        ("/reports/agent-performance", P),
        ("/reports/adherence", P),
        ("/reports/shrinkage", P),
        ("/reports/dashboard", {}),
    ):
        assert (await client.get(f"{API}{path}", headers=h, params=q)).status_code == 403, path


async def test_requests_and_approvals_are_own_only(client: AsyncClient, admin: dict) -> None:
    who = await people(client, admin)
    h, org = who["h"], who["org"]
    async with TestSession() as db:
        approval_other = ApprovalRequest(
            organization_id=org,
            source="scheduling",
            kind="shift_change",
            title="Liam's",
            employee_id=who["liam"],
            requested_by=uuid.uuid4(),
        )
        approval_mine = ApprovalRequest(
            organization_id=org,
            source="scheduling",
            kind="shift_change",
            title="Ava's",
            employee_id=who["ava"],
        )
        db.add_all([approval_other, approval_mine])
        await db.flush()
        other_id, mine_id = approval_other.id, approval_mine.id
        await db.commit()
    listed = (await client.get(f"{API}/integrations/approvals", headers=h)).json()["data"]["items"]
    assert [a["title"] for a in listed] == ["Ava's"]
    assert (
        await client.get(f"{API}/integrations/approvals/{mine_id}", headers=h)
    ).status_code == 200
    assert (
        await client.get(f"{API}/integrations/approvals/{other_id}", headers=h)
    ).status_code == 404
    staff = await client.get(f"{API}/integrations/approvals", headers=admin["headers"])
    assert len(staff.json()["data"]["items"]) == 2
    # Requests: filtering by a colleague doesn't reach their records.
    r = await client.get(f"{API}/requests", headers=h, params={"employee_id": str(who["liam"])})
    assert r.status_code == 200 and r.json()["data"]["items"] == []


async def test_older_schedules_show_only_own_shifts(client: AsyncClient, admin: dict) -> None:
    who = await people(client, admin)
    h = who["h"]
    async with TestSession() as db:

        def at(hour: int) -> datetime:
            return datetime(2026, 10, 5, hour, tzinfo=UTC)

        both = Schedule(organization_id=who["org"], name="Both", week_start=DAY, status="published")
        others = Schedule(
            organization_id=who["org"], name="Others", week_start=DAY, status="published"
        )
        db.add_all([both, others])
        await db.flush()
        for sched, emp in ((both, who["ava"]), (both, who["liam"]), (others, who["liam"])):
            db.add(
                ScheduleShift(
                    schedule_id=sched.id, employee_id=emp, day=DAY, start_ts=at(9), end_ts=at(17)
                )
            )
        both_id, others_id = both.id, others.id
        await db.commit()
    listed = (await client.get(f"{API}/scheduling/schedules", headers=h)).json()["data"]
    assert [s["id"] for s in listed] == [str(both_id)]
    detail = (await client.get(f"{API}/scheduling/schedules/{both_id}", headers=h)).json()["data"]
    assert [s["employee_id"] for s in detail["shifts"]] == [str(who["ava"])]
    assert (
        await client.get(f"{API}/scheduling/schedules/{others_id}", headers=h)
    ).status_code == 404
    assert (
        await client.get(f"{API}/scheduling/schedules/{both_id}/validate", headers=h)
    ).status_code == 403
    staff = await client.get(f"{API}/scheduling/schedules/{both_id}", headers=admin["headers"])
    assert len(staff.json()["data"]["shifts"]) == 2
    assert (await client.get(f"{API}/employees", headers=h)).status_code == 403


async def test_settings_hide_colleagues_week_offs(client: AsyncClient, admin: dict) -> None:
    who = await people(client, admin)
    rules = {"a01": {"weekOff": [5, 6]}, "a02": {"weekOff": [0, 1]}}
    await client.put(
        f"{API}/scheduling/settings/agent_rules", headers=admin["headers"], json={"value": rules}
    )
    got = await client.get(f"{API}/scheduling/settings/agent_rules", headers=who["h"])
    assert list(got.json()["data"]["value"]) == ["a01"]
    listed = (await client.get(f"{API}/scheduling/settings", headers=who["h"])).json()["data"]
    assert list(next(s for s in listed if s["key"] == "agent_rules")["value"]) == ["a01"]
    staff = await client.get(f"{API}/scheduling/settings/agent_rules", headers=admin["headers"])
    assert sorted(staff.json()["data"]["value"]) == ["a01", "a02"]
