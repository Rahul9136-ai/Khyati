"""Autonomy orchestration: run agents, govern application, manage the policy.

The orchestrator runs every enabled agent, persists each decision, and — under
an org's autonomy policy — either applies a high-confidence action immediately
or leaves it pending human approval. Applying an action executes a real effect
(e.g. the Forecast Agent's retrain generates a new forecast version) and always
records an audit-log entry and manager notifications.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.autonomy import agents as agent_lib
from app.modules.autonomy.models import (
    STATUS_APPLIED,
    STATUS_AUTO_APPLIED,
    STATUS_PENDING,
    STATUS_REJECTED,
    AgentAction,
    AutonomyPolicy,
)
from app.modules.autonomy.schemas import AgentInfo, PolicyUpdate
from app.modules.identity.models import User
from app.modules.identity.service import record_audit
from app.modules.notifications.service import notify_user

_LEVELS = {"manual", "assisted", "autonomous"}


# ------------------------------------------------------------------- policy
async def get_or_create_policy(db: AsyncSession, org_id: uuid.UUID) -> AutonomyPolicy:
    policy = (
        await db.execute(select(AutonomyPolicy).where(AutonomyPolicy.organization_id == org_id))
    ).scalar_one_or_none()
    if policy is None:
        policy = AutonomyPolicy(organization_id=org_id, agent_config={})
        db.add(policy)
        await db.flush()
    return policy


def _agent_state(policy: AutonomyPolicy) -> dict[str, dict[str, bool]]:
    """Merge per-agent defaults with any policy overrides."""
    config = policy.agent_config or {}
    state: dict[str, dict[str, bool]] = {}
    for spec in agent_lib.AGENT_SPECS:
        override = config.get(spec.key, {})
        state[spec.key] = {
            "enabled": bool(override.get("enabled", True)),
            "auto_apply": bool(override.get("auto_apply", spec.default_auto_apply)),
        }
    return state


def list_agents(policy: AutonomyPolicy) -> list[AgentInfo]:
    state = _agent_state(policy)
    return [
        AgentInfo(
            key=spec.key,
            label=spec.label,
            description=spec.description,
            enabled=state[spec.key]["enabled"],
            auto_apply=state[spec.key]["auto_apply"],
        )
        for spec in agent_lib.AGENT_SPECS
    ]


async def update_policy(
    db: AsyncSession, org_id: uuid.UUID, actor: User, update: PolicyUpdate
) -> AutonomyPolicy:
    policy = await get_or_create_policy(db, org_id)
    before = {
        "autonomy_level": policy.autonomy_level,
        "auto_apply_threshold": policy.auto_apply_threshold,
    }
    if update.autonomy_level is not None:
        if update.autonomy_level not in _LEVELS:
            raise ValidationError(f"autonomy_level must be one of {sorted(_LEVELS)}")
        policy.autonomy_level = update.autonomy_level
    if update.auto_apply_threshold is not None:
        policy.auto_apply_threshold = update.auto_apply_threshold
    if update.agent_config is not None:
        merged = dict(policy.agent_config or {})
        for key, cfg in update.agent_config.items():
            if key not in agent_lib.AGENTS_BY_KEY:
                raise ValidationError(f"Unknown agent '{key}'")
            merged[key] = {**merged.get(key, {}), **cfg}
        policy.agent_config = merged
    await db.flush()
    await record_audit(
        db, actor=actor, action="autonomy.policy_update", entity_type="autonomy_policy",
        entity_id=policy.id, before=before,
        after={"autonomy_level": policy.autonomy_level,
               "auto_apply_threshold": policy.auto_apply_threshold},
    )
    return policy


# --------------------------------------------------------------- orchestrator
async def run_orchestrator(
    db: AsyncSession,
    org_id: uuid.UUID,
    actor: User,
    *,
    dry_run: bool = False,
    only: list[str] | None = None,
) -> dict:
    """Evaluate agents and dispose of their proposals per the autonomy policy."""
    policy = await get_or_create_policy(db, org_id)
    state = _agent_state(policy)
    run_id = uuid.uuid4()
    today = datetime.now(UTC).date()
    ctx = agent_lib.AgentContext(db=db, org_id=org_id, today=today)

    actions: list[AgentAction] = []
    auto_applied = pending = 0
    for spec in agent_lib.AGENT_SPECS:
        if only and spec.key not in only:
            continue
        if not state[spec.key]["enabled"]:
            continue
        for proposal in await spec.fn(ctx):
            action = _build_action(org_id, run_id, proposal)
            auto = (
                policy.autonomy_level == "autonomous"
                and state[spec.key]["auto_apply"]
                and proposal.confidence >= policy.auto_apply_threshold
            )
            if dry_run:
                action.id = uuid.uuid4()
                action.created_at = datetime.now(UTC)
                action.status = STATUS_AUTO_APPLIED if auto else STATUS_PENDING
            else:
                db.add(action)
                await db.flush()
                if auto:
                    note = await apply_action(db, action, actor)
                    _mark_applied(action, actor, STATUS_AUTO_APPLIED, note)
            if auto:
                auto_applied += 1
            else:
                pending += 1
            actions.append(action)

    if not dry_run and actions:
        await record_audit(
            db, actor=actor, action="autonomy.run", entity_type="autonomy_run",
            entity_id=run_id,
            after={"proposed": len(actions), "auto_applied": auto_applied,
                   "pending": pending, "level": policy.autonomy_level},
        )
    return {
        "run_id": run_id,
        "dry_run": dry_run,
        "autonomy_level": policy.autonomy_level,
        "auto_apply_threshold": policy.auto_apply_threshold,
        "proposed": len(actions),
        "auto_applied": auto_applied,
        "pending_review": pending,
        "actions": actions,
    }


def _build_action(
    org_id: uuid.UUID, run_id: uuid.UUID, proposal: agent_lib.Proposal
) -> AgentAction:
    return AgentAction(
        organization_id=org_id,
        run_id=run_id,
        agent=proposal.agent,
        action_type=proposal.action_type,
        title=proposal.title,
        rationale=proposal.rationale,
        confidence=proposal.confidence,
        severity=proposal.severity,
        status=STATUS_PENDING,
        target_type=proposal.target_type,
        target_id=proposal.target_id,
        target_label=proposal.target_label,
        payload=proposal.payload,
    )


def _mark_applied(action: AgentAction, actor: User, status: str, note: str) -> None:
    now = datetime.now(UTC)
    action.status = status
    action.applied_at = now
    action.result_note = note
    if status == STATUS_APPLIED:
        action.decided_by = actor.id
        action.decided_at = now


# --------------------------------------------------------------- application
async def apply_action(db: AsyncSession, action: AgentAction, actor: User) -> str:
    """Execute the real-world effect of an action; returns a result note."""
    if action.action_type == "retrain_forecast":
        return await _apply_retrain(db, action, actor)
    return await _apply_advisory(db, action, actor)


async def _apply_retrain(db: AsyncSession, action: AgentAction, actor: User) -> str:
    from app.modules.forecasting.schemas import ForecastRequest
    from app.modules.forecasting.service import run_forecast

    series_id = action.payload.get("series_id")
    if not series_id:
        await _notify_leaders(
            db, action.organization_id,
            title="Forecast Agent: manual retrain needed",
            body=action.rationale, kind="warning",
        )
        return "No source series linked — flagged to planners for a manual retrain."
    forecast = await run_forecast(
        db, action.organization_id,
        ForecastRequest(
            series_id=uuid.UUID(str(series_id)),
            model="auto",
            horizon_days=int(action.payload.get("horizon_days") or 28),
            parent_id=uuid.UUID(str(action.payload["forecast_id"]))
            if action.payload.get("forecast_id") else None,
        ),
        actor=actor,
    )
    mape = f"{forecast.mape:.1%}" if forecast.mape is not None else "n/a"
    note = (
        f"Retrained → new version v{forecast.version} using {forecast.model} "
        f"(backtest MAPE {mape}). Pending approval before it goes live."
    )
    action.payload = {**action.payload, "new_forecast_id": str(forecast.id),
                      "new_model": forecast.model, "new_mape": forecast.mape}
    await _notify_leaders(
        db, action.organization_id,
        title="Forecast Agent retrained a drifting forecast", body=note, kind="success",
    )
    return note


async def _apply_advisory(db: AsyncSession, action: AgentAction, actor: User) -> str:
    n = await _notify_leaders(
        db, action.organization_id,
        title=f"[{action.agent}] {action.title}",
        body=action.rationale,
        kind="warning" if action.severity in ("warning", "critical") else "info",
    )
    return f"Dispatched to {n} manager(s) for action."


async def _notify_leaders(
    db: AsyncSession, org_id: uuid.UUID, *, title: str, body: str, kind: str
) -> int:
    """Notify org superusers/admins. Avoids lazy role traversal on purpose."""
    users = (
        await db.execute(
            select(User).where(
                User.organization_id == org_id,
                User.is_superuser.is_(True),
                User.is_active.is_(True),
            )
        )
    ).scalars()
    count = 0
    for user in users:
        await notify_user(db, org_id, user.id, title=title, body=body, kind=kind)
        count += 1
    return count


# --------------------------------------------------------------- action queue
async def list_actions(
    db: AsyncSession,
    org_id: uuid.UUID,
    *,
    status: str | None = None,
    agent: str | None = None,
    limit: int = 100,
) -> list[AgentAction]:
    query = select(AgentAction).where(AgentAction.organization_id == org_id)
    if status:
        query = query.where(AgentAction.status == status)
    if agent:
        query = query.where(AgentAction.agent == agent)
    rows = await db.execute(query.order_by(AgentAction.created_at.desc()).limit(limit))
    return list(rows.scalars())


async def _get_action(db: AsyncSession, org_id: uuid.UUID, action_id: uuid.UUID) -> AgentAction:
    action = await db.get(AgentAction, action_id)
    if action is None or action.organization_id != org_id:
        raise NotFoundError("Agent action not found")
    return action


async def approve_action(
    db: AsyncSession, org_id: uuid.UUID, actor: User, action_id: uuid.UUID, note: str | None
) -> AgentAction:
    action = await _get_action(db, org_id, action_id)
    if action.status != STATUS_PENDING:
        raise ValidationError(f"Action is already {action.status}")
    result = await apply_action(db, action, actor)
    _mark_applied(action, actor, STATUS_APPLIED, note or result)
    await record_audit(
        db, actor=actor, action="autonomy.approve", entity_type="agent_action",
        entity_id=action.id, after={"result": action.result_note},
    )
    return action


async def reject_action(
    db: AsyncSession, org_id: uuid.UUID, actor: User, action_id: uuid.UUID, note: str | None
) -> AgentAction:
    action = await _get_action(db, org_id, action_id)
    if action.status != STATUS_PENDING:
        raise ValidationError(f"Action is already {action.status}")
    now = datetime.now(UTC)
    action.status = STATUS_REJECTED
    action.decided_by = actor.id
    action.decided_at = now
    action.result_note = note or "Rejected by operator."
    await record_audit(
        db, actor=actor, action="autonomy.reject", entity_type="agent_action",
        entity_id=action.id, note=note,
    )
    return action
