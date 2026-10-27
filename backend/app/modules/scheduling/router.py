"""Scheduling endpoints: /scheduling/templates, /scheduling/schedules."""
from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response

from app.api.deps import DbSession, require_permission
from app.modules.identity.models import User
from app.modules.scheduling import (
    channel_drafts,
    dayplan_service,
    labour_law,
    offers,
    service,
    settings_service,
)
from app.modules.scheduling.models import ShiftTemplate
from app.modules.scheduling.schemas import (
    ChannelDraftOut,
    ChannelDraftsIn,
    ChannelPublishOut,
    ChannelRangeIn,
    DayAddOvertimeIn,
    DayApplyEditIn,
    DayComplianceOut,
    DayCoverageSlot,
    DayFillIn,
    DayFillOut,
    DayMarkAuxIn,
    DayMoveIn,
    DayOpResult,
    DayPlanBulkIn,
    DayPlanOut,
    DayPlanSummaryOut,
    DayPublishIn,
    DayPublishOut,
    DayResizeShiftIn,
    DaySkipped,
    DayUnmarkIn,
    GenerateScheduleRequest,
    LabourLawPolicyIn,
    LabourLawPolicyOut,
    MyScheduleOut,
    OfferClaimIn,
    OfferOut,
    OfferPatchIn,
    OffersUpsertIn,
    OffersUpsertOut,
    ScheduleDetailOut,
    ScheduleOut,
    SettingIn,
    SettingOut,
    ShiftIn,
    ShiftOut,
    ShiftTemplateIn,
    ShiftTemplateOut,
    ShiftUpdate,
    ValidationOut,
)
from app.modules.workforce.service import (
    create_entity,
    delete_entity,
    list_entities,
    org_scope,
    update_entity,
)
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/scheduling", tags=["scheduling"])

Reader = Annotated[User, Depends(require_permission("schedule:read"))]
Writer = Annotated[User, Depends(require_permission("schedule:write"))]
Publisher = Annotated[User, Depends(require_permission("schedule:publish"))]


# ---------------------------------------------------------------- templates

@router.get("/templates", response_model=ApiResponse[list[ShiftTemplateOut]])
async def list_templates(db: DbSession, user: Reader):
    rows = await list_entities(db, ShiftTemplate, org_scope(user))
    return ApiResponse(data=[ShiftTemplateOut.model_validate(t) for t in rows])


@router.post("/templates", response_model=ApiResponse[ShiftTemplateOut], status_code=201)
async def create_template(body: ShiftTemplateIn, db: DbSession, actor: Writer):
    obj = await create_entity(
        db, ShiftTemplate, org_scope(actor), body.model_dump(),
        actor=actor, entity_name="shift_template",
    )
    return ApiResponse(data=ShiftTemplateOut.model_validate(obj))


@router.patch("/templates/{template_id}", response_model=ApiResponse[ShiftTemplateOut])
async def update_template(
    template_id: uuid.UUID, body: ShiftTemplateIn, db: DbSession, actor: Writer
):
    obj = await update_entity(
        db, ShiftTemplate, template_id, body.model_dump(),
        actor=actor, entity_name="shift_template",
    )
    return ApiResponse(data=ShiftTemplateOut.model_validate(obj))


@router.delete("/templates/{template_id}", response_model=ApiResponse[dict])
async def delete_template(template_id: uuid.UUID, db: DbSession, actor: Writer):
    await delete_entity(db, ShiftTemplate, template_id, actor=actor,
                        entity_name="shift_template")
    return ApiResponse(data={"detail": "Template deleted"})


# ---------------------------------------------------------------- schedules

@router.post("/schedules/generate", response_model=ApiResponse[ScheduleDetailOut],
             status_code=201)
async def generate_schedule(body: GenerateScheduleRequest, db: DbSession, actor: Writer):
    schedule = await service.generate_schedule(db, org_scope(actor), body, actor=actor)
    return ApiResponse(data=ScheduleDetailOut.model_validate(schedule))


@router.get("/schedules", response_model=ApiResponse[list[ScheduleOut]])
async def list_schedules(
    db: DbSession, user: Reader, team_id: uuid.UUID | None = None, status: str | None = None
):
    rows = await service.list_schedules(db, org_scope(user), team_id=team_id, status=status)
    return ApiResponse(data=[ScheduleOut.model_validate(s) for s in rows])


@router.get("/schedules/{schedule_id}", response_model=ApiResponse[ScheduleDetailOut])
async def get_schedule(schedule_id: uuid.UUID, db: DbSession, user: Reader):
    schedule = await service.get_schedule(db, schedule_id)
    return ApiResponse(data=ScheduleDetailOut.model_validate(schedule))


@router.get("/schedules/{schedule_id}/validate", response_model=ApiResponse[ValidationOut])
async def validate_schedule(schedule_id: uuid.UUID, db: DbSession, user: Reader):
    schedule = await service.get_schedule(db, schedule_id)
    return ApiResponse(data=service.validate_schedule(schedule))


@router.post("/schedules/{schedule_id}/publish", response_model=ApiResponse[ScheduleOut])
async def publish_schedule(schedule_id: uuid.UUID, db: DbSession, actor: Publisher):
    schedule = await service.publish_schedule(db, schedule_id, actor=actor)
    return ApiResponse(data=ScheduleOut.model_validate(schedule))


@router.post("/schedules/{schedule_id}/shifts", response_model=ApiResponse[ShiftOut],
             status_code=201)
async def add_shift(schedule_id: uuid.UUID, body: ShiftIn, db: DbSession, actor: Writer):
    shift = await service.add_shift(db, schedule_id, body, actor=actor)
    return ApiResponse(data=ShiftOut.model_validate(shift))


@router.patch("/shifts/{shift_id}", response_model=ApiResponse[ShiftOut])
async def update_shift(shift_id: uuid.UUID, body: ShiftUpdate, db: DbSession, actor: Writer):
    shift = await service.update_shift(db, shift_id, body, actor=actor)
    return ApiResponse(data=ShiftOut.model_validate(shift))


@router.delete("/shifts/{shift_id}", response_model=ApiResponse[dict])
async def delete_shift(shift_id: uuid.UUID, db: DbSession, actor: Writer):
    await service.delete_shift(db, shift_id, actor=actor)
    return ApiResponse(data={"detail": "Shift deleted"})


# --------------------------------------------- omni-channel day plans (timeline)
# The Scheduling timeline's server copy: one row per agent per date with the
# shift, breaks/lunch, Phone/Chat/Email blocks, OT and overlay activities.


def _result(saved, skipped) -> ApiResponse[DayOpResult]:
    return ApiResponse(data=DayOpResult(
        saved=[DayPlanOut.model_validate(r) for r in saved],
        skipped=[DaySkipped(**s) for s in skipped],
    ))


@router.get("/day-plans", response_model=ApiResponse[list[DayPlanSummaryOut]])
async def list_day_plan_range(
    db: DbSession, user: Reader,
    start: date | None = None, end: date | None = None,
    agent_keys: Annotated[list[str] | None, Query()] = None,
):
    """Every saved agent-day in a date range (default: the next 3 months) as
    one-line summaries — the multi-week overview. Drafts are hidden from
    users who can't edit schedules; agents only get their own days."""
    lo, hi = dayplan_service.default_horizon()
    rows = await dayplan_service.list_range(db, org_scope(user), start or lo, end or hi, agent_keys)
    rows = dayplan_service.visible(rows, user)
    return ApiResponse(data=[DayPlanSummaryOut(**dayplan_service.summary(r)) for r in rows])


@router.get("/day-plans/range", response_model=ApiResponse[list[DayPlanOut]])
async def list_day_plan_range_full(
    db: DbSession, user: Reader, start: date, end: date,
    agent_keys: Annotated[list[str] | None, Query()] = None,
):
    """Full day plans (breaks, channel blocks, OT, activities) for a date range —
    what the channel auto-planner works from. Same visibility as one day."""
    rows = await dayplan_service.list_range(db, org_scope(user), start, end, agent_keys)
    rows = dayplan_service.visible(rows, user)
    return ApiResponse(data=[DayPlanOut.model_validate(r) for r in rows])


@router.post("/day-plans/fill", response_model=ApiResponse[DayFillOut])
async def fill_day_plans(body: DayFillIn, db: DbSession, actor: Writer):
    """Create schedules for agent-days that have none saved (e.g. pattern
    defaults for dates nobody has opened yet). Existing days are untouched."""
    return ApiResponse(data=DayFillOut(**await dayplan_service.fill_missing(
        db, org_scope(actor), body, actor=actor
    )))


@router.post("/day-plans/publish", response_model=ApiResponse[DayPublishOut])
async def publish_day_plans(body: DayPublishIn, db: DbSession, actor: Publisher):
    """Publish the saved schedules in a date range: agents and their team
    leaders can see them and get a notification. Later changes to published
    days are visible straight away and notify them again."""
    org = org_scope(actor)
    return ApiResponse(data=DayPublishOut(**await dayplan_service.publish(
        db, org, body, actor=actor
    )))


@router.get("/my-schedule", response_model=ApiResponse[MyScheduleOut])
async def my_schedule(
    db: DbSession, user: Reader, start: date | None = None, end: date | None = None
):
    """The signed-in agent's published days (default: the next 3 months)."""
    lo, hi = dayplan_service.default_horizon()
    keys, rows = await dayplan_service.my_schedule(db, user, start or lo, end or hi)
    return ApiResponse(data=MyScheduleOut(
        agent_keys=keys, days=[DayPlanOut.model_validate(r) for r in rows]
    ))


@router.get("/agent-schedule/{agent_key}", response_model=ApiResponse[list[DayPlanOut]])
async def agent_schedule(
    agent_key: str, db: DbSession, user: Reader,
    start: date | None = None, end: date | None = None,
):
    """One agent's published days, exactly as that agent sees them."""
    lo, hi = dayplan_service.default_horizon()
    rows = await dayplan_service.agent_schedule(
        db, org_scope(user), user, agent_key, start or lo, end or hi
    )
    return ApiResponse(data=[DayPlanOut.model_validate(r) for r in rows])


@router.get("/day-plans/{plan_date}", response_model=ApiResponse[list[DayPlanOut]])
async def list_day_plans(
    plan_date: date, db: DbSession, user: Reader,
    agent_keys: Annotated[list[str] | None, Query()] = None,
):
    rows = await dayplan_service.list_day_plans(db, org_scope(user), plan_date, agent_keys)
    rows = dayplan_service.visible(rows, user)
    return ApiResponse(data=[DayPlanOut.model_validate(r) for r in rows])


@router.put("/day-plans/{plan_date}", response_model=ApiResponse[list[DayPlanOut]])
async def save_day_plans(plan_date: date, body: DayPlanBulkIn, db: DbSession, actor: Writer):
    """Upsert many agents' days at once (all-or-nothing, same rules as the UI)."""
    rows = await dayplan_service.save_day_plans(db, org_scope(actor), plan_date, body, actor=actor)
    return ApiResponse(data=[DayPlanOut.model_validate(r) for r in rows])


@router.delete("/day-plans/{plan_date}/{agent_key}", response_model=ApiResponse[dict])
async def reset_day_plan(plan_date: date, agent_key: str, db: DbSession, actor: Writer):
    await dayplan_service.reset_day_plan(db, org_scope(actor), plan_date, agent_key, actor=actor)
    return ApiResponse(data={"detail": "Day plan reset to default"})


@router.post("/day-plans/{plan_date}/edit", response_model=ApiResponse[DayOpResult])
async def edit_day_plan(plan_date: date, body: DayApplyEditIn, db: DbSession, actor: Writer):
    """Move/resize a break, activity, channel or OT block, or a shift edge —
    optionally on every follower's matching block too (bulk drag)."""
    org = org_scope(actor)
    return _result(*await dayplan_service.apply_edit(db, org, plan_date, body, actor=actor))


@router.post("/day-plans/{plan_date}/move", response_model=ApiResponse[DayOpResult])
async def move_day_plans(plan_date: date, body: DayMoveIn, db: DbSession, actor: Writer):
    """Move whole schedules earlier/later (Ctrl+←/→ in the UI)."""
    return _result(*await dayplan_service.move(db, org_scope(actor), plan_date, body, actor=actor))


@router.post("/day-plans/{plan_date}/resize-shift", response_model=ApiResponse[DayOpResult])
async def resize_day_plan_shifts(
    plan_date: date, body: DayResizeShiftIn, db: DbSession, actor: Writer
):
    org = org_scope(actor)
    return _result(*await dayplan_service.resize_shift(db, org, plan_date, body, actor=actor))


@router.post("/day-plans/{plan_date}/mark-aux", response_model=ApiResponse[DayOpResult])
async def mark_aux(plan_date: date, body: DayMarkAuxIn, db: DbSession, actor: Writer):
    """Mark any AUX (break, lunch, meeting, training, coaching, LOA, absence,
    other) on many agents, optionally staggered in waves."""
    org = org_scope(actor)
    return _result(*await dayplan_service.mark_aux(db, org, plan_date, body, actor=actor))


@router.post("/day-plans/{plan_date}/unmark", response_model=ApiResponse[DayOpResult])
async def unmark_activities(plan_date: date, body: DayUnmarkIn, db: DbSession, actor: Writer):
    org = org_scope(actor)
    return _result(*await dayplan_service.unmark(db, org, plan_date, body, actor=actor))


@router.post("/day-plans/{plan_date}/overtime", response_model=ApiResponse[DayOpResult])
async def add_overtime(plan_date: date, body: DayAddOvertimeIn, db: DbSession, actor: Writer):
    """Add OT on a channel (after / before shift, or set times) for many agents."""
    org = org_scope(actor)
    return _result(*await dayplan_service.add_overtime(db, org, plan_date, body, actor=actor))


@router.get("/day-plans/{plan_date}/coverage", response_model=ApiResponse[list[DayCoverageSlot]])
async def day_plan_coverage(plan_date: date, db: DbSession, user: Reader):
    rows = await dayplan_service.list_day_plans(db, org_scope(user), plan_date)
    rows = dayplan_service.visible(rows, user)
    return ApiResponse(data=[DayCoverageSlot(**s) for s in dayplan_service.coverage(rows)])


@router.get("/day-plans/{plan_date}/export")
async def export_day_plans(
    plan_date: date, db: DbSession, user: Reader,
    format: Literal["json", "csv"] = "json",
    agent_keys: Annotated[list[str] | None, Query()] = None,
):
    """Same five sheets as the UI export (segments, agent summary, 15-min grid,
    channel coverage, legend) as JSON or a sectioned CSV."""
    org = org_scope(user)
    rows = dayplan_service.visible(
        await dayplan_service.list_day_plans(db, org, plan_date, agent_keys), user
    )
    # Labour-law compliance sheets are included when the organisation has a country set.
    law = await dayplan_service.org_law(db, org)
    if format == "csv":
        filename = f"schedules-{plan_date.isoformat()}.csv"
        return Response(
            dayplan_service.export_csv(rows, law), media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    return ApiResponse(data=dayplan_service.export_sheets(rows, law))


@router.get(
    "/day-plans/{plan_date}/compliance", response_model=ApiResponse[DayComplianceOut]
)
async def day_plan_compliance(
    plan_date: date, db: DbSession, user: Reader, country: str | None = None
):
    """Check every agent's day against the organisation's labour law (or a
    `country` preset). Daily rules only; warnings, nothing is blocked."""
    org = org_scope(user)
    law = await dayplan_service.org_law(db, org, country)
    rows = dayplan_service.visible(await dayplan_service.list_day_plans(db, org, plan_date), user)
    return ApiResponse(data=DayComplianceOut(**dayplan_service.compliance(rows, law)))


# ------------------------------------------- VTO / PTO / OT / Leave slots


async def _offer_view(db, user: User, offer) -> OfferOut:
    keys = None if dayplan_service.sees_everyone(user) else (
        await dayplan_service.user_agent_keys(db, user)
    )
    return OfferOut(**offers.offer_out(offer, keys))


@router.get("/offers", response_model=ApiResponse[list[OfferOut]])
async def list_offers(
    db: DbSession, user: Reader, start: date | None = None, end: date | None = None
):
    """Open slots with filled / left counts (default: the next 3 months).
    Agents see the slots they can take and their own claims."""
    lo, hi = dayplan_service.default_horizon()
    rows = await offers.list_offers(db, org_scope(user), user, start or lo, end or hi)
    return ApiResponse(data=[OfferOut(**r) for r in rows])


@router.post("/offers", response_model=ApiResponse[OffersUpsertOut])
async def open_offers(body: OffersUpsertIn, db: DbSession, actor: Writer):
    """Open VTO / PTO / OT / Leave slots (or update ones already open for the
    same date, queue, kind and times) and tell eligible agents."""
    res = await offers.upsert_offers(db, org_scope(actor), body, actor=actor)
    return ApiResponse(data=OffersUpsertOut(
        created=res["created"], updated=res["updated"], notified=res["notified"],
        offers=[OfferOut(**o) for o in res["offers"]],
    ))


@router.patch("/offers/{offer_id}", response_model=ApiResponse[OfferOut])
async def update_offer(offer_id: uuid.UUID, body: OfferPatchIn, db: DbSession, actor: Writer):
    """Change a slot's capacity (not below what's taken) or close / reopen it."""
    offer = await offers.patch_offer(db, org_scope(actor), offer_id, body, actor=actor)
    return ApiResponse(data=OfferOut(**offers.offer_out(offer)))


@router.delete("/offers/{offer_id}", response_model=ApiResponse[dict])
async def delete_offer(offer_id: uuid.UUID, db: DbSession, actor: Writer):
    await offers.delete_offer(db, org_scope(actor), offer_id, actor=actor)
    return ApiResponse(data={"detail": "Slot removed"})


@router.post("/offers/{offer_id}/claim", response_model=ApiResponse[OfferOut])
async def claim_offer(offer_id: uuid.UUID, body: OfferClaimIn, db: DbSession, user: Reader):
    """Take a slot (first come, first served). It's written into the agent's
    schedule straight away: VTO / PTO / Leave as time off, OT as an OT block."""
    offer = await offers.claim(db, org_scope(user), offer_id, body, user=user)
    return ApiResponse(data=await _offer_view(db, user, offer))


@router.post("/offers/claims/{claim_id}/cancel", response_model=ApiResponse[OfferOut])
async def cancel_offer_claim(claim_id: uuid.UUID, db: DbSession, user: Reader):
    """Give a slot back (agents: their own, for today or later) — it's taken
    back out of the schedule and the slot reopens."""
    offer = await offers.cancel_claim(db, org_scope(user), claim_id, user=user)
    return ApiResponse(data=await _offer_view(db, user, offer))


# ------------------------------------- auto-planned Phone/Chat/Email (drafts)


@router.get("/channel-drafts", response_model=ApiResponse[list[ChannelDraftOut]])
async def list_channel_drafts(db: DbSession, actor: Writer, start: date, end: date):
    """Unpublished auto-planned channel changes — schedulers only."""
    rows = await channel_drafts.list_drafts(db, org_scope(actor), start, end)
    return ApiResponse(data=[ChannelDraftOut.model_validate(r, from_attributes=True) for r in rows])


@router.put("/channel-drafts", response_model=ApiResponse[list[ChannelDraftOut]])
async def save_channel_drafts(body: ChannelDraftsIn, db: DbSession, actor: Writer):
    """Save a fresh auto-plan for a date range (replaces earlier drafts there).
    Nothing changes for agents until it's published."""
    rows = await channel_drafts.replace_drafts(db, org_scope(actor), body, actor=actor)
    return ApiResponse(data=[ChannelDraftOut.model_validate(r, from_attributes=True) for r in rows])


@router.post("/channel-drafts/discard", response_model=ApiResponse[dict])
async def discard_channel_drafts(body: ChannelRangeIn, db: DbSession, actor: Writer):
    n = await channel_drafts.discard(db, org_scope(actor), body, actor=actor)
    return ApiResponse(data={"discarded": n})


@router.post("/channel-drafts/publish", response_model=ApiResponse[ChannelPublishOut])
async def publish_channel_drafts(body: ChannelRangeIn, db: DbSession, actor: Publisher):
    """Write the drafts into the schedules and publish those days: agents and
    their team leaders see the new channels and get a pop-up."""
    res = await channel_drafts.publish(db, org_scope(actor), body, actor=actor)
    return ApiResponse(data=ChannelPublishOut(
        applied=res["applied"], stale=[DaySkipped(**s) for s in res["stale"]],
        published_days=res["published_days"], notified=res["notified"],
    ))


# ------------------------------------------------- shared settings (config)


@router.get("/settings", response_model=ApiResponse[list[SettingOut]])
async def list_settings(db: DbSession, user: Reader):
    """Work rules, compliance limits, shift patterns and agents' rules / week
    offs saved for the organisation (keys that were never saved are absent)."""
    rows = await settings_service.list_settings(db, org_scope(user))
    return ApiResponse(data=[SettingOut.model_validate(r, from_attributes=True) for r in rows])


@router.get("/settings/{key}", response_model=ApiResponse[SettingOut])
async def get_setting(key: str, db: DbSession, user: Reader):
    row = await settings_service.get_setting(db, org_scope(user), key)
    return ApiResponse(data=SettingOut.model_validate(row, from_attributes=True))


@router.put("/settings/{key}", response_model=ApiResponse[SettingOut])
async def put_setting(key: str, body: SettingIn, db: DbSession, actor: Writer):
    """Save one setting (work_rules, work_compliance, shift_patterns or
    agent_rules). Pass the `base_version` you read to avoid overwriting a newer
    change (409). Every browser and connected tool picks it up."""
    row = await settings_service.put_setting(
        db, org_scope(actor), key, body.value, body.base_version, actor=actor
    )
    return ApiResponse(data=SettingOut.model_validate(row, from_attributes=True))


# ------------------------------------------------------------ country labour law


@router.get("/labour-laws", response_model=ApiResponse[dict])
async def list_labour_laws(user: Reader):
    """Country presets (simplified statutory baselines — see `disclaimer`)."""
    return ApiResponse(data={"disclaimer": labour_law.disclaimer(), "laws": labour_law.presets()})


@router.get("/labour-law", response_model=ApiResponse[LabourLawPolicyOut])
async def get_labour_law(db: DbSession, user: Reader):
    policy = await dayplan_service.get_policy(db, org_scope(user))
    return ApiResponse(data=LabourLawPolicyOut(**dayplan_service.policy_out(policy)))


@router.put("/labour-law", response_model=ApiResponse[LabourLawPolicyOut])
async def set_labour_law(body: LabourLawPolicyIn, db: DbSession, actor: Writer):
    """Select the organisation's country (its preset applies automatically) and
    optionally override individual values."""
    policy = await dayplan_service.set_policy(db, org_scope(actor), body, actor=actor)
    return ApiResponse(data=LabourLawPolicyOut(**dayplan_service.policy_out(policy)))
