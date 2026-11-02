"""/reports/scheduled: email report schedules, recipient lists, preview and history."""

from __future__ import annotations

import re
import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Query
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select

from app.api.deps import DbSession, require_permission
from app.core.config import settings
from app.core.exceptions import NotFoundError, ValidationError
from app.modules.identity.models import User
from app.modules.identity.service import record_audit
from app.modules.reporting import dashboard, mailer, scheduled
from app.modules.reporting.models import ReportRecipientList, ReportRun, ReportSubscription
from app.modules.workforce.service import org_scope
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/reports/scheduled", tags=["reports"])
Manager = Annotated[User, Depends(require_permission("report:export"))]
Frequency = Literal["daily", "weekly", "mtd"]
_EMAIL = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+")


def _email(value: str) -> str:
    """A plain address only, so nothing can be smuggled into mail headers. Internal
    domains such as ops@corp.local are fine, which is why this isn't email_validator."""
    email = value.strip()
    if len(email) > 254 or not _EMAIL.fullmatch(email):
        raise ValueError(f"'{value}' isn't a valid email address")
    return email


class ListIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    emails: list[str] = Field(min_length=1, max_length=200)

    @field_validator("emails")
    @classmethod
    def _check(cls, v: list[str]) -> list[str]:
        return list(dict.fromkeys(_email(e) for e in v))


class ListOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    emails: list[str]


class SubscriptionIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    frequency: Frequency
    weekdays: list[int] = Field(min_length=1, max_length=7)
    send_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    timezone: str = Field(max_length=64)
    lob: str = Field("", max_length=128)
    to_recipients: list[str] = Field(min_length=1, max_length=100)
    cc_recipients: list[str] = Field(default=[], max_length=100)
    active: bool = True

    @field_validator("weekdays")
    @classmethod
    def _days(cls, v: list[int]) -> list[int]:
        if any(d < 0 or d > 6 for d in v):
            raise ValueError("Days are 0 (Monday) to 6 (Sunday)")
        return sorted(set(v))

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"Unknown time zone '{v}'") from exc
        return v

    @field_validator("to_recipients", "cc_recipients")
    @classmethod
    def _recipients(cls, v: list[str]) -> list[str]:
        out = []
        for entry in v:
            if entry.startswith(scheduled.LIST_PREFIX):
                uuid.UUID(entry[len(scheduled.LIST_PREFIX) :])
                out.append(entry)
            else:
                out.append(_email(entry))
        return list(dict.fromkeys(out))


def _utc(value: datetime | None) -> datetime | None:
    """SQLite hands times back without a zone; they're always UTC."""
    return value.replace(tzinfo=UTC) if value and value.tzinfo is None else value


UtcTime = Annotated[datetime | None, AfterValidator(_utc)]


class SubscriptionOut(SubscriptionIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    next_run_at: UtcTime
    last_run_at: UtcTime
    last_status: str
    created_by_email: str


class RunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    trigger: str
    period_start: date
    period_end: date
    to_recipients: list[str]
    cc_recipients: list[str]
    status: str
    error: str
    created_at: UtcTime


async def _check_lists(db: DbSession, org: uuid.UUID, body: SubscriptionIn) -> None:
    for entry in [*body.to_recipients, *body.cc_recipients]:
        if entry.startswith(scheduled.LIST_PREFIX):
            row = await db.get(ReportRecipientList, uuid.UUID(entry[len(scheduled.LIST_PREFIX) :]))
            if row is None or row.organization_id != org:
                raise ValidationError("A chosen distribution list no longer exists")


async def _sub(db: DbSession, user: User, sub_id: uuid.UUID) -> ReportSubscription:
    sub = await db.get(ReportSubscription, sub_id)
    if sub is None or sub.organization_id != org_scope(user):
        raise NotFoundError("Report schedule not found")
    return sub


def _apply(sub: ReportSubscription, body: SubscriptionIn) -> None:
    for key, value in body.model_dump().items():
        setattr(sub, key, value)
    sub.next_run_at = (
        scheduled.next_run(sub.send_time, sub.weekdays, sub.timezone, datetime.now(UTC))
        if sub.active
        else None
    )


@router.get("/status", response_model=ApiResponse[dict])
async def email_status(user: Manager):
    """Whether email is set up (never any credentials)."""
    kind = mailer.provider()
    return ApiResponse(
        data={"configured": bool(kind), "provider": kind, "from": settings.EMAIL_FROM}
    )


@router.get("/preview", response_model=ApiResponse[dict])
async def preview(
    db: DbSession,
    user: Manager,
    frequency: Frequency = "daily",
    lob: str = Query("", max_length=128),
    name: str = Query("Report preview", max_length=160),
    timezone: str = Query("UTC", max_length=64),
):
    """The dashboard exactly as it would be emailed now. Nothing is sent."""
    try:
        today = scheduled.local_today(timezone, datetime.now(UTC))
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValidationError(f"Unknown time zone '{timezone}'") from exc
    start, end = dashboard.period_for(frequency, today)
    data = await dashboard.build(db, org_scope(user), frequency, start, end, lob)
    return ApiResponse(
        data={
            "subject": dashboard.subject(name, data),
            "html": dashboard.render(name, data),
            "start": start,
            "end": end,
        }
    )


@router.get("/lists", response_model=ApiResponse[list[ListOut]])
async def list_lists(db: DbSession, user: Manager):
    rows = await db.execute(
        select(ReportRecipientList)
        .where(ReportRecipientList.organization_id == org_scope(user))
        .order_by(ReportRecipientList.name)
    )
    return ApiResponse(data=[ListOut.model_validate(r) for r in rows.scalars()])


@router.post("/lists", response_model=ApiResponse[ListOut], status_code=201)
async def create_list(body: ListIn, db: DbSession, actor: Manager):
    row = ReportRecipientList(organization_id=org_scope(actor), **body.model_dump())
    db.add(row)
    await db.flush()
    await record_audit(
        db,
        actor=actor,
        action="report_list.create",
        entity_type="report_list",
        entity_id=row.id,
        after=body.model_dump(),
    )
    return ApiResponse(data=ListOut.model_validate(row))


async def _list(db: DbSession, user: User, list_id: uuid.UUID) -> ReportRecipientList:
    row = await db.get(ReportRecipientList, list_id)
    if row is None or row.organization_id != org_scope(user):
        raise NotFoundError("Distribution list not found")
    return row


@router.put("/lists/{list_id}", response_model=ApiResponse[ListOut])
async def update_list(list_id: uuid.UUID, body: ListIn, db: DbSession, actor: Manager):
    row = await _list(db, actor, list_id)
    row.name, row.emails = body.name, body.emails
    await db.flush()
    await record_audit(
        db,
        actor=actor,
        action="report_list.update",
        entity_type="report_list",
        entity_id=row.id,
        after=body.model_dump(),
    )
    return ApiResponse(data=ListOut.model_validate(row))


@router.delete("/lists/{list_id}", response_model=ApiResponse[dict])
async def delete_list(list_id: uuid.UUID, db: DbSession, actor: Manager):
    row = await _list(db, actor, list_id)
    ref = f"{scheduled.LIST_PREFIX}{row.id}"
    subs = await db.execute(
        select(ReportSubscription).where(ReportSubscription.organization_id == row.organization_id)
    )
    users = [s.name for s in subs.scalars() if ref in s.to_recipients or ref in s.cc_recipients]
    if users:
        raise ValidationError(f"Still used by: {', '.join(users)}")
    await db.delete(row)
    await record_audit(
        db, actor=actor, action="report_list.delete", entity_type="report_list", entity_id=list_id
    )
    return ApiResponse(data={"detail": "Removed"})


@router.get("", response_model=ApiResponse[list[SubscriptionOut]])
async def list_subscriptions(db: DbSession, user: Manager):
    rows = await db.execute(
        select(ReportSubscription)
        .where(ReportSubscription.organization_id == org_scope(user))
        .order_by(ReportSubscription.created_at)
    )
    return ApiResponse(data=[SubscriptionOut.model_validate(r) for r in rows.scalars()])


@router.post("", response_model=ApiResponse[SubscriptionOut], status_code=201)
async def create_subscription(body: SubscriptionIn, db: DbSession, actor: Manager):
    org = org_scope(actor)
    await _check_lists(db, org, body)
    sub = ReportSubscription(organization_id=org, created_by_email=actor.email, last_status="")
    _apply(sub, body)
    db.add(sub)
    await db.flush()
    await record_audit(
        db,
        actor=actor,
        action="report_schedule.create",
        entity_type="report_schedule",
        entity_id=sub.id,
        after=body.model_dump(),
    )
    return ApiResponse(data=SubscriptionOut.model_validate(sub))


@router.put("/{sub_id}", response_model=ApiResponse[SubscriptionOut])
async def update_subscription(
    sub_id: uuid.UUID, body: SubscriptionIn, db: DbSession, actor: Manager
):
    sub = await _sub(db, actor, sub_id)
    await _check_lists(db, sub.organization_id, body)
    _apply(sub, body)
    await db.flush()
    await record_audit(
        db,
        actor=actor,
        action="report_schedule.update",
        entity_type="report_schedule",
        entity_id=sub.id,
        after=body.model_dump(),
    )
    return ApiResponse(data=SubscriptionOut.model_validate(sub))


@router.delete("/{sub_id}", response_model=ApiResponse[dict])
async def delete_subscription(sub_id: uuid.UUID, db: DbSession, actor: Manager):
    sub = await _sub(db, actor, sub_id)
    await db.delete(sub)
    await record_audit(
        db,
        actor=actor,
        action="report_schedule.delete",
        entity_type="report_schedule",
        entity_id=sub_id,
    )
    return ApiResponse(data={"detail": "Removed"})


@router.post("/{sub_id}/send", response_model=ApiResponse[RunOut])
async def send_now(sub_id: uuid.UUID, db: DbSession, actor: Manager):
    """Send to its real To and CC now; the regular schedule isn't affected."""
    sub = await _sub(db, actor, sub_id)
    run = await scheduled.send_subscription(db, sub, "manual")
    await record_audit(
        db,
        actor=actor,
        action="report_schedule.send",
        entity_type="report_schedule",
        entity_id=sub.id,
        after={"status": run.status},
    )
    return ApiResponse(data=RunOut.model_validate(run))


@router.get("/{sub_id}/runs", response_model=ApiResponse[list[RunOut]])
async def list_runs(
    sub_id: uuid.UUID, db: DbSession, user: Manager, limit: Annotated[int, Query(ge=1, le=100)] = 20
):
    sub = await _sub(db, user, sub_id)
    rows = await db.execute(
        select(ReportRun)
        .where(ReportRun.subscription_id == sub.id)
        .order_by(ReportRun.created_at.desc())
        .limit(limit)
    )
    return ApiResponse(data=[RunOut.model_validate(r) for r in rows.scalars()])
