"""Scheduling DTOs."""
from __future__ import annotations

import uuid
from datetime import date, datetime, time

from pydantic import BaseModel, ConfigDict, Field


class ActivityBlock(BaseModel):
    offset_minutes: int = Field(ge=0)
    duration_minutes: int = Field(gt=0)
    activity: str = Field(
        pattern="^(break|lunch|meeting|training|coaching|one_on_one)$"
    )


class ShiftTemplateIn(BaseModel):
    name: str
    shift_type: str = Field("fixed", pattern="^(fixed|rotational|split|night)$")
    start_time: time
    end_time: time
    days_of_week: list[int] = Field(default=[0, 1, 2, 3, 4])
    breaks: list[ActivityBlock] = []


class ShiftTemplateOut(ShiftTemplateIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID


class GenerateScheduleRequest(BaseModel):
    name: str = ""
    team_id: uuid.UUID
    week_start: date
    template_ids: list[uuid.UUID] = Field(min_length=1)


class ShiftIn(BaseModel):
    employee_id: uuid.UUID
    day: date
    start_ts: datetime
    end_ts: datetime
    template_id: uuid.UUID | None = None
    activities: list[ActivityBlock] = []


class ShiftUpdate(BaseModel):
    day: date | None = None
    start_ts: datetime | None = None
    end_ts: datetime | None = None
    activities: list[ActivityBlock] | None = None
    employee_id: uuid.UUID | None = None


class ShiftOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    schedule_id: uuid.UUID
    employee_id: uuid.UUID
    template_id: uuid.UUID | None
    day: date
    start_ts: datetime
    end_ts: datetime
    activities: list


class ScheduleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    team_id: uuid.UUID | None
    lob_id: uuid.UUID | None
    week_start: date
    status: str
    published_at: datetime | None
    created_at: datetime


class ScheduleDetailOut(ScheduleOut):
    shifts: list[ShiftOut]


class ConflictOut(BaseModel):
    employee_id: uuid.UUID
    day: date
    shift_ids: list[uuid.UUID]
    message: str


class ValidationOut(BaseModel):
    valid: bool
    conflicts: list[ConflictOut]
    warnings: list[str]
