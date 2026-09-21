"""DTOs for the HC planning API."""
from __future__ import annotations

import uuid
from datetime import date

from pydantic import BaseModel, ConfigDict, Field


class TenureBandDTO(BaseModel):
    bucket: str
    months_to: float | None = None
    label: str = ""


class ConfigIn(BaseModel):
    lob_id: uuid.UUID | None = None
    ooo_shrinkage: float | None = None
    io_shrinkage: float | None = None
    attrition: float | None = None
    weekly_hours: float | None = None
    hiring_throughput: float | None = None
    training_throughput: float | None = None
    training_days: int | None = None
    nesting_days: int | None = None
    actuals_through: str | None = None
    tenure_bands: list[TenureBandDTO] | None = None
    monthly_overrides: dict | None = None
    closing_overrides: dict[str, float] | None = None


class ConfigOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID | None = None
    lob_id: uuid.UUID | None = None
    ooo_shrinkage: float
    io_shrinkage: float
    attrition: float
    weekly_hours: float
    hiring_throughput: float
    training_throughput: float
    training_days: int
    nesting_days: int
    actuals_through: str | None
    tenure_bands: list
    monthly_overrides: dict
    closing_overrides: dict


class DemandIn(BaseModel):
    lob_id: uuid.UUID | None = None
    month: str = Field(pattern=r"^\d{4}-\d{2}$")
    billable_fte: float = Field(ge=0)


class DemandBulkIn(BaseModel):
    lob_id: uuid.UUID | None = None
    items: list[DemandIn]


class DemandOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    month: str
    billable_fte: float
    locked: bool = False


class ProfileIn(BaseModel):
    planning_status: str | None = None
    dop: date | None = None
    experience_type: str | None = None
    function: str | None = None
    current_function: str | None = None
    move_out_date: date | None = None
    move_in_date: date | None = None
    target_lob_id: uuid.UUID | None = None


class ProfileOut(ProfileIn):
    model_config = ConfigDict(from_attributes=True)
    employee_id: uuid.UUID


class MonthResultOut(BaseModel):
    month: str
    billable_fte: float
    required_hc: float
    production_agents: float
    fte_ramp: float
    closing_hc: float
    closing_overridden: bool
    capacity_pct: float | None
    excess_deficit: float
    ot_vto_hours: float
    fte: float
    ramp: float
    notice_period: float
    ojt: float
    investment_bench: float
    ops_bench: float
    training: float
    long_leave: float
    maternity_leave: float
    overall_utilization: float | None
    productive_utilization: float | None
    buffer_pct: float | None
    headcount_vs_billable: float
    req_hc_vs_actual: float
    fresher_lt_1yr: float
    lateral_gt_1yr: float


class CapacityTableOut(BaseModel):
    lob_id: uuid.UUID | None
    lob_name: str | None
    months: list[str]
    results: list[MonthResultOut]
    config: ConfigOut
    agent_count: int


class BatchIn(BaseModel):
    lob_id: uuid.UUID | None = None
    hire_date: date
    planned_hires: float = Field(ge=0)
    experience_type: str | None = None
    location: str | None = None
    hiring_throughput: float | None = None
    training_throughput: float | None = None
    training_days: int | None = None
    nesting_days: int | None = None
    note: str = ""


class BatchUpdate(BaseModel):
    hire_date: date | None = None
    planned_hires: float | None = None
    experience_type: str | None = None
    location: str | None = None
    hiring_throughput: float | None = None
    training_throughput: float | None = None
    training_days: int | None = None
    nesting_days: int | None = None
    note: str | None = None


class BatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    lob_id: uuid.UUID | None
    hire_date: date
    planned_hires: float
    experience_type: str | None
    location: str | None
    note: str


class AgentRowOut(BaseModel):
    employee_id: uuid.UUID
    name: str
    lob_id: uuid.UUID | None
    location: str | None
    planning_status: str
    dop: date | None
    experience_type: str | None
    move_out_date: date | None
    move_in_date: date | None
    target_lob_id: uuid.UUID | None


class PipelineStageOut(BaseModel):
    hire_date: date
    training_start: date
    nesting_start: date
    production_date: date
    production_month: str
    planned_hires: float
    successful_hires: float
    entering_training: float
    production: float
