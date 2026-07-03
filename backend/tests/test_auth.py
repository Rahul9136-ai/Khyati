"""Auth + RBAC integration tests."""
from __future__ import annotations

from httpx import AsyncClient

from tests.conftest import ADMIN_EMAIL, login


async def test_login_and_me(client: AsyncClient, admin: dict) -> None:
    resp = await client.get("/api/v1/auth/me", headers=admin["headers"])
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert body["email"] == ADMIN_EMAIL
    assert body["is_superuser"] is True


async def test_wrong_password_rejected(client: AsyncClient, admin: dict) -> None:
    resp = await client.post(
        "/api/v1/auth/login", json={"email": ADMIN_EMAIL, "password": "nope-nope-1"}
    )
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "authentication_error"


async def test_refresh_rotation_is_one_time_use(client: AsyncClient, admin: dict) -> None:
    first = await client.post(
        "/api/v1/auth/refresh", json={"refresh_token": admin["refresh_token"]}
    )
    assert first.status_code == 200
    # replaying the same refresh token must fail (rotated)
    replay = await client.post(
        "/api/v1/auth/refresh", json={"refresh_token": admin["refresh_token"]}
    )
    assert replay.status_code == 401


async def test_rbac_denies_out_of_scope_action(client: AsyncClient, admin: dict) -> None:
    # create a low-privilege Employee-role user via admin
    resp = await client.post(
        "/api/v1/users",
        headers=admin["headers"],
        json={"email": "agent@test.dev", "password": "Agent@12345",
              "full_name": "Agent", "role_names": ["Employee"]},
    )
    assert resp.status_code == 201, resp.text
    agent_headers = await login(client, "agent@test.dev", "Agent@12345")

    denied = await client.post(
        "/api/v1/users",
        headers=agent_headers,
        json={"email": "x@test.dev", "password": "Xx@1234567", "role_names": []},
    )
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "permission_denied"

    # but the agent can read their own schedule list (schedule:read granted)
    ok = await client.get("/api/v1/scheduling/schedules", headers=agent_headers)
    assert ok.status_code == 200


async def test_unauthenticated_request_rejected(client: AsyncClient, admin: dict) -> None:
    resp = await client.get("/api/v1/employees")
    assert resp.status_code == 401
