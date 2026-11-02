"""Scheduled report emails: To / CC, lists, timing, the dashboard and failures."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta

import httpx
import pytest
from httpx import AsyncClient

from app.core.config import settings
from app.modules.reporting import dashboard, mailer, scheduled
from app.modules.reporting.models import ReportRun
from tests.conftest import TestSession, login
from tests.test_dayplan import plan_json
from tests.test_publishing import save

API = "/api/v1/reports/scheduled"
BASE = {
    "name": "Ops daily",
    "frequency": "daily",
    "weekdays": [0, 1, 2, 3, 4],
    "send_time": "08:00",
    "timezone": "Asia/Kolkata",
    "to_recipients": ["boss@acme.dev"],
    "cc_recipients": ["team@acme.dev"],
}


class Inbox:
    def __init__(self, status: int = 200) -> None:
        self.status = status
        self.sent: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.sent.append(json.loads(request.content))
        return httpx.Response(self.status, json={"id": "x"})


@pytest.fixture
def inbox(monkeypatch: pytest.MonkeyPatch) -> Inbox:
    box = Inbox()
    monkeypatch.setattr(mailer, "_transport", httpx.MockTransport(box))
    monkeypatch.setattr(settings, "EMAIL_FROM", "reports@acme.dev")
    monkeypatch.setattr(settings, "RESEND_API_KEY", "key")
    return box


def test_periods() -> None:
    assert dashboard.period_for("daily", date(2026, 11, 10)) == (
        date(2026, 11, 9),
        date(2026, 11, 9),
    )
    assert dashboard.period_for("weekly", date(2026, 11, 10)) == (
        date(2026, 11, 3),
        date(2026, 11, 9),
    )
    assert dashboard.period_for("mtd", date(2026, 11, 10)) == (date(2026, 11, 1), date(2026, 11, 9))
    # On the 1st, month to date is the whole of last month.
    assert dashboard.period_for("mtd", date(2026, 11, 1)) == (date(2026, 10, 1), date(2026, 10, 31))


def test_next_run_uses_the_local_time_and_days() -> None:
    # Monday 2 Nov 2026, 08:00 in India is 02:30 UTC.
    now = datetime(2026, 11, 2, 1, 0, tzinfo=UTC)
    assert scheduled.next_run("08:00", [0], "Asia/Kolkata", now) == datetime(
        2026, 11, 2, 2, 30, tzinfo=UTC
    )
    later = datetime(2026, 11, 2, 2, 30, tzinfo=UTC)  # exactly due → the next one, not again
    assert scheduled.next_run("08:00", [0], "Asia/Kolkata", later) == datetime(
        2026, 11, 9, 2, 30, tzinfo=UTC
    )
    assert scheduled.next_run("08:00", [2, 4], "Asia/Kolkata", now) == datetime(
        2026, 11, 4, 2, 30, tzinfo=UTC
    )
    # Daylight saving: New York moves from UTC-4 to UTC-5 on 1 Nov 2026.
    before = datetime(2026, 10, 31, 20, 0, tzinfo=UTC)
    assert scheduled.next_run("09:00", [6], "America/New_York", before) == datetime(
        2026, 11, 1, 14, 0, tzinfo=UTC
    )


async def test_validation_and_permissions(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    for bad in (
        {"to_recipients": []},
        {"to_recipients": ["not-an-email"]},
        {"to_recipients": ["a@b.dev, c@d.dev"]},
        {"to_recipients": ["Name <a@b.dev>"]},
        {"cc_recipients": ["a@b.dev\nBcc: evil@x.dev"]},
        {"frequency": "hourly"},
        {"weekdays": [9]},
        {"weekdays": []},
        {"send_time": "25:00"},
        {"timezone": "Mars/Base"},
        {"to_recipients": ["list:00000000-0000-0000-0000-000000000001"]},
    ):
        r = await client.post(API, headers=h, json={**BASE, **bad})
        assert r.status_code == 422, (bad, r.text)
    assert (await client.get(API)).status_code == 401
    await client.post(
        "/api/v1/users",
        headers=h,
        json={"email": "emp@test.dev", "password": "Passw0rd!x", "role_names": ["Employee"]},
    )
    emp = await login(client, "emp@test.dev", "Passw0rd!x")
    assert (await client.get(API, headers=emp)).status_code == 403
    assert (await client.post(API, headers=emp, json=BASE)).status_code == 403
    assert (await client.get(f"{API}/preview", headers=emp)).status_code == 403


async def test_to_cc_and_lists_are_kept_apart(
    client: AsyncClient, admin: dict, inbox: Inbox
) -> None:
    h = admin["headers"]
    lst = (
        await client.post(
            f"{API}/lists",
            headers=h,
            json={"name": "Leaders", "emails": ["tl1@acme.dev", "BOSS@acme.dev", "tl2@acme.dev"]},
        )
    ).json()["data"]
    body = {
        **BASE,
        "to_recipients": ["boss@acme.dev", "x@acme.dev"],
        "cc_recipients": [f"list:{lst['id']}"],
    }
    sub = (await client.post(API, headers=h, json=body)).json()["data"]
    assert sub["next_run_at"].endswith("Z")  # a real moment, so browsers show local time
    run = (await client.post(f"{API}/{sub['id']}/send", headers=h)).json()["data"]
    assert run["status"] == "sent"
    mail = inbox.sent[0]
    assert mail["to"] == ["boss@acme.dev", "x@acme.dev"]
    assert mail["cc"] == ["tl1@acme.dev", "tl2@acme.dev"]  # someone in To isn't copied too
    assert mail["from"] == "reports@acme.dev" and mail["subject"].startswith("Ops daily · ")
    assert "<html" in mail["html"] and "Service level" in mail["text"]
    # A list in use can't be deleted out from under a schedule.
    assert (await client.delete(f"{API}/lists/{lst['id']}", headers=h)).status_code == 422
    await client.delete(f"{API}/{sub['id']}", headers=h)
    assert (await client.delete(f"{API}/lists/{lst['id']}", headers=h)).status_code == 200


async def test_failures_are_recorded_not_lost(
    client: AsyncClient, admin: dict, monkeypatch: pytest.MonkeyPatch, inbox: Inbox
) -> None:
    h = admin["headers"]
    sub = (await client.post(API, headers=h, json=BASE)).json()["data"]
    inbox.status = 500
    run = (await client.post(f"{API}/{sub['id']}/send", headers=h)).json()["data"]
    assert run["status"] == "failed" and "500" in run["error"]
    monkeypatch.setattr(settings, "RESEND_API_KEY", "")
    monkeypatch.setattr(settings, "SMTP_HOST", "")
    run = (await client.post(f"{API}/{sub['id']}/send", headers=h)).json()["data"]
    assert run["status"] == "failed" and "isn't set up" in run["error"]
    status = (await client.get(f"{API}/status", headers=h)).json()["data"]
    assert status == {"configured": False, "provider": "", "from": "reports@acme.dev"}
    runs = (await client.get(f"{API}/{sub['id']}/runs", headers=h)).json()["data"]
    assert [r["status"] for r in runs] == ["failed", "failed"]
    listed = (await client.get(API, headers=h)).json()["data"][0]
    assert listed["last_status"] == "failed"


async def test_scheduler_sends_once_when_due(
    client: AsyncClient, admin: dict, inbox: Inbox
) -> None:
    h = admin["headers"]
    sub = (await client.post(API, headers=h, json={**BASE, "weekdays": list(range(7))})).json()[
        "data"
    ]
    due = datetime.fromisoformat(sub["next_run_at"].replace("Z", "+00:00"))
    assert await scheduled.run_due(TestSession, due - timedelta(minutes=1)) == 0
    assert await scheduled.run_due(TestSession, due) == 1
    assert await scheduled.run_due(TestSession, due) == 0  # moved on: no double send
    assert len(inbox.sent) == 1
    # Paused schedules don't send.
    await client.put(
        f"{API}/{sub['id']}", headers=h, json={**BASE, "weekdays": list(range(7)), "active": False}
    )
    assert await scheduled.run_due(TestSession, due + timedelta(days=3)) == 0
    async with TestSession() as db:
        run = (await db.execute(ReportRun.__table__.select())).first()
    assert run.trigger == "schedule"


async def test_dashboard_counts_published_only_and_escapes(
    client: AsyncClient, admin: dict
) -> None:
    h = admin["headers"]
    day = (date.today() - timedelta(days=1)).isoformat()
    today = date.today().isoformat()
    await save(client, h, day, plan_json("a01"), plan_json("a02"))
    await client.post(
        "/api/v1/scheduling/day-plans/publish", headers=h, json={"start": day, "end": day}
    )
    await save(client, h, day, plan_json("a03"))  # a draft, added later
    await client.put(
        "/api/v1/scheduling/settings/agent_rules",
        headers=h,
        json={"value": {"a01": {"lob": "Sales"}, "a02": {"lob": "<b>Care</b>"}}},
    )
    r = await client.get(
        f"{API}/preview", headers=h, params={"frequency": "daily", "name": "<script>x</script>"}
    )
    assert r.status_code == 200, r.text
    html = r.json()["data"]["html"]
    assert "<script" not in html and "&lt;script&gt;" in html
    assert "<b>Care</b>" not in html and "&lt;b&gt;Care&lt;/b&gt;" in html
    assert "Agents scheduled" in html and ">2<" in html  # a03's draft isn't counted
    assert "a01" not in html and "Agent a01" not in html  # no named individuals
    assert "http://" not in html.replace("https://", "") and today
    # One LOB only.
    one = (await client.get(f"{API}/preview", headers=h, params={"lob": "Sales"})).json()["data"][
        "html"
    ]
    assert ">1<" in one and "Care" not in one
    assert (
        await client.get(f"{API}/preview", headers=h, params={"timezone": "Nope"})
    ).status_code == 422
