"""Workforce DTOs."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field

# ------------------------------------------------------------- org structure


class OrganizationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    code: str


class CountryIn(BaseModel):
    name: str
    iso_code: str = Field(min_length=2, max_length=2)
    timezone: str = "UTC"
    holiday_calendar_id: uuid.UUID | None = None


class CountryOut(CountryIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID


class BusinessUnitIn(BaseModel):
    name: str
    code: str


class BusinessUnitOut(BusinessUnitIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID


class LobIn(BaseModel):
    business_unit_id: uuid.UUID
    name: str
    code: str
    client: str = ""
    department: str = ""


class LobOut(LobIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID


class TeamIn(BaseModel):
    lob_id: uuid.UUID
    name: str
    leader_employee_id: uuid.UUID | None = None


class TeamOut(TeamIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID


class SkillIn(BaseModel):
    name: str
    category: str = "general"


class SkillOut(SkillIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID


class QueueIn(BaseModel):
    lob_id: uuid.UUID | None = None
    name: str
    channel: str = Field("voice", pattern="^(voice|chat|email|ticket)$")
    sla_threshold_seconds: int = Field(30, ge=1)
    sla_target_pct: float = Field(0.8, gt=0, le=1)
    target_occupancy: float = Field(0.85, gt=0, le=1)
    concurrency: float = Field(1.0, ge=1)
    default_aht_seconds: int = Field(300, ge=1)
    interval_minutes: int = Field(30, ge=15, le=60)


class QueueOut(QueueIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID


class HolidayIn(BaseModel):
    day: date
    name: str


class HolidayCalendarIn(BaseModel):
    name: str
    holidays: list[HolidayIn] = []


class HolidayOut(HolidayIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID


class HolidayCalendarOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    holidays: list[HolidayOut]


# ----------------------------------------------------------------- employees


class EmployeeSkillIn(BaseModel):
    skill_id: uuid.UUID
    proficiency: int = Field(3, ge=1, le=5)
    priority: int = Field(1, ge=1, le=10)


class EmployeeSkillOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    skill_id: uuid.UUID
    proficiency: int
    priority: int


class EmployeeIn(BaseModel):
    employee_code: str
    first_name: str
    last_name: str = ""
    email: EmailStr
    country_id: uuid.UUID | None = None
    team_id: uuid.UUID | None = None
    lob_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None
    employment_type: str = Field("full_time", pattern="^(full_time|part_time|contract)$")
    status: str = Field("active", pattern="^(active|inactive|terminated)$")
    weekly_hours: float = Field(40.0, gt=0, le=80)
    timezone: str = "UTC"
    location: str = ""
    shift_pattern: str = Field("fixed", pattern="^(fixed|rotational|split|night)$")
    availability: dict | None = None
    languages: list[str] | None = None
    hire_date: date | None = None
    termination_date: date | None = None


class EmployeeUpdate(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    email: EmailStr | None = None
    country_id: uuid.UUID | None = None
    team_id: uuid.UUID | None = None
    lob_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None
    employment_type: str | None = None
    status: str | None = None
    weekly_hours: float | None = None
    timezone: str | None = None
    location: str | None = None
    shift_pattern: str | None = None
    availability: dict | None = None
    languages: list[str] | None = None
    hire_date: date | None = None
    termination_date: date | None = None


class EmployeeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    employee_code: str
    first_name: str
    last_name: str
    full_name: str
    email: EmailStr
    country_id: uuid.UUID | None
    team_id: uuid.UUID | None
    lob_id: uuid.UUID | None
    manager_id: uuid.UUID | None
    employment_type: str
    status: str
    weekly_hours: float
    timezone: str
    location: str
    shift_pattern: str
    availability: dict | None
    languages: list | None
    hire_date: date | None
    termination_date: date | None
    skills: list[EmployeeSkillOut]
    created_at: datetime
