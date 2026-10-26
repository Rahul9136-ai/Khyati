"""Auto-planned Phone/Chat/Email drafts: hidden until published, publishing
writes them into the schedules, publishes the days and notifies people."""

from __future__ import annotations

from datetime import date, timedelta

from httpx import AsyncClient

from tests.test_dayplan import m, plan_json
from tests.test_publishing import inbox, read_all, save, setup_people

API = "/api/v1/scheduling"
DAY = (date.today() + timedelta(days=7)).isoformat()
DAY2 = (date.today() + timedelta(days=8)).isoformat()


def lanes(*blocks: tuple[str, str, str]) -> list[dict]:
    return [
        {"id": f"c{i}", "channel": ch, "start": m(s), "end": m(e)}
        for i, (ch, s, e) in enumerate(blocks)
    ]


async def setup(client: AsyncClient, h: dict) -> dict:
    who = await setup_people(client, h)
    await save(client, h, DAY, plan_json("a01", team_lead="Marcus Webb"), plan_json("a02"))
    await save(client, h, DAY2, plan_json("a02", team_lead="Marcus Webb"))
    await client.post(f"{API}/day-plans/publish", headers=h, json={"start": DAY, "end": DAY})
    for k in who.values():
        await read_all(client, k)
    return who


async def version(client: AsyncClient, h: dict, day: str, key: str) -> int:
    rows = (
        await client.get(f"{API}/day-plans/range", headers=h, params={"start": day, "end": day})
    ).json()["data"]
    return next(r["version"] for r in rows if r["agent_key"] == key)


async def channels_of(client: AsyncClient, headers: dict, day: str, key: str):
    rows = (await client.get(f"{API}/day-plans/{day}", headers=headers)).json()["data"]
    row = next((r for r in rows if r["agent_key"] == key), None)
    return row and [(c["channel"], c["start"], c["end"]) for c in row["channels"]]


async def test_drafts_hidden_until_published(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    who = await setup(client, h)
    full = (
        await client.get(f"{API}/day-plans/range", headers=h, params={"start": DAY, "end": DAY2})
    ).json()["data"]
    assert [(r["plan_date"], r["agent_key"]) for r in full] == [
        (DAY, "a01"),
        (DAY, "a02"),
        (DAY2, "a02"),
    ]
    assert full[0]["breaks"] and full[0]["channels"]  # full rows, not summaries

    r = await client.put(
        f"{API}/channel-drafts",
        headers=h,
        json={
            "start": DAY,
            "end": DAY2,
            "items": [
                {
                    "plan_date": DAY,
                    "agent_key": "a01",
                    "agent_name": "Agent a01",
                    "base_version": await version(client, h, DAY, "a01"),
                    "summary": "Phone → Phone + Email",
                    "channels": lanes(("phone", "07:00", "11:00"), ("email", "11:00", "15:30")),
                },
                {
                    "plan_date": DAY2,
                    "agent_key": "a02",
                    "base_version": await version(client, h, DAY2, "a02"),
                    "channels": lanes(("chat", "07:00", "15:30")),
                },
            ],
        },
    )
    assert r.status_code == 200, r.text
    drafts = (
        await client.get(f"{API}/channel-drafts", headers=h, params={"start": DAY, "end": DAY2})
    ).json()["data"]
    assert [(d["plan_date"], d["agent_key"], d["summary"]) for d in drafts] == [
        (DAY, "a01", "Phone → Phone + Email"),
        (DAY2, "a02", ""),
    ]

    # Agents, TLs and the schedule itself are unchanged until publishing.
    assert await channels_of(client, who["agent"], DAY, "a01") == [
        ("phone", m("07:00"), m("15:30"))
    ]
    assert [n for n in await inbox(client, who["agent"]) if not n["read_at"]] == []
    denied = await client.get(
        f"{API}/channel-drafts", headers=who["team_lead"], params={"start": DAY, "end": DAY2}
    )
    assert denied.status_code == 403

    pub = await client.post(
        f"{API}/channel-drafts/publish", headers=h, json={"start": DAY, "end": DAY2}
    )
    assert pub.status_code == 200, pub.text
    res = pub.json()["data"]
    assert (res["applied"], res["stale"], res["published_days"]) == (2, [], 1)

    assert await channels_of(client, who["agent"], DAY, "a01") == [
        ("phone", m("07:00"), m("11:00")),
        ("email", m("11:00"), m("15:30")),
    ]
    [note] = [n for n in await inbox(client, who["agent"]) if not n["read_at"]]
    assert note["title"].startswith("Your schedule changed")
    assert note["body"] == "Channels now Phone 07:00–11:00 · Email 11:00–15:30"
    # DAY2 was a draft day: now published, so the TL sees it.
    assert await channels_of(client, who["team_lead"], DAY2, "a02") == [
        ("chat", m("07:00"), m("15:30"))
    ]
    left = (
        await client.get(f"{API}/channel-drafts", headers=h, params={"start": DAY, "end": DAY2})
    ).json()["data"]
    assert left == []


async def test_stale_invalid_and_discard(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    who = await setup(client, h)
    base = await version(client, h, DAY, "a01")
    bad = await client.put(
        f"{API}/channel-drafts",
        headers=h,
        json={
            "start": DAY,
            "end": DAY,
            "items": [
                {
                    "plan_date": DAY,
                    "agent_key": "a01",
                    "base_version": base,
                    "channels": lanes(("phone", "06:00", "15:30")),
                },
            ],
        },
    )
    assert bad.status_code == 422 and "inside the shift" in str(bad.json()["error"]["details"])
    unknown = await client.put(
        f"{API}/channel-drafts",
        headers=h,
        json={
            "start": DAY,
            "end": DAY,
            "items": [
                {
                    "plan_date": DAY,
                    "agent_key": "zz9",
                    "base_version": 1,
                    "channels": lanes(("chat", "07:00", "15:30")),
                },
            ],
        },
    )
    assert unknown.status_code == 422

    item = {
        "plan_date": DAY,
        "agent_key": "a01",
        "base_version": base,
        "channels": lanes(("chat", "07:00", "15:30")),
    }
    await client.put(
        f"{API}/channel-drafts", headers=h, json={"start": DAY, "end": DAY, "items": [item]}
    )
    # Someone edits the day after it was planned → the draft is skipped, not forced.
    await save(
        client,
        h,
        DAY,
        plan_json("a01", shift_end=m("16:00"), channels=lanes(("phone", "07:00", "16:00"))),
    )
    res = (
        await client.post(
            f"{API}/channel-drafts/publish", headers=h, json={"start": DAY, "end": DAY}
        )
    ).json()["data"]
    assert res["applied"] == 0 and res["stale"][0]["agent_key"] == "a01"
    assert await channels_of(client, h, DAY, "a01") == [("phone", m("07:00"), m("16:00"))]

    await client.put(
        f"{API}/channel-drafts",
        headers=h,
        json={
            "start": DAY,
            "end": DAY,
            "items": [{**item, "base_version": await version(client, h, DAY, "a01")}],
        },
    )
    tl_pub = await client.post(
        f"{API}/channel-drafts/publish", headers=who["team_lead"], json={"start": DAY, "end": DAY}
    )
    assert tl_pub.status_code == 403
    gone = await client.post(
        f"{API}/channel-drafts/discard", headers=h, json={"start": DAY, "end": DAY}
    )
    assert gone.json()["data"] == {"discarded": 1}
