"""Publishing day plans, who can see drafts, and the notifications agents and
team leaders get when published schedules change."""

from __future__ import annotations

from datetime import date

from httpx import AsyncClient

from app.modules.scheduling import dayplan as dp
from app.modules.scheduling import dayplan_service, schedule_notify
from tests.conftest import login
from tests.helpers import create_structure
from tests.test_dayplan import m, plan_json

D1, D2, D3 = "2026-10-26", "2026-10-27", "2026-10-28"
API = "/api/v1/scheduling"


def lunch_at(key: str, start: str, **over) -> dict:
    body = plan_json(key, team_lead="Marcus Webb", **over)
    body["breaks"][1].update(start=m(start), end=m(start) + 30)
    return body


async def setup_people(client: AsyncClient, h: dict) -> dict:
    """a01 + a02 in team Alpha (led by employee L01), logins for a01 (agent),
    L01 (TL via team), Marcus Webb (TL via roster name) and an unrelated TL."""
    s = await create_structure(client, h)

    async def employee(code: str, first: str) -> str:
        r = await client.post("/api/v1/employees", headers=h, json={
            "employee_code": code, "first_name": first, "last_name": "Test",
            "email": f"{code}@test.dev", "team_id": s["team"]["id"], "lob_id": s["lob"]["id"],
        })
        assert r.status_code == 201, r.text
        return r.json()["data"]["id"]

    a01, _a02, lead = await employee("a01", "Ava"), await employee("a02", "Liam"), await employee(
        "L01", "Lena"
    )
    r = await client.patch(f"/api/v1/org/teams/{s['team']['id']}", headers=h,
                           json={"lob_id": s["lob"]["id"], "name": "Alpha",
                                 "leader_employee_id": lead})
    assert r.status_code == 200, r.text

    async def user(email: str, name: str, role: str, employee_id: str | None = None) -> dict:
        body = {"email": email, "password": "Demo@12345", "full_name": name, "role_names": [role]}
        if employee_id:
            body["employee_id"] = employee_id
        r = await client.post("/api/v1/users", headers=h, json=body)
        assert r.status_code == 201, r.text
        return await login(client, email, "Demo@12345")

    return {
        "agent": await user("ava@test.dev", "Ava Test", "Employee", a01),
        "team_lead": await user("lena@test.dev", "Lena Test", "Team Leader", lead),
        "marcus": await user("marcus@test.dev", "Marcus Webb", "Team Leader"),
        "other_tl": await user("olga@test.dev", "Olga Other", "Team Leader"),
    }


async def inbox(client: AsyncClient, headers: dict) -> list[dict]:
    return (await client.get("/api/v1/notifications", headers=headers)).json()["data"]


async def read_all(client: AsyncClient, headers: dict) -> None:
    for n in await inbox(client, headers):
        await client.post(f"/api/v1/notifications/{n['id']}/read", headers=headers)


async def save(client: AsyncClient, h: dict, day: str, *items: dict) -> None:
    r = await client.put(f"{API}/day-plans/{day}", headers=h, json={"items": list(items)})
    assert r.status_code == 200, r.text


# ------------------------------------------------------------------- unit


def test_describe_change() -> None:
    def day(**over) -> dp.AgentDay:
        d = dp.AgentDay(
            m("07:00"), m("15:30"),
            [dp.BreakSeg("b2", "lunch", "Lunch", m("11:00"), m("11:30"))],
            [dp.ChannelSeg("p", "phone", m("07:00"), m("15:30"))],
        )
        for k, v in over.items():
            setattr(d, k, v)
        return d

    base = day()
    assert schedule_notify.describe_change(base, base) == "Schedule updated"
    moved = day(breaks=[dp.BreakSeg("b2", "lunch", "Lunch", m("11:30"), m("12:00"))])
    assert schedule_notify.describe_change(base, moved) == "Lunch 11:00 → 11:30"
    longer = day(breaks=[dp.BreakSeg("b2", "lunch", "Lunch", m("11:00"), m("12:00"))])
    assert schedule_notify.describe_change(base, longer) == "Lunch 11:00–11:30 → 11:00–12:00"
    busy = day(
        shift_end=m("16:30"),
        activities=[dp.ActivitySeg("x", "meeting", m("13:00"), m("14:00"))],
        ot=[dp.ChannelSeg("o", "chat", m("16:30"), m("17:30"))],
    )
    assert schedule_notify.describe_change(base, busy) == (
        "Shift 07:00–15:30 → 07:00–16:30; + Meeting 13:00–14:00; + OT Chat 16:30–17:30"
    )
    assert schedule_notify.describe_change(busy, base).endswith("− OT Chat 16:30–17:30")
    realigned = day(channels=[dp.ChannelSeg("c", "chat", m("07:00"), m("15:30"))])
    assert schedule_notify.describe_change(base, realigned) == "Phone/Chat/Email alignment changed"
    assert schedule_notify.describe_change(base, None) == "Schedule removed"
    assert schedule_notify.fmt_day(date(2026, 11, 5)) == "Thu 5 Nov"


def test_default_horizon_is_three_months() -> None:
    assert dayplan_service.default_horizon(date(2026, 10, 24)) == (
        date(2026, 10, 24), date(2027, 1, 23)
    )
    # 30 Nov + 3 months has no 30 Feb — clamp to the month's last day first.
    assert dayplan_service.default_horizon(date(2026, 11, 30))[1] == date(2027, 2, 27)


# -------------------------------------------------------------------- API


async def test_drafts_hidden_until_published(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    who = await setup_people(client, h)
    await save(client, h, D1, plan_json("a01"), plan_json("a02"))

    assert len((await client.get(f"{API}/day-plans/{D1}", headers=h)).json()["data"]) == 2
    for viewer in (who["team_lead"], who["agent"]):
        assert (await client.get(f"{API}/day-plans/{D1}", headers=viewer)).json()["data"] == []
        rng = await client.get(f"{API}/day-plans", headers=viewer,
                               params={"start": D1, "end": D3})
        assert rng.json()["data"] == []

    pub = await client.post(f"{API}/day-plans/publish", headers=h,
                            json={"start": D1, "end": D1})
    assert pub.status_code == 200, pub.text
    assert pub.json()["data"] | {"notified": 0} == {
        "start": D1, "end": D1, "days": 1, "agents": 2, "published": 2, "unchanged": 0,
        "notified": 0,
    }

    tl_rows = (await client.get(f"{API}/day-plans/{D1}", headers=who["team_lead"])).json()
    assert [r["agent_key"] for r in tl_rows["data"]] == ["a01", "a02"]
    assert tl_rows["data"][0]["published_at"] is not None
    mine = (await client.get(f"{API}/day-plans/{D1}", headers=who["agent"])).json()["data"]
    assert [r["agent_key"] for r in mine] == ["a01"]  # agents only see themselves
    sheets = (await client.get(f"{API}/day-plans/{D1}/export", headers=who["agent"])).json()
    assert {r["Agent ID"] for r in sheets["data"]["Agent summary"]} == {"a01"}


async def test_publish_notifies_agent_and_team_leaders(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    who = await setup_people(client, h)
    await save(client, h, D1, lunch_at("a01", "11:00"), lunch_at("a02", "11:00"))
    await save(client, h, D2, lunch_at("a01", "11:00"))

    pub = (await client.post(f"{API}/day-plans/publish", headers=h,
                             json={"start": D1, "end": D3})).json()["data"]
    assert (pub["published"], pub["days"], pub["notified"]) == (3, 2, 3)

    [agent_note] = await inbox(client, who["agent"])
    assert agent_note["kind"] == "schedule_published"
    assert agent_note["title"] == "Your schedule is published"
    assert agent_note["body"].startswith("Mon 26 Oct – Tue 27 Oct · 2 days")
    assert agent_note["link"] == f"/scheduling?date={D1}"
    for tl in ("team_lead", "marcus"):  # via the team's leader, and via the roster TL name
        [digest] = await inbox(client, who[tl])
        assert digest["title"] == "Team schedules published"
        assert "2 agents: Agent a01, Agent a02" in digest["body"]
    assert await inbox(client, who["other_tl"]) == []
    assert await inbox(client, h) == []  # the publisher isn't notified

    again = (await client.post(f"{API}/day-plans/publish", headers=h,
                               json={"start": D1, "end": D3})).json()["data"]
    assert (again["published"], again["unchanged"], again["notified"]) == (0, 3, 0)


async def test_changes_to_published_days_notify_and_coalesce(
    client: AsyncClient, admin: dict
) -> None:
    h = admin["headers"]
    who = await setup_people(client, h)
    await save(client, h, D1, lunch_at("a01", "11:00"), lunch_at("a02", "11:00"))
    await save(client, h, D2, lunch_at("a01", "11:00"))
    await client.post(f"{API}/day-plans/publish", headers=h, json={"start": D1, "end": D1})
    for k in who.values():
        await read_all(client, k)

    # Drafts (D2 isn't published) change silently.
    await save(client, h, D2, lunch_at("a01", "12:00"))
    assert [n for n in await inbox(client, who["agent"]) if not n["read_at"]] == []

    await save(client, h, D1, lunch_at("a01", "11:30"))
    [note] = [n for n in await inbox(client, who["agent"]) if not n["read_at"]]
    assert note["kind"] == "schedule_changed"
    assert note["title"] == "Your schedule changed · Mon 26 Oct"
    assert note["body"] == "Lunch 11:00 → 11:30" and note["link"] == f"/scheduling?date={D1}"

    # A second edit while unread updates the same notification instead of adding one.
    await save(client, h, D1, lunch_at("a01", "12:00"), lunch_at("a02", "11:15"))
    unread = [n for n in await inbox(client, who["agent"]) if not n["read_at"]]
    assert len(unread) == 1 and unread[0]["body"] == "Lunch 11:00 → 11:30; Lunch 11:30 → 12:00"
    [digest] = [n for n in await inbox(client, who["marcus"]) if not n["read_at"]]
    assert digest["title"] == "Team schedule changed · Mon 26 Oct"
    assert digest["body"].splitlines() == [
        "Agent a01: Lunch 11:00 → 11:30; Lunch 11:30 → 12:00",
        "Agent a02: Lunch 11:00 → 11:15",
    ]

    # Server-side operations notify too, and so does removing a published day.
    await read_all(client, who["agent"])
    r = await client.post(f"{API}/day-plans/{D1}/mark-aux", headers=h, json={
        "agent_keys": ["a01"], "kind": "meeting", "start": m("13:30"), "length": 60,
    })
    assert r.status_code == 200, r.text
    [note] = [n for n in await inbox(client, who["agent"]) if not n["read_at"]]
    assert note["body"] == "+ Meeting 13:30–14:30"
    await read_all(client, who["agent"])
    await client.delete(f"{API}/day-plans/{D1}/a01", headers=h)
    [note] = [n for n in await inbox(client, who["agent"]) if not n["read_at"]]
    assert note["body"] == "Schedule removed"


async def test_fill_and_range_summary(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await save(client, h, D1, plan_json(
        "a01", overtime=[{"id": "o", "channel": "chat", "start": m("15:30"), "end": m("16:30")}],
        activities=[{"id": "x", "type": "meeting", "start": m("13:30"), "end": m("14:00")}],
    ))
    items = [{**plan_json(k, shift_start=m("08:00"), shift_end=m("16:30"), channels=[
        {"id": "p", "channel": "phone", "start": m("08:00"), "end": m("16:30")}
    ], breaks=[]), "plan_date": d} for d in (D1, D2, D3) for k in ("a01", "a02")]
    r = await client.post(f"{API}/day-plans/fill", headers=h, json={"items": items})
    assert r.status_code == 200, r.text
    assert r.json()["data"] == {"created": 5, "existing": 1}

    await client.post(f"{API}/day-plans/publish", headers=h,
                      json={"start": D2, "end": D2, "agent_keys": ["a02"]})
    rows = (await client.get(f"{API}/day-plans", headers=h,
                             params={"start": D1, "end": D3})).json()["data"]
    assert len(rows) == 6
    first = rows[0]
    assert (first["plan_date"], first["agent_key"], first["shift_start"]) == (D1, "a01", 420)
    assert (first["ot_minutes"], first["activities"]) == (60, ["meeting"])
    assert first["published"] is False
    assert [r["agent_key"] for r in rows if r["published"]] == ["a02"]

    bad = await client.get(f"{API}/day-plans", headers=h, params={"start": D3, "end": D1})
    assert bad.status_code == 422
    too_long = await client.post(f"{API}/day-plans/publish", headers=h,
                                 json={"start": "2026-01-01", "end": "2026-12-31"})
    assert too_long.status_code == 422


async def test_my_schedule_and_permissions(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    who = await setup_people(client, h)
    await save(client, h, D1, plan_json("a01"), plan_json("a02"))
    await save(client, h, D2, plan_json("a01"))
    await client.post(f"{API}/day-plans/publish", headers=h, json={"start": D1, "end": D1})

    mine = (await client.get(f"{API}/my-schedule", headers=who["agent"],
                             params={"start": D1, "end": D3})).json()["data"]
    assert mine["agent_keys"] == ["a01"]
    assert [d["plan_date"] for d in mine["days"]] == [D1]  # D2 is still a draft
    nobody = (await client.get(f"{API}/my-schedule", headers=who["marcus"])).json()["data"]
    assert nobody == {"agent_keys": [], "days": []}

    preview = await client.get(f"{API}/agent-schedule/a01", headers=who["team_lead"],
                               params={"start": D1, "end": D3})
    assert [d["plan_date"] for d in preview.json()["data"]] == [D1]
    denied = await client.get(f"{API}/agent-schedule/a02", headers=who["agent"],
                              params={"start": D1, "end": D3})
    assert denied.status_code == 403

    tl_publish = await client.post(f"{API}/day-plans/publish", headers=who["team_lead"],
                                   json={"start": D1, "end": D1})
    assert tl_publish.status_code == 403
    agent_fill = await client.post(f"{API}/day-plans/fill", headers=who["agent"],
                                   json={"items": [{**plan_json("a01"), "plan_date": D3}]})
    assert agent_fill.status_code == 403
