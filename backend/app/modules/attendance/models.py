"""Attendance models: configurable codes + daily records."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.mixins import TenantMixin, TimestampMixin, UUIDMixin


class AttendanceCode(UUIDMixin, TenantMixin, Base):
    __tablename__ = "attendance_codes"
    __table_args__ = (UniqueConstraint("organization_id", "code"),)

    code: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(128))
    # present|late|early_logout|absent|leave|sick|vacation|training|other
    category: Mapped[str] = mapped_column(String(24), default="present")
    is_paid: Mapped[bool] = mapped_column(Boolean, default=True)
    counts_as_shrinkage: Mapped[bool] = mapped_column(Boolean, default=False)


class AttendanceRecord(UUIDMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "attendance_records"
    __table_args__ = (UniqueConstraint("employee_id", "day", "code_id"),)

    employee_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("employees.id", ondelete="CASCADE"), index=True
    )
    code_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("attendance_codes.id", ondelete="CASCADE")
    )
    day: Mapped[date] = mapped_column(Date, index=True)
    scheduled_start: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    scheduled_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    actual_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    actual_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    minutes_late: Mapped[int] = mapped_column(Integer, default=0)
    minutes_early_logout: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[str] = mapped_column(String(512), default="")
    source: Mapped[str] = mapped_column(String(16), default="manual")  # manual|bulk|system

    code: Mapped[AttendanceCode] = relationship(lazy="selectin")
