"""Save and load the app's data per organisation, so what anyone adds stays
until someone removes it, and shows up in every browser and on every device.

Each area (`KEYS`) is saved whole, with a version: a save based on an older
version is refused (409, with the current value) so nobody silently
overwrites someone else's change. Who may change an area follows the
permission codes in `KEYS` (None = anyone signed in to the organisation).
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictError,
    NotFoundError,
    PermissionDeniedError,
    ValidationError,
)
from app.modules.connect import webhooks
from app.modules.workspace.models import WorkspaceData

_EMP = ("employee:write",)
_REQ = ("request:create", "request:approve_wfm", "request:approve_manager")

#: area -> permission codes that may change it (any of them); None = anyone signed in.
KEYS: dict[str, tuple[str, ...] | None] = {
    # people
    "agents": (*_EMP, "schedule:write"),
    "employeeProfiles": _EMP,
    "formerEmployees": _EMP,
    "employeeChanges": (*_EMP, "schedule:write"),
    "dataSources": _EMP,
    "users": ("admin:users",),
    "permissions": ("admin:roles",),
    # demand
    "queues": ("admin:org", "forecast:write", "plan:write", "planning:write"),
    "forecasts": ("forecast:write",),
    "forecastMethod": ("forecast:write",),
    "importedActuals": ("forecast:write",),
    "externalFactors": ("forecast:write",),
    "shrinkage": ("plan:write", "planning:write", "attendance:write", "schedule:write"),
    "scenarios": ("plan:write", "planning:write"),
    # requests and day-to-day
    "ptoRequests": (*_REQ, "attendance:write", "schedule:write"),
    "swaps": (*_REQ, "schedule:write"),
    "exceptions": (*_REQ, "attendance:write", "intraday:write", "schedule:write"),
    "skillChangeRecommendations": (*_REQ, "intraday:write", "agent:manage"),
    "messages": None,
    "auditLog": None,
    # automation
    "thresholds": ("agent:manage", "admin:settings"),
    "ruleState": ("agent:manage", "admin:settings"),
    "pipelineAutoRun": ("agent:manage", "admin:settings"),
}
MAX_BYTES = 5_000_000


def can_write(user, key: str) -> bool:  # noqa: ANN001 - a User or an API-key actor
    need = KEYS.get(key)
    return bool(user.is_superuser or need is None or set(need) & user.permission_codes)


def _check_key(key: str) -> None:
    if key not in KEYS:
        raise NotFoundError(f"Unknown area '{key}' (use one of: {', '.join(KEYS)})")


async def _get(db: AsyncSession, org: uuid.UUID, key: str) -> WorkspaceData | None:
    return (
        await db.execute(
            select(WorkspaceData).where(
                WorkspaceData.organization_id == org, WorkspaceData.key == key
            )
        )
    ).scalar_one_or_none()


def out(row: WorkspaceData, user, *, value: bool = True) -> dict[str, Any]:  # noqa: ANN001
    data: dict[str, Any] = {
        "key": row.key,
        "version": row.version,
        "updatedAt": row.updated_at,
        "updatedBy": row.updated_by,
        "canWrite": can_write(user, row.key),
    }
    if value:
        data["value"] = row.value
    return data


async def list_all(db: AsyncSession, org: uuid.UUID) -> list[WorkspaceData]:
    return list(
        (
            await db.execute(
                select(WorkspaceData)
                .where(WorkspaceData.organization_id == org)
                .order_by(WorkspaceData.key)
            )
        ).scalars()
    )


async def get(db: AsyncSession, org: uuid.UUID, key: str) -> WorkspaceData:
    _check_key(key)
    row = await _get(db, org, key)
    if row is None:
        raise NotFoundError(f"'{key}' hasn't been saved yet")
    return row


async def put(
    db: AsyncSession,
    org: uuid.UUID,
    key: str,
    value: Any,
    base_version: int | None,
    *,
    actor,  # noqa: ANN001
) -> WorkspaceData:
    _check_key(key)
    if not can_write(actor, key):
        need = KEYS[key] or ()
        raise PermissionDeniedError(
            f"Changing '{key}' needs one of: {', '.join(need)}",
            details={"required": list(need)},
        )
    if value is None:
        raise ValidationError("value is required")
    if len(json.dumps(value)) > MAX_BYTES:
        raise ValidationError(f"'{key}' is too large to save (max {MAX_BYTES // 1_000_000} MB)")
    row = await _get(db, org, key)
    current = row.version if row else 0
    if row is not None and row.value == value:
        return row  # already saved (e.g. by another tab of the same browser): nothing to do
    if base_version is not None and base_version != current:
        raise ConflictError(
            f"'{key}' was changed by someone else; their version is loaded",
            details={"version": current, "value": row.value if row else None},
        )
    if row is None:
        row = WorkspaceData(organization_id=org, key=key, value=value, version=1)
        db.add(row)
    else:
        row.value = value
        row.version = current + 1
    row.updated_by = getattr(actor, "email", "") or ""
    await db.flush()
    await db.refresh(row, ["updated_at"])
    await webhooks.emit(
        db,
        org,
        "workspace.updated",
        {"key": key, "version": row.version, "updatedBy": row.updated_by},
    )
    return row
