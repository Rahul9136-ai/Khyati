"""Connect: API keys, shared settings, signed webhooks and inbound time-off —
what a CRM uses to stay in sync."""

from __future__ import annotations

import json
from datetime import date, timedelta

import httpx
import pytest
from httpx import AsyncClient

from app.modules.connect import webhooks
from tests.conftest import TestSession
from tests.test_dayplan import m, plan_json
from tests.test_publishing import save

API = "/api/v1"
DAY = (date.today() + timedelta(days=5)).isoformat()
DAY2 = (date.today() + timedelta(days=6)).isoformat()

RULES = [
    {
        "id": "wr-8h",
        "name": "8h · 30m lunch + 2×15m breaks",
        "shiftMinutes": 480,
        "breaks": [
            {"type": "break", "minutes": 15},
            {"type": "lunch", "minutes": 30},
            {"type": "break", "minutes": 15},
        ],
        "weekOff": [5, 6],
        "weekOffMode": "fixed",
        "defaultStart": "09:00",
    }
]


async def make_key(client: AsyncClient, h: dict, *scopes: str, name: str = "CRM") -> str:
    r = await client.post(
        f"{API}/connect/api-keys", headers=h, json={"name": name, "scopes": list(scopes)}
    )
    assert r.status_code == 201, r.text
    body = r.json()["data"]
    assert body["key"].startswith("wfm_") and body["prefix"] == body["key"][:12]
    return body["key"]


class Receiver:
    """A fake webhook endpoint (httpx MockTransport)."""

    def __init__(self, status: int = 200) -> None:
        self.status = status
        self.calls: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        return httpx.Response(self.status, text="ok" if self.status < 300 else "nope")

    def events(self) -> list[dict]:
        return [json.loads(c.content) for c in self.calls]


@pytest.fixture
def receiver(monkeypatch: pytest.MonkeyPatch) -> Receiver:
    rec = Receiver()
    monkeypatch.setattr(webhooks, "_transport", httpx.MockTransport(rec))
    return rec


async def dispatch() -> int:
    async with TestSession() as db:
        n = await webhooks.dispatch_pending(db)
        await db.commit()
    return n


# ------------------------------------------------------------------ API keys


async def test_api_key_scopes_and_revocation(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await save(client, h, DAY, plan_json("a01"))
    await client.post(
        f"{API}/scheduling/day-plans/publish", headers=h, json={"start": DAY, "end": DAY}
    )
    # Read-only: published days only (drafts need schedule:write, like in the app).
    key = await make_key(client, h, "schedule:read", "employee:read")
    as_key = {"X-API-Key": key}

    r = await client.get(
        f"{API}/scheduling/day-plans/range", headers=as_key, params={"start": DAY, "end": DAY}
    )
    assert r.status_code == 200 and r.json()["data"][0]["agent_key"] == "a01"
    # The same key as a bearer token works too.
    bearer = {"Authorization": f"Bearer {key}"}
    assert (
        await client.get(f"{API}/scheduling/day-plans/{DAY}", headers=bearer)
    ).status_code == 200

    # Read-only key: can't write, and can't mint more keys.
    r = await client.put(
        f"{API}/scheduling/day-plans/{DAY}", headers=as_key, json={"items": [plan_json("a02")]}
    )
    assert r.status_code == 403
    assert (await client.get(f"{API}/connect/api-keys", headers=as_key)).status_code == 403

    listed = (await client.get(f"{API}/connect/api-keys", headers=h)).json()["data"]
    assert listed[0]["name"] == "CRM" and "key" not in listed[0]
    assert listed[0]["last_used_at"] is not None

    await client.delete(f"{API}/connect/api-keys/{listed[0]['id']}", headers=h)
    r = await client.get(f"{API}/scheduling/day-plans/{DAY}", headers=as_key)
    assert r.status_code == 401
    assert (
        await client.get(f"{API}/scheduling/day-plans/{DAY}", headers={"X-API-Key": "wfm_nope"})
    ).status_code == 401
    assert (await client.get(f"{API}/scheduling/day-plans/{DAY}")).status_code == 401


async def test_key_cannot_exceed_its_creator(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    r = await client.post(
        f"{API}/connect/api-keys", headers=h, json={"name": "x", "scopes": ["nope:nope"]}
    )
    assert r.status_code == 422
    scopes = (await client.get(f"{API}/connect/scopes", headers=h)).json()["data"]
    assert {
        "code": "schedule:write",
        "description": "Create and edit schedules and shift templates",
    } in scopes


# ------------------------------------------------------------------ settings


async def test_settings_are_shared_and_versioned(
    client: AsyncClient, admin: dict, receiver: Receiver
) -> None:
    h = admin["headers"]
    await client.post(
        f"{API}/connect/webhooks",
        headers=h,
        json={"url": "https://crm.example/hook", "events": ["settings.updated"]},
    )
    assert (await client.get(f"{API}/scheduling/settings", headers=h)).json()["data"] == []

    r = await client.put(
        f"{API}/scheduling/settings/work_rules", headers=h, json={"value": RULES, "base_version": 0}
    )
    assert r.status_code == 200 and r.json()["data"]["version"] == 1
    agents = {
        "a01": {"shiftPatternId": "wr:wr-8h@09:00", "weekOff": [5, 6], "weekOffMode": "fixed"}
    }
    await client.put(f"{API}/scheduling/settings/agent_rules", headers=h, json={"value": agents})

    # Another browser / a CRM with a key sees the same.
    key = await make_key(client, h, "schedule:read", "schedule:write")
    got = (await client.get(f"{API}/scheduling/settings", headers={"X-API-Key": key})).json()[
        "data"
    ]
    assert {s["key"]: s["value"] for s in got} == {"agent_rules": agents, "work_rules": RULES}

    # Saving the same value again doesn't make a new version.
    r = await client.put(
        f"{API}/scheduling/settings/work_rules", headers=h, json={"value": RULES, "base_version": 1}
    )
    assert r.json()["data"]["version"] == 1
    # A change based on an old version is refused.
    changed = [{**RULES[0], "shiftMinutes": 540}]
    r = await client.put(
        f"{API}/scheduling/settings/work_rules",
        headers={"X-API-Key": key},
        json={"value": changed, "base_version": 1},
    )
    assert r.json()["data"]["version"] == 2
    r = await client.put(
        f"{API}/scheduling/settings/work_rules", headers=h, json={"value": RULES, "base_version": 1}
    )
    assert r.status_code == 409

    bad = [{**RULES[0], "weekOff": [9]}]
    assert (
        await client.put(f"{API}/scheduling/settings/work_rules", headers=h, json={"value": bad})
    ).status_code == 422
    assert (
        await client.put(f"{API}/scheduling/settings/nope", headers=h, json={"value": {}})
    ).status_code == 404

    assert await dispatch() == 3  # work_rules v1, agent_rules v1, work_rules v2
    events = receiver.events()
    assert [(e["type"], e["data"]["key"], e["data"]["version"]) for e in events] == [
        ("settings.updated", "work_rules", 1),
        ("settings.updated", "agent_rules", 1),
        ("settings.updated", "work_rules", 2),
    ]
    assert "(API key: CRM)" in events[2]["data"]["updated_by"]


# ------------------------------------------------------------------ webhooks


async def test_schedule_changes_are_signed_and_delivered(
    client: AsyncClient, admin: dict, receiver: Receiver
) -> None:
    h = admin["headers"]
    sub = (
        await client.post(
            f"{API}/connect/webhooks",
            headers=h,
            json={
                "url": "https://crm.example/hook",
                "events": ["schedule.updated", "schedule.published"],
            },
        )
    ).json()["data"]
    assert sub["secret"].startswith("whsec_")

    await save(client, h, DAY, plan_json("a01"), plan_json("a02"))
    await client.post(
        f"{API}/scheduling/day-plans/publish", headers=h, json={"start": DAY, "end": DAY}
    )
    assert await dispatch() == 2
    assert await dispatch() == 0  # nothing left

    upd, pub = receiver.events()
    assert upd["type"] == "schedule.updated" and upd["data"]["date"] == DAY
    a01 = upd["data"]["agents"][0]
    assert a01["agent_key"] == "a01" and a01["shift"] == {"start": "07:00", "end": "15:30"}
    assert a01["day_status"] == "working" and a01["breaks"][0]["start"] == "09:00"
    assert pub["type"] == "schedule.published"
    assert pub["data"]["days"] == [{"date": DAY, "agents": ["a01", "a02"]}]

    req = receiver.calls[0]
    assert req.headers["X-WFM-Event"] == "schedule.updated"
    assert webhooks.verify(
        sub["secret"], req.headers["X-WFM-Timestamp"], req.content, req.headers["X-WFM-Signature"]
    )
    assert not webhooks.verify(
        "whsec_wrong", req.headers["X-WFM-Timestamp"], req.content, req.headers["X-WFM-Signature"]
    )

    log = (await client.get(f"{API}/connect/webhooks/{sub['id']}/deliveries", headers=h)).json()[
        "data"
    ]
    assert [d["status"] for d in log] == ["delivered", "delivered"]


async def test_failed_deliveries_retry_and_can_be_redelivered(
    client: AsyncClient, admin: dict, receiver: Receiver
) -> None:
    h = admin["headers"]
    sub = (
        await client.post(
            f"{API}/connect/webhooks", headers=h, json={"url": "https://crm.example/hook"}
        )
    ).json()["data"]
    receiver.status = 500
    await save(client, h, DAY, plan_json("a01"))
    assert await dispatch() == 1
    [d] = (await client.get(f"{API}/connect/webhooks/{sub['id']}/deliveries", headers=h)).json()[
        "data"
    ]
    assert (d["status"], d["attempts"], d["response_status"], d["error"]) == (
        "retrying",
        1,
        500,
        "HTTP 500",
    )
    assert await dispatch() == 0  # waits for the backoff

    receiver.status = 200
    r = await client.post(f"{API}/connect/deliveries/{d['id']}/redeliver", headers=h)
    assert r.json()["data"]["status"] == "delivered" and r.json()["data"]["attempts"] == 2
    hooks = (await client.get(f"{API}/connect/webhooks", headers=h)).json()["data"]
    assert hooks[0]["consecutive_failures"] == 0 and hooks[0]["last_success_at"]

    # Test button: a ping, sent straight away.
    r = await client.post(f"{API}/connect/webhooks/{sub['id']}/test", headers=h)
    assert r.json()["data"]["event_type"] == "ping" and r.json()["data"]["status"] == "delivered"

    # Paused webhooks get nothing new queued; only subscribed events are sent.
    await client.patch(f"{API}/connect/webhooks/{sub['id']}", headers=h, json={"active": False})
    await save(client, h, DAY, plan_json("a02"))
    assert await dispatch() == 0
    bad = await client.post(
        f"{API}/connect/webhooks", headers=h, json={"url": "ftp://x", "events": ["nope"]}
    )
    assert bad.status_code == 422


# ------------------------------------------------------------------ inbound


async def test_crm_marks_leave_and_absence(
    client: AsyncClient, admin: dict, receiver: Receiver
) -> None:
    h = admin["headers"]
    await save(client, h, DAY, plan_json("a01"))
    await save(client, h, DAY2, plan_json("a01"))
    key = {"X-API-Key": await make_key(client, h, "schedule:read", "schedule:write")}
    await client.post(
        f"{API}/connect/webhooks",
        headers=h,
        json={"url": "https://crm.example/hook", "events": ["schedule.updated"]},
    )

    end = (date.fromisoformat(DAY2) + timedelta(days=1)).isoformat()
    body = {
        "agent_key": "a01",
        "start_date": DAY,
        "end_date": end,
        "type": "leave",
        "note": "Annual leave",
        "external_id": "LV-1001",
    }
    r = await client.post(f"{API}/connect/inbound/time-off", headers=key, json=body)
    data = r.json()["data"]
    assert data["applied"] == [DAY, DAY2]
    assert data["skipped"] == [{"date": end, "reason": "No schedule saved for that day yet"}]

    async def acts(day: str) -> list[tuple]:
        row = (await client.get(f"{API}/scheduling/day-plans/{day}", headers=h)).json()["data"][0]
        return [(a["type"], a["start"], a["end"], a.get("note")) for a in row["activities"]]

    assert await acts(DAY) == [("leave", m("07:00"), m("15:30"), "Annual leave")]
    # Same external id again → updated in place (not doubled); part-day absence.
    body2 = {
        **body,
        "end_date": DAY,
        "type": "absence",
        "start": "13:00",
        "end": "15:30",
        "note": "Doctor",
    }
    await client.post(f"{API}/connect/inbound/time-off", headers=key, json=body2)
    assert await acts(DAY) == [("absence", m("13:00"), m("15:30"), "Doctor")]
    # And removed.
    await client.post(
        f"{API}/connect/inbound/time-off", headers=key, json={**body2, "action": "remove"}
    )
    assert await acts(DAY) == []

    await dispatch()
    statuses = [a["day_status"] for e in receiver.events() for a in e["data"]["agents"]]
    assert statuses[:2] == ["leave", "leave"]

    ro = {"X-API-Key": await make_key(client, h, "schedule:read", name="ro")}
    assert (
        await client.post(f"{API}/connect/inbound/time-off", headers=ro, json=body)
    ).status_code == 403
