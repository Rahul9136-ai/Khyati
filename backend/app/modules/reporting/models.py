"""Scheduled email reports: who gets which dashboard, how often, and what was sent."""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import TenantMixin, TimestampMixin, UUIDMixin


class ReportRecipientList(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """A named distribution list kept in the tool (a mail-system list's own address
    can simply be used as an ordinary recipient instead)."""

    __tablename__ = "report_recipient_lists"

    name: Mapped[str] = mapped_column(String(120))
    emails: Mapped[list] = mapped_column(JSON, default=list)


class ReportSubscription(UUIDMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "report_subscriptions"

    name: Mapped[str] = mapped_column(String(160))
    #: daily = yesterday · weekly = the last 7 days · mtd = this month so far.
    frequency: Mapped[str] = mapped_column(String(16))
    #: Days it goes out, 0 = Monday … 6 = Sunday.
    weekdays: Mapped[list] = mapped_column(JSON, default=list)
    send_time: Mapped[str] = mapped_column(String(5))
    timezone: Mapped[str] = mapped_column(String(64))
    #: Limit to one LOB ("" = all).
    lob: Mapped[str] = mapped_column(String(128), default="")
    #: Email addresses and/or "list:<id>" references.
    to_recipients: Mapped[list] = mapped_column(JSON, default=list)
    cc_recipients: Mapped[list] = mapped_column(JSON, default=list)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    next_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_status: Mapped[str] = mapped_column(String(16), default="")
    created_by_email: Mapped[str] = mapped_column(String(255), default="")


class ReportRun(UUIDMixin, TenantMixin, Base):
    """One attempt to send a report: the history shown in the tool."""

    __tablename__ = "report_runs"

    subscription_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("report_subscriptions.id", ondelete="CASCADE"), index=True
    )
    trigger: Mapped[str] = mapped_column(String(16))  # schedule | manual
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    to_recipients: Mapped[list] = mapped_column(JSON, default=list)
    cc_recipients: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(16))  # sent | failed
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
