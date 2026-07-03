"""Scheduling models: shift templates, weekly schedules, shifts."""
from __future__ import annotations

import uuid
from datetime import date, datetime, time

from sqlalchemy import (
    JSON,
    Date,
    DateTime,
    ForeignKey,
    String,
    Time,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.mixins import TenantMixin, TimestampMixin, UUIDMixin


class ShiftTemplate(UUIDMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "shift_templates"

    name: Mapped[str] = mapped_column(String(128))
    # fixed | rotational | split | night
    shift_type: Mapped[str] = mapped_column(String(16), default="fixed")
    start_time: Mapped[time] = mapped_column(Time)
    end_time: Mapped[time] = mapped_column(Time)  # < start_time ⇒ wraps past midnight
    days_of_week: Mapped[list] = mapped_column(JSON, default=list)  # [0..6], 0=Monday
    # paid/unpaid activity blocks laid inside the shift:
    # [{"offset_minutes": 120, "duration_minutes": 15, "activity": "break"}, ...]
    breaks: Mapped[list] = mapped_column(JSON, default=list)


class Schedule(UUIDMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "schedules"

    name: Mapped[str] = mapped_column(String(128))
    team_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("teams.id", ondelete="CASCADE"), nullable=True, index=True
    )
    lob_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("lobs.id", ondelete="SET NULL"), nullable=True
    )
    week_start: Mapped[date] = mapped_column(Date, index=True)
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft|published
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    published_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    shifts: Mapped[list[ScheduleShift]] = relationship(
        back_populates="schedule", cascade="all, delete-orphan",
        order_by="ScheduleShift.start_ts",
    )


class ScheduleShift(UUIDMixin, Base):
    __tablename__ = "schedule_shifts"

    schedule_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("schedules.id", ondelete="CASCADE"), index=True
    )
    employee_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("employees.id", ondelete="CASCADE"), index=True
    )
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("shift_templates.id", ondelete="SET NULL"), nullable=True
    )
    day: Mapped[date] = mapped_column(Date, index=True)
    start_ts: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    end_ts: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # activity blocks incl. breaks/lunch/meeting/training/coaching/one_on_one
    activities: Mapped[list] = mapped_column(JSON, default=list)

    schedule: Mapped[Schedule] = relationship(back_populates="shifts")
