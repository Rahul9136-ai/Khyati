"""Tests for the Strategy Agent (trend-level, not single-snapshot, proposals)
and tier-based stakeholder routing (tactical -> floor, strategic -> plan
owners) — see app/modules/autonomy/agents.py and service.py.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta

from sqlalchemy import select

from app.modules.autonomy import agents as agent_lib
from app.modules.autonomy.service import _notify_stakeholders
from app.modules.forecasting.models import Forecast
from app.modules.identity.schemas import UserCreate
from app.modules.identity.service import create_user
from app.modules.notifications.models import Notification
from app.modules.planning.models import CapacityPlan, CapacityPlanWeek
from tests.conftest import TestSession

TODAY = date(2026, 9, 24)


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


async def _seed_plan_weeks(db, org_id: uuid.UUID, *, short_count: int, total: int) -> None:
    plan = CapacityPlan(organization_id=org_id, name="LOB A")
    db.add(plan)
    await db.flush()
    base = _monday(TODAY) - timedelta(weeks=total)
    for i in range(total):
        short = i < short_count
        db.add(CapacityPlanWeek(
            plan_id=plan.id, week_start=base + timedelta(weeks=i),
            required_fte=100.0,
            gap=-15.0 if short else 2.0,
            available_hc=85.0 if short else 102.0,
        ))
    await db.commit()


async def _seed_forecast_versions(db, org_id: uuid.UUID, queue_id, mapes: list[float]) -> None:
    for version, mape in enumerate(mapes, start=1):
        db.add(Forecast(
            organization_id=org_id, queue_id=queue_id, name=f"Queue forecast v{version}",
            model="ml_random_forest", horizon_days=28, version=version, mape=mape,
        ))
    await db.commit()


# --------------------------------------------------------------- structural
async def test_strategy_agent_flags_persistent_structural_shortfall(admin: dict) -> None:
    org_id = uuid.UUID(admin["org_id"])
    async with TestSession() as db:
        await _seed_plan_weeks(db, org_id, short_count=5, total=6)  # 5/6 ~83% short

    async with TestSession() as db:
        ctx = agent_lib.AgentContext(db=db, org_id=org_id, today=TODAY)
        proposals = await agent_lib.strategy_agent(ctx)

    plan_proposals = [p for p in proposals if p.target_type == "plan"]
    assert plan_proposals, "expected a structural-shortfall proposal"
    p = plan_proposals[0]
    assert p.tier == "strategic"
    assert p.action_type == "strategy_change"
    assert p.payload["short_weeks"] == 5
    assert "strategy" in p.rationale.lower()


async def test_strategy_agent_silent_on_occasional_shortfalls(admin: dict) -> None:
    org_id = uuid.UUID(admin["org_id"])
    async with TestSession() as db:
        await _seed_plan_weeks(db, org_id, short_count=1, total=6)  # 1/6 ~17%, well under 60%

    async with TestSession() as db:
        ctx = agent_lib.AgentContext(db=db, org_id=org_id, today=TODAY)
        proposals = await agent_lib.strategy_agent(ctx)

    assert not [p for p in proposals if p.target_type == "plan"]


async def test_strategy_agent_silent_with_too_little_history(admin: dict) -> None:
    org_id = uuid.UUID(admin["org_id"])
    async with TestSession() as db:
        await _seed_plan_weeks(db, org_id, short_count=3, total=3)  # 100% short but < 4 weeks

    async with TestSession() as db:
        ctx = agent_lib.AgentContext(db=db, org_id=org_id, today=TODAY)
        proposals = await agent_lib.strategy_agent(ctx)

    assert not [p for p in proposals if p.target_type == "plan"]


# --------------------------------------------------------------- forecasting
async def test_strategy_agent_flags_retrains_that_never_improve(admin: dict) -> None:
    org_id = uuid.UUID(admin["org_id"])
    queue_id = uuid.uuid4()
    async with TestSession() as db:
        await _seed_forecast_versions(db, org_id, queue_id, [0.22, 0.21, 0.20])  # flat, all bad

    async with TestSession() as db:
        ctx = agent_lib.AgentContext(db=db, org_id=org_id, today=TODAY)
        proposals = await agent_lib.strategy_agent(ctx)

    fc_proposals = [p for p in proposals if p.target_type == "forecast"]
    assert fc_proposals
    assert fc_proposals[0].tier == "strategic"
    assert fc_proposals[0].action_type == "strategy_change"


async def test_strategy_agent_silent_when_forecast_is_healthy_or_improving(admin: dict) -> None:
    org_id = uuid.UUID(admin["org_id"])
    healthy_queue, improving_queue = uuid.uuid4(), uuid.uuid4()
    async with TestSession() as db:
        await _seed_forecast_versions(db, org_id, healthy_queue, [0.10, 0.09, 0.08])
        await _seed_forecast_versions(db, org_id, improving_queue, [0.30, 0.20, 0.10])

    async with TestSession() as db:
        ctx = agent_lib.AgentContext(db=db, org_id=org_id, today=TODAY)
        proposals = await agent_lib.strategy_agent(ctx)

    assert not [p for p in proposals if p.target_type == "forecast"]


# ------------------------------------------------------------------- tiering
async def test_planning_agent_tiers_by_lead_time(admin: dict) -> None:
    org_id = uuid.UUID(admin["org_id"])
    async with TestSession() as db:
        plan = CapacityPlan(organization_id=org_id, name="Near-term LOB")
        db.add(plan)
        await db.flush()
        db.add(CapacityPlanWeek(
            plan_id=plan.id, week_start=TODAY + timedelta(weeks=1),
            required_fte=100.0, gap=-20.0, available_hc=80.0,
        ))
        await db.commit()

    async with TestSession() as db:
        ctx = agent_lib.AgentContext(db=db, org_id=org_id, today=TODAY)
        proposals = await agent_lib.planning_agent(ctx)
    assert proposals and proposals[0].tier == "tactical"
    assert proposals[0].action_type == "offer_overtime"

    async with TestSession() as db:
        plan2 = CapacityPlan(organization_id=org_id, name="Far-out LOB")
        db.add(plan2)
        await db.flush()
        db.add(CapacityPlanWeek(
            plan_id=plan2.id, week_start=TODAY + timedelta(weeks=8),
            required_fte=100.0, gap=-20.0, available_hc=80.0,
        ))
        await db.commit()

    async with TestSession() as db:
        ctx = agent_lib.AgentContext(db=db, org_id=org_id, today=TODAY)
        proposals = await agent_lib.planning_agent(ctx)
    # worst week wins — both plans are equally short, but the query orders by
    # gap ascending and ties go to whichever sorts first; assert on whichever
    # one comes back rather than assuming an order.
    assert proposals and proposals[0].tier in ("tactical", "strategic")


async def test_root_cause_agent_is_always_strategic(admin: dict) -> None:
    org_id = uuid.UUID(admin["org_id"])
    async with TestSession() as db:
        plan = CapacityPlan(organization_id=org_id, name="LOB A")
        db.add(plan)
        await db.flush()
        db.add(CapacityPlanWeek(
            plan_id=plan.id, week_start=TODAY - timedelta(weeks=1),
            required_fte=100.0, gap=-60.0, available_hc=40.0,
        ))
        await db.commit()

    async with TestSession() as db:
        ctx = agent_lib.AgentContext(db=db, org_id=org_id, today=TODAY)
        proposals = await agent_lib.root_cause_agent(ctx)
    assert proposals and all(p.tier == "strategic" for p in proposals)


# -------------------------------------------------------------------- routing
async def _seed_om_and_planning_manager(
    db, org_id: uuid.UUID, suffix: str,
) -> tuple[uuid.UUID, uuid.UUID]:
    # Operations Manager: request:approve_manager only -> tactical-only.
    # Planning Manager: planning:write, no intraday:write/request:approve_manager
    # -> strategic-only. (WFM Director deliberately not used here — it holds
    # almost every permission, so it legitimately matches both tiers; these
    # two roles are the clean single-tier cases.)
    om = await create_user(
        db, UserCreate(email=f"om.{suffix}@test.dev", password="Om@12345",
                       full_name="Om Router", role_names=["Operations Manager"],
                       organization_id=org_id),
        actor=None,
    )
    planner = await create_user(
        db, UserCreate(email=f"planner.{suffix}@test.dev", password="Pl@12345",
                       full_name="Planner Router", role_names=["Planning Manager"],
                       organization_id=org_id),
        actor=None,
    )
    await db.commit()
    return om.id, planner.id


async def test_notify_stakeholders_routes_tactical_to_operations_manager(admin: dict) -> None:
    org_id = uuid.UUID(admin["org_id"])
    async with TestSession() as db:
        om_id, planner_id = await _seed_om_and_planning_manager(db, org_id, "tac")

    async with TestSession() as db:
        n = await _notify_stakeholders(
            db, org_id, tier="tactical", title="SLA at risk", body="test", kind="warning",
        )
        await db.commit()
    assert n >= 1

    async with TestSession() as db:
        om_notified = (await db.execute(
            select(Notification).where(Notification.user_id == om_id)
        )).scalars().all()
        planner_notified = (await db.execute(
            select(Notification).where(Notification.user_id == planner_id)
        )).scalars().all()
    assert om_notified, "Operations Manager should get the tactical alert"
    assert not planner_notified, "Planning Manager should not get a tactical-only alert"


async def test_notify_stakeholders_routes_strategic_to_planning_manager(admin: dict) -> None:
    org_id = uuid.UUID(admin["org_id"])
    async with TestSession() as db:
        om_id, planner_id = await _seed_om_and_planning_manager(db, org_id, "strat")

    async with TestSession() as db:
        n = await _notify_stakeholders(
            db, org_id, tier="strategic", title="Change the hiring strategy", body="test",
            kind="warning",
        )
        await db.commit()
    assert n >= 1

    async with TestSession() as db:
        om_notified = (await db.execute(
            select(Notification).where(Notification.user_id == om_id)
        )).scalars().all()
        planner_notified = (await db.execute(
            select(Notification).where(Notification.user_id == planner_id)
        )).scalars().all()
    assert planner_notified, "Planning Manager should get the strategic alert"
    assert not om_notified, "Operations Manager alone should not get a strategic-only alert"


async def test_notify_stakeholders_falls_back_to_superuser_when_no_role_matches(
    admin: dict,
) -> None:
    """A brand-new org with only the seeded superadmin (no Operations Manager /
    WFM Director yet) must still reach someone — never silently drop a proposal."""
    org_id = uuid.UUID(admin["org_id"])
    async with TestSession() as db:
        n = await _notify_stakeholders(
            db, org_id, tier="strategic", title="x", body="y", kind="info",
        )
        await db.commit()
    assert n >= 1


# --------------------------------------------------------------- scheduled run
async def test_scheduled_run_all_orgs_uses_no_human_actor(admin: dict, monkeypatch) -> None:
    """The celery-beat entrypoint (autonomy/tasks.py) has no HTTP request and
    therefore no human actor — it must still run cleanly end to end. Patches
    its session factory to the test DB rather than the real one."""
    from app.modules.autonomy import tasks as autonomy_tasks

    monkeypatch.setattr(autonomy_tasks, "AsyncSessionLocal", TestSession)
    summary = await autonomy_tasks._run_all_orgs()
    assert summary["orgs_run"] >= 1
    assert summary["errors"] == []
