"""Connect: API keys and outbound webhooks for CRMs and other tools.

* `ApiKey` — a named, scoped key a tool sends as `X-API-Key` (or
  `Authorization: Bearer wfm_…`) to call the REST API. It acts as the user
  who created it, limited to the key's scopes. Only a SHA-256 hash is stored;
  the key itself is shown once.
* `WebhookSubscription` — a URL that receives signed JSON events
  (schedule.updated, schedule.published, slot.claimed, …).
* `WebhookDelivery` — the outbox: one row per event per subscription,
  written in the same transaction as the change, then sent (and retried with
  backoff) by the dispatcher in `webhooks.py`.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import TenantMixin, TimestampMixin, UUIDMixin


class ApiKey(UUIDMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "api_keys"

    name: Mapped[str] = mapped_column(String(120))
    #: First characters of the key ("wfm_AbCd1234"), to recognise it in lists.
    prefix: Mapped[str] = mapped_column(String(16))
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    #: Permission codes the key may use (never more than its creator has).
    scopes: Mapped[list] = mapped_column(JSON, default=list)
    created_by: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    created_by_email: Mapped[str] = mapped_column(String(255), default="")
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WebhookSubscription(UUIDMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "webhook_subscriptions"

    url: Mapped[str] = mapped_column(String(1024))
    description: Mapped[str] = mapped_column(String(255), default="")
    #: Event types to send, or ["*"] for all.
    events: Mapped[list] = mapped_column(JSON, default=list)
    #: HMAC-SHA256 signing secret (shown to admins so the receiver can verify).
    secret: Mapped[str] = mapped_column(String(128))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by_email: Mapped[str] = mapped_column(String(255), default="")
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_failure_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0)


class WebhookDelivery(UUIDMixin, TenantMixin, Base):
    __tablename__ = "webhook_deliveries"

    subscription_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("webhook_subscriptions.id", ondelete="CASCADE"), index=True
    )
    event_id: Mapped[str] = mapped_column(String(64), index=True)
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    payload: Mapped[dict] = mapped_column(JSON)
    #: pending → delivered, or retrying → … → failed after the last attempt.
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    response_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    response_body: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[str] = mapped_column(String(500), default="")
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
