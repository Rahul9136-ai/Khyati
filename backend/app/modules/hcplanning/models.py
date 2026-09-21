"""HC planning persistence.

Additive tables only — no existing table is altered. Agent planning attributes
that the existing Employee record doesn't carry (Date of Production, experience
type, planned LOB movement, planning status) live in a 1:1 profile so the
Employee module is untouched. Demand and configuration are per organization and
optionally per LOB.
"""
from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    Float,
    ForeignKey,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import TenantMixin, TimestampMixin, UUIDMixin

# Planning Status categories an agent can hold (drives the capacity category rows).
PLANNING_STATUSES = (
    "FTE", "Ramp", "Notice Period", "OJT", "Investment Bench", "Ops Bench",
    "Training", "Long Leave", "Maternity Leave", "TTL&Above", "QA",
)


class AgentPlanningProfile(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """Planning-specific attributes for an employee (1:1). Everything else
    (LOB, location, DOJ, inactive date) is read from the Employee record."""

    __tablename__ = "agent_planning_profiles"
    __table_args__ = (UniqueConstraint("employee_id"),)

    employee_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("employees.id", ondelete="CASCADE"), index=True
    )
    planning_status: Mapped[str] = mapped_column(String(32), default="FTE")
    dop: Mapped[date | None] = mapped_column(Date, nullable=True)  # Date of Production
    experience_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    function: Mapped[str | None] = mapped_column(String(64), nullable=True)
    current_function: Mapped[str | None] = mapped_column(String(64), nullable=True)
    move_out_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    move_in_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    target_lob_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("lobs.id", ondelete="SET NULL"), nullable=True
    )


class HcPlanningConfig(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """Planning assumptions. A row with ``lob_id`` NULL is the org-wide default;
    a per-LOB row overrides it."""

    __tablename__ = "hc_planning_configs"
    __table_args__ = (UniqueConstraint("organization_id", "lob_id"),)

    lob_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("lobs.id", ondelete="CASCADE"), nullable=True, index=True
    )
    ooo_shrinkage: Mapped[float] = mapped_column(Float, default=0.04)
    io_shrinkage: Mapped[float] = mapped_column(Float, default=0.04)
    attrition: Mapped[float] = mapped_column(Float, default=0.0125)
    weekly_hours: Mapped[float] = mapped_column(Float, default=40.0)
    hiring_throughput: Mapped[float] = mapped_column(Float, default=0.90)
    training_throughput: Mapped[float] = mapped_column(Float, default=0.95)
    # last actual month (YYYY-MM); later months are projected
    actuals_through: Mapped[str | None] = mapped_column(String(7), nullable=True)
    # [{bucket, months_to, label}]; empty ⇒ engine defaults
    tenure_bands: Mapped[list] = mapped_column(JSON, default=list)
    # per-month assumption overrides: {"ooo": {"2026-01": 0.05}, "io": {...}, "attrition": {...}}
    monthly_overrides: Mapped[dict] = mapped_column(JSON, default=dict)
    # editable Closing HC overrides: {"YYYY-MM": value}
    closing_overrides: Mapped[dict] = mapped_column(JSON, default=dict)


class HcDemand(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """Monthly Billable FTE requirement (editable/uploadable demand input)."""

    __tablename__ = "hc_demand"
    __table_args__ = (UniqueConstraint("organization_id", "lob_id", "month"),)

    lob_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("lobs.id", ondelete="CASCADE"), nullable=True, index=True
    )
    month: Mapped[str] = mapped_column(String(7), index=True)  # YYYY-MM
    billable_fte: Mapped[float] = mapped_column(Float, default=0.0)
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
