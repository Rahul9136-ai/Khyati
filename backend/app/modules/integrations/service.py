"""Approval-bridge services.

Real-time (intraday) and scheduling raise an `ApprovalRequest`; it is dispatched
to Slack/Teams (and always recorded in-app) and routed to the *respective
Operations Manager*. The OM approves/rejects in Slack/Teams or in-app; on
approval the change is applied to the live plan. Every step is written to the
approval's timeline and the global audit trail.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import NotFoundError, PermissionDeniedError, ValidationError
from app.modules.identity.models import Role, User, user_roles
from app.modules.identity.service import record_audit
from app.modules.integrations.adapters import SlackAdapter, TeamsAdapter, kind_label
from app.modules.integrations.models import (
    CHANNELS,
    KINDS,
    SOURCES,
    ApprovalEvent,
    ApprovalRequest,
    IntegrationConfig,
)
from app.modules.integrations.schemas import ApprovalCreate, IntegrationConfigIn
from app.modules.notifications.service import notify_employees, notify_user
from app.modules.scheduling.models import ScheduleShift
from app.modules.workforce.models import Employee

# OM sign-off reuses the existing "operations manager" approval permission.
OM_APPROVE_PERMISSION = "request:approve_manager"
OM_ROLE_NAME = "Operations Manager"
APPROVAL_TTL_HOURS = 24


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
async def get_or_create_config(db: AsyncSession, org_id: uuid.UUID) -> IntegrationConfig:
    row = (
        await db.execute(
            select(IntegrationConfig).where(IntegrationConfig.organization_id == org_id)
        )
    ).scalar_one_or_none()
    if row is None:
        row = IntegrationConfig(organization_id=org_id)
        db.add(row)
        await db.flush()
    return row


async def update_config(
    db: AsyncSession, org_id: uuid.UUID, payload: IntegrationConfigIn, *, actor: User
) -> IntegrationConfig:
    config = await get_or_create_config(db, org_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(config, field, value)
    await db.flush()
    await record_audit(
        db, actor=actor, action="integration.config_update",
        entity_type="integration_config", entity_id=config.id,
        after={"slack_enabled": config.slack_enabled, "teams_enabled": config.teams_enabled},
    )
    return config


# --------------------------------------------------------------------------- #
# OM routing
# --------------------------------------------------------------------------- #
async def resolve_om(
    db: AsyncSession,
    org_id: uuid.UUID,
    *,
    preferred_id: uuid.UUID | None = None,
    config: IntegrationConfig | None = None,
) -> User | None:
    """Find the Operations Manager who should approve.

    Preference order: an explicitly supplied OM → the org's configured default
    approver → the first active user holding the Operations Manager role.
    """
    if preferred_id:
        user = await db.get(User, preferred_id)
        if user and user.organization_id == org_id and user.is_active:
            return user
    if config and config.default_approver_id:
        user = await db.get(User, config.default_approver_id)
        if user and user.organization_id == org_id and user.is_active:
            return user
    rows = await db.execute(
        select(User)
        .join(user_roles, user_roles.c.user_id == User.id)
        .join(Role, Role.id == user_roles.c.role_id)
        .where(
            User.organization_id == org_id,
            User.is_active.is_(True),
            Role.name == OM_ROLE_NAME,
        )
        .limit(1)
    )
    return rows.scalars().first()


def _actor_is_om(user: User) -> bool:
    return user.is_superuser or OM_APPROVE_PERMISSION in user.permission_codes


# --------------------------------------------------------------------------- #
# Create + dispatch
# --------------------------------------------------------------------------- #
def _log_event(
    db: AsyncSession, approval: ApprovalRequest, type_: str, *,
    channel: str | None = None, actor_email: str = "", detail: str = "",
) -> None:
    """Append a timeline entry.

    We add the row by FK rather than via ``approval.events.append`` so we never
    trigger a lazy load of the collection in a sync serialization context.
    """
    db.add(
        ApprovalEvent(
            approval_id=approval.id, type=type_, channel=channel,
            actor_email=actor_email, detail=detail,
        )
    )


async def create_approval(
    db: AsyncSession, org_id: uuid.UUID, payload: ApprovalCreate, *, actor: User
) -> ApprovalRequest:
    if payload.source not in SOURCES:
        raise ValidationError(f"Unknown source '{payload.source}'")
    if payload.kind not in KINDS:
        raise ValidationError(f"Unknown kind '{payload.kind}'")
    if payload.employee_id:
        employee = await db.get(Employee, payload.employee_id)
        if employee is None or employee.organization_id != org_id:
            raise NotFoundError("Employee not found")

    config = await get_or_create_config(db, org_id)
    om = await resolve_om(db, org_id, preferred_id=payload.assigned_om_id, config=config)

    approval = ApprovalRequest(
        organization_id=org_id,
        source=payload.source,
        kind=payload.kind,
        title=payload.title,
        summary=payload.summary,
        payload=payload.payload,
        status="pending",
        approver_role=OM_ROLE_NAME,
        assigned_om_id=om.id if om else None,
        employee_id=payload.employee_id,
        queue_id=payload.queue_id,
        requested_by=actor.id,
        expires_at=datetime.now(UTC) + timedelta(hours=APPROVAL_TTL_HOURS),
    )
    db.add(approval)
    await db.flush()
    _log_event(db, approval, "created", actor_email=actor.email,
               detail=f"{kind_label(payload.kind)} raised from {payload.source}")

    await _dispatch(db, approval, config, requested=payload.channels)

    if om:
        await notify_user(
            db, org_id, om.id, kind="approval_request",
            title=f"Approval needed: {approval.title}",
            body=f"{kind_label(approval.kind)} from {approval.source} awaits your sign-off.",
        )
    await record_audit(
        db, actor=actor, action="approval.create", entity_type="approval_request",
        entity_id=approval.id,
        after={"kind": approval.kind, "source": approval.source, "channel": approval.channel},
    )
    await db.flush()
    return await get_approval(db, approval.id)


async def _dispatch(
    db: AsyncSession,
    approval: ApprovalRequest,
    config: IntegrationConfig,
    *,
    requested: list[str] | None = None,
) -> None:
    """Post to each selected channel; always keep an in-app copy."""
    targets: list[str] = list(requested or [])
    if not targets:
        if config.slack_enabled:
            targets.append("slack")
        if config.teams_enabled:
            targets.append("teams")
    # de-dupe and drop anything unknown
    targets = [c for c in dict.fromkeys(targets) if c in CHANNELS and c != "in_app"]

    refs = dict(approval.external_refs)
    delivered: list[str] = []
    for channel in targets:
        adapter = SlackAdapter(config) if channel == "slack" else TeamsAdapter(config)
        result = await adapter.send(approval)
        refs[channel] = {"simulated": result.simulated, "ok": result.ok, **result.ref}
        detail = ("simulated — " if result.simulated else "") + result.detail
        _log_event(db, approval, "dispatched" if result.ok else "failed",
                   channel=channel, detail=detail)
        if result.ok:
            delivered.append(channel)

    approval.external_refs = refs
    approval.channel = delivered[0] if delivered else "in_app"
    if not delivered:
        _log_event(db, approval, "dispatched", channel="in_app",
                   detail="in-app only (no external channel configured)")


# --------------------------------------------------------------------------- #
# Decide + apply
# --------------------------------------------------------------------------- #
async def decide_approval(
    db: AsyncSession,
    approval_id: uuid.UUID,
    *,
    approve: bool,
    actor: User,
    note: str | None = None,
    via: str = "in_app",
) -> ApprovalRequest:
    approval = await get_approval(db, approval_id)
    if approval.status != "pending":
        raise ValidationError(f"Approval is already '{approval.status}'")
    if not _actor_is_om(actor):
        raise PermissionDeniedError(
            "Only an Operations Manager can decide this approval",
            details={"required": [OM_APPROVE_PERMISSION]},
        )

    now = datetime.now(UTC)
    approval.decided_by = actor.id
    approval.decided_at = now
    approval.decided_via = via
    approval.decision_note = note
    approval.status = "approved" if approve else "rejected"
    _log_event(db, approval, "approved" if approve else "rejected",
               channel=via, actor_email=actor.email, detail=note or "")

    await record_audit(
        db, actor=actor, action=f"approval.{'approve' if approve else 'reject'}",
        entity_type="approval_request", entity_id=approval.id,
        after={"status": approval.status, "via": via}, note=note,
    )

    config = await get_or_create_config(db, approval.organization_id)
    if approve and config.auto_apply_on_approve:
        await _apply(db, approval, actor=actor)

    # tell the requester + affected employee how it went
    body = f"{kind_label(approval.kind)} was {approval.status} by {actor.full_name or actor.email}."
    if approval.requested_by and approval.requested_by != actor.id:
        await notify_user(db, approval.organization_id, approval.requested_by,
                          title=f"Approval {approval.status}", body=body, kind="approval_update")
    if approval.employee_id:
        await notify_employees(db, approval.organization_id, [approval.employee_id],
                               title=f"Schedule {approval.status}", body=body,
                               kind="approval_update")
    await db.flush()
    # events were appended after the initial load — refresh so the response
    # (and its timeline) reflects the decision + apply entries.
    await db.refresh(approval, ["events"])
    return approval


async def _apply(db: AsyncSession, approval: ApprovalRequest, *, actor: User) -> None:
    """Apply the approved change to the live plan.

    Where the payload names a concrete `shift_id`, the schedule is really
    mutated; other kinds record an applied decision on the timeline + audit
    trail (the hook the downstream module reads).
    """
    try:
        result = await _apply_change(db, approval)
        approval.status = "applied"
        approval.applied_at = datetime.now(UTC)
        approval.apply_result = result
        _log_event(db, approval, "applied", actor_email=actor.email,
                   detail=result.get("detail", "applied"))
        await record_audit(
            db, actor=actor, action="approval.apply", entity_type="approval_request",
            entity_id=approval.id, after=result,
        )
    except (ValidationError, NotFoundError) as exc:
        approval.status = "failed"
        approval.apply_result = {"error": str(exc)}
        _log_event(db, approval, "failed", detail=f"apply failed: {exc}")


async def _apply_change(db: AsyncSession, approval: ApprovalRequest) -> dict:
    """Kind-specific application. Returns a JSON-able result summary."""
    payload = approval.payload or {}
    shift_id = payload.get("shift_id")

    # Kinds that target a concrete roster shift really mutate it.
    shift_kinds = {"shift_change", "break_move", "overtime", "vto", "extra_shift"}
    if approval.kind in shift_kinds and shift_id:
        shift = await db.get(ScheduleShift, uuid.UUID(str(shift_id)))
        if shift is None:
            raise NotFoundError("Target shift not found")
        before = {
            "start_ts": shift.start_ts.isoformat() if shift.start_ts else None,
            "end_ts": shift.end_ts.isoformat() if shift.end_ts else None,
            "activities": list(shift.activities or []),
        }
        if payload.get("new_start_ts"):
            shift.start_ts = datetime.fromisoformat(payload["new_start_ts"])
        if payload.get("new_end_ts"):
            shift.end_ts = datetime.fromisoformat(payload["new_end_ts"])
        if payload.get("activities") is not None:
            shift.activities = payload["activities"]
        await db.flush()
        return {
            "applied": approval.kind, "shift_id": str(shift.id),
            "before": before,
            "after": {
                "start_ts": shift.start_ts.isoformat() if shift.start_ts else None,
                "end_ts": shift.end_ts.isoformat() if shift.end_ts else None,
                "activities": list(shift.activities or []),
            },
            "detail": f"{kind_label(approval.kind)} applied to shift {shift.id}",
        }

    # Swap two employees between two shifts when both are supplied.
    if (approval.kind == "shift_swap"
            and payload.get("shift_id") and payload.get("swap_with_shift_id")):
        a = await db.get(ScheduleShift, uuid.UUID(str(payload["shift_id"])))
        b = await db.get(ScheduleShift, uuid.UUID(str(payload["swap_with_shift_id"])))
        if a is None or b is None:
            raise NotFoundError("One or both swap shifts not found")
        a.employee_id, b.employee_id = b.employee_id, a.employee_id
        await db.flush()
        return {"applied": "shift_swap", "shifts": [str(a.id), str(b.id)],
                "detail": "Swapped employees between the two shifts"}

    # Kinds without a direct roster target: record the decision as the applied hook.
    return {
        "applied": approval.kind, "target": "recorded",
        "payload": payload,
        "detail": f"{kind_label(approval.kind)} approved and recorded for downstream execution",
    }


# --------------------------------------------------------------------------- #
# Queries
# --------------------------------------------------------------------------- #
async def get_approval(db: AsyncSession, approval_id: uuid.UUID) -> ApprovalRequest:
    # explicit select (not db.get) so selectinload always runs, even when the
    # instance is already in the identity map with an unloaded collection.
    approval = (
        await db.execute(
            select(ApprovalRequest)
            .where(ApprovalRequest.id == approval_id)
            .options(selectinload(ApprovalRequest.events))
        )
    ).scalar_one_or_none()
    if approval is None:
        raise NotFoundError("Approval not found")
    return approval


async def list_approvals(
    db: AsyncSession,
    org_id: uuid.UUID,
    *,
    status: str | None = None,
    source: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> tuple[list[ApprovalRequest], int]:
    from sqlalchemy import func as sa_func

    query = select(ApprovalRequest).where(ApprovalRequest.organization_id == org_id)
    if status:
        query = query.where(ApprovalRequest.status == status)
    if source:
        query = query.where(ApprovalRequest.source == source)
    total = (
        await db.execute(select(sa_func.count()).select_from(query.subquery()))
    ).scalar_one()
    rows = await db.execute(
        query.order_by(ApprovalRequest.created_at.desc()).offset(offset).limit(limit)
    )
    return list(rows.scalars()), total
