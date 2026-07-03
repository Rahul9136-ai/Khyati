"""Planning models: capacity plans and their weekly lines."""
from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import (
    JSON,
    Date,
    Float,
    ForeignKey,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.mixins import TenantMixin, TimestampMixin, UUIDMixin


class CapacityPlan(UUIDMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "capacity_plans"

    name: Mapped[str] = mapped_column(String(128))
    queue_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("queues.id", ondelete="SET NULL"), nullable=True
    )
    lob_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("lobs.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft|active|archived
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    starting_headcount: Mapped[float] = mapped_column(Float, default=0)
    # {aht_seconds, shrinkage, occupancy, concurrency, weekly_hours,
    #  attrition_weekly_pct, buffer_pct}
    assumptions: Mapped[dict] = mapped_column(JSON, default=dict)

    weeks: Mapped[list[CapacityPlanWeek]] = relationship(
        back_populates="plan", cascade="all, delete-orphan",
        order_by="CapacityPlanWeek.week_start",
    )


class CapacityPlanWeek(UUIDMixin, Base):
    __tablename__ = "capacity_plan_weeks"
    __table_args__ = (UniqueConstraint("plan_id", "week_start"),)

    plan_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("capacity_plans.id", ondelete="CASCADE"), index=True
    )
    week_start: Mapped[date] = mapped_column(Date)
    # inputs
    volume: Mapped[float] = mapped_column(Float, default=0)
    aht_override: Mapped[float | None] = mapped_column(Float, nullable=True)
    new_hires: Mapped[float] = mapped_column(Float, default=0)
    planned_attrition: Mapped[float | None] = mapped_column(Float, nullable=True)  # heads
    # computed outputs (persisted for reporting)
    workload_hours: Mapped[float] = mapped_column(Float, default=0)
    required_fte: Mapped[float] = mapped_column(Float, default=0)
    available_hc: Mapped[float] = mapped_column(Float, default=0)
    gap: Mapped[float] = mapped_column(Float, default=0)
    notes: Mapped[str] = mapped_column(String(255), default="")

    plan: Mapped[CapacityPlan] = relationship(back_populates="weeks")
