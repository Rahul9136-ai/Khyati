"""Attendance DTOs."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class CodeIn(BaseModel):
    code: str = Field(min_length=1, max_length=16)
    name: str
    category: str = Field(
        "present",
        pattern="^(present|late|early_logout|absent|leave|sick|vacation|training|other)$",
    )
    is_paid: bool = True
    counts_as_shrinkage: bool = False


class CodeOut(CodeIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID


class RecordIn(BaseModel):
    employee_id: uuid.UUID
    code_id: uuid.UUID
    day: date
    scheduled_start: datetime | None = None
    scheduled_end: datetime | None = None
    actual_start: datetime | None = None
    actual_end: datetime | None = None
    notes: str = ""


class RecordUpdate(BaseModel):
    code_id: uuid.UUID | None = None
    actual_start: datetime | None = None
    actual_end: datetime | None = None
    notes: str | None = None


class RecordOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    employee_id: uuid.UUID
    code_id: uuid.UUID
    day: date
    scheduled_start: datetime | None
    scheduled_end: datetime | None
    actual_start: datetime | None
    actual_end: datetime | None
    minutes_late: int
    minutes_early_logout: int
    notes: str
    source: str
    code: CodeOut


class BulkRecordsIn(BaseModel):
    records: list[RecordIn] = Field(min_length=1, max_length=500)


class AttendanceSummary(BaseModel):
    start: date
    end: date
    total_records: int
    absent_records: int
    late_records: int
    absenteeism_rate: float
    late_rate: float
    shrinkage_rate: float
    by_category: dict[str, int]
