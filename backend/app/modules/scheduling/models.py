"""Scheduling models: shift templates, weekly schedules, shifts."""
from __future__ import annotations

import uuid
from datetime import date, datetime, time

from sqlalchemy import (
    JSON,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Time,
    UniqueConstraint,
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


class DaySchedulePlan(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """One agent's omni-channel day plan — the server copy of what the
    Scheduling timeline edits (see `dayplan.py`). Times are minutes from
    midnight; block lists are JSON arrays of {id, start, end, ...}.

    `agent_key` is the roster id the frontend uses; when it matches an
    employee's `employee_code` the row is also linked via `employee_id`.
    `version` increments on every write for optimistic concurrency.

    A row is a draft until published (`published_at`); only published rows are
    visible to agents and team leaders, and changes to a published row notify
    them (see `schedule_notify.py`).
    """

    __tablename__ = "day_schedule_plans"
    __table_args__ = (UniqueConstraint("organization_id", "plan_date", "agent_key"),)

    plan_date: Mapped[date] = mapped_column(Date, index=True)
    agent_key: Mapped[str] = mapped_column(String(64), index=True)
    employee_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True, index=True
    )
    agent_name: Mapped[str] = mapped_column(String(255), default="")
    team: Mapped[str] = mapped_column(String(128), default="")
    # Team leader's name as the roster has it — matched to Team Leader logins.
    team_lead: Mapped[str] = mapped_column(String(255), default="")
    shift_start: Mapped[int] = mapped_column(Integer)
    shift_end: Mapped[int] = mapped_column(Integer)
    # [{"id","type":"break|lunch","label","start","end"}]
    breaks: Mapped[list] = mapped_column(JSON, default=list)
    # [{"id","channel":"phone|chat|email","start","end"}]
    channels: Mapped[list] = mapped_column(JSON, default=list)
    overtime: Mapped[list] = mapped_column(JSON, default=list)
    # [{"id","type":"meeting|training|coaching|loa|absence|other","start","end","note"?}]
    activities: Mapped[list] = mapped_column(JSON, default=list)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    published_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)


class ScheduleOffer(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """A slot opened to agents from the requirement vs the schedule: VTO / PTO
    (time off where a queue is over-staffed), OT (where it's short) or a
    full-day Leave. `capacity` agents can claim it, first come first served;
    each claim is written into the claimant's day plan (see `offers.py`).
    Times are minutes from midnight (Leave: the whole day, 0–1440)."""

    __tablename__ = "schedule_offers"
    __table_args__ = (
        UniqueConstraint(
            "organization_id", "plan_date", "queue_key", "kind", "start_min", "end_min"
        ),
    )

    plan_date: Mapped[date] = mapped_column(Date, index=True)
    queue_key: Mapped[str] = mapped_column(String(64))  # the roster's queue id
    queue_name: Mapped[str] = mapped_column(String(128), default="")
    kind: Mapped[str] = mapped_column(String(8))  # vto | pto | ot | leave
    start_min: Mapped[int] = mapped_column(Integer)
    end_min: Mapped[int] = mapped_column(Integer)
    capacity: Mapped[int] = mapped_column(Integer)
    # OT channel; None = the claimant's main channel that day.
    channel: Mapped[str | None] = mapped_column(String(8), nullable=True)
    status: Mapped[str] = mapped_column(String(8), default="open")  # open | closed
    # Agent keys who may claim it (skilled on the queue); None = anyone.
    eligible: Mapped[list | None] = mapped_column(JSON, nullable=True)
    note: Mapped[str] = mapped_column(String(255), default="")
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)

    claims: Mapped[list[OfferClaim]] = relationship(
        back_populates="offer", cascade="all, delete-orphan", lazy="selectin",
        order_by="OfferClaim.created_at",
    )


class OfferClaim(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """One agent taking a ScheduleOffer slot. `start_min`/`end_min` is the block
    actually written into their day (time off clipped to their shift; OT outside
    it), `seg_id` its id there — both used to undo it when cancelled."""

    __tablename__ = "schedule_offer_claims"

    offer_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("schedule_offers.id", ondelete="CASCADE"), index=True
    )
    agent_key: Mapped[str] = mapped_column(String(64), index=True)
    agent_name: Mapped[str] = mapped_column(String(255), default="")
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    seg_id: Mapped[str] = mapped_column(String(64))
    start_min: Mapped[int] = mapped_column(Integer)
    end_min: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(12), default="filled")  # filled | cancelled
    cancelled_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    offer: Mapped[ScheduleOffer] = relationship(back_populates="claims")


class ChannelPlanDraft(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """An auto-planned Phone/Chat/Email alignment for one agent-day, waiting to
    be published. Only schedulers see drafts; publishing writes `channels` into
    the day plan (if it's still at `base_version`) and publishes the day, so
    agents and team leaders see it and are notified. See `channel_drafts.py`."""

    __tablename__ = "channel_plan_drafts"
    __table_args__ = (UniqueConstraint("organization_id", "plan_date", "agent_key"),)

    plan_date: Mapped[date] = mapped_column(Date, index=True)
    agent_key: Mapped[str] = mapped_column(String(64))
    agent_name: Mapped[str] = mapped_column(String(255), default="")
    # [{"id","channel":"phone|chat|email","start","end"}]
    channels: Mapped[list] = mapped_column(JSON, default=list)
    base_version: Mapped[int] = mapped_column(Integer)
    summary: Mapped[str] = mapped_column(String(500), default="")
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)


class SchedulingPolicy(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """Organisation-wide scheduling policy: the country labour-law preset the
    day plans are checked against (see `labour_law.py`) plus local overrides
    (state rules, awards, collective agreements). One row per organisation.
    """

    __tablename__ = "scheduling_policies"
    __table_args__ = (UniqueConstraint("organization_id"),)

    country_code: Mapped[str | None] = mapped_column(String(8), nullable=True)
    overrides: Mapped[dict] = mapped_column(JSON, default=dict)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
