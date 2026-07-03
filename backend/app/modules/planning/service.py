"""Planning services: capacity-plan computation and CRUD.

Weekly FTE model:
  workload_hours   = volume * AHT / 3600 / concurrency
  productive_hours = weekly_hours * (1 - shrinkage) * occupancy   (per FTE)
  required_fte     = workload_hours / productive_hours * (1 + buffer)
Headcount rolls forward week over week:
  available_i = available_{i-1} * (1 - attrition_weekly) + new_hires_i - planned_attrition_i
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import NotFoundError
from app.modules.identity.models import User
from app.modules.identity.service import record_audit
from app.modules.planning.models import CapacityPlan, CapacityPlanWeek
from app.modules.planning.schemas import (
    Assumptions,
    PlanCreate,
    PlanUpdate,
    PlanWeekIn,
    PlanWeekOut,
)


def compute_weeks(
    weeks: list[PlanWeekIn], assumptions: Assumptions, starting_headcount: float
) -> list[PlanWeekOut]:
    productive = (
        assumptions.weekly_hours * (1 - assumptions.shrinkage) * assumptions.occupancy
    )
    available = starting_headcount
    out: list[PlanWeekOut] = []
    for i, week in enumerate(sorted(weeks, key=lambda w: w.week_start)):
        aht = week.aht_override or assumptions.aht_seconds
        workload = week.volume * aht / 3600 / assumptions.concurrency
        required = (workload / productive) * (1 + assumptions.buffer_pct) if productive else 0
        if i > 0:
            available *= 1 - assumptions.attrition_weekly_pct
        available += week.new_hires - (week.planned_attrition or 0)
        available = max(0.0, available)
        out.append(
            PlanWeekOut(
                week_start=week.week_start,
                volume=week.volume,
                aht_override=week.aht_override,
                new_hires=week.new_hires,
                planned_attrition=week.planned_attrition,
                workload_hours=round(workload, 1),
                required_fte=round(required, 2),
                available_hc=round(available, 2),
                gap=round(available - required, 2),
                notes=week.notes,
            )
        )
    return out


def _week_rows(plan_id: uuid.UUID | None, computed: list[PlanWeekOut]) -> list[CapacityPlanWeek]:
    return [
        CapacityPlanWeek(
            **({"plan_id": plan_id} if plan_id else {}),
            week_start=w.week_start,
            volume=w.volume,
            aht_override=w.aht_override,
            new_hires=w.new_hires,
            planned_attrition=w.planned_attrition,
            workload_hours=w.workload_hours,
            required_fte=w.required_fte,
            available_hc=w.available_hc,
            gap=w.gap,
            notes=w.notes,
        )
        for w in computed
    ]


async def create_plan(
    db: AsyncSession, org_id: uuid.UUID, payload: PlanCreate, *, actor: User
) -> CapacityPlan:
    computed = compute_weeks(payload.weeks, payload.assumptions, payload.starting_headcount)
    plan = CapacityPlan(
        organization_id=org_id,
        name=payload.name,
        queue_id=payload.queue_id,
        lob_id=payload.lob_id,
        starting_headcount=payload.starting_headcount,
        assumptions=payload.assumptions.model_dump(),
        created_by=actor.id,
        weeks=_week_rows(None, computed),
    )
    db.add(plan)
    await db.flush()
    await record_audit(
        db, actor=actor, action="plan.create", entity_type="capacity_plan", entity_id=plan.id,
        after={"name": plan.name, "weeks": len(computed)},
    )
    return plan


async def get_plan(db: AsyncSession, plan_id: uuid.UUID) -> CapacityPlan:
    plan = await db.get(CapacityPlan, plan_id, options=[selectinload(CapacityPlan.weeks)])
    if plan is None:
        raise NotFoundError("Capacity plan not found")
    return plan


async def list_plans(db: AsyncSession, org_id: uuid.UUID) -> list[CapacityPlan]:
    rows = await db.execute(
        select(CapacityPlan)
        .where(CapacityPlan.organization_id == org_id)
        .order_by(CapacityPlan.created_at.desc())
    )
    return list(rows.scalars())


async def update_plan(
    db: AsyncSession, plan_id: uuid.UUID, payload: PlanUpdate, *, actor: User
) -> CapacityPlan:
    plan = await get_plan(db, plan_id)
    if payload.name is not None:
        plan.name = payload.name
    if payload.status is not None:
        plan.status = payload.status
    if payload.starting_headcount is not None:
        plan.starting_headcount = payload.starting_headcount
    if payload.assumptions is not None:
        plan.assumptions = payload.assumptions.model_dump()

    weeks_in = payload.weeks
    if weeks_in is None and (
        payload.assumptions is not None or payload.starting_headcount is not None
    ):
        # recompute existing weeks under the new assumptions
        weeks_in = [
            PlanWeekIn(
                week_start=w.week_start, volume=w.volume, aht_override=w.aht_override,
                new_hires=w.new_hires, planned_attrition=w.planned_attrition, notes=w.notes,
            )
            for w in plan.weeks
        ]
    if weeks_in is not None:
        computed = compute_weeks(
            weeks_in, Assumptions(**plan.assumptions), plan.starting_headcount
        )
        plan.weeks = _week_rows(None, computed)
    await record_audit(
        db, actor=actor, action="plan.update", entity_type="capacity_plan", entity_id=plan.id,
        after=payload.model_dump(exclude_unset=True, mode="json"),
    )
    return plan


async def what_if(
    db: AsyncSession, plan_id: uuid.UUID, overrides: Assumptions
) -> list[PlanWeekOut]:
    """Recompute a plan under alternative assumptions without persisting."""
    plan = await get_plan(db, plan_id)
    weeks_in = [
        PlanWeekIn(
            week_start=w.week_start, volume=w.volume, aht_override=w.aht_override,
            new_hires=w.new_hires, planned_attrition=w.planned_attrition, notes=w.notes,
        )
        for w in plan.weeks
    ]
    return compute_weeks(weeks_in, overrides, plan.starting_headcount)
