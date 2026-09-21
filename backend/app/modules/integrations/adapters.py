"""Slack + Teams channel adapters for the approval bridge.

Each adapter builds a platform-native interactive card and posts it. When the
channel is configured (webhook URL / bot token) the post is a real HTTP call;
otherwise the adapter returns a `simulated` result carrying the exact payload
that would have been sent, so the flow works end-to-end with zero external
setup. Delivery failures never raise into the business flow — they are captured
in the returned result and surfaced on the approval's timeline.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import httpx
import structlog

from app.core.config import settings

if TYPE_CHECKING:
    from app.modules.integrations.models import ApprovalRequest, IntegrationConfig

log = structlog.get_logger(__name__)

_KIND_LABELS = {
    "overtime": "Overtime offer",
    "vto": "Voluntary time off",
    "reforecast_publish": "Publish intraday reforecast",
    "break_recovery": "Break recovery (recall)",
    "skill_rebalance": "Skill re-balance",
    "shift_change": "Shift change",
    "break_move": "Break move",
    "shift_swap": "Shift swap",
    "extra_shift": "Extra shift",
}


def kind_label(kind: str) -> str:
    return _KIND_LABELS.get(kind, kind.replace("_", " ").title())


@dataclass
class DispatchResult:
    channel: str
    ok: bool
    simulated: bool
    detail: str = ""
    # channel-native handle for later message updates (ts/channel, activity id…)
    ref: dict = field(default_factory=dict)
    # the exact payload posted (or that would be posted, when simulated)
    payload: dict = field(default_factory=dict)


def _web_link(approval_id: str) -> str:
    return f"{settings.APP_WEB_URL.rstrip('/')}/approvals?focus={approval_id}"


def _callback_url(platform: str) -> str:
    base = settings.APP_PUBLIC_URL.rstrip("/")
    return f"{base}{settings.API_V1_PREFIX}/integrations/{platform}/actions"


# --------------------------------------------------------------------------- #
# Slack
# --------------------------------------------------------------------------- #
def build_slack_blocks(approval: ApprovalRequest) -> dict:
    """A Slack Block Kit message with Approve / Reject buttons.

    The buttons target the app's interactivity Request URL (our
    `/integrations/slack/actions` endpoint); the value carries the approval id.
    """
    aid = str(approval.id)
    return {
        "text": f"Approval needed: {approval.title}",  # notification fallback
        "blocks": [
            {
                "type": "header",
                "text": {"type": "plain_text",
                         "text": f"🕑 {kind_label(approval.kind)} — approval needed"},
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"*{approval.title}*\n{approval.summary}"},
            },
            {
                "type": "context",
                "elements": [
                    {"type": "mrkdwn",
                     "text": f"Source: *{approval.source}* · Awaiting: *{approval.approver_role}*"}
                ],
            },
            {
                "type": "actions",
                "block_id": f"approval:{aid}",
                "elements": [
                    {
                        "type": "button", "style": "primary",
                        "text": {"type": "plain_text", "text": "Approve"},
                        "action_id": "approval_approve", "value": aid,
                    },
                    {
                        "type": "button", "style": "danger",
                        "text": {"type": "plain_text", "text": "Reject"},
                        "action_id": "approval_reject", "value": aid,
                    },
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "Open in FlowForce"},
                        "url": _web_link(aid), "action_id": "approval_open",
                    },
                ],
            },
        ],
    }


class SlackAdapter:
    def __init__(self, config: IntegrationConfig) -> None:
        self.config = config

    @property
    def live(self) -> bool:
        return bool(
            self.config.slack_enabled
            and (self.config.slack_webhook_url or self.config.slack_bot_token)
        )

    async def send(self, approval: ApprovalRequest) -> DispatchResult:
        payload = build_slack_blocks(approval)
        if not self.live:
            return DispatchResult("slack", ok=True, simulated=True,
                                  detail="Slack not configured — simulated", payload=payload)
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                if self.config.slack_bot_token:
                    body = {**payload, "channel": self.config.slack_channel or "#wfm-approvals"}
                    res = await client.post(
                        "https://slack.com/api/chat.postMessage",
                        json=body,
                        headers={"Authorization": f"Bearer {self.config.slack_bot_token}"},
                    )
                    data = res.json()
                    if not data.get("ok"):
                        return DispatchResult("slack", ok=False, simulated=False,
                                              detail=f"Slack API error: {data.get('error')}",
                                              payload=payload)
                    return DispatchResult(
                        "slack", ok=True, simulated=False, detail="posted",
                        ref={"channel": data.get("channel"), "ts": data.get("ts")},
                        payload=payload,
                    )
                res = await client.post(self.config.slack_webhook_url, json=payload)
                ok = res.status_code < 300
                return DispatchResult("slack", ok=ok, simulated=False,
                                      detail=f"webhook status {res.status_code}", payload=payload)
        except httpx.HTTPError as exc:  # network/DNS/timeout — never break the flow
            log.warning("slack_dispatch_failed", error=str(exc))
            return DispatchResult("slack", ok=False, simulated=False,
                                  detail=f"delivery error: {exc}", payload=payload)


# --------------------------------------------------------------------------- #
# Microsoft Teams
# --------------------------------------------------------------------------- #
def build_teams_card(approval: ApprovalRequest, security_token: str) -> dict:
    """An Adaptive Card (Actionable Message) with Action.Http approve/reject.

    Teams POSTs the button action to our callback URL with the shared
    `security_token` in the body so we can trust the caller.
    """
    aid = str(approval.id)
    callback = _callback_url("teams")

    def action(title: str, decision: str) -> dict:
        return {
            "type": "Action.Http", "method": "POST", "title": title,
            "url": callback,
            "body": json.dumps(
                {"approval_id": aid, "action": decision, "token": security_token}
            ),
            "headers": [{"name": "Content-Type", "value": "application/json"}],
        }

    return {
        "type": "message",
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard", "version": "1.4",
                    "body": [
                        {"type": "TextBlock", "size": "Medium", "weight": "Bolder",
                         "text": f"{kind_label(approval.kind)} — approval needed"},
                        {"type": "TextBlock", "text": approval.title,
                         "weight": "Bolder", "wrap": True},
                        {"type": "TextBlock", "text": approval.summary,
                         "wrap": True, "isSubtle": True},
                        {"type": "FactSet", "facts": [
                            {"title": "Source", "value": approval.source},
                            {"title": "Awaiting", "value": approval.approver_role},
                        ]},
                    ],
                    "actions": [
                        action("Approve", "approve"),
                        action("Reject", "reject"),
                        {"type": "Action.OpenUrl", "title": "Open in FlowForce",
                         "url": _web_link(aid)},
                    ],
                },
            }
        ],
    }


class TeamsAdapter:
    def __init__(self, config: IntegrationConfig) -> None:
        self.config = config

    @property
    def live(self) -> bool:
        return bool(self.config.teams_enabled and self.config.teams_webhook_url)

    async def send(self, approval: ApprovalRequest) -> DispatchResult:
        payload = build_teams_card(approval, self.config.teams_security_token)
        if not self.live:
            return DispatchResult("teams", ok=True, simulated=True,
                                  detail="Teams not configured — simulated", payload=payload)
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                res = await client.post(self.config.teams_webhook_url, json=payload)
                ok = res.status_code < 300
                return DispatchResult("teams", ok=ok, simulated=False,
                                      detail=f"webhook status {res.status_code}", payload=payload)
        except httpx.HTTPError as exc:
            log.warning("teams_dispatch_failed", error=str(exc))
            return DispatchResult("teams", ok=False, simulated=False,
                                  detail=f"delivery error: {exc}", payload=payload)
