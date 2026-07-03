"""Forecasting DTOs."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class PointIn(BaseModel):
    day: date
    volume: float = Field(ge=0)
    aht: float | None = Field(default=None, ge=0)


class SeriesUpload(BaseModel):
    name: str
    queue_id: uuid.UUID | None = None
    points: list[PointIn] = Field(min_length=7)


class PointOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    day: date
    volume: float
    aht: float | None


class SeriesOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    queue_id: uuid.UUID | None
    granularity: str
    source: str
    cleaning_report: dict | None
    created_at: datetime


class ForecastRequest(BaseModel):
    series_id: uuid.UUID
    name: str = ""
    model: str = "auto"
    horizon_days: int = Field(28, ge=7, le=365)
    holiday_calendar_id: uuid.UUID | None = None
    parent_id: uuid.UUID | None = None  # creates the next version of that forecast


class ForecastPointOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    day: date
    volume: float
    lower: float
    upper: float
    aht: float


class ForecastOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    queue_id: uuid.UUID | None
    series_id: uuid.UUID | None
    parent_id: uuid.UUID | None
    model: str
    granularity: str
    horizon_days: int
    version: int
    status: str
    mape: float | None
    backtest: dict | None
    created_by: uuid.UUID | None
    submitted_at: datetime | None
    approved_by: uuid.UUID | None
    approved_at: datetime | None
    rejection_reason: str | None
    created_at: datetime


class ForecastDetailOut(ForecastOut):
    points: list[ForecastPointOut]


class RejectRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=512)


class IntervalBreakdown(BaseModel):
    day: date
    interval_minutes: int
    labels: list[str]
    volumes: list[float]
