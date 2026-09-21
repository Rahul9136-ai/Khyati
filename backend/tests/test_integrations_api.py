"""Approval-bridge (Slack/Teams) integration tests.

Covers config round-trip with secret masking, raising an approval and its
dispatch/timeline, OM-gated decisions, auto-apply, the Slack HMAC verifier, and
the full inbound Slack callback recording a decision end to end.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from urllib.parse import quote_plus

from httpx import AsyncClient

from app.modules.integrations.security import verify_slack_signature
from tests.conftest import ADMIN_PASSWORD, TestSession, login


async def _create_user(org_id: str, email: str, role: str) -> None:
    from app.modules.identity.schemas import UserCreate
    from app.modules.identity.service import create_user

    async with TestSession() as db:
        await create_user(
            db,
            UserCreate(email=email, password=ADMIN_PASSWORD, full_name=email,
                       role_names=[role], organization_id=org_id),
            actor=None,
        )
        await db.commit()


async def test_config_roundtrip_masks_secrets(client: AsyncClient, admin: dict):
    h = admin["headers"]
    resp = await client.put("/api/v1/integrations/config", headers=h, json={
        "slack_enabled": True,
        "slack_webhook_url": "https://hooks.slack.com/services/T/B/secret",
        "slack_signing_secret": "shhh-signing",
        "slack_channel": "#wfm-approvals",
        "teams_enabled": True,
        "teams_security_token": "teams-token",
    })
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    # secret *values* are never echoed back — only boolean "set" flags
    blob = json.dumps(data)
    assert "shhh-signing" not in blob
    assert "hooks.slack.com" not in blob
    assert "teams-token" not in blob
    assert data["slack_webhook_set"] is True
    assert data["slack_signing_secret_set"] is True
    assert data["teams_security_token_set"] is True
    assert data["slack_channel"] == "#wfm-approvals"
    assert data["any_channel_live"] is True


async def test_create_dispatch_and_auto_apply(client: AsyncClient, admin: dict):
    h = admin["headers"]
    # enable both channels (simulated — no real creds) so dispatch records them
    await client.put("/api/v1/integrations/config", headers=h,
                     json={"slack_enabled": True, "teams_enabled": True})

    resp = await client.post("/api/v1/integrations/approvals", headers=h, json={
        "source": "intraday", "kind": "overtime",
        "title": "Offer 2h OT — volume over forecast",
        "summary": "SL at risk; propose 2h OT for 3 agents.",
        "payload": {"hours": 2, "agents": 3},
    })
    assert resp.status_code == 201, resp.text
    approval = resp.json()["data"]
    assert approval["status"] == "pending"
    # dispatched to both simulated channels + a created event on the timeline
    types = {e["type"] for e in approval["events"]}
    assert "created" in types and "dispatched" in types
    channels = {e["channel"] for e in approval["events"] if e["type"] == "dispatched"}
    assert {"slack", "teams"} <= channels

    aid = approval["id"]
    dec = await client.post(f"/api/v1/integrations/approvals/{aid}/decision", headers=h,
                            json={"approve": True, "note": "ok, protect SL"})
    assert dec.status_code == 200, dec.text
    decided = dec.json()["data"]
    assert decided["status"] == "applied"          # auto_apply default is on
    assert decided["decided_via"] == "in_app"
    assert decided["apply_result"]["applied"] == "overtime"


async def test_non_om_cannot_decide(client: AsyncClient, admin: dict):
    h = admin["headers"]
    org_id = admin["org_id"]
    # raise an approval as admin
    resp = await client.post("/api/v1/integrations/approvals", headers=h, json={
        "source": "scheduling", "kind": "shift_change", "title": "Move a break",
        "payload": {},
    })
    aid = resp.json()["data"]["id"]

    # an Employee holds neither request:approve_manager nor even request:read
    await _create_user(org_id, "emp@test.dev", "Employee")
    emp_h = await login(client, "emp@test.dev", ADMIN_PASSWORD)
    forbidden = await client.post(
        f"/api/v1/integrations/approvals/{aid}/decision", headers=emp_h,
        json={"approve": True},
    )
    assert forbidden.status_code == 403, forbidden.text


def test_slack_signature_verifier():
    secret = "8f742231b10e8888abcd99yyyzzz85a5"
    body = b"payload=%7B%22ok%22%3Atrue%7D"
    ts = str(int(time.time()))
    good = "v0=" + hmac.new(secret.encode(), b"v0:" + ts.encode() + b":" + body,
                            hashlib.sha256).hexdigest()
    assert verify_slack_signature(secret, ts, good, body) is True
    assert verify_slack_signature(secret, ts, "v0=deadbeef", body) is False
    assert verify_slack_signature(secret, "0", good, body) is False  # stale timestamp
    assert verify_slack_signature("", ts, good, body) is False       # unconfigured


async def test_inbound_slack_callback_records_decision(client: AsyncClient, admin: dict):
    h = admin["headers"]
    org_id = admin["org_id"]
    signing_secret = "test-signing-secret-value"
    await client.put("/api/v1/integrations/config", headers=h, json={
        "slack_enabled": True, "slack_signing_secret": signing_secret,
    })
    # the inbound callback records the decision on behalf of the org's OM
    await _create_user(org_id, "om@test.dev", "Operations Manager")

    resp = await client.post("/api/v1/integrations/approvals", headers=h, json={
        "source": "intraday", "kind": "vto", "title": "Offer VTO — volume light",
        "payload": {},
    })
    aid = resp.json()["data"]["id"]

    slack_payload = {"actions": [{"action_id": "approval_approve", "value": aid}],
                     "user": {"id": "U123"}}
    raw = f"payload={quote_plus(json.dumps(slack_payload))}".encode()
    ts = str(int(time.time()))
    sig = "v0=" + hmac.new(signing_secret.encode(), b"v0:" + ts.encode() + b":" + raw,
                           hashlib.sha256).hexdigest()

    cb = await client.post(
        "/api/v1/integrations/slack/actions", content=raw,
        headers={"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig,
                 "Content-Type": "application/x-www-form-urlencoded"},
    )
    assert cb.status_code == 200, cb.text
    assert "recorded" in cb.json()["text"].lower()

    # the approval is now approved/applied, decided via slack
    got = await client.get(f"/api/v1/integrations/approvals/{aid}", headers=h)
    detail = got.json()["data"]
    assert detail["status"] in ("approved", "applied")
    assert detail["decided_via"] == "slack"


async def test_inbound_slack_rejects_bad_signature(client: AsyncClient, admin: dict):
    h = admin["headers"]
    await client.put("/api/v1/integrations/config", headers=h,
                     json={"slack_enabled": True, "slack_signing_secret": "abc"})
    resp = await client.post("/api/v1/integrations/approvals", headers=h, json={
        "source": "intraday", "kind": "overtime", "title": "x", "payload": {}})
    aid = resp.json()["data"]["id"]
    bad = await client.post(
        "/api/v1/integrations/slack/actions",
        content=f"payload={quote_plus(json.dumps({'actions':[{'action_id':'approval_approve','value':aid}]}))}".encode(),
        headers={"X-Slack-Request-Timestamp": str(int(time.time())),
                 "X-Slack-Signature": "v0=wrong",
                 "Content-Type": "application/x-www-form-urlencoded"},
    )
    assert bad.status_code == 401


async def test_test_dispatch_endpoint(client: AsyncClient, admin: dict):
    h = admin["headers"]
    await client.put("/api/v1/integrations/config", headers=h,
                     json={"slack_enabled": True, "teams_enabled": True})
    resp = await client.post("/api/v1/integrations/config/test", headers=h)
    assert resp.status_code == 200, resp.text
    results = resp.json()["data"]["results"]
    channels = {r["channel"] for r in results}
    assert channels == {"slack", "teams"}
    assert all(r["simulated"] for r in results)  # no real creds ⇒ simulated
