"""Change request services: submission, two-stage decisions, SLA, comments."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.identity.models import User
from app.modules.identity.service import record_audit
from app.modules.notifications.service import notify_employees, notify_user
from app.modules.requests.models import (
    WFM_ONLY_CATEGORIES,
    ChangeRequest,
    RequestComment,
)
from app.modules.requests.schemas import CommentIn, DecisionIn, RequestCreate
from app.modules.workforce.models import Employee

SLA_HOURS = 48


async def create_request(
    db: AsyncSession, org_id: uuid.UUID, payload: RequestCreate, *, actor: User
) -> ChangeRequest:
    employee = await db.get(Employee, payload.employee_id)
    if employee is None or employee.organization_id != org_id:
        raise NotFoundError("Employee not found")
    status = (
        "pending_wfm" if payload.category in WFM_ONLY_CATEGORIES else "pending_manager"
    )
    request = ChangeRequest(
        organization_id=org_id,
        employee_id=payload.employee_id,
        requested_by=actor.id,
        category=payload.category,
        status=status,
        reason=payload.reason,
        payload=payload.payload,
        attachments=payload.attachments,
        sla_due_at=datetime.now(UTC) + timedelta(hours=SLA_HOURS),
    )
    db.add(request)
    await db.flush()
    await record_audit(
        db, actor=actor, action="request.create", entity_type="change_request",
        entity_id=request.id, after={"category": payload.category, "status": status},
    )
    return request


async def get_request(db: AsyncSession, request_id: uuid.UUID) -> ChangeRequest:
    request = await db.get(
        ChangeRequest, request_id, options=[selectinload(ChangeRequest.comments)]
    )
    if request is None:
        raise NotFoundError("Request not found")
    return request


async def list_requests(
    db: AsyncSession,
    org_id: uuid.UUID,
    *,
    status: str | None = None,
    category: str | None = None,
    employee_id: uuid.UUID | None = None,
    overdue_only: bool = False,
    offset: int = 0,
    limit: int = 50,
) -> tuple[list[ChangeRequest], int]:
    query = select(ChangeRequest).where(ChangeRequest.organization_id == org_id)
    if status:
        query = query.where(ChangeRequest.status == status)
    if category:
        query = query.where(ChangeRequest.category == category)
    if employee_id:
        query = query.where(ChangeRequest.employee_id == employee_id)
    if overdue_only:
        query = query.where(
            ChangeRequest.status.in_(["pending_manager", "pending_wfm"]),
            ChangeRequest.sla_due_at < datetime.now(UTC),
        )
    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    rows = await db.execute(
        query.order_by(ChangeRequest.created_at.desc()).offset(offset).limit(limit)
    )
    return list(rows.scalars()), total


async def decide(
    db: AsyncSession,
    request_id: uuid.UUID,
    stage: str,  # "manager" | "wfm"
    decision: DecisionIn,
    *,
    actor: User,
) -> ChangeRequest:
    request = await get_request(db, request_id)
    now = datetime.now(UTC)

    if stage == "manager":
        if request.status != "pending_manager":
            raise ValidationError(f"Request is '{request.status}', not awaiting manager")
        request.manager_decided_by, request.manager_decided_at = actor.id, now
        request.status = "pending_wfm" if decision.approve else "rejected"
    elif stage == "wfm":
        if request.status != "pending_wfm":
            raise ValidationError(f"Request is '{request.status}', not awaiting WFM")
        request.wfm_decided_by, request.wfm_decided_at = actor.id, now
        request.status = "approved" if decision.approve else "rejected"
    else:  # pragma: no cover - guarded by router paths
        raise ValidationError("Unknown approval stage")

    if decision.note:
        request.decision_note = decision.note
    await record_audit(
        db, actor=actor, action=f"request.{stage}_decision", entity_type="change_request",
        entity_id=request.id,
        after={"approve": decision.approve, "status": request.status}, note=decision.note,
    )
    await notify_employees(
        db, request.organization_id, [request.employee_id],
        title=f"Request {request.status.replace('_', ' ')}",
        body=f"Your {request.category} request is now {request.status.replace('_', ' ')}.",
        kind="request_update",
    )
    if request.requested_by and request.requested_by != actor.id:
        await notify_user(
            db, request.organization_id, request.requested_by,
            title=f"Request {request.status.replace('_', ' ')}",
            body=f"{request.category} request for employee moved to {request.status}.",
            kind="request_update",
        )
    return request


async def cancel_request(
    db: AsyncSession, request_id: uuid.UUID, *, actor: User
) -> ChangeRequest:
    request = await get_request(db, request_id)
    if request.status not in ("pending_manager", "pending_wfm"):
        raise ValidationError("Only pending requests can be cancelled")
    if request.requested_by != actor.id and not actor.is_superuser:
        raise ValidationError("Only the requester can cancel this request")
    request.status = "cancelled"
    await record_audit(
        db, actor=actor, action="request.cancel", entity_type="change_request",
        entity_id=request.id,
    )
    return request


async def add_comment(
    db: AsyncSession, request_id: uuid.UUID, payload: CommentIn, *, actor: User
) -> RequestComment:
    request = await get_request(db, request_id)
    comment = RequestComment(
        request_id=request.id, author_user_id=actor.id, author_email=actor.email,
        body=payload.body,
    )
    db.add(comment)
    await db.flush()
    return comment
