"""HC planning services: config, demand, agent profiles, and the capacity
computation that binds the persisted inputs to the pure engine."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.modules.hcplanning.engine import seasonality
from app.modules.hcplanning.engine.agents import AgentRecord
from app.modules.hcplanning.engine.capacity import build_capacity_table
from app.modules.hcplanning.engine.config import DEFAULT_TENURE_BANDS, PlanningConfig, TenureBand
from app.modules.hcplanning.engine.dates import add_months, months_between
from app.modules.hcplanning.engine.newhire import (
    HiringBatch,
    pipeline,
    production_by_month,
)
from app.modules.hcplanning.models import (
    AgentPlanningProfile,
    HcDemand,
    HcPlanningConfig,
    HcPromotion,
    NewHireBatch,
)
from app.modules.hcplanning.schemas import (
    ConfigIn,
    DemandIn,
    ProfileIn,
    PromotionIn,
    PromotionUpdate,
)
from app.modules.workforce.models import Employee, Lob


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
async def _config_row(
    db: AsyncSession, org_id: uuid.UUID, lob_id: uuid.UUID | None
) -> HcPlanningConfig | None:
    return (
        await db.execute(
            select(HcPlanningConfig).where(
                HcPlanningConfig.organization_id == org_id,
                HcPlanningConfig.lob_id == lob_id,
            )
        )
    ).scalar_one_or_none()


async def get_config_row(
    db: AsyncSession, org_id: uuid.UUID, lob_id: uuid.UUID | None
) -> HcPlanningConfig:
    """LOB-specific config if present, else the org default, else a created default."""
    row = await _config_row(db, org_id, lob_id)
    if row is None and lob_id is not None:
        row = await _config_row(db, org_id, None)
    if row is None:
        row = HcPlanningConfig(organization_id=org_id, lob_id=None)
        db.add(row)
        await db.flush()
    return row


async def upsert_config(
    db: AsyncSession, org_id: uuid.UUID, payload: ConfigIn
) -> HcPlanningConfig:
    row = await _config_row(db, org_id, payload.lob_id)
    if row is None:
        row = HcPlanningConfig(organization_id=org_id, lob_id=payload.lob_id)
        db.add(row)
    data = payload.model_dump(exclude_unset=True, exclude={"lob_id"})
    if "tenure_bands" in data and data["tenure_bands"] is not None:
        data["tenure_bands"] = [b if isinstance(b, dict) else b.model_dump()
                                for b in data["tenure_bands"]]
    for k, v in data.items():
        if v is not None:
            setattr(row, k, v)
    await db.flush()
    return row


def to_engine_config(row: HcPlanningConfig) -> PlanningConfig:
    bands = (
        tuple(TenureBand(bucket=b["bucket"], months_to=b.get("months_to"),
                         label=b.get("label", "")) for b in row.tenure_bands)
        if row.tenure_bands else DEFAULT_TENURE_BANDS
    )
    ov = row.monthly_overrides or {}
    return PlanningConfig(
        ooo_shrinkage=row.ooo_shrinkage, io_shrinkage=row.io_shrinkage,
        attrition=row.attrition, weekly_hours=row.weekly_hours,
        hiring_throughput=row.hiring_throughput, training_throughput=row.training_throughput,
        training_days=row.training_days, nesting_days=row.nesting_days,
        actuals_through=row.actuals_through, tenure_bands=bands,
        ooo_by_month=ov.get("ooo", {}), io_by_month=ov.get("io", {}),
        attrition_by_month=ov.get("attrition", {}),
    )


# --------------------------------------------------------------------------- #
# New hire batches
# --------------------------------------------------------------------------- #
async def list_batches(
    db: AsyncSession, org_id: uuid.UUID, lob_id: uuid.UUID | None
) -> list[NewHireBatch]:
    rows = await db.execute(
        select(NewHireBatch).where(
            NewHireBatch.organization_id == org_id, NewHireBatch.lob_id == lob_id
        ).order_by(NewHireBatch.hire_date)
    )
    return list(rows.scalars())


async def create_batch(db: AsyncSession, org_id: uuid.UUID, data) -> NewHireBatch:
    row = NewHireBatch(organization_id=org_id, **data.model_dump(exclude_unset=True))
    db.add(row)
    await db.flush()
    return row


async def update_batch(
    db: AsyncSession, org_id: uuid.UUID, batch_id: uuid.UUID, data
) -> NewHireBatch:
    row = await db.get(NewHireBatch, batch_id)
    if row is None or row.organization_id != org_id:
        raise NotFoundError("Batch not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(row, k, v)
    await db.flush()
    return row


async def delete_batch(db: AsyncSession, org_id: uuid.UUID, batch_id: uuid.UUID) -> None:
    row = await db.get(NewHireBatch, batch_id)
    if row is None or row.organization_id != org_id:
        raise NotFoundError("Batch not found")
    await db.delete(row)


def _to_hiring_batches(rows: list[NewHireBatch]) -> list[HiringBatch]:
    return [
        HiringBatch(
            hire_date=r.hire_date, planned_hires=r.planned_hires,
            hiring_throughput=r.hiring_throughput, training_throughput=r.training_throughput,
            training_days=r.training_days, nesting_days=r.nesting_days,
            label=r.note,
        )
        for r in rows
    ]


async def newhire_pipeline(
    db: AsyncSession, org_id: uuid.UUID, lob_id: uuid.UUID | None
) -> list:
    rows = await list_batches(db, org_id, lob_id)
    cfg_row = await get_config_row(db, org_id, lob_id)
    return pipeline(
        _to_hiring_batches(rows),
        hiring_throughput=cfg_row.hiring_throughput,
        training_throughput=cfg_row.training_throughput,
        training_days=cfg_row.training_days, nesting_days=cfg_row.nesting_days,
    )


# --------------------------------------------------------------------------- #
# Demand
# --------------------------------------------------------------------------- #
async def list_demand(
    db: AsyncSession, org_id: uuid.UUID, lob_id: uuid.UUID | None
) -> list[HcDemand]:
    rows = await db.execute(
        select(HcDemand).where(
            HcDemand.organization_id == org_id, HcDemand.lob_id == lob_id
        ).order_by(HcDemand.month)
    )
    return list(rows.scalars())


async def upsert_demand(
    db: AsyncSession, org_id: uuid.UUID, lob_id: uuid.UUID | None, items: list[DemandIn]
) -> list[HcDemand]:
    existing = {r.month: r for r in await list_demand(db, org_id, lob_id)}
    out = []
    for item in items:
        row = existing.get(item.month)
        if row is None:
            row = HcDemand(organization_id=org_id, lob_id=lob_id, month=item.month)
            db.add(row)
        row.billable_fte = item.billable_fte
        out.append(row)
    await db.flush()
    return out


# --------------------------------------------------------------------------- #
# Agent profiles → engine records
# --------------------------------------------------------------------------- #
async def upsert_profile(
    db: AsyncSession, org_id: uuid.UUID, employee_id: uuid.UUID, payload: ProfileIn
) -> AgentPlanningProfile:
    emp = await db.get(Employee, employee_id)
    if emp is None or emp.organization_id != org_id:
        raise NotFoundError("Employee not found")
    row = (
        await db.execute(
            select(AgentPlanningProfile).where(
                AgentPlanningProfile.employee_id == employee_id
            )
        )
    ).scalar_one_or_none()
    if row is None:
        row = AgentPlanningProfile(organization_id=org_id, employee_id=employee_id)
        db.add(row)
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(row, k, v)
    await db.flush()
    return row


async def list_agents(
    db: AsyncSession, org_id: uuid.UUID, lob_id: uuid.UUID
) -> list[dict]:
    """Agents in the LOB (or planned to move in) with their planning profile —
    the source for the Agent Movement view."""
    rows = await db.execute(
        select(Employee, AgentPlanningProfile)
        .join(AgentPlanningProfile,
              AgentPlanningProfile.employee_id == Employee.id, isouter=True)
        .where(
            Employee.organization_id == org_id,
            Employee.deleted_at.is_(None),
            (Employee.lob_id == lob_id) | (AgentPlanningProfile.target_lob_id == lob_id),
        )
        .order_by(Employee.first_name)
    )
    out = []
    for emp, profile in rows.all():
        out.append({
            "employee_id": emp.id, "name": emp.full_name, "lob_id": emp.lob_id,
            "location": emp.location or None,
            "planning_status": (profile.planning_status if profile else None) or "FTE",
            "dop": (profile.dop if profile else None) or emp.hire_date,
            "experience_type": (profile.experience_type if profile else None),
            "move_out_date": (profile.move_out_date if profile else None),
            "move_in_date": (profile.move_in_date if profile else None),
            "target_lob_id": (profile.target_lob_id if profile else None),
        })
    return out


async def build_agent_records(
    db: AsyncSession, org_id: uuid.UUID, lob_id: uuid.UUID
) -> list[AgentRecord]:
    """Employees in the LOB (or planned to move into it) as engine records."""
    rows = await db.execute(
        select(Employee, AgentPlanningProfile)
        .join(
            AgentPlanningProfile,
            AgentPlanningProfile.employee_id == Employee.id,
            isouter=True,
        )
        .where(
            Employee.organization_id == org_id,
            Employee.deleted_at.is_(None),
            (Employee.lob_id == lob_id)
            | (AgentPlanningProfile.target_lob_id == lob_id),
        )
    )
    records: list[AgentRecord] = []
    for emp, profile in rows.all():
        records.append(AgentRecord(
            status=(profile.planning_status if profile else None) or "FTE",
            lob=str(emp.lob_id) if emp.lob_id else "",
            location=emp.location or None,
            experience=(profile.experience_type if profile else None),
            dop=(profile.dop if profile else None) or emp.hire_date,
            inactive=emp.termination_date,
            move_out=(profile.move_out_date if profile else None),
            move_in=(profile.move_in_date if profile else None),
            target_lob=(str(profile.target_lob_id)
                        if profile and profile.target_lob_id else None),
            name=emp.full_name,
        ))
    return records


# --------------------------------------------------------------------------- #
# Capacity computation
# --------------------------------------------------------------------------- #
async def compute_capacity(
    db: AsyncSession,
    org_id: uuid.UUID,
    lob_id: uuid.UUID,
    *,
    from_month: str | None = None,
    to_month: str | None = None,
) -> dict:
    lob = await db.get(Lob, lob_id)
    if lob is None or lob.organization_id != org_id:
        raise NotFoundError("LOB not found")

    demand_rows = await list_demand(db, org_id, lob_id)
    demand = {r.month: r.billable_fte for r in demand_rows}
    # `locked` rows are last year's actuals kept only as the seasonality
    # suggestion engine's history (see engine/seasonality.py) — they must
    # never silently extend the live plan's default window.
    live_months = [r.month for r in demand_rows if not r.locked]

    if from_month and to_month:
        months = months_between(from_month, to_month)
    elif live_months:
        months = months_between(min(live_months), max(live_months))
    else:
        return {"lob": lob, "months": [], "results": [], "config_row": None, "agents": 0}

    cfg_row = await get_config_row(db, org_id, lob_id)
    cfg = to_engine_config(cfg_row)
    agents = await build_agent_records(db, org_id, lob_id)

    batch_rows = await list_batches(db, org_id, lob_id)
    newhire_prod = production_by_month(
        _to_hiring_batches(batch_rows),
        hiring_throughput=cfg_row.hiring_throughput,
        training_throughput=cfg_row.training_throughput,
        training_days=cfg_row.training_days, nesting_days=cfg_row.nesting_days,
    )

    billable = {m: demand.get(m, 0.0) for m in months}
    closing_overrides = {
        m: v for m, v in (cfg_row.closing_overrides or {}).items() if m in months
    }
    table = build_capacity_table(
        agents, str(lob_id), months, billable, cfg,
        newhire_production_by_month=newhire_prod,
        closing_overrides=closing_overrides,
    )
    return {
        "lob": lob, "months": months, "results": table.results,
        "config_row": cfg_row, "agents": len(agents),
    }


def default_month_window(anchor: str, past: int = 0, ahead: int = 13) -> tuple[str, str]:
    return add_months(anchor, -past), add_months(anchor, ahead)


# --------------------------------------------------------------------------- #
# Scenario planning (baseline vs what-if; the baseline is never mutated)
# --------------------------------------------------------------------------- #
async def compute_scenario(
    db: AsyncSession,
    org_id: uuid.UUID,
    lob_id: uuid.UUID,
    *,
    from_month: str | None = None,
    to_month: str | None = None,
    overrides: dict,
) -> dict:
    from datetime import date

    baseline = await compute_capacity(
        db, org_id, lob_id, from_month=from_month, to_month=to_month
    )
    months = baseline["months"]
    if not months:
        return {"baseline": baseline, "scenario": baseline}

    cfg_row = await get_config_row(db, org_id, lob_id)
    cfg = to_engine_config(cfg_row)  # fresh instance — safe to mutate
    for key in ("ooo_shrinkage", "io_shrinkage", "attrition",
                "hiring_throughput", "training_throughput"):
        if overrides.get(key) is not None:
            setattr(cfg, key, overrides[key])
    cfg.validate()

    agents = await build_agent_records(db, org_id, lob_id)
    demand = {r.month: r.billable_fte for r in await list_demand(db, org_id, lob_id)}
    mult = 1 + (overrides.get("demand_pct") or 0) / 100.0
    billable = {m: demand.get(m, 0.0) * mult for m in months}

    batches = _to_hiring_batches(await list_batches(db, org_id, lob_id))
    for eh in overrides.get("extra_hires") or []:
        batches.append(HiringBatch(
            hire_date=date.fromisoformat(eh["hire_date"]),
            planned_hires=float(eh["count"]),
        ))
    newhire = production_by_month(
        batches, hiring_throughput=cfg.hiring_throughput,
        training_throughput=cfg.training_throughput,
        training_days=cfg.training_days, nesting_days=cfg.nesting_days,
    )
    closing_overrides = {
        m: v for m, v in (cfg_row.closing_overrides or {}).items() if m in months
    }
    table = build_capacity_table(
        agents, str(lob_id), months, billable, cfg,
        newhire_production_by_month=newhire, closing_overrides=closing_overrides,
    )
    scenario = {
        "lob": baseline["lob"], "months": months, "results": table.results,
        "config_row": cfg_row, "agents": len(agents),
    }
    return {"baseline": baseline, "scenario": scenario}


# --------------------------------------------------------------------------- #
# Promotions (fixed/recurring business events feeding the demand suggestion)
# --------------------------------------------------------------------------- #
async def list_promotions(
    db: AsyncSession, org_id: uuid.UUID, lob_id: uuid.UUID | None
) -> list[HcPromotion]:
    """LOB-specific promotions plus org-wide ones (``lob_id`` NULL) — both apply
    to that LOB."""
    rows = await db.execute(
        select(HcPromotion).where(
            HcPromotion.organization_id == org_id,
            (HcPromotion.lob_id == lob_id) | (HcPromotion.lob_id.is_(None)),
        ).order_by(HcPromotion.month_from)
    )
    return list(rows.scalars())


async def create_promotion(db: AsyncSession, org_id: uuid.UUID, data: PromotionIn) -> HcPromotion:
    row = HcPromotion(organization_id=org_id, **data.model_dump(exclude_unset=True))
    db.add(row)
    await db.flush()
    return row


async def update_promotion(
    db: AsyncSession, org_id: uuid.UUID, promotion_id: uuid.UUID, data: PromotionUpdate
) -> HcPromotion:
    row = await db.get(HcPromotion, promotion_id)
    if row is None or row.organization_id != org_id:
        raise NotFoundError("Promotion not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(row, k, v)
    await db.flush()
    return row


async def delete_promotion(db: AsyncSession, org_id: uuid.UUID, promotion_id: uuid.UUID) -> None:
    row = await db.get(HcPromotion, promotion_id)
    if row is None or row.organization_id != org_id:
        raise NotFoundError("Promotion not found")
    await db.delete(row)


# --------------------------------------------------------------------------- #
# Seasonality suggestions (last year's actuals + promotions -> next-year plan)
# --------------------------------------------------------------------------- #
def _to_promotion_windows(rows: list[HcPromotion]) -> list[seasonality.PromotionWindow]:
    return [
        seasonality.PromotionWindow(
            name=r.name, month_from=r.month_from, month_to=r.month_to,
            demand_impact_pct=r.demand_impact_pct, recurring=r.recurring,
        )
        for r in rows
    ]


async def compute_seasonality(
    db: AsyncSession, org_id: uuid.UUID, lob_id: uuid.UUID, *,
    from_month: str | None = None, to_month: str | None = None,
) -> dict:
    """Suggested demand + assumptions for each editable month in the window,
    derived from last year's actuals (``HcDemand``/``historical_assumptions``
    rows marked historical) and known promotions. Review-only — nothing is
    written until `apply_seasonality` is called."""
    demand_rows = await list_demand(db, org_id, lob_id)
    demand = {r.month: r.billable_fte for r in demand_rows}
    editable_months = [r.month for r in demand_rows if not r.locked]

    if from_month and to_month:
        months = months_between(from_month, to_month)
    elif editable_months:
        months = months_between(min(editable_months), max(editable_months))
    else:
        months = []

    cfg_row = await get_config_row(db, org_id, lob_id)
    promos = _to_promotion_windows(await list_promotions(db, org_id, lob_id))
    hist = cfg_row.historical_assumptions or {}

    out = []
    for month in months:
        demand_suggestion = seasonality.suggest_demand(
            demand, month, cfg_row.yoy_growth_pct, promos
        )
        assumption_suggestions = {
            key: seasonality.suggest_assumption(hist.get(key, {}), month)
            for key in ("ooo", "io", "attrition")
        }
        out.append({
            "month": month,
            "current_demand": demand.get(month),
            "demand_suggestion": demand_suggestion,
            "assumption_suggestions": assumption_suggestions,
        })
    return {"months": out, "yoy_growth_pct": cfg_row.yoy_growth_pct}


async def apply_seasonality(
    db: AsyncSession, org_id: uuid.UUID, lob_id: uuid.UUID, *,
    months: list[str], apply_demand: bool, apply_assumptions: bool,
) -> dict:
    """Write the accepted suggestions through the same paths a human edit
    would use — ``upsert_demand`` for demand, ``monthly_overrides`` for
    assumptions — so nothing downstream needs to know these came from the
    seasonality engine rather than a planner typing them in."""
    if not months:
        return {"applied_demand_months": 0, "applied_assumption_values": 0}
    result = await compute_seasonality(
        db, org_id, lob_id, from_month=min(months), to_month=max(months)
    )
    by_month = {m["month"]: m for m in result["months"] if m["month"] in months}

    applied_demand = 0
    if apply_demand:
        items = [
            DemandIn(lob_id=lob_id, month=month,
                     billable_fte=round(m["demand_suggestion"]["suggested"]))
            for month, m in by_month.items()
            if m["demand_suggestion"]["suggested"] is not None
        ]
        if items:
            await upsert_demand(db, org_id, lob_id, items)
            applied_demand = len(items)

    applied_assumptions = 0
    if apply_assumptions:
        cfg_row = await get_config_row(db, org_id, lob_id)
        overrides = {k: dict(v) for k, v in (cfg_row.monthly_overrides or {}).items()}
        for key in ("ooo", "io", "attrition"):
            overrides.setdefault(key, {})
        for month, m in by_month.items():
            for key in ("ooo", "io", "attrition"):
                suggested = m["assumption_suggestions"][key]["suggested"]
                if suggested is not None:
                    overrides[key][month] = suggested
                    applied_assumptions += 1
        cfg_row.monthly_overrides = overrides
        await db.flush()

    return {
        "applied_demand_months": applied_demand,
        "applied_assumption_values": applied_assumptions,
    }
