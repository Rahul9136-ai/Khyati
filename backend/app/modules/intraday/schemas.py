"""Intraday DTOs."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class ActualIn(BaseModel):
    queue_id: uuid.UUID
    ts: datetime
    offered: float = Field(ge=0)
    handled: float = Field(0, ge=0)
    aht_seconds: float = Field(0, ge=0)
    service_level: float | None = Field(default=None, ge=0, le=1)
    occupancy: float | None = Field(default=None, ge=0, le=1)
    staffed: float | None = Field(default=None, ge=0)


class BulkActualsIn(BaseModel):
    actuals: list[ActualIn] = Field(min_length=1, max_length=1000)


class ActualOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    queue_id: uuid.UUID
    ts: datetime
    offered: float
    handled: float
    aht_seconds: float
    service_level: float | None
    occupancy: float | None
    staffed: float | None


class IntervalStatus(BaseModel):
    label: str
    forecast_volume: float
    actual_volume: float | None
    deviation_pct: float | None
    service_level: float | None
    occupancy: float | None
    staffed: float | None
    required_agents: int | None


class IntradayStatus(BaseModel):
    queue_id: uuid.UUID
    day: date
    forecast_id: uuid.UUID | None
    forecast_total: float
    actual_so_far: float
    forecast_so_far: float
    deviation_pct: float | None
    reforecast_total: float | None
    sl_attained: float | None
    intervals: list[IntervalStatus]
    recommendations: list[str]
