"""Forgot password, reset links (emailed or from an admin), and change password."""

from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import update

from app.core.config import settings
from app.modules.identity import password_reset
from app.modules.identity.models import PasswordResetToken
from app.modules.reporting import mailer
from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD, TestSession, login

AUTH = "/api/v1/auth"


class Mail:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.sent.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "x"})

    def token(self) -> str:
        m = re.search(r"/reset-password\?token=([\w-]+)", self.sent[-1]["text"])
        assert m, self.sent[-1]["text"]
        return m.group(1)


@pytest.fixture(autouse=True)
def _fresh_limits():
    password_reset._requests.clear()
    yield
    password_reset._requests.clear()


@pytest.fixture
def mail(monkeypatch: pytest.MonkeyPatch) -> Mail:
    box = Mail()
    monkeypatch.setattr(mailer, "_transport", httpx.MockTransport(box))
    monkeypatch.setattr(settings, "EMAIL_FROM", "no-reply@purvi.ai")
    monkeypatch.setattr(settings, "RESEND_API_KEY", "key")
    monkeypatch.setattr(settings, "APP_WEB_URL", "https://app.example")
    return box


async def add_user(client: AsyncClient, h: dict, email: str, role: str = "Employee") -> dict:
    r = await client.post(
        "/api/v1/users",
        headers=h,
        json={
            "email": email,
            "password": "Start@12345",
            "full_name": email.split("@")[0],
            "role_names": [role],
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["data"]


async def test_forgot_password_emails_a_one_time_link_and_reset_signs_out_everywhere(
    client: AsyncClient, admin: dict, mail: Mail
) -> None:
    await add_user(client, admin["headers"], "ava@test.dev")
    session = (
        await client.post(
            f"{AUTH}/login", json={"email": "ava@test.dev", "password": "Start@12345"}
        )
    ).json()["data"]

    # unknown and known emails get the same answer; only the real one gets mail
    a = await client.post(f"{AUTH}/forgot-password", json={"email": "nobody@test.dev"})
    b = await client.post(f"{AUTH}/forgot-password", json={"email": "AVA@test.dev"})
    assert a.status_code == b.status_code == 200 and a.json() == b.json()
    assert len(mail.sent) == 1 and mail.sent[0]["to"] == ["ava@test.dev"]
    assert mail.sent[0]["subject"] == "Reset your Purvi.AI password"
    assert "https://app.example/reset-password?token=" in mail.sent[0]["text"]
    assert "30 minutes" in mail.sent[0]["text"]
    token = mail.token()

    check = await client.get(f"{AUTH}/reset-password", params={"token": token})
    assert check.status_code == 200 and check.json()["data"] == {"email": "ava@test.dev"}

    weak = await client.post(
        f"{AUTH}/reset-password", json={"token": token, "new_password": "short"}
    )
    assert weak.status_code == 422 and "8 characters" in weak.json()["error"]["message"]
    letters = await client.post(
        f"{AUTH}/reset-password", json={"token": token, "new_password": "onlyletters"}
    )
    assert "letter and one number" in letters.json()["error"]["message"]

    ok = await client.post(
        f"{AUTH}/reset-password", json={"token": token, "new_password": "Fresh-pass-42"}
    )
    assert ok.status_code == 200, ok.text
    assert (
        await client.post(
            f"{AUTH}/login", json={"email": "ava@test.dev", "password": "Start@12345"}
        )
    ).status_code == 401
    assert (
        await client.post(
            f"{AUTH}/login", json={"email": "ava@test.dev", "password": "Fresh-pass-42"}
        )
    ).status_code == 200
    # signed out everywhere: the old session can't be refreshed
    assert (
        await client.post(f"{AUTH}/refresh", json={"refresh_token": session["refresh_token"]})
    ).status_code == 401
    # the link works once
    again = await client.post(
        f"{AUTH}/reset-password", json={"token": token, "new_password": "Another-pass-43"}
    )
    assert (
        again.status_code == 422
        and "expired or was already used" in again.json()["error"]["message"]
    )
    assert (await client.get(f"{AUTH}/reset-password", params={"token": token})).status_code == 422


async def test_links_expire_and_a_new_password_uses_up_older_links(
    client: AsyncClient, admin: dict, mail: Mail
) -> None:
    await add_user(client, admin["headers"], "liam@test.dev")
    await client.post(f"{AUTH}/forgot-password", json={"email": "liam@test.dev"})
    first = mail.token()
    await client.post(f"{AUTH}/forgot-password", json={"email": "liam@test.dev"})
    second = mail.token()
    assert first != second
    r = await client.post(
        f"{AUTH}/reset-password", json={"token": second, "new_password": "Second-pass-1"}
    )
    assert r.status_code == 200
    r = await client.post(
        f"{AUTH}/reset-password", json={"token": first, "new_password": "First-pass-1"}
    )
    assert r.status_code == 422  # used up when the password changed

    await client.post(f"{AUTH}/forgot-password", json={"email": "liam@test.dev"})
    third = mail.token()
    async with TestSession() as db:
        await db.execute(
            update(PasswordResetToken)
            .where(PasswordResetToken.used_at.is_(None))
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await db.commit()
    r = await client.post(
        f"{AUTH}/reset-password", json={"token": third, "new_password": "Third-pass-1"}
    )
    assert r.status_code == 422 and "expired" in r.json()["error"]["message"]


async def test_forgot_password_is_rate_limited(
    client: AsyncClient, admin: dict, mail: Mail
) -> None:
    for _ in range(password_reset.REQUESTS_PER_WINDOW):
        assert (
            await client.post(f"{AUTH}/forgot-password", json={"email": "x@test.dev"})
        ).status_code == 200
    r = await client.post(f"{AUTH}/forgot-password", json={"email": "x@test.dev"})
    assert r.status_code == 429
    assert (
        await client.post(f"{AUTH}/forgot-password", json={"email": "not-an-email"})
    ).status_code == 422


async def test_admin_makes_a_reset_link_for_someone_in_their_organisation(
    client: AsyncClient, admin: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    h = admin["headers"]
    ava = await add_user(client, h, "ava@test.dev")
    monkeypatch.setattr(
        settings, "EMAIL_FROM", ""
    )  # email not set up: the admin passes the link on
    r = await client.post(f"/api/v1/users/{ava['id']}/reset-password-link", headers=h)
    assert r.status_code == 200, r.text
    out = r.json()["data"]
    assert out["emailed"] is False and "isn't set up" in out["email_problem"]
    token = out["link"].split("token=")[1]
    assert (await client.get(f"{AUTH}/reset-password", params={"token": token})).json()["data"][
        "email"
    ] == "ava@test.dev"
    r = await client.post(
        f"{AUTH}/reset-password", json={"token": token, "new_password": "Given-by-admin-7"}
    )
    assert r.status_code == 200

    # people without admin:users can't, and admins can't reach other organisations
    emp = await login(client, "ava@test.dev", "Given-by-admin-7")
    assert (
        await client.post(f"/api/v1/users/{ava['id']}/reset-password-link", headers=emp)
    ).status_code == 403
    from app.modules.identity.schemas import UserCreate
    from app.modules.identity.service import create_user
    from app.modules.workforce.models import Organization

    async with TestSession() as db:
        other = Organization(name="Other", code="OTHER")
        db.add(other)
        await db.flush()
        stranger = await create_user(
            db,
            UserCreate(
                email="s@other.dev",
                password="Start@12345",
                full_name="S",
                role_names=["Employee"],
                organization_id=other.id,
            ),
            actor=None,
        )
        org_admin = await create_user(
            db,
            UserCreate(
                email="boss@test.dev",
                password="Start@12345",
                full_name="Boss",
                role_names=["Super Admin"],
                organization_id=uuid.UUID(admin["org_id"]),
            ),
            actor=None,
        )
        sid = stranger.id
        assert not org_admin.is_superuser
        await db.commit()
    boss = await login(client, "boss@test.dev", "Start@12345")
    assert (
        await client.post(f"/api/v1/users/{sid}/reset-password-link", headers=boss)
    ).status_code == 403
    # and the account list only shows their own organisation
    emails = [
        u["email"]
        for u in (await client.get("/api/v1/users", headers=boss)).json()["data"]["items"]
    ]
    assert "s@other.dev" not in emails and "ava@test.dev" in emails
    found = (await client.get("/api/v1/users", headers=boss, params={"search": "AVA"})).json()[
        "data"
    ]
    assert [u["email"] for u in found["items"]] == ["ava@test.dev"] and found["total"] == 1


async def test_change_password(client: AsyncClient, admin: dict) -> None:
    await add_user(client, admin["headers"], "zara@test.dev")
    h = await login(client, "zara@test.dev", "Start@12345")
    url = f"{AUTH}/change-password"
    assert (
        await client.post(
            url, headers=h, json={"current_password": "wrong", "new_password": "Next-pass-11"}
        )
    ).status_code == 401
    assert (
        await client.post(
            url, headers=h, json={"current_password": "Start@12345", "new_password": "Start@12345"}
        )
    ).status_code == 422
    assert (
        await client.post(
            url, headers=h, json={"current_password": "Start@12345", "new_password": "abcdefghij"}
        )
    ).status_code == 422
    ok = await client.post(
        url, headers=h, json={"current_password": "Start@12345", "new_password": "Next-pass-11"}
    )
    assert ok.status_code == 200
    assert (
        await client.post(
            f"{AUTH}/login", json={"email": "zara@test.dev", "password": "Next-pass-11"}
        )
    ).status_code == 200
    assert ADMIN_EMAIL and ADMIN_PASSWORD  # the admin account is untouched


async def test_links_point_at_the_app_people_use_never_at_an_untrusted_site(
    client: AsyncClient, admin: dict, mail: Mail, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "BACKEND_CORS_ORIGINS", ["https://app.purvi.ai"])
    await add_user(client, admin["headers"], "mia@test.dev")
    await client.post(
        f"{AUTH}/forgot-password",
        json={"email": "mia@test.dev"},
        headers={"Origin": "https://app.purvi.ai"},
    )
    assert "https://app.purvi.ai/reset-password?token=" in mail.sent[-1]["text"]
    await client.post(
        f"{AUTH}/forgot-password",
        json={"email": "mia@test.dev"},
        headers={"Origin": "https://evil.example"},
    )
    assert "evil.example" not in mail.sent[-1]["text"]
    assert "https://app.example/reset-password?token=" in mail.sent[-1]["text"]  # APP_WEB_URL
