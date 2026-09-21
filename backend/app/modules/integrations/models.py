"""Integration + approval-bridge models.

The approval bridge lets the Real-Time (intraday) and Scheduling modules raise a
proposed change that must be signed off by the *respective Operations Manager*
before it is applied. The request is pushed to Slack and/or Microsoft Teams as
an interactive card; the OM approves/rejects there (or in-app), and on approval
the change is applied to the live plan.

`IntegrationConfig` holds the per-org channel wiring (webhook URLs, bot token,
signing secrets). Real HTTP is used when a channel is configured; otherwise the
adapters run in a simulated mode that records the exact payload that *would* be
sent, so the whole flow is exercisable with zero external setup.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.mixins import TenantMixin, TimestampMixin, UUIDMixin

# Where an approval originates and what kind of change it carries.
SOURCES = ("intraday", "scheduling")
KINDS = (
    # real-time / intraday
    "overtime", "vto", "reforecast_publish", "break_recovery", "skill_rebalance",
    # scheduling
    "shift_change", "break_move", "shift_swap", "extra_shift",
)

# Lifecycle: pending → approved/rejected; approved → applied (or failed).
STATUSES = ("pending", "approved", "rejected", "applied", "failed", "expired", "cancelled")

# Channels an approval can be dispatched on.
CHANNELS = ("slack", "teams", "in_app")


class IntegrationConfig(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """Per-org Slack/Teams wiring. One row per organization."""

    __tablename__ = "integration_configs"

    # --- Slack ---
    slack_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    slack_webhook_url: Mapped[str] = mapped_column(String(512), default="")
    slack_bot_token: Mapped[str] = mapped_column(String(512), default="")
    slack_signing_secret: Mapped[str] = mapped_column(String(512), default="")
    slack_channel: Mapped[str] = mapped_column(String(128), default="")

    # --- Microsoft Teams ---
    teams_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    teams_webhook_url: Mapped[str] = mapped_column(String(1024), default="")
    # shared secret Teams echoes back on Action.Http callbacks so we can trust them
    teams_security_token: Mapped[str] = mapped_column(String(512), default="")

    # --- routing / behaviour ---
    # fallback OM to route approvals to when none can be derived from the team/queue
    default_approver_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    # apply the change automatically the moment the OM approves
    auto_apply_on_approve: Mapped[bool] = mapped_column(Boolean, default=True)

    @property
    def any_channel_live(self) -> bool:
        return bool(
            (self.slack_enabled and (self.slack_webhook_url or self.slack_bot_token))
            or (self.teams_enabled and self.teams_webhook_url)
        )


class ApprovalRequest(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """A proposed real-time/scheduling change awaiting the respective OM's sign-off."""

    __tablename__ = "approval_requests"

    source: Mapped[str] = mapped_column(String(24), index=True)   # intraday | scheduling
    kind: Mapped[str] = mapped_column(String(32), index=True)
    title: Mapped[str] = mapped_column(String(200))
    summary: Mapped[str] = mapped_column(Text, default="")
    # the concrete change to apply, e.g. {"shift_id": "...", "new_end": "..."}
    payload: Mapped[dict] = mapped_column(JSON, default=dict)

    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    channel: Mapped[str] = mapped_column(String(16), default="in_app")

    # who must approve — a designation plus, where known, the specific OM user
    approver_role: Mapped[str] = mapped_column(String(48), default="Operations Manager")
    assigned_om_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True, index=True)

    # context for routing + display
    employee_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    queue_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    requested_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)

    # message handles for each channel we posted to, for later update/threading
    external_refs: Mapped[dict] = mapped_column(JSON, default=dict)

    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    decided_via: Mapped[str | None] = mapped_column(String(16), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    decision_note: Mapped[str | None] = mapped_column(String(512), nullable=True)

    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    apply_result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    events: Mapped[list[ApprovalEvent]] = relationship(
        back_populates="approval", cascade="all, delete-orphan",
        order_by="ApprovalEvent.at",
    )


class ApprovalEvent(UUIDMixin, Base):
    """Append-only timeline entry for an approval (dispatch, decision, apply)."""

    __tablename__ = "approval_events"

    approval_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("approval_requests.id", ondelete="CASCADE"), index=True
    )
    at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    # created | dispatched | approved | rejected | applied | failed | note | expired
    type: Mapped[str] = mapped_column(String(24))
    channel: Mapped[str | None] = mapped_column(String(16), nullable=True)
    actor_email: Mapped[str] = mapped_column(String(255), default="")
    detail: Mapped[str] = mapped_column(Text, default="")

    approval: Mapped[ApprovalRequest] = relationship(back_populates="events")
