"""Scheduled report emails: recipients, timing, sending and the background loop."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.logging import get_logger
from app.modules.reporting import dashboard, mailer
from app.modules.reporting.models import ReportRecipientList, ReportRun, ReportSubscription

log = get_logger(__name__)
LIST_PREFIX = "list:"


def next_run(send_time: str, weekdays: list[int], tz: str, after: datetime) -> datetime | None:
    """The next moment on one of `weekdays` at `send_time` in `tz`, in UTC."""
    if not weekdays:
        return None
    zone = ZoneInfo(tz)
    local = after.astimezone(zone)
    hour, minute = (int(x) for x in send_time.split(":"))
    for i in range(8):
        day = local.date() + timedelta(days=i)
        if day.weekday() not in weekdays:
            continue
        candidate = datetime.combine(day, time(hour, minute), tzinfo=zone)
        if candidate > after:
            return candidate.astimezone(UTC)
    return None


async def expand(db: AsyncSession, org_id: uuid.UUID, entries: list[str]) -> list[str]:
    """Addresses from a mix of emails and list references, without duplicates."""
    out: dict[str, str] = {}
    for entry in entries:
        if entry.startswith(LIST_PREFIX):
            row = await db.get(ReportRecipientList, uuid.UUID(entry[len(LIST_PREFIX) :]))
            emails = row.emails if row and row.organization_id == org_id else []
        else:
            emails = [entry]
        for email in emails:
            out.setdefault(email.lower(), email)
    return list(out.values())


def local_today(tz: str, now: datetime) -> date:
    return now.astimezone(ZoneInfo(tz)).date()


async def send_subscription(
    db: AsyncSession, sub: ReportSubscription, trigger: str, now: datetime | None = None
) -> ReportRun:
    """Build and send one report, recording the outcome. A failure is recorded, not raised."""
    now = now or datetime.now(UTC)
    start, end = dashboard.period_for(sub.frequency, local_today(sub.timezone, now))
    to = await expand(db, sub.organization_id, sub.to_recipients)
    in_to = {e.lower() for e in to}
    cc = [
        e
        for e in await expand(db, sub.organization_id, sub.cc_recipients)
        if e.lower() not in in_to
    ]
    status, error = "sent", ""
    try:
        if not to:
            raise mailer.MailSendError("No one to send to: the To list is empty")
        data = await dashboard.build(db, sub.organization_id, sub.frequency, start, end, sub.lob)
        await mailer.send(
            to,
            cc,
            dashboard.subject(sub.name, data),
            dashboard.render(sub.name, data),
            dashboard.render_text(sub.name, data),
        )
    except (mailer.MailSendError, mailer.MailNotConfiguredError) as exc:
        status, error = "failed", str(exc)
    run = ReportRun(
        organization_id=sub.organization_id,
        subscription_id=sub.id,
        trigger=trigger,
        period_start=start,
        period_end=end,
        to_recipients=to,
        cc_recipients=cc,
        status=status,
        error=error,
    )
    db.add(run)
    sub.last_run_at, sub.last_status = now, status
    await db.flush()
    await db.refresh(run, ["created_at"])
    return run


async def run_due(
    session_factory: async_sessionmaker[AsyncSession], now: datetime | None = None
) -> int:
    """Send every report that's due. Each is moved to its next time and committed
    before sending, so a crash can't make it go out twice."""
    now = now or datetime.now(UTC)
    async with session_factory() as db:
        ids = list(
            (
                await db.execute(
                    select(ReportSubscription.id).where(
                        ReportSubscription.active.is_(True), ReportSubscription.next_run_at <= now
                    )
                )
            ).scalars()
        )
    for sub_id in ids:
        async with session_factory() as db:
            sub = await db.get(ReportSubscription, sub_id)
            if sub is None:
                continue
            # Claimed atomically: during a deploy two servers overlap, and only one may send.
            claimed = await db.execute(
                update(ReportSubscription)
                .where(
                    ReportSubscription.id == sub_id,
                    ReportSubscription.next_run_at == sub.next_run_at,
                )
                .values(next_run_at=next_run(sub.send_time, sub.weekdays, sub.timezone, now))
                .execution_options(synchronize_session=False)
            )
            await db.commit()
            if claimed.rowcount != 1:
                continue
            await db.refresh(sub)
            await send_subscription(db, sub, "schedule", now)
            await db.commit()
    return len(ids)


async def run_scheduler(
    session_factory: async_sessionmaker[AsyncSession], interval: float = 60.0
) -> None:
    """Background loop started with the app. A report that came due while the server
    was asleep goes out as soon as it wakes."""
    while True:
        try:
            await run_due(session_factory)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - keep the loop alive; it tries again next tick
            log.exception("reports.scheduler_failed")
        await asyncio.sleep(interval)
