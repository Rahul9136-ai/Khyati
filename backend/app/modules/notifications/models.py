"""Notification center: in-app notifications (email/Teams/Slack go via workers)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import UUIDMixin


class Notification(UUIDMixin, Base):
    __tablename__ = "notifications"

    organization_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True, index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True, index=True)
    employee_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(48), default="info")
    title: Mapped[str] = mapped_column(String(255))
    body: Mapped[str] = mapped_column(String(1024), default="")
    channel: Mapped[str] = mapped_column(String(16), default="in_app")
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
