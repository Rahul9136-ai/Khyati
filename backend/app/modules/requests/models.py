"""Schedule change request models: two-stage (manager → WFM) approval workflow."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
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

CATEGORIES = (
    "schedule_flex", "attendance_coding", "shift_change", "leave", "meeting",
    "training", "overtime", "vto", "wfh", "wfo", "holiday_swap",
)

# categories that skip manager approval and go straight to WFM
WFM_ONLY_CATEGORIES = {"attendance_coding"}


class ChangeRequest(UUIDMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "change_requests"

    employee_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("employees.id", ondelete="CASCADE"), index=True
    )
    requested_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    category: Mapped[str] = mapped_column(String(32), index=True)
    # pending_manager | pending_wfm | approved | rejected | cancelled
    status: Mapped[str] = mapped_column(String(24), default="pending_manager", index=True)
    reason: Mapped[str] = mapped_column(Text, default="")
    # category-specific detail, e.g. {"date": "...", "from": "...", "to": "..."}
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    attachments: Mapped[list] = mapped_column(JSON, default=list)  # [{filename, url}]
    sla_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    manager_decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    manager_decided_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    wfm_decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    wfm_decided_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    decision_note: Mapped[str | None] = mapped_column(String(512), nullable=True)

    comments: Mapped[list[RequestComment]] = relationship(
        back_populates="request", cascade="all, delete-orphan",
        order_by="RequestComment.created_at",
    )


class RequestComment(UUIDMixin, Base):
    __tablename__ = "request_comments"

    request_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("change_requests.id", ondelete="CASCADE"), index=True
    )
    author_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    author_email: Mapped[str] = mapped_column(String(255), default="")
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    request: Mapped[ChangeRequest] = relationship(back_populates="comments")
