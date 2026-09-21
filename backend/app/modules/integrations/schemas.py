"""DTOs for the integrations / approval-bridge API."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Source = Literal["intraday", "scheduling"]
Channel = Literal["slack", "teams", "in_app"]


# --------------------------------------------------------------------------- #
# Integration config
# --------------------------------------------------------------------------- #
class IntegrationConfigIn(BaseModel):
    slack_enabled: bool | None = None
    slack_webhook_url: str | None = None
    slack_bot_token: str | None = None
    slack_signing_secret: str | None = None
    slack_channel: str | None = None
    teams_enabled: bool | None = None
    teams_webhook_url: str | None = None
    teams_security_token: str | None = None
    default_approver_id: uuid.UUID | None = None
    auto_apply_on_approve: bool | None = None


class IntegrationConfigOut(BaseModel):
    """Config with secrets masked — never echoes tokens back to the client."""

    slack_enabled: bool
    slack_configured: bool
    slack_channel: str
    slack_webhook_set: bool
    slack_bot_token_set: bool
    slack_signing_secret_set: bool
    teams_enabled: bool
    teams_configured: bool
    teams_webhook_set: bool
    teams_security_token_set: bool
    default_approver_id: uuid.UUID | None
    auto_apply_on_approve: bool
    any_channel_live: bool


# --------------------------------------------------------------------------- #
# Approvals
# --------------------------------------------------------------------------- #
class ApprovalCreate(BaseModel):
    source: Source
    kind: str
    title: str = Field(min_length=1, max_length=200)
    summary: str = ""
    payload: dict = Field(default_factory=dict)
    employee_id: uuid.UUID | None = None
    queue_id: uuid.UUID | None = None
    assigned_om_id: uuid.UUID | None = None
    # channels to dispatch on; empty ⇒ use whatever is configured (falls back to in_app)
    channels: list[Channel] = Field(default_factory=list)


class ApprovalDecision(BaseModel):
    approve: bool
    note: str | None = None


class ApprovalEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    at: datetime
    type: str
    channel: str | None
    actor_email: str
    detail: str


class ApprovalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    source: str
    kind: str
    title: str
    summary: str
    payload: dict
    status: str
    channel: str
    approver_role: str
    assigned_om_id: uuid.UUID | None
    employee_id: uuid.UUID | None
    queue_id: uuid.UUID | None
    requested_by: uuid.UUID | None
    external_refs: dict
    decided_by: uuid.UUID | None
    decided_via: str | None
    decided_at: datetime | None
    decision_note: str | None
    applied_at: datetime | None
    apply_result: dict | None
    created_at: datetime


class ApprovalDetailOut(ApprovalOut):
    events: list[ApprovalEventOut] = Field(default_factory=list)


class DispatchOut(BaseModel):
    channel: str
    ok: bool
    simulated: bool
    detail: str


class TestDispatchOut(BaseModel):
    results: list[DispatchOut]
