"""Workforce models: org hierarchy, skills, queues, holiday calendars, employees.

Hierarchy: Organization → BusinessUnit → LOB → Team → Employee.
Countries, skills and queues hang off the organization; queues optionally bind
to a LOB. All business tables carry `organization_id` (TenantMixin).
"""
from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import (
    JSON,
    Date,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.mixins import SoftDeleteMixin, TenantMixin, TimestampMixin, UUIDMixin


class Organization(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(255))
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)


class HolidayCalendar(UUIDMixin, TenantMixin, Base):
    __tablename__ = "holiday_calendars"

    name: Mapped[str] = mapped_column(String(128))

    holidays: Mapped[list[Holiday]] = relationship(
        back_populates="calendar", lazy="selectin", cascade="all, delete-orphan"
    )


class Holiday(UUIDMixin, Base):
    __tablename__ = "holidays"

    calendar_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("holiday_calendars.id", ondelete="CASCADE"), index=True
    )
    day: Mapped[date] = mapped_column(Date)
    name: Mapped[str] = mapped_column(String(128))

    calendar: Mapped[HolidayCalendar] = relationship(back_populates="holidays")


class Country(UUIDMixin, TenantMixin, Base):
    __tablename__ = "countries"
    __table_args__ = (UniqueConstraint("organization_id", "iso_code"),)

    name: Mapped[str] = mapped_column(String(128))
    iso_code: Mapped[str] = mapped_column(String(2))
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    holiday_calendar_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("holiday_calendars.id", ondelete="SET NULL"), nullable=True
    )


class BusinessUnit(UUIDMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "business_units"
    __table_args__ = (UniqueConstraint("organization_id", "code"),)

    name: Mapped[str] = mapped_column(String(128))
    code: Mapped[str] = mapped_column(String(32))


class Lob(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """Line of business (may also carry client + department labels)."""

    __tablename__ = "lobs"
    __table_args__ = (UniqueConstraint("organization_id", "code"),)

    business_unit_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("business_units.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(128))
    code: Mapped[str] = mapped_column(String(32))
    client: Mapped[str] = mapped_column(String(128), default="")
    department: Mapped[str] = mapped_column(String(128), default="")


class Team(UUIDMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "teams"

    lob_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("lobs.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(128))
    leader_employee_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("employees.id", ondelete="SET NULL", use_alter=True), nullable=True
    )


class Skill(UUIDMixin, TenantMixin, Base):
    __tablename__ = "skills"
    __table_args__ = (UniqueConstraint("organization_id", "name"),)

    name: Mapped[str] = mapped_column(String(128))
    category: Mapped[str] = mapped_column(String(64), default="general")  # channel|language|...


class Queue(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """A routable workload stream (voice/chat/email/ticket) with SLA targets."""

    __tablename__ = "queues"

    lob_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("lobs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(128))
    channel: Mapped[str] = mapped_column(String(16), default="voice")  # voice|chat|email|ticket
    sla_threshold_seconds: Mapped[int] = mapped_column(Integer, default=30)
    sla_target_pct: Mapped[float] = mapped_column(Float, default=0.8)
    target_occupancy: Mapped[float] = mapped_column(Float, default=0.85)
    concurrency: Mapped[float] = mapped_column(Float, default=1.0)  # >1 for chat
    default_aht_seconds: Mapped[int] = mapped_column(Integer, default=300)
    interval_minutes: Mapped[int] = mapped_column(Integer, default=30)  # 15|30|60


class Employee(UUIDMixin, TenantMixin, TimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "employees"
    __table_args__ = (UniqueConstraint("organization_id", "employee_code"),)

    employee_code: Mapped[str] = mapped_column(String(32), index=True)
    first_name: Mapped[str] = mapped_column(String(128))
    last_name: Mapped[str] = mapped_column(String(128), default="")
    email: Mapped[str] = mapped_column(String(255), index=True)
    country_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("countries.id", ondelete="SET NULL"), nullable=True
    )
    team_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("teams.id", ondelete="SET NULL"), nullable=True, index=True
    )
    lob_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("lobs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    manager_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    employment_type: Mapped[str] = mapped_column(String(16), default="full_time")
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)
    weekly_hours: Mapped[float] = mapped_column(Float, default=40.0)
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    location: Mapped[str] = mapped_column(String(128), default="")
    # fixed | rotational | split | night
    shift_pattern: Mapped[str] = mapped_column(String(32), default="fixed")
    # availability per weekday, e.g. {"mon": ["09:00","17:30"], "sun": null}
    availability: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    languages: Mapped[list | None] = mapped_column(JSON, nullable=True)
    hire_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    termination_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    skills: Mapped[list[EmployeeSkill]] = relationship(
        back_populates="employee", lazy="selectin", cascade="all, delete-orphan"
    )

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()


class EmployeeSkill(UUIDMixin, Base):
    __tablename__ = "employee_skills"
    __table_args__ = (UniqueConstraint("employee_id", "skill_id"),)

    employee_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("employees.id", ondelete="CASCADE"), index=True
    )
    skill_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("skills.id", ondelete="CASCADE"), index=True
    )
    proficiency: Mapped[int] = mapped_column(Integer, default=3)  # 1..5
    priority: Mapped[int] = mapped_column(Integer, default=1)  # routing priority

    employee: Mapped[Employee] = relationship(back_populates="skills")
    skill: Mapped[Skill] = relationship(lazy="selectin")
