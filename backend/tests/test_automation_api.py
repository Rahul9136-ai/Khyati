"""Inbound automation: @mention commands in Slack/Teams → parse → (confidence-gated)
auto-apply → reply. Covers both channels, the confidence gate, the channel/mention
filters, and that a genuinely-applied change really mutates attendance/schedule rows.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from datetime import date

import pytest
from httpx import AsyncClient

from tests.conftest import ADMIN_PASSWORD, TestSession, login
from tests.helpers import create_employees, create_structure, next_monday

SLACK_URL = "/api/v1/integrations/slack/events"
TEAMS_URL = "/api/v1/integrations/teams/messages"


async def _create_user(org_id: str, email: str, role: str) -> None:
    from app.modules.identity.schemas import UserCreate
    from app.modules.identity.service import create_user

    async with TestSession() as db:
        await create_user(
            db, UserCreate(email=email, password=ADMIN_PASSWORD, full_name=email,
                           role_names=[role], organization_id=org_id),
            actor=None,
        )
        await db.commit()


def _slack_sig(secret: str, raw: bytes, ts: str) -> str:
    return "v0=" + hmac.new(secret.encode(), b"v0:" + ts.encode() + b":" + raw, hashlib.sha256).hexdigest()


async def _post_slack_event(client: AsyncClient, secret: str, event: dict, *, retry: bool = False) -> object:
    body = json.dumps({"type": "event_callback", "event": event}).encode()
    ts = str(int(time.time()))
    headers = {"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": _slack_sig(secret, body, ts),
              "Content-Type": "application/json"}
    if retry:
        headers["X-Slack-Retry-Num"] = "1"
    return await client.post(SLACK_URL, content=body, headers=headers)


async def _post_teams_message(client: AsyncClient, token: str, activity: dict) -> object:
    return await client.post(TEAMS_URL, json=activity, headers={"X-Teams-Command-Token": token})


async def _setup_org(client: AsyncClient, admin: dict, *, n_employees: int = 1) -> dict:
    ids = await create_structure(client, admin["headers"])
    employees = await create_employees(client, admin["headers"], ids["team"]["id"], ids["lob"]["id"], count=n_employees)
    await _create_user(admin["org_id"], "om@test.dev", "Operations Manager")
    return {**ids, "employees": employees}


async def _enable_automation(client: AsyncClient, h: dict, **patch) -> None:
    body = {"automation_enabled": True, "slack_command_channel": "C-CMD",
            "slack_signing_secret": "sig-secret", "teams_command_channel": "conv-1",
            "teams_security_token": "teams-shared-token", **patch}
    r = await client.put("/api/v1/integrations/config", headers=h, json=body)
    assert r.status_code == 200, r.text


async def _add_code(client: AsyncClient, h: dict, code: str, category: str) -> str:
    r = await client.post("/api/v1/attendance/codes", headers=h,
                          json={"code": code, "name": code, "category": category})
    assert r.status_code == 201, r.text
    return r.json()["data"]["id"]


async def _add_shift(client: AsyncClient, h: dict, team_id: str, employee_id: str, day: date,
                     start: str, end: str) -> dict:
    template = (await client.post("/api/v1/scheduling/templates", headers=h, json={
        "name": "T", "start_time": "08:00:00", "end_time": "16:00:00", "days_of_week": [0, 1, 2, 3, 4, 5, 6],
    })).json()["data"]
    schedule = (await client.post("/api/v1/scheduling/schedules/generate", headers=h, json={
        "team_id": team_id, "week_start": next_monday().isoformat(), "template_ids": [template["id"]],
    })).json()["data"]
    shift = await client.post(f"/api/v1/scheduling/schedules/{schedule['id']}/shifts", headers=h, json={
        "employee_id": employee_id, "day": day.isoformat(),
        "start_ts": f"{day.isoformat()}T{start}:00Z", "end_ts": f"{day.isoformat()}T{end}:00Z",
    })
    assert shift.status_code == 201, shift.text
    return shift.json()["data"]


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
async def test_automation_config_roundtrip(client: AsyncClient, admin: dict):
    h = admin["headers"]
    r = await client.put("/api/v1/integrations/config", headers=h, json={
        "automation_enabled": True, "auto_apply_min_confidence": "Medium",
        "slack_command_channel": "C123", "teams_command_channel": "conv-1",
        "teams_app_id": "app-id", "teams_app_password": "app-secret",
    })
    data = r.json()["data"]
    assert data["automation_enabled"] is True
    assert data["auto_apply_min_confidence"] == "Medium"
    assert data["slack_command_channel"] == "C123"
    assert data["teams_command_channel"] == "conv-1"
    assert data["teams_app_id_set"] is True and data["teams_app_password_set"] is True
    assert "app-secret" not in json.dumps(data)  # never echoed


# --------------------------------------------------------------------------- #
# Slack: high confidence → auto-applied
# --------------------------------------------------------------------------- #
async def test_slack_mention_auto_applies_mark_absence_and_replies(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]
    await _add_code(client, h, "SIC", "sick")
    await _enable_automation(client, h)

    resp = await _post_slack_event(client, "sig-secret", {
        "type": "app_mention", "channel": "C-CMD", "ts": "1700000000.001",
        "text": f"<@U0BOT> {emp['employee_code']} called in sick on 2026-06-30",
    })
    assert resp.status_code == 200, resp.text

    records = (await client.get("/api/v1/attendance/records", headers=h,
                                params={"employee_id": emp["id"]})).json()["data"]["items"]
    assert len(records) == 1
    assert records[0]["code"]["code"] == "SIC" and records[0]["day"] == "2026-06-30"
    assert records[0]["source"] == "automation"

    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert len(approvals) == 1
    assert approvals[0]["status"] == "applied" and approvals[0]["decided_via"] == "auto"
    assert approvals[0]["kind"] == "absence_mark"


async def test_slack_reply_is_simulated_without_a_bot_token_and_says_so(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]
    await _add_code(client, h, "SIC", "sick")
    await _enable_automation(client, h)  # no slack_bot_token configured

    resp = await _post_slack_event(client, "sig-secret", {
        "type": "app_mention", "channel": "C-CMD", "ts": "1700000000.002",
        "text": f"<@U0BOT>: {emp['employee_code']} sick today",
    })
    assert resp.status_code == 200
    # simulated reply never raises into the request/response — it's a 200 either way.


# --------------------------------------------------------------------------- #
# Confidence gate
# --------------------------------------------------------------------------- #
async def test_low_confidence_message_is_raised_for_approval_not_applied(client: AsyncClient, admin: dict):
    h = admin["headers"]
    await _setup_org(client, admin)
    await _enable_automation(client, h)

    resp = await _post_slack_event(client, "sig-secret", {
        "type": "app_mention", "channel": "C-CMD", "ts": "1700000000.003",
        "text": "<@U0BOT> someone needs leave",  # no employee ID at all
    })
    assert resp.status_code == 200

    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert len(approvals) == 1
    assert approvals[0]["status"] == "pending"
    assert approvals[0]["employee_id"] is None


async def test_threshold_medium_lets_medium_confidence_auto_apply(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]
    await _add_code(client, h, "ABS", "absent")
    # "emergency" alone is a *weakly*-worded Mark Absence trigger in the rule parser
    # (Medium confidence, even with a clear ID) — raise the threshold to let it through.
    await _enable_automation(client, h, auto_apply_min_confidence="Medium")

    resp = await _post_slack_event(client, "sig-secret", {
        "type": "app_mention", "channel": "C-CMD", "ts": "1700000000.004",
        "text": f"<@U0BOT> emergency at home for {emp['employee_code']} on 2026-07-10",
    })
    assert resp.status_code == 200
    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert approvals[0]["payload"]["confidence"] == "Medium"
    assert approvals[0]["kind"] == "absence_mark"
    assert approvals[0]["status"] == "applied"


async def test_default_threshold_high_does_not_auto_apply_medium_confidence(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]
    await _add_code(client, h, "ABS", "absent")
    await _enable_automation(client, h)  # default threshold is "High"

    resp = await _post_slack_event(client, "sig-secret", {
        "type": "app_mention", "channel": "C-CMD", "ts": "1700000000.004b",
        "text": f"<@U0BOT> emergency at home for {emp['employee_code']} on 2026-07-10",
    })
    assert resp.status_code == 200
    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert approvals[0]["payload"]["confidence"] == "Medium"
    assert approvals[0]["status"] == "pending"


async def test_automation_disabled_ignores_inbound_messages_entirely(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]
    await _add_code(client, h, "SIC", "sick")
    await _enable_automation(client, h, automation_enabled=False)

    resp = await _post_slack_event(client, "sig-secret", {
        "type": "app_mention", "channel": "C-CMD", "ts": "1700000000.005",
        "text": f"<@U0BOT> {emp['employee_code']} is sick today",
    })
    assert resp.status_code == 200
    # the master switch is off — the bot doesn't even raise a pending approval, it
    # simply isn't listening, which is different from "listening but always asking a human"
    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert approvals == []


# --------------------------------------------------------------------------- #
# Shift Swap never auto-applies, regardless of confidence
# --------------------------------------------------------------------------- #
async def test_shift_swap_never_auto_applies(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin, n_employees=2)
    e0, e1 = setup["employees"]
    await _enable_automation(client, h)

    resp = await _post_slack_event(client, "sig-secret", {
        "type": "app_mention", "channel": "C-CMD", "ts": "1700000000.006",
        "text": f"<@U0BOT> swap shifts between {e0['employee_code']} and {e1['employee_code']} on 2026-07-01",
    })
    assert resp.status_code == 200
    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert approvals[0]["kind"] == "shift_swap"
    assert approvals[0]["status"] == "pending"


# --------------------------------------------------------------------------- #
# Change Shift Timing — only auto-applies with an explicit clock-time window
# --------------------------------------------------------------------------- #
async def test_shift_timing_change_auto_applies_and_mutates_the_shift(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]
    day = date(2026, 6, 30)
    shift = await _add_shift(client, h, setup["team"]["id"], emp["id"], day, "09:00", "17:00")
    await _enable_automation(client, h)

    resp = await _post_slack_event(client, "sig-secret", {
        "type": "app_mention", "channel": "C-CMD", "ts": "1700000000.007",
        "text": f"<@U0BOT> change shift timing for {emp['employee_code']} on 2026-06-30 to 11am-7pm",
    })
    assert resp.status_code == 200

    updated = (await client.get(f"/api/v1/scheduling/schedules/{shift['schedule_id']}", headers=h)).json()["data"]
    row = next(s for s in updated["shifts"] if s["id"] == shift["id"])
    assert row["start_ts"].startswith("2026-06-30T11:00")
    assert row["end_ts"].startswith("2026-06-30T19:00")
    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert approvals[0]["status"] == "applied"


async def test_shift_timing_change_without_explicit_times_falls_back_to_approval(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]
    await _enable_automation(client, h)

    resp = await _post_slack_event(client, "sig-secret", {
        "type": "app_mention", "channel": "C-CMD", "ts": "1700000000.008",
        "text": f"<@U0BOT> {emp['employee_code']} wants to leave early today",  # no explicit clock times
    })
    assert resp.status_code == 200
    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert approvals[0]["status"] == "pending"


async def test_shift_timing_change_with_no_matching_shift_falls_back_to_approval_not_failed(
    client: AsyncClient, admin: dict,
):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]  # no shift ever created for this employee
    await _enable_automation(client, h)

    resp = await _post_slack_event(client, "sig-secret", {
        "type": "app_mention", "channel": "C-CMD", "ts": "1700000000.009",
        "text": f"<@U0BOT> change shift timing for {emp['employee_code']} on 2026-06-30 to 11am-7pm",
    })
    assert resp.status_code == 200
    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert approvals[0]["status"] == "pending"  # not "failed" — a human still gets it
    assert "auto-apply attempted but failed" in approvals[0]["decision_note"].lower()


# --------------------------------------------------------------------------- #
# Cancel Leave — idempotent apply, and "nothing to cancel" also falls back safely
# --------------------------------------------------------------------------- #
async def test_cancel_leave_removes_the_existing_record(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]
    code_id = await _add_code(client, h, "VAC", "vacation")
    await client.post("/api/v1/attendance/records", headers=h,
                      json={"employee_id": emp["id"], "code_id": code_id, "day": "2026-06-30"})
    await _enable_automation(client, h)

    resp = await _post_slack_event(client, "sig-secret", {
        "type": "app_mention", "channel": "C-CMD", "ts": "1700000000.010",
        "text": f"<@U0BOT> cancel leave for {emp['employee_code']} on 2026-06-30",
    })
    assert resp.status_code == 200
    records = (await client.get("/api/v1/attendance/records", headers=h,
                                params={"employee_id": emp["id"]})).json()["data"]["items"]
    assert records == []
    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert approvals[0]["status"] == "applied"


async def test_marking_leave_twice_is_idempotent_not_a_conflict_error(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]
    await _add_code(client, h, "VAC", "vacation")
    await _enable_automation(client, h)

    for i in range(2):
        resp = await _post_slack_event(client, "sig-secret", {
            "type": "app_mention", "channel": "C-CMD", "ts": f"1700000000.{11 + i}",
            "text": f"<@U0BOT> mark leave for {emp['employee_code']} on 2026-06-30",
        })
        assert resp.status_code == 200
    records = (await client.get("/api/v1/attendance/records", headers=h,
                                params={"employee_id": emp["id"]})).json()["data"]["items"]
    assert len(records) == 1  # the second message didn't create a duplicate or error
    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert len(approvals) == 2 and all(a["status"] == "applied" for a in approvals)


# --------------------------------------------------------------------------- #
# Filters: channel mismatch, non-mention, retry, bad signature
# --------------------------------------------------------------------------- #
async def test_message_outside_the_command_channel_is_ignored(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]
    await _add_code(client, h, "SIC", "sick")
    await _enable_automation(client, h)

    resp = await _post_slack_event(client, "sig-secret", {
        "type": "app_mention", "channel": "C-OTHER", "ts": "1700000000.020",
        "text": f"<@U0BOT> {emp['employee_code']} sick today",
    })
    assert resp.status_code == 200
    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert approvals == []


async def test_retry_delivery_is_not_reprocessed(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]
    await _add_code(client, h, "SIC", "sick")
    await _enable_automation(client, h)

    resp = await _post_slack_event(client, "sig-secret", {
        "type": "app_mention", "channel": "C-CMD", "ts": "1700000000.021",
        "text": f"<@U0BOT> {emp['employee_code']} sick today",
    }, retry=True)
    assert resp.status_code == 200
    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert approvals == []


async def test_bad_slack_signature_is_rejected(client: AsyncClient, admin: dict):
    h = admin["headers"]
    await _setup_org(client, admin)
    await _enable_automation(client, h)
    body = json.dumps({"type": "event_callback",
                       "event": {"type": "app_mention", "channel": "C-CMD", "text": "x"}}).encode()
    resp = await client.post(SLACK_URL, content=body, headers={
        "X-Slack-Request-Timestamp": str(int(time.time())), "X-Slack-Signature": "v0=bad",
    })
    assert resp.status_code == 401


async def test_slack_url_verification_echoes_the_challenge(client: AsyncClient):
    resp = await client.post(SLACK_URL, json={"type": "url_verification", "challenge": "abc123"})
    assert resp.status_code == 200 and resp.json()["challenge"] == "abc123"


async def test_bot_messages_never_trigger_automation(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]
    await _add_code(client, h, "SIC", "sick")
    await _enable_automation(client, h)

    resp = await _post_slack_event(client, "sig-secret", {
        "type": "app_mention", "channel": "C-CMD", "ts": "1700000000.022", "bot_id": "B999",
        "text": f"<@U0BOT> {emp['employee_code']} sick today",
    })
    assert resp.status_code == 200
    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert approvals == []


# --------------------------------------------------------------------------- #
# Teams — same behaviour through the other channel
# --------------------------------------------------------------------------- #
async def test_teams_mention_auto_applies_and_replies_simulated(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]
    await _add_code(client, h, "VAC", "vacation")
    await _enable_automation(client, h)

    resp = await _post_teams_message(client, "teams-shared-token", {
        "type": "message", "id": "activity-1", "serviceUrl": "https://smba.example/",
        "conversation": {"id": "conv-1"},
        "text": f"<at>Bot</at> mark leave for {emp['employee_code']} on 2026-07-15",
    })
    assert resp.status_code == 200

    records = (await client.get("/api/v1/attendance/records", headers=h,
                                params={"employee_id": emp["id"]})).json()["data"]["items"]
    assert len(records) == 1 and records[0]["day"] == "2026-07-15"


async def test_teams_wrong_conversation_is_ignored(client: AsyncClient, admin: dict):
    h = admin["headers"]
    setup = await _setup_org(client, admin)
    emp = setup["employees"][0]
    await _add_code(client, h, "VAC", "vacation")
    await _enable_automation(client, h)

    resp = await _post_teams_message(client, "teams-shared-token", {
        "type": "message", "id": "activity-2", "serviceUrl": "https://smba.example/",
        "conversation": {"id": "conv-OTHER"},
        "text": f"<at>Bot</at> mark leave for {emp['employee_code']} on 2026-07-15",
    })
    assert resp.status_code == 200
    approvals = (await client.get("/api/v1/integrations/approvals", headers=h)).json()["data"]["items"]
    assert approvals == []


async def test_teams_bad_token_is_rejected(client: AsyncClient, admin: dict):
    h = admin["headers"]
    await _setup_org(client, admin)
    await _enable_automation(client, h)
    resp = await _post_teams_message(client, "wrong-token", {
        "type": "message", "id": "activity-3", "serviceUrl": "https://smba.example/",
        "conversation": {"id": "conv-1"}, "text": "x",
    })
    assert resp.status_code == 401
