"""Work rules can forbid breaks near the shift's start / end; the server enforces it."""

from __future__ import annotations

from datetime import date, timedelta

from httpx import AsyncClient

from tests.test_dayplan import m, plan_json
from tests.test_publishing import save

API = "/api/v1/scheduling"
DAY = (date.today() + timedelta(days=5)).isoformat()
RULE = {
    "id": "wr-x",
    "name": "Guarded",
    "shiftMinutes": 510,
    "breaks": [{"type": "break", "minutes": 15}],
    "weekOff": [],
    "defaultStart": "07:00",
    "noBreakStartMinutes": 60,
    "noBreakEndMinutes": 60,
}


def brk(start: str, end: str) -> dict:
    return {"id": "b1", "type": "break", "label": "Break", "start": m(start), "end": m(end)}


async def setup(client: AsyncClient, h: dict) -> None:
    for key, value in (
        ("work_rules", [RULE]),
        ("agent_rules", {"a01": {"shiftPatternId": "wr:wr-x@07:00"}}),
    ):
        r = await client.put(f"{API}/settings/{key}", headers=h, json={"value": value})
        assert r.status_code == 200, r.text
    await save(client, h, DAY, plan_json("a01", breaks=[brk("10:00", "10:15")]), plan_json("a02"))


async def test_saves_cant_put_a_break_in_the_zone(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await setup(client, h)
    url = f"{API}/day-plans/{DAY}"
    for bad in (brk("07:30", "07:45"), brk("15:00", "15:15")):
        r = await client.put(url, headers=h, json={"items": [plan_json("a01", breaks=[bad])]})
        assert r.status_code == 422 and "no-break" in r.text
    ok = await client.put(
        url, headers=h, json={"items": [plan_json("a01", breaks=[brk("08:00", "08:15")])]}
    )
    assert ok.status_code == 200
    # Agents not on such a rule are unaffected.
    other = await client.put(
        url, headers=h, json={"items": [plan_json("a02", breaks=[brk("07:30", "07:45")])]}
    )
    assert other.status_code == 200


async def test_marking_a_break_in_the_zone_is_skipped(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await setup(client, h)
    body = {"agent_keys": ["a01"], "kind": "break", "start": m("07:15"), "length": 15}
    r = await client.post(f"{API}/day-plans/{DAY}/mark-aux", headers=h, json=body)
    assert r.status_code == 200, r.text
    assert "no breaks" in r.json()["data"]["skipped"][0]["reason"]


async def test_break_already_in_the_zone_doesnt_block_other_edits(
    client: AsyncClient, admin: dict
) -> None:
    h = admin["headers"]
    await setup(client, h)
    url = f"{API}/day-plans/{DAY}"
    await client.put(f"{API}/settings/agent_rules", headers=h, json={"value": {}})
    await save(client, h, DAY, plan_json("a01", breaks=[brk("07:30", "07:45")]))
    await client.put(
        f"{API}/settings/agent_rules",
        headers=h,
        json={"value": {"a01": {"shiftPatternId": "wr:wr-x@07:00"}}},
    )
    # The rule was tightened later: the old break stays, unrelated changes still save.
    body = plan_json("a01", breaks=[brk("07:30", "07:45")], team="Bravo")
    assert (await client.put(url, headers=h, json={"items": [body]})).status_code == 200


async def test_rule_where_breaks_cant_fit_is_refused(client: AsyncClient, admin: dict) -> None:
    bad = {**RULE, "noBreakStartMinutes": 240, "noBreakEndMinutes": 240, "shiftMinutes": 480}
    r = await client.put(
        f"{API}/settings/work_rules", headers=admin["headers"], json={"value": [bad]}
    )
    assert r.status_code == 422 and "fit" in r.text
