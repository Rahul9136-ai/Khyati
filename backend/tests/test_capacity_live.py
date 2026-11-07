"""Capacity Planning, real time: the live stream, the activity feed and batch sync."""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from contextlib import asynccontextmanager

from httpx import AsyncClient

from app.modules.capacity import live, service
from tests.conftest import TestSession
from tests.test_capacity_api import API, load
from tests.test_connect import Receiver, dispatch, make_key
from tests.test_connect import receiver as receiver  # noqa: F401  (pytest fixture)


@asynccontextmanager
async def session():
    async with TestSession() as db:
        yield db


def parse(chunk: str) -> tuple[str, dict]:
    lines = dict(line.split(": ", 1) for line in chunk.strip().splitlines())
    return lines["event"], json.loads(lines["data"])


async def open_stream(org: str, gone: list[bool]):
    async def disconnected() -> bool:
        return gone[0]

    # a long check interval: only a commit notification can wake the stream in time
    gen = live.stream(uuid.UUID(org), session, disconnected, check_seconds=30)
    assert (await anext(gen)).startswith("retry:")
    return gen


async def test_stream_pushes_a_change_the_moment_it_is_saved(
    client: AsyncClient, admin: dict
) -> None:
    h = admin["headers"]
    await load(client, h)
    gone = [False]
    gen = await open_stream(admin["org_id"], gone)
    name, hello = parse(await anext(gen))
    assert name == "hello" and hello["state"]["sheets"]["workingDays"]["version"] == 1
    assert live.listeners(uuid.UUID(admin["org_id"])) == 1

    # a CRM changes a row; the open stream hears about it straight away
    key = {
        "X-API-Key": await make_key(client, h, "planning:read", "planning:write", name="HubSpot")
    }
    nxt = asyncio.create_task(anext(gen))
    await asyncio.sleep(0.05)
    assert not nxt.done()  # nothing has changed yet
    r = await client.patch(
        f"{API}/sheets/workingDays/rows",
        headers=key,
        json={"upsert": [{"match": {"Month": "Sep'26"}, "values": {"Days": 42}}]},
    )
    assert r.status_code == 200, r.text
    name, change = parse(await asyncio.wait_for(nxt, timeout=2))
    assert name == "change"
    assert change["resultsVersion"] != hello["resultsVersion"]
    assert change["state"]["sheets"]["workingDays"]["version"] == 2
    top = change["activity"][0]
    assert top["source"] == "api" and top["apiKey"] == "HubSpot" and top["sheet"] == "workingDays"

    # a refused change (stale version) is rolled back: no event
    nxt = asyncio.create_task(anext(gen))
    r = await client.patch(
        f"{API}/sheets/workingDays/rows",
        headers=key,
        json={"upsert": [{"row": 2, "values": {"Days": 1}}], "base_version": 1},
    )
    assert r.status_code == 409
    await asyncio.sleep(0.2)
    assert not nxt.done()

    gone[0] = True
    nxt.cancel()  # the client went away mid-wait
    with contextlib.suppress(asyncio.CancelledError):
        await nxt
    await gen.aclose()
    assert live.listeners(uuid.UUID(admin["org_id"])) == 0


async def test_stream_endpoint_needs_auth(client: AsyncClient) -> None:
    assert (await client.get(f"{API}/stream")).status_code == 401


async def test_activity_shows_who_changed_what_app_or_api(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await load(client, h)
    await client.patch(f"{API}/config", headers=h, json={"config": {"snpPct": 0.25}})
    key = {"X-API-Key": await make_key(client, h, "planning:read", "planning:write", name="Zoho")}
    await client.patch(
        f"{API}/sheets/hiring/rows",
        headers=key,
        json={"deleteMatch": [{"Customer Name": "NO SUCH CUSTOMER"}]},
    )  # matches nothing: not logged
    await client.patch(
        f"{API}/sheets/workingDays/rows",
        headers=key,
        json={"upsert": [{"match": {"Month": "Sep'26"}, "values": {"Days": 20}}]},
    )
    r = await client.get(f"{API}/activity", headers=key, params={"limit": 3})
    assert r.status_code == 200, r.text
    a = r.json()["data"]
    assert [x["verb"] for x in a] == ["edited", "changed the switches", "replaced"]
    assert a[0]["source"] == "api" and a[0]["apiKey"] == "Zoho" and a[0]["label"] == "Working Days"
    assert a[0]["summary"] == "1 updated" and a[0]["version"] == 2
    assert (
        a[1]["source"] == "app" and a[1]["by"] == "admin@test.dev" and a[1]["summary"] == "snpPct"
    )
    assert (await client.get(f"{API}/activity", headers=h)).json()["data"].__len__() == 16


async def test_sync_applies_a_batch_all_or_nothing(
    client: AsyncClient, admin: dict, receiver: Receiver
) -> None:  # noqa: F811
    h = admin["headers"]
    await load(client, h)
    await client.post(
        "/api/v1/connect/webhooks",
        headers=h,
        json={"url": "https://crm.example/hook", "events": ["capacity.results.updated"]},
    )
    key = {"X-API-Key": await make_key(client, h, "planning:read", "planning:write")}
    before = (await client.get(f"{API}/state", headers=key)).json()["data"]
    batch = {
        "changes": [
            {
                "sheet": "workingDays",
                "upsert": [{"match": {"Month": "2026-09"}, "values": {"Days": 42}}],
            },
            {
                "sheet": "hiring",
                "upsert": [
                    {
                        "match": {"RR Number": "RR-NEW-1"},
                        "values": {"Customer Name": "PROJECT X", "Opening": 2},
                    }
                ],
            },
        ],
        "config": {"snpPct": 0.3},
    }
    r = await client.post(f"{API}/sync", headers={**key, "Idempotency-Key": "batch-1"}, json=batch)
    assert r.status_code == 200, r.text
    out = r.json()["data"]
    assert [a["sheet"] for a in out["applied"]] == ["workingDays", "hiring"]
    assert out["applied"][0]["updated"] == 1 and out["applied"][1]["inserted"] == 1
    assert out["config"]["config"]["snpPct"] == 0.3 and out["replayed"] is False
    after = (await client.get(f"{API}/state", headers=key)).json()["data"]
    assert out["resultsVersion"] == after["resultsVersion"] != before["resultsVersion"]
    assert after["sheets"]["hiring"]["rows"] == before["sheets"]["hiring"]["rows"] + 1

    # one recalculation → one results webhook for the whole batch
    receiver.calls.clear()
    await dispatch()
    assert [e["type"] for e in receiver.events()] == ["capacity.results.updated"]

    # the CRM retries (e.g. after a timeout): same answer, nothing applied twice
    r = await client.post(f"{API}/sync", headers={**key, "Idempotency-Key": "batch-1"}, json=batch)
    assert r.json()["data"]["replayed"] is True
    assert r.json()["data"]["resultsVersion"] == out["resultsVersion"]
    again = (await client.get(f"{API}/state", headers=key)).json()["data"]
    assert again["resultsVersion"] == after["resultsVersion"]
    # same key, different body → refused
    r = await client.post(
        f"{API}/sync",
        headers={**key, "Idempotency-Key": "batch-1"},
        json={"config": {"snpPct": 0.1}},
    )
    assert r.status_code == 409

    # second change is bad → the first one isn't saved either
    bad = {
        "changes": [
            {"sheet": "workingDays", "upsert": [{"row": 2, "values": {"Days": 5}}]},
            {"sheet": "hiring", "upsert": [{"values": {"Not A Column": 1}}]},
        ]
    }
    r = await client.post(f"{API}/sync", headers=key, json=bad)
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["message"].startswith("changes[1] (hiring): upsert[0]: unknown column")
    assert err["details"]["index"] == 1
    st = (await client.get(f"{API}/state", headers=key)).json()["data"]
    assert st["resultsVersion"] == after["resultsVersion"]
    wd = (await client.get(f"{API}/sheets/workingDays", headers=key)).json()["data"]
    assert next(r for r in wd["rows"] if r["__row"] == 2)["Days"] != 5

    # results after a rolled-back batch are still right (no stale cache)
    async with TestSession() as db:
        res, rv = await service.results(db, uuid.UUID(admin["org_id"]))
    assert rv == after["resultsVersion"]

    assert (await client.post(f"{API}/sync", headers=key, json={})).status_code == 422
    assert (
        await client.post(f"{API}/sync", headers=key, json={"changes": [{"sheet": "nope"}]})
    ).status_code == 404
