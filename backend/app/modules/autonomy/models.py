"""Autonomy models: agent decisions and the per-org governance policy."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.db.base import Base
from app.db.mixins import TenantMixin, TimestampMixin, UUIDMixin

# Action lifecycle -------------------------------------------------------------
# pending_review : awaiting a human decision (assisted mode, or low confidence)
# auto_applied   : executed automatically by the system (autonomous mode)
# applied        : executed after a human approved it
# rejected       : a human declined it
STATUS_PENDING = "pending_review"
STATUS_AUTO_APPLIED = "auto_applied"
STATUS_APPLIED = "applied"
STATUS_REJECTED = "rejected"
TERMINAL_STATUSES = {STATUS_AUTO_APPLIED, STATUS_APPLIED, STATUS_REJECTED}


class AgentAction(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """A single decision produced by an agent during an orchestrator run."""

    __tablename__ = "agent_actions"

    run_id: Mapped[uuid.UUID] = mapped_column(Uuid(), index=True)
    agent: Mapped[str] = mapped_column(String(32), index=True)
    action_type: Mapped[str] = mapped_column(String(48))
    title: Mapped[str] = mapped_column(String(200))
    rationale: Mapped[str] = mapped_column(String(1200))
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    severity: Mapped[str] = mapped_column(String(16), default="info")  # info|warning|critical
    status: Mapped[str] = mapped_column(String(24), default=STATUS_PENDING, index=True)

    target_type: Mapped[str | None] = mapped_column(String(24), nullable=True)
    target_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    target_label: Mapped[str | None] = mapped_column(String(160), nullable=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)

    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result_note: Mapped[str | None] = mapped_column(String(600), nullable=True)


class AutonomyPolicy(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """One governance policy per organization controlling the agent layer.

    autonomy_level:
      manual     — agents observe but never queue actions automatically
      assisted   — agents queue actions for human approval (default)
      autonomous — high-confidence actions are applied without a human
    """

    __tablename__ = "autonomy_policies"
    __table_args__ = (UniqueConstraint("organization_id"),)

    autonomy_level: Mapped[str] = mapped_column(String(16), default="assisted")
    auto_apply_threshold: Mapped[float] = mapped_column(Float, default=0.85)
    # {agent_key: {"enabled": bool, "auto_apply": bool}}
    agent_config: Mapped[dict] = mapped_column(JSON, default=dict)
