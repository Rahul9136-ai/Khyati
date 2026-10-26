"""VTO / PTO / OT / Leave slots: opening, who sees them, first-come claims
written into the schedule, capacity, cancelling and notifications."""

from __future__ import annotations

from datetime import date, timedelta

from httpx import AsyncClient

from tests.test_dayplan import m, plan_json
from tests.test_publishing import inbox, read_all, save, setup_people

API = "/api/v1/scheduling"
DAY = (date.today() + timedelta(days=2)).isoformat()
DRAFT_DAY = (date.today() + timedelta(days=3)).isoformat()


def slot(kind: str, start: str, end: str, capacity: int, eligible=None, **over) -> dict:
    return {
        "plan_date": DAY,
        "queue_key": "sales",
        "queue_name": "Sales",
        "kind": kind,
        "start": m(start),
        "end": m(end),
        "capacity": capacity,
        "eligible": eligible,
        **over,
    }


async def setup(client: AsyncClient, h: dict) -> tuple[dict, dict[str, dict]]:
    who = await setup_people(client, h)
    await save(
        client,
        h,
        DAY,
        plan_json("a01", team_lead="Marcus Webb"),
        plan_json("a02", team_lead="Marcus Webb"),
    )
    await save(client, h, DRAFT_DAY, plan_json("a01"))
    await client.post(f"{API}/day-plans/publish", headers=h, json={"start": DAY, "end": DAY})
    for k in who.values():
        await read_all(client, k)
    r = await client.post(
        f"{API}/offers",
        headers=h,
        json={
            "items": [
                slot("vto", "13:00", "14:00", 2, ["a01", "a02"]),
                slot("ot", "16:00", "17:00", 1, ["a01"], channel="chat"),
                slot("pto", "10:00", "11:00", 1, ["a02"]),
                slot("leave", "00:00", "00:00", 1, ["a02"]),
                slot("ot", "09:00", "10:00", 3, None),
            ]
        },
    )
    assert r.status_code == 200, r.text
    by = {f"{o['kind']}@{o['start']}": o for o in r.json()["data"]["offers"]}
    return who, by


async def offers_for(client: AsyncClient, headers: dict) -> dict[str, dict]:
    rows = (
        await client.get(f"{API}/offers", headers=headers, params={"start": DAY, "end": DAY})
    ).json()["data"]
    return {f"{o['kind']}@{o['start']}": o for o in rows}


async def day_of(client: AsyncClient, h: dict, key: str, day: str = DAY) -> dict:
    rows = (await client.get(f"{API}/day-plans/{day}", headers=h)).json()["data"]
    return next(r for r in rows if r["agent_key"] == key)


async def test_open_slots_and_who_sees_them(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    who, opened = await setup(client, h)
    assert {k: (o["capacity"], o["filled"], o["left"]) for k, o in opened.items()} == {
        f"vto@{m('13:00')}": (2, 0, 2),
        f"ot@{m('16:00')}": (1, 0, 1),
        f"pto@{m('10:00')}": (1, 0, 1),
        "leave@0": (1, 0, 1),
        f"ot@{m('09:00')}": (3, 0, 3),
    }
    assert opened["leave@0"]["end"] == 24 * 60

    # The agent (a01) only sees what they're eligible for.
    mine = await offers_for(client, who["agent"])
    assert set(mine) == {f"vto@{m('13:00')}", f"ot@{m('16:00')}", f"ot@{m('09:00')}"}
    [note] = [n for n in await inbox(client, who["agent"]) if not n["read_at"]]
    assert note["kind"] == "schedule_slots" and note["link"] == "/scheduling"
    assert note["body"].endswith(": 4 OT · 2 VTO")  # 1 + 3 OT, 2 VTO on the day
    assert len(await offers_for(client, who["marcus"])) == 5  # staff see all

    # Re-opening the same slot updates it instead of adding another.
    again = await client.post(
        f"{API}/offers",
        headers=h,
        json={
            "items": [slot("vto", "13:00", "14:00", 3, ["a01", "a02"])],
            "notify": False,
        },
    )
    assert again.json()["data"] | {"offers": None} == {
        "created": 0,
        "updated": 1,
        "notified": 0,
        "offers": None,
    }


async def test_claims_fill_slots_and_edit_the_schedule(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    who, opened = await setup(client, h)
    vto, ot = opened[f"vto@{m('13:00')}"], opened[f"ot@{m('16:00')}"]

    r = await client.post(f"{API}/offers/{vto['id']}/claim", headers=who["agent"], json={})
    assert r.status_code == 200, r.text
    got = r.json()["data"]
    assert (got["filled"], got["left"], got["mine"]["agent_key"]) == (1, 1, "a01")
    day = await day_of(client, h, "a01")
    assert [(a["type"], a["start"], a["end"]) for a in day["activities"]] == [
        ("vto", m("13:00"), m("14:00"))
    ]
    # The TL hears about it like any change to a published day.
    [digest] = [n for n in await inbox(client, who["marcus"]) if not n["read_at"]]
    assert digest["body"] == "Agent a01: + VTO 13:00–14:00"

    dup = await client.post(f"{API}/offers/{vto['id']}/claim", headers=who["agent"], json={})
    assert dup.status_code == 409

    r = await client.post(f"{API}/offers/{ot['id']}/claim", headers=who["agent"], json={})
    assert r.status_code == 200, r.text
    assert [
        (o["channel"], o["start"], o["end"]) for o in (await day_of(client, h, "a01"))["overtime"]
    ] == [("chat", m("16:00"), m("17:00"))]
    full = await client.post(f"{API}/offers/{ot['id']}/claim", headers=h, json={"agent_key": "a02"})
    assert full.status_code == 422  # a02 isn't eligible for this one…
    early = opened[f"ot@{m('09:00')}"]
    inside = await client.post(f"{API}/offers/{early['id']}/claim", headers=who["agent"], json={})
    assert inside.status_code == 422 and "already working" in inside.json()["error"]["message"]

    # Staff can claim for an agent: full-day Leave for a02.
    leave = opened["leave@0"]
    r = await client.post(f"{API}/offers/{leave['id']}/claim", headers=h, json={"agent_key": "a02"})
    assert r.status_code == 200, r.text
    a02 = await day_of(client, h, "a02")
    assert [(a["type"], a["start"], a["end"]) for a in a02["activities"]] == [
        ("leave", m("07:00"), m("15:30"))
    ]
    no_more = await client.post(
        f"{API}/offers/{leave['id']}/claim", headers=h, json={"agent_key": "a02"}
    )
    assert no_more.status_code == 409
    pto = opened[f"pto@{m('10:00')}"]
    not_mine = await client.post(f"{API}/offers/{pto['id']}/claim", headers=who["agent"], json={})
    assert not_mine.status_code == 422 and "skilled on Sales" in not_mine.json()["error"]["message"]

    # Agents see their own claim only; staff see everyone's.
    agent_view = (await offers_for(client, who["agent"]))[f"vto@{m('13:00')}"]
    assert [c["agent_key"] for c in agent_view["claims"]] == ["a01"]
    staff_view = (await offers_for(client, h))["leave@0"]
    assert [c["agent_key"] for c in staff_view["claims"]] == ["a02"]


async def test_cancel_capacity_close_and_rules(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    who, opened = await setup(client, h)
    vto, ot = opened[f"vto@{m('13:00')}"], opened[f"ot@{m('16:00')}"]
    mine = (
        await client.post(f"{API}/offers/{vto['id']}/claim", headers=who["agent"], json={})
    ).json()["data"]["mine"]
    ot_claim = (
        await client.post(f"{API}/offers/{ot['id']}/claim", headers=who["agent"], json={})
    ).json()["data"]["mine"]

    r = await client.post(f"{API}/offers/claims/{mine['id']}/cancel", headers=who["agent"])
    assert r.status_code == 200, r.text
    assert (r.json()["data"]["filled"], r.json()["data"]["mine"]) == (0, None)
    r = await client.post(f"{API}/offers/claims/{ot_claim['id']}/cancel", headers=h)
    assert r.status_code == 200, r.text
    day = await day_of(client, h, "a01")
    assert (day["activities"], day["overtime"]) == ([], [])
    again = await client.post(f"{API}/offers/claims/{mine['id']}/cancel", headers=h)
    assert again.status_code == 409

    await client.post(f"{API}/offers/{vto['id']}/claim", headers=who["agent"], json={})
    low = await client.patch(f"{API}/offers/{vto['id']}", headers=h, json={"capacity": 0})
    assert low.status_code == 422
    closed = await client.patch(f"{API}/offers/{ot['id']}", headers=h, json={"status": "closed"})
    assert closed.json()["data"]["status"] == "closed"
    assert f"ot@{m('16:00')}" not in await offers_for(client, who["agent"])
    shut = await client.post(f"{API}/offers/{ot['id']}/claim", headers=who["agent"], json={})
    assert shut.status_code == 409
    busy = await client.delete(f"{API}/offers/{vto['id']}", headers=h)
    assert busy.status_code == 409
    assert (await client.delete(f"{API}/offers/{ot['id']}", headers=h)).status_code == 200

    # Not published yet, and permissions.
    draft = (
        await client.post(
            f"{API}/offers",
            headers=h,
            json={
                "items": [{**slot("vto", "13:00", "14:00", 1, None), "plan_date": DRAFT_DAY}],
                "notify": False,
            },
        )
    ).json()["data"]["offers"][0]
    r = await client.post(f"{API}/offers/{draft['id']}/claim", headers=who["agent"], json={})
    assert r.status_code == 422 and "isn't published" in r.json()["error"]["message"]
    other = await client.post(
        f"{API}/offers/{draft['id']}/claim", headers=who["agent"], json={"agent_key": "a02"}
    )
    assert other.status_code == 403
    tl_open = await client.post(
        f"{API}/offers",
        headers=who["team_lead"],
        json={"items": [slot("vto", "13:00", "14:00", 1)]},
    )
    assert tl_open.status_code == 403
