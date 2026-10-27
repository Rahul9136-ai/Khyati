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
ActivityName = Literal[
    "meeting", "training", "coaching", "loa", "absence", "other", "vto", "pto", "leave", "off"
]
AuxName = Literal[
    "break", "lunch", "meeting", "training", "coaching", "loa", "absence", "other",
    "vto", "pto", "leave", "off",
]


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
    team_lead: str = Field("", max_length=255)
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
    team_lead: str = ""
    shift_start: int
    shift_end: int
    breaks: list
    channels: list
    overtime: list
    activities: list
    version: int
    updated_at: datetime
    published_at: datetime | None = None


class DayPlanBulkIn(BaseModel):
    items: list[DayPlanIn] = Field(min_length=1, max_length=1000)
    #: Human-readable summary for the audit log, e.g. "Lunch 11:00–11:30 → 12:00–12:30".
    detail: str = Field("", max_length=500)


class DayPlanSummaryOut(BaseModel):
    """One agent-day in the multi-week overview (no block detail)."""

    plan_date: date
    agent_key: str
    agent_name: str
    team: str
    shift_start: int
    shift_end: int
    ot_minutes: int
    activities: list[str]  # activity types on the day, e.g. ["meeting", "loa"]
    version: int
    published: bool


class DayPlanDatedIn(DayPlanIn):
    plan_date: date


class DayFillIn(BaseModel):
    """Days to create where none is saved yet (existing rows are left untouched),
    e.g. the default schedules for dates nobody has opened before publishing."""

    items: list[DayPlanDatedIn] = Field(min_length=1, max_length=10_000)


class DayFillOut(BaseModel):
    created: int
    existing: int


class DayPublishIn(BaseModel):
    start: date
    end: date
    #: Limit to these agents; default all saved schedules in the range.
    agent_keys: list[str] | None = None
    note: str = Field("", max_length=255)


class DayPublishOut(BaseModel):
    start: date
    end: date
    days: int
    agents: int
    published: int  # agent-days newly published or re-published with changes
    unchanged: int  # already published and unchanged
    notified: int  # users notified (agents + team leaders)


OfferKind = Literal["vto", "pto", "ot", "leave"]


class OfferIn(BaseModel):
    """One slot to open (or update — same date, queue, kind and times)."""

    plan_date: date
    queue_key: str = Field(min_length=1, max_length=64)
    queue_name: str = Field("", max_length=128)
    kind: OfferKind
    start: int = _Minute
    end: int = _Minute
    capacity: int = Field(ge=0, le=1000)
    channel: ChannelName | None = None
    eligible: list[str] | None = Field(None, max_length=5000)
    note: str = Field("", max_length=255)


class OffersUpsertIn(BaseModel):
    items: list[OfferIn] = Field(min_length=1, max_length=500)
    #: Tell eligible agents that new slots are open (one pop-up each).
    notify: bool = True


class OfferPatchIn(BaseModel):
    capacity: int | None = Field(None, ge=0, le=1000)
    status: Literal["open", "closed"] | None = None


class OfferClaimIn(BaseModel):
    #: Staff can claim for an agent; agents claim for themselves (leave empty).
    agent_key: str | None = Field(None, max_length=64)


class OfferClaimOut(BaseModel):
    id: uuid.UUID
    agent_key: str
    agent_name: str
    start: int
    end: int
    status: str
    created_at: datetime


class OfferOut(BaseModel):
    id: uuid.UUID
    plan_date: date
    queue_key: str
    queue_name: str
    kind: OfferKind
    start: int
    end: int
    capacity: int
    filled: int
    left: int
    channel: str | None
    status: str
    note: str
    #: Staff see every active claim; agents only their own.
    claims: list[OfferClaimOut]
    #: The caller's own active claim on this slot, if any.
    mine: OfferClaimOut | None = None


class OffersUpsertOut(BaseModel):
    created: int
    updated: int
    notified: int
    offers: list[OfferOut]


class ChannelDraftIn(BaseModel):
    plan_date: date
    agent_key: str = Field(min_length=1, max_length=64)
    agent_name: str = Field("", max_length=255)
    channels: list[DayChannelIn] = Field(min_length=1)
    #: The day plan's version the plan was made from; publishing skips it if it changed since.
    base_version: int
    summary: str = Field("", max_length=500)


class ChannelDraftsIn(BaseModel):
    """Replace every draft in [start, end] with these (a fresh auto-plan)."""

    start: date
    end: date
    items: list[ChannelDraftIn] = Field(max_length=10_000)


class ChannelDraftOut(BaseModel):
    plan_date: date
    agent_key: str
    agent_name: str
    channels: list
    base_version: int
    summary: str


class ChannelRangeIn(BaseModel):
    start: date
    end: date


class ChannelPublishOut(BaseModel):
    applied: int  # agent-days whose channels were changed
    #: Drafts skipped because the day was edited after it was planned.
    stale: list[DaySkipped]
    published_days: int  # agent-days that were drafts and are now published too
    notified: int


class MyScheduleOut(BaseModel):
    #: Roster ids linked to the signed-in user's employee record.
    agent_keys: list[str]
    days: list[DayPlanOut]


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


# ------------------------------------------------- country labour law

class LabourBreakRule(BaseModel):
    afterHours: float = Field(gt=0, le=24)
    minBreakMinutes: int = Field(gt=0, le=24 * 60)
    continuous: bool = False


class LabourLawOverrides(BaseModel):
    """Values that replace the country preset (state rules, awards, agreements).
    Unset = use the statute; explicit null = "no limit"."""

    model_config = ConfigDict(extra="forbid")
    standardDailyHours: float | None = Field(None, ge=0, le=24)
    maxDailyHours: float | None = Field(None, ge=0, le=24)
    maxDailyOtHours: float | None = Field(None, ge=0, le=24)
    maxSpreadHours: float | None = Field(None, ge=0, le=24)
    maxContinuousWorkHours: float | None = Field(None, ge=0, le=24)
    minBreakBlockMinutes: int | None = Field(None, ge=0, le=24 * 60)
    breakRules: list[LabourBreakRule] | None = None
    standardWeeklyHours: float | None = Field(None, ge=0, le=168)
    maxWeeklyHours: float | None = Field(None, ge=0, le=168)
    minDailyRestHours: float | None = Field(None, ge=0, le=24)


class LabourLawPolicyIn(BaseModel):
    country_code: str | None = Field(None, max_length=8)
    overrides: LabourLawOverrides = LabourLawOverrides()


class LabourLawPolicyOut(BaseModel):
    country_code: str | None
    overrides: dict
    #: 0 = nothing saved for this organisation yet.
    version: int
    #: Preset with overrides applied (null when no country is selected).
    effective: dict | None
    disclaimer: str


class AgentComplianceOut(BaseModel):
    agent_key: str
    agent_name: str
    worked_minutes: int
    compliant: bool
    issues: list[dict]


class DayComplianceOut(BaseModel):
    country_code: str | None
    law: dict | None
    disclaimer: str
    agents: list[AgentComplianceOut]


# ------------------------------------------- workspace settings (shared config)

_HHMM = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
WeekOffMode = Literal["fixed", "rotating"]


class _Loose(BaseModel):
    """Extra fields are kept (the app may add some), known ones are checked."""

    model_config = ConfigDict(extra="allow")


class BreakStepIn(_Loose):
    type: Literal["break", "lunch"]
    minutes: int = Field(ge=5, le=240)


class WorkRuleIn(_Loose):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    shiftMinutes: int = Field(ge=60, le=16 * 60)
    breaks: list[BreakStepIn] = []
    weekOff: list[int] = []
    weekOffMode: WeekOffMode | None = None
    defaultStart: str = _HHMM


class PatternBreakIn(_Loose):
    id: str
    type: Literal["break", "lunch"]
    label: str = ""
    offsetMinutes: int = Field(ge=0, le=24 * 60)
    durationMinutes: int = Field(ge=1, le=240)


class ShiftPatternIn(_Loose):
    id: str = Field(min_length=1, max_length=96)
    name: str = Field(min_length=1, max_length=160)
    start: str = _HHMM
    end: str = _HHMM
    breaks: list[PatternBreakIn] = []


class AgentRuleIn(_Loose):
    #: Shift pattern (a work rule's pattern is "wr:<rule id>@HH:MM").
    shiftPatternId: str | None = None
    weekOff: list[int] | None = None
    weekOffMode: WeekOffMode | None = None


class WorkComplianceIn(_Loose):
    breakRequiredAfterHours: float | None = None
    maxContinuousWorkHours: float | None = None
    lunchRequiredAfterHours: float | None = None
    minLunchMinutes: int = 30
    maxConsecutiveWorkDays: int | None = None
    minDaysOffPerWeek: int | None = None
    maxWeeklyHours: float | None = None
    minRestBetweenShiftsHours: float | None = None


class SettingIn(BaseModel):
    value: dict | list
    #: The version this change is based on; a mismatch is rejected with 409.
    base_version: int | None = None


class SettingOut(BaseModel):
    key: str
    value: dict | list
    version: int
    updated_at: datetime
    updated_by: str
