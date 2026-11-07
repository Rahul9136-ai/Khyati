"""Workspace data: what people add is saved on the server, per organisation,
until someone removes it; versions stop silent overwrites; roles limit who
may change what."""

from __future__ import annotations

import uuid

from httpx import AsyncClient

from tests.conftest import ADMIN_PASSWORD, TestSession, login
from tests.test_connect import Receiver, dispatch
from tests.test_connect import receiver as receiver  # noqa: F401  (pytest fixture)

API = "/api/v1/workspace/data"


async def _user(org_id: str, email: str, role: str) -> dict:
    from app.modules.identity.schemas import UserCreate
    from app.modules.identity.service import create_user

    async with TestSession() as db:
        await create_user(
            db,
            UserCreate(
                email=email,
                password=ADMIN_PASSWORD,
                full_name=email,
                role_names=[role],
                organization_id=uuid.UUID(org_id),
            ),
            actor=None,
        )
        await db.commit()
    return await login(_client, email, ADMIN_PASSWORD)


_client: AsyncClient


async def test_added_items_stay_until_removed_and_every_browser_sees_them(
    client: AsyncClient, admin: dict
) -> None:
    h = admin["headers"]
    assert (await client.get(API, headers=h)).json()["data"]["areas"] == []

    scenarios = [{"id": "s1", "name": "Peak season +20%"}]
    r = await client.put(
        f"{API}/scenarios", headers=h, json={"value": scenarios, "base_version": 0}
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["version"] == 1

    # another browser (a fresh login) loads it
    other = await login(client, "admin@test.dev", ADMIN_PASSWORD)
    data = (await client.get(API, headers=other)).json()["data"]
    area = next(a for a in data["areas"] if a["key"] == "scenarios")
    assert area["value"] == scenarios and area["version"] == 1 and area["canWrite"] is True
    assert data["keys"]["agents"] is True

    # add a second one, then remove the first: each save is a new version
    two = [*scenarios, {"id": "s2", "name": "New site"}]
    r = await client.put(f"{API}/scenarios", headers=other, json={"value": two, "base_version": 1})
    assert r.json()["data"]["version"] == 2
    r = await client.put(f"{API}/scenarios", headers=h, json={"value": two[1:], "base_version": 2})
    assert r.json()["data"]["version"] == 3
    got = (await client.get(f"{API}/scenarios", headers=h)).json()["data"]
    assert got["value"] == [{"id": "s2", "name": "New site"}]

    # saving the same value again doesn't make a new version
    r = await client.put(f"{API}/scenarios", headers=h, json={"value": two[1:], "base_version": 3})
    assert r.json()["data"]["version"] == 3

    # versions only (cheap to poll)
    lite = (await client.get(API, headers=h, params={"values": "false"})).json()["data"]
    assert "value" not in lite["areas"][0] and lite["areas"][0]["version"] == 3


async def test_stale_save_is_refused_with_the_current_copy(
    client: AsyncClient, admin: dict
) -> None:
    h = admin["headers"]
    await client.put(
        f"{API}/ptoRequests", headers=h, json={"value": [{"id": "a"}], "base_version": 0}
    )
    await client.put(
        f"{API}/ptoRequests",
        headers=h,
        json={"value": [{"id": "a"}, {"id": "b"}], "base_version": 1},
    )
    r = await client.put(f"{API}/ptoRequests", headers=h, json={"value": [], "base_version": 1})
    assert r.status_code == 409
    details = r.json()["error"]["details"]
    assert details["version"] == 2 and details["value"] == [{"id": "a"}, {"id": "b"}]
    # a stale save of exactly what's already there is fine (two tabs saving the same change)
    r = await client.put(
        f"{API}/ptoRequests",
        headers=h,
        json={"value": [{"id": "a"}, {"id": "b"}], "base_version": 1},
    )
    assert r.status_code == 200 and r.json()["data"]["version"] == 2


async def test_bad_requests(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    assert (await client.get(API)).status_code == 401
    assert (await client.put(f"{API}/nope", headers=h, json={"value": 1})).status_code == 404
    assert (await client.get(f"{API}/agents", headers=h)).status_code == 404  # never saved
    assert (await client.put(f"{API}/agents", headers=h, json={"value": None})).status_code == 422
    big = "x" * 5_000_001
    assert (await client.put(f"{API}/auditLog", headers=h, json={"value": big})).status_code == 422


async def test_roles_limit_who_may_change_what(client: AsyncClient, admin: dict) -> None:
    global _client
    _client = client
    emp = await _user(admin["org_id"], "emp@test.dev", "Employee")
    # an employee may post messages and raise PTO requests, not edit the roster or users
    assert (
        await client.put(f"{API}/messages", headers=emp, json={"value": [{"id": "m1"}]})
    ).status_code == 200
    assert (
        await client.put(f"{API}/ptoRequests", headers=emp, json={"value": [{"id": "p1"}]})
    ).status_code == 200
    r = await client.put(f"{API}/agents", headers=emp, json={"value": []})
    assert r.status_code == 403 and "employee:write" in r.json()["error"]["message"]
    assert (await client.put(f"{API}/users", headers=emp, json={"value": []})).status_code == 403
    keys = (await client.get(API, headers=emp)).json()["data"]["keys"]
    assert keys["messages"] and keys["ptoRequests"] and not keys["agents"] and not keys["users"]
    # but can read what others saved
    await client.put(f"{API}/queues", headers=admin["headers"], json={"value": [{"id": "q1"}]})
    area = next(
        a
        for a in (await client.get(API, headers=emp)).json()["data"]["areas"]
        if a["key"] == "queues"
    )
    assert area["value"] == [{"id": "q1"}] and area["canWrite"] is False


async def test_saves_send_a_webhook(client: AsyncClient, admin: dict, receiver: Receiver) -> None:  # noqa: F811
    h = admin["headers"]
    await client.post(
        "/api/v1/connect/webhooks",
        headers=h,
        json={"url": "https://crm.example/hook", "events": ["workspace.updated"]},
    )
    await client.put(f"{API}/agents", headers=h, json={"value": [{"id": "a1", "name": "Asha"}]})
    await dispatch()
    ev = receiver.events()[0]
    assert ev["type"] == "workspace.updated" and ev["data"]["key"] == "agents"
    assert ev["data"]["version"] == 1
