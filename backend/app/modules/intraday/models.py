"""Intraday models: per-interval actuals posted by ACD feeds or RTAs."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import TenantMixin, UUIDMixin


class IntervalActual(UUIDMixin, TenantMixin, Base):
    __tablename__ = "interval_actuals"
    __table_args__ = (UniqueConstraint("queue_id", "ts"),)

    queue_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("queues.id", ondelete="CASCADE"), index=True
    )
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    offered: Mapped[float] = mapped_column(Float, default=0)
    handled: Mapped[float] = mapped_column(Float, default=0)
    aht_seconds: Mapped[float] = mapped_column(Float, default=0)
    service_level: Mapped[float | None] = mapped_column(Float, nullable=True)
    occupancy: Mapped[float | None] = mapped_column(Float, nullable=True)
    staffed: Mapped[float | None] = mapped_column(Float, nullable=True)
