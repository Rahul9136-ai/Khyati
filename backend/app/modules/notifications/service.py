"""Notification services. In-app rows are written synchronously; external
channels (email/Teams/Slack/SMS) are dispatched by Celery workers reading the
same table, so business modules only ever call these two functions."""
from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.identity.models import User
from app.modules.notifications.models import Notification


async def notify_user(
    db: AsyncSession,
    org_id: uuid.UUID | None,
    user_id: uuid.UUID,
    *,
    title: str,
    body: str = "",
    kind: str = "info",
) -> None:
    db.add(
        Notification(
            organization_id=org_id, user_id=user_id, title=title, body=body, kind=kind
        )
    )


async def notify_employees(
    db: AsyncSession,
    org_id: uuid.UUID | None,
    employee_ids: Iterable[uuid.UUID],
    *,
    title: str,
    body: str = "",
    kind: str = "info",
) -> None:
    """Notify the user accounts linked to the given employees (if any)."""
    ids = {e for e in employee_ids if e}
    if not ids:
        return
    users = (await db.execute(select(User).where(User.employee_id.in_(ids)))).scalars()
    linked: set[uuid.UUID] = set()
    for user in users:
        if user.employee_id is None:  # unreachable given the filter; narrows the type
            continue
        linked.add(user.employee_id)
        db.add(
            Notification(
                organization_id=org_id, user_id=user.id, employee_id=user.employee_id,
                title=title, body=body, kind=kind,
            )
        )
    for emp_id in ids - linked:  # employees without accounts still get a row
        db.add(
            Notification(
                organization_id=org_id, employee_id=emp_id, title=title, body=body, kind=kind
            )
        )


async def list_for_user(
    db: AsyncSession, user_id: uuid.UUID, *, unread_only: bool = False, limit: int = 50
) -> list[Notification]:
    query = select(Notification).where(Notification.user_id == user_id)
    if unread_only:
        query = query.where(Notification.read_at.is_(None))
    rows = await db.execute(query.order_by(Notification.created_at.desc()).limit(limit))
    return list(rows.scalars())


async def mark_read(db: AsyncSession, user_id: uuid.UUID, notification_id: uuid.UUID) -> bool:
    row = await db.get(Notification, notification_id)
    if row is None or row.user_id != user_id:
        return False
    row.read_at = datetime.now(UTC)
    return True
