"""Planning DTOs."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class Assumptions(BaseModel):
    aht_seconds: float = Field(300, gt=0)
    shrinkage: float = Field(0.3, ge=0, lt=1)
    occupancy: float = Field(0.85, gt=0, le=1)
    concurrency: float = Field(1.0, ge=1)
    weekly_hours: float = Field(40, gt=0, le=80)
    attrition_weekly_pct: float = Field(0.0, ge=0, lt=0.5)
    buffer_pct: float = Field(0.0, ge=0, le=0.5)


class PlanWeekIn(BaseModel):
    week_start: date
    volume: float = Field(ge=0)
    aht_override: float | None = Field(default=None, gt=0)
    new_hires: float = Field(0, ge=0)
    planned_attrition: float | None = Field(default=None, ge=0)
    notes: str = ""


class PlanCreate(BaseModel):
    name: str
    queue_id: uuid.UUID | None = None
    lob_id: uuid.UUID | None = None
    starting_headcount: float = Field(0, ge=0)
    assumptions: Assumptions = Assumptions()
    weeks: list[PlanWeekIn] = Field(min_length=1)


class PlanUpdate(BaseModel):
    name: str | None = None
    status: str | None = Field(default=None, pattern="^(draft|active|archived)$")
    starting_headcount: float | None = Field(default=None, ge=0)
    assumptions: Assumptions | None = None
    weeks: list[PlanWeekIn] | None = None


class PlanWeekOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    week_start: date
    volume: float
    aht_override: float | None
    new_hires: float
    planned_attrition: float | None
    workload_hours: float
    required_fte: float
    available_hc: float
    gap: float
    notes: str


class PlanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    queue_id: uuid.UUID | None
    lob_id: uuid.UUID | None
    status: str
    starting_headcount: float
    assumptions: dict
    created_at: datetime


class PlanDetailOut(PlanOut):
    weeks: list[PlanWeekOut]


class WhatIfRequest(BaseModel):
    overrides: Assumptions


# --------------------------------------------------------- erlang calculators


class ErlangRequirementRequest(BaseModel):
    volume: float = Field(gt=0, description="Contacts in the interval")
    aht_seconds: float = Field(300, gt=0)
    interval_seconds: int = Field(1800, ge=60)
    sla_target: float = Field(0.8, gt=0, le=1)
    sla_threshold_seconds: float = Field(30, ge=0)
    max_occupancy: float = Field(0.9, gt=0, le=1)
    shrinkage: float = Field(0.0, ge=0, lt=1)
    concurrency: float = Field(1.0, ge=1)
    patience_seconds: float = Field(90, gt=0)


class ErlangRequirementResponse(BaseModel):
    agents: int
    agents_with_shrinkage: int
    intensity_erlangs: float
    service_level: float
    asa_seconds: float
    occupancy: float
    abandonment: float


class ErlangServiceLevelRequest(BaseModel):
    agents: int = Field(gt=0)
    volume: float = Field(gt=0)
    aht_seconds: float = Field(300, gt=0)
    interval_seconds: int = Field(1800, ge=60)
    sla_threshold_seconds: float = Field(30, ge=0)
    patience_seconds: float = Field(90, gt=0)


class ErlangServiceLevelResponse(BaseModel):
    service_level: float
    asa_seconds: float
    occupancy: float
    abandonment: float
    wait_probability: float
