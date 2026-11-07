"""Live updates for Capacity Planning (Server-Sent Events).

GET /capacity/stream keeps a connection open and sends an event the moment
anything in the plan changes — a sheet imported or edited in the app, a row a
CRM pushed through the API, a switch flipped — so screens and connected tools
don't have to poll.

How a change reaches a stream:
* service code calls `mark_changed(db, org)` when it saves a document;
* once that transaction commits (never before, never on rollback) every open
  stream of that organisation is woken up and re-reads the versions;
* every stream also re-checks the versions every few seconds, so changes made
  by another server process still arrive (within `CHECK_SECONDS`).

Events (`text/event-stream`):
  event: hello   — on connect: {resultsVersion, state, activity}
  event: change  — after a change: same shape; `activity` holds the latest entries
  : ping         — a comment every ~15 s so proxies keep the connection open
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections import defaultdict
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

_PENDING = "capacity_changed_orgs"
_waiters: dict[uuid.UUID, set[asyncio.Event]] = defaultdict(set)
_rollback_hooks: list[Callable[[uuid.UUID], None]] = []

CHECK_SECONDS = 3.0
HEARTBEAT_SECONDS = 15.0
#: Activity entries sent with each event.
ACTIVITY_IN_EVENT = 10


def mark_changed(db: AsyncSession, org: uuid.UUID) -> None:
    """Note that `org`'s plan changed in this transaction (streams wake on commit)."""
    db.info.setdefault(_PENDING, set()).add(org)


def on_rollback(fn: Callable[[uuid.UUID], None]) -> None:
    """Run `fn(org)` when a transaction that changed `org`'s plan is rolled back."""
    _rollback_hooks.append(fn)


def notify(org: uuid.UUID) -> None:
    for ev in list(_waiters.get(org, ())):
        ev.set()


def listeners(org: uuid.UUID) -> int:
    return len(_waiters.get(org, ()))


@event.listens_for(Session, "after_commit")
def _after_commit(session: Session) -> None:
    for org in session.info.pop(_PENDING, None) or ():
        notify(org)


@event.listens_for(Session, "after_rollback")
def _after_rollback(session: Session) -> None:
    for org in session.info.pop(_PENDING, None) or ():
        for fn in _rollback_hooks:
            fn(org)


def _sse(name: str, data: dict[str, Any]) -> str:
    return f"event: {name}\ndata: {json.dumps(jsonable_encoder(data), separators=(',', ':'))}\n\n"


async def stream(
    org: uuid.UUID,
    session: Callable[[], AbstractAsyncContextManager[AsyncSession]],
    is_disconnected: Callable[[], Awaitable[bool]],
    *,
    check_seconds: float = CHECK_SECONDS,
    heartbeat_seconds: float = HEARTBEAT_SECONDS,
) -> AsyncIterator[str]:
    """Yield SSE text for `org` until the client goes away."""
    from app.modules.capacity import service  # imported here: service imports this module

    wake = asyncio.Event()
    _waiters[org].add(wake)
    try:
        yield "retry: 3000\n\n"
        last: str | None = None
        quiet = 0.0
        while True:
            wake.clear()  # before reading, so a commit during the read isn't lost
            async with session() as db:
                rv = await service.results_version(db, org)
                if rv != last:
                    payload = {
                        "resultsVersion": rv,
                        "state": await service.state(db, org),
                        "activity": await service.activity(db, org, limit=ACTIVITY_IN_EVENT),
                    }
            if rv != last:
                yield _sse("hello" if last is None else "change", payload)
                last = rv
                quiet = 0.0
            try:
                await asyncio.wait_for(wake.wait(), timeout=check_seconds)
            except TimeoutError:
                quiet += check_seconds
                if quiet >= heartbeat_seconds:
                    yield ": ping\n\n"
                    quiet = 0.0
            if await is_disconnected():
                return
    finally:
        _waiters[org].discard(wake)
        if not _waiters[org]:
            _waiters.pop(org, None)
