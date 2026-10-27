from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.connect.webhooks import EVENTS


class ApiKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    scopes: list[str] = Field(min_length=1)
    #: Leave empty for a key that doesn't expire.
    expires_in_days: int | None = Field(None, ge=1, le=3650)


class ApiKeyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    prefix: str
    scopes: list[str]
    created_by_email: str
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime | None
    revoked_at: datetime | None


class ApiKeyCreated(ApiKeyOut):
    #: The full key — shown only in this response.
    key: str


class ScopeOut(BaseModel):
    code: str
    description: str


def _check_url(v: str) -> str:
    v = v.strip()
    if not v.startswith(("https://", "http://")):
        raise ValueError("Webhook URL must start with https:// (or http:// for testing)")
    return v


def _check_events(v: list[str]) -> list[str]:
    unknown = [e for e in v if e != "*" and e not in EVENTS]
    if unknown:
        raise ValueError(f"Unknown event(s): {', '.join(unknown)} — use {', '.join(EVENTS)} or *")
    if not v:
        raise ValueError("Pick at least one event (or * for all)")
    return sorted(set(v))


class WebhookIn(BaseModel):
    url: str = Field(max_length=1024)
    description: str = Field("", max_length=255)
    events: list[str] = ["*"]
    active: bool = True

    _url = field_validator("url")(_check_url)
    _events = field_validator("events")(_check_events)


class WebhookPatch(BaseModel):
    url: str | None = Field(None, max_length=1024)
    description: str | None = Field(None, max_length=255)
    events: list[str] | None = None
    active: bool | None = None

    @field_validator("url")
    @classmethod
    def _u(cls, v: str | None) -> str | None:
        return None if v is None else _check_url(v)

    @field_validator("events")
    @classmethod
    def _e(cls, v: list[str] | None) -> list[str] | None:
        return None if v is None else _check_events(v)


class WebhookOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    url: str
    description: str
    events: list[str]
    active: bool
    secret: str
    created_by_email: str
    created_at: datetime
    last_success_at: datetime | None
    last_failure_at: datetime | None
    consecutive_failures: int


class DeliveryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    subscription_id: uuid.UUID
    event_id: str
    event_type: str
    status: str
    attempts: int
    next_attempt_at: datetime
    last_attempt_at: datetime | None
    response_status: int | None
    response_body: str
    error: str
    duration_ms: int | None
    created_at: datetime
    payload: dict


class EventTypeOut(BaseModel):
    type: str
    description: str


InboundKind = Literal[
    "leave", "absence", "loa", "off", "pto", "vto", "meeting", "training", "coaching", "other"
]


class InboundTimeOffIn(BaseModel):
    """Mark (or remove) leave, absence, a week off or another activity for one
    agent over a date range — e.g. pushed by a CRM / HR tool."""

    agent_key: str = Field(min_length=1, max_length=64)
    start_date: date
    end_date: date
    type: InboundKind
    #: "HH:MM" — leave both empty for the whole shift.
    start: str | None = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end: str | None = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$|^24:00$")
    note: str = Field("", max_length=255)
    #: Your record's id. Sending it again updates the same entry; with
    #: action "remove" it takes it back off.
    external_id: str | None = Field(
        None, min_length=1, max_length=48, pattern=r"^[A-Za-z0-9_.:-]+$"
    )
    action: Literal["mark", "remove"] = "mark"
    #: Replace meetings / other activities it overlaps (otherwise those days are skipped).
    replace: bool = True


class InboundSkipped(BaseModel):
    date: date
    reason: str


class InboundResultOut(BaseModel):
    applied: list[date]
    skipped: list[InboundSkipped]
