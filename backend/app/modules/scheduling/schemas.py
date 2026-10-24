"""Scheduling DTOs."""
from __future__ import annotations

import uuid
from datetime import date, datetime, time
from typing import Literal

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


# ------------------------------------------------- omni-channel day plans

_Minute = Field(ge=0, le=24 * 60)
ChannelName = Literal["phone", "chat", "email"]
ActivityName = Literal["meeting", "training", "coaching", "loa", "absence", "other"]
AuxName = Literal["break", "lunch", "meeting", "training", "coaching", "loa", "absence", "other"]


class DayBreakIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    type: Literal["break", "lunch"]
    label: str = Field("", max_length=64)
    start: int = _Minute
    end: int = _Minute


class DayChannelIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    channel: ChannelName
    start: int = _Minute
    end: int = _Minute


class DayActivityIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    type: ActivityName
    start: int = _Minute
    end: int = _Minute
    note: str | None = Field(None, max_length=255)


class DayPlanIn(BaseModel):
    """One agent's full day (absolute minutes). `base_version` = the version the
    client last saw; a mismatch is rejected with 409 so edits aren't lost."""

    agent_key: str = Field(min_length=1, max_length=64)
    agent_name: str = Field("", max_length=255)
    team: str = Field("", max_length=128)
    shift_start: int = _Minute
    shift_end: int = _Minute
    breaks: list[DayBreakIn] = []
    channels: list[DayChannelIn] = []
    overtime: list[DayChannelIn] = []
    activities: list[DayActivityIn] = []
    base_version: int | None = None


class DayPlanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    plan_date: date
    agent_key: str
    employee_id: uuid.UUID | None
    agent_name: str
    team: str
    shift_start: int
    shift_end: int
    breaks: list
    channels: list
    overtime: list
    activities: list
    version: int
    updated_at: datetime


class DayPlanBulkIn(BaseModel):
    items: list[DayPlanIn] = Field(min_length=1, max_length=1000)
    #: Human-readable summary for the audit log, e.g. "Lunch 11:00–11:30 → 12:00–12:30".
    detail: str = Field("", max_length=500)


class DaySkipped(BaseModel):
    agent_key: str
    reason: str


class DayOpResult(BaseModel):
    saved: list[DayPlanOut]
    skipped: list[DaySkipped] = []


class DayEditOpIn(BaseModel):
    kind: Literal[
        "aux-move", "aux-resize", "channel-resize", "ot-resize",
        "activity-move", "activity-resize", "shift-resize",
    ]
    seg_id: str | None = None
    edge: Literal["start", "end"] | None = None


class DayApplyEditIn(BaseModel):
    """Move/resize one block (or the shift) on `agent_key`'s day to `value`.
    `followers` get the same delta on their matching block (bulk drag)."""

    agent_key: str
    op: DayEditOpIn
    value: int = _Minute
    followers: list[str] = []


class DayMoveIn(BaseModel):
    agent_keys: list[str] = Field(min_length=1)
    delta: int = Field(ge=-24 * 60, le=24 * 60)


class DayResizeShiftIn(BaseModel):
    agent_keys: list[str] = Field(min_length=1)
    edge: Literal["start", "end"]
    delta: int = Field(ge=-24 * 60, le=24 * 60)


class DayStaggerIn(BaseModel):
    group_size: int = Field(ge=1)
    every: int = Field(ge=5)


class DayMarkAuxIn(BaseModel):
    """Mark any AUX on many agents (right-click menu / Add activity)."""

    agent_keys: list[str] = Field(min_length=1)
    kind: AuxName
    start: int = _Minute
    length: int = Field(30, ge=1, le=24 * 60)
    full_shift: bool = False
    note: str | None = Field(None, max_length=255)
    stagger: DayStaggerIn | None = None


class DayUnmarkIn(BaseModel):
    agent_keys: list[str] = Field(min_length=1)
    at: int = _Minute


class DayAddOvertimeIn(BaseModel):
    agent_keys: list[str] = Field(min_length=1)
    channel: ChannelName
    timing: Literal["after", "before", "custom"] = "after"
    duration: int = Field(60, ge=1, le=24 * 60)
    start: int | None = Field(None, ge=0, le=24 * 60)
    end: int | None = Field(None, ge=0, le=24 * 60)


class DayCoverageSlot(BaseModel):
    start: int
    phone: float
    chat: float
    email: float
    ot: float
    activity: float
