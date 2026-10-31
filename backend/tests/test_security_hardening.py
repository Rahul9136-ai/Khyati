"""Regressions from the QA pass: writes are saved before the response, sign-in
throttling, security headers, and webhooks can't reach internal addresses."""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from app.api.deps import DbSession
from app.core.config import settings
from app.modules.connect import webhooks
from app.modules.identity import service as identity
from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD

API = "/api/v1"


@pytest.fixture(autouse=True)
def _clean_throttle():
    identity._login_failures.clear()
    yield
    identity._login_failures.clear()


def test_session_commits_before_the_response() -> None:
    assert DbSession.__metadata__[0].scope == "function"


async def test_refresh_token_is_one_time_use(client: AsyncClient, admin: dict) -> None:
    old = admin["refresh_token"]
    body = {"refresh_token": old}
    assert (await client.post(f"{API}/auth/refresh", json=body)).status_code == 200
    assert (await client.post(f"{API}/auth/refresh", json=body)).status_code == 401


async def test_failed_sign_ins_lock_the_email(client: AsyncClient, admin: dict) -> None:
    good = {"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    bad = {"email": ADMIN_EMAIL, "password": "wrong"}
    # A success clears the count.
    for _ in range(identity.LOGIN_MAX_FAILURES - 1):
        assert (await client.post(f"{API}/auth/login", json=bad)).status_code == 401
    assert (await client.post(f"{API}/auth/login", json=good)).status_code == 200
    for _ in range(identity.LOGIN_MAX_FAILURES):
        assert (await client.post(f"{API}/auth/login", json=bad)).status_code == 401
    # Locked, even with the right password and different letter case.
    assert (await client.post(f"{API}/auth/login", json=good)).status_code == 429
    locked = {**good, "email": ADMIN_EMAIL.upper()}
    assert (await client.post(f"{API}/auth/login", json=locked)).status_code == 429
    # Other accounts aren't affected; unknown emails behave the same as real ones.
    other = {"email": "nobody@test.dev", "password": "wrong"}
    assert (await client.post(f"{API}/auth/login", json=other)).status_code == 401


async def test_security_headers(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    r = await client.get(f"{API}/health")
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert "Strict-Transport-Security" not in r.headers
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    r = await client.get(f"{API}/health")
    assert r.headers["Strict-Transport-Security"].startswith("max-age=")


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8000/x",
        "http://localhost/x",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/",
        "http://192.168.1.1/",
        "http://[::1]/",
        "http://0.0.0.0/",
    ],
)
async def test_internal_webhook_urls_blocked_in_production(
    client: AsyncClient, admin: dict, monkeypatch: pytest.MonkeyPatch, url: str
) -> None:
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    r = await client.post(f"{API}/connect/webhooks", headers=admin["headers"], json={"url": url})
    assert r.status_code == 422, r.text
    assert "internal address" in r.json()["error"]["message"]


async def test_public_name_resolving_inward_is_blocked(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")

    async def fake(self, host, port):  # noqa: ANN001
        addr = "10.1.2.3" if host == "sneaky.example" else "93.184.216.34"
        return [(2, 1, 6, "", (addr, 0))]

    monkeypatch.setattr("asyncio.base_events.BaseEventLoop.getaddrinfo", fake)
    assert "internal address" in (await webhooks.blocked_url_reason("https://sneaky.example/h"))
    assert await webhooks.blocked_url_reason("https://crm.example/h") is None


async def test_delivery_rechecks_the_address(
    client: AsyncClient, admin: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    h = admin["headers"]
    sub = (
        await client.post(f"{API}/connect/webhooks", headers=h, json={"url": "http://127.0.0.1:9/x"})
    ).json()["data"]  # allowed outside production…
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    r = await client.post(f"{API}/connect/webhooks/{sub['id']}/test", headers=h)
    d = r.json()["data"]  # …but never called once it is
    assert d["status"] == "retrying" and "internal address" in d["error"]
    assert d["response_status"] is None
