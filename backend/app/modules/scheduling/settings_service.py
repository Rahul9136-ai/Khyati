"""Shared scheduling configuration, saved per organisation.

Keys:
  work_rules        [{id, name, shiftMinutes, breaks[{type, minutes}], weekOff[0-6],
                     weekOffMode, defaultStart}]
  work_compliance   {breakRequiredAfterHours, maxContinuousWorkHours, …}
  shift_patterns    [{id, name, start, end,
                     breaks[{id, type, label, offsetMinutes, durationMinutes}]}]
  agent_rules       {agent_key: {shiftPatternId, weekOff[0-6], weekOffMode}}
  schedule_horizon  {through: "YYYY-MM-DD"} — how far ahead schedules have been
                    generated (at most MAX_GENERATE_WEEKS from today)

Every browser loads these on sign-in and saves its changes back, so a change
made anywhere — in the app or by a connected tool through the API — shows up
everywhere. A `base_version` that doesn't match the saved one is rejected
(409) so nobody silently overwrites someone else's change.
"""

from __future__ import annotations

import json
import uuid
from datetime import date, timedelta
from typing import Any

from pydantic import TypeAdapter
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.modules.connect import webhooks
from app.modules.identity.models import User
from app.modules.identity.service import record_audit
from app.modules.scheduling.models import WorkspaceSetting
from app.modules.scheduling.schemas import (
    AgentRuleIn,
    ScheduleHorizonIn,
    ShiftPatternIn,
    WorkComplianceIn,
    WorkRuleIn,
)

KEYS: dict[str, TypeAdapter[Any]] = {
    "work_rules": TypeAdapter(list[WorkRuleIn]),
    "work_compliance": TypeAdapter(WorkComplianceIn),
    "shift_patterns": TypeAdapter(list[ShiftPatternIn]),
    "agent_rules": TypeAdapter(dict[str, AgentRuleIn]),
    "schedule_horizon": TypeAdapter(ScheduleHorizonIn),
}
MAX_BYTES = 1_000_000
#: How far ahead schedules can be generated.
MAX_GENERATE_WEEKS = 52


def _check(key: str, value: Any) -> None:
    if key not in KEYS:
        raise NotFoundError(f"Unknown setting '{key}' (use one of: {', '.join(KEYS)})")
    if len(json.dumps(value)) > MAX_BYTES:
        raise ValidationError(f"'{key}' is too large")
    try:
        parsed = KEYS[key].validate_python(value)
    except PydanticValidationError as exc:
        raise ValidationError(
            f"'{key}' isn't valid",
            details=[{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()[:20]],
        ) from exc
    days: list[list[int] | None] = []
    if key == "work_rules":
        days = [r.weekOff for r in parsed]
        ids = [r.id for r in parsed]
        if len(ids) != len(set(ids)):
            raise ValidationError("Work rule ids must be unique")
        for r in parsed:
            used = sum(b.minutes for b in r.breaks) + r.noBreakStartMinutes + r.noBreakEndMinutes
            if r.breaks and used > r.shiftMinutes:
                raise ValidationError(f"{r.name}: the breaks don't fit between the no-break times")
    elif key == "agent_rules":
        days = [a.weekOff for a in parsed.values()]
    elif key == "schedule_horizon":
        if parsed.through > date.today() + timedelta(weeks=MAX_GENERATE_WEEKS):
            raise ValidationError(
                f"Schedules can be generated at most {MAX_GENERATE_WEEKS} weeks ahead"
            )
    if any(d < 0 or d > 6 for ds in days if ds for d in ds):
        raise ValidationError("Week-off days are 0 (Monday) to 6 (Sunday)")


async def break_zones(
    db: AsyncSession, org_id: uuid.UUID, keys: list[str]
) -> dict[str, tuple[int, int]]:
    """agent_key → (no-break minutes after shift start, before shift end), for
    agents whose work rule sets them."""
    agents = await _get(db, org_id, "agent_rules")
    rules = await _get(db, org_id, "work_rules")
    if agents is None or rules is None or not isinstance(agents.value, dict):
        return {}
    by_id = {r.get("id"): r for r in rules.value if isinstance(r, dict)}
    out: dict[str, tuple[int, int]] = {}
    for key in keys:
        pattern = (agents.value.get(key) or {}).get("shiftPatternId") or ""
        if not pattern.startswith("wr:"):
            continue
        rule = by_id.get(pattern[3:].split("@")[0]) or {}
        zones = (rule.get("noBreakStartMinutes") or 0, rule.get("noBreakEndMinutes") or 0)
        if any(zones):
            out[key] = zones
    return out


async def _get(db: AsyncSession, org_id: uuid.UUID, key: str) -> WorkspaceSetting | None:
    return (
        await db.execute(
            select(WorkspaceSetting).where(
                WorkspaceSetting.organization_id == org_id, WorkspaceSetting.key == key
            )
        )
    ).scalar_one_or_none()


async def get_value(db: AsyncSession, org_id: uuid.UUID, key: str) -> Any:
    row = await _get(db, org_id, key)
    return row.value if row else None


async def list_settings(db: AsyncSession, org_id: uuid.UUID) -> list[WorkspaceSetting]:
    return list(
        (
            await db.execute(
                select(WorkspaceSetting)
                .where(WorkspaceSetting.organization_id == org_id)
                .order_by(WorkspaceSetting.key)
            )
        ).scalars()
    )


async def get_setting(db: AsyncSession, org_id: uuid.UUID, key: str) -> WorkspaceSetting:
    if key not in KEYS:
        raise NotFoundError(f"Unknown setting '{key}' (use one of: {', '.join(KEYS)})")
    row = await _get(db, org_id, key)
    if row is None:
        raise NotFoundError(f"'{key}' hasn't been saved yet")
    return row


async def put_setting(
    db: AsyncSession,
    org_id: uuid.UUID,
    key: str,
    value: Any,
    base_version: int | None,
    *,
    actor: User,
) -> WorkspaceSetting:
    _check(key, value)
    row = await _get(db, org_id, key)
    current = row.version if row else 0
    if base_version is not None and base_version != current:
        raise ConflictError(
            f"'{key}' was changed by someone else — reload and retry",
            details={"version": current, "value": row.value if row else None},
        )
    if row is None:
        row = WorkspaceSetting(organization_id=org_id, key=key, value=value, version=1)
        db.add(row)
    elif row.value == value:
        return row  # nothing changed — no new version, no event
    else:
        row.value = value
        row.version = current + 1
    row.updated_by = actor.email
    await db.flush()
    await db.refresh(row, ["updated_at"])
    await webhooks.emit(
        db,
        org_id,
        "settings.updated",
        {
            "key": key,
            "version": row.version,
            "updated_by": row.updated_by,
            "value": value,
        },
    )
    await record_audit(
        db,
        actor=actor,
        action="settings.update",
        entity_type="workspace_setting",
        entity_id=key,
        after={"version": row.version},
    )
    return row
