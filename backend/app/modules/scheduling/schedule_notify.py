"""Who hears about published schedules and later changes, and what they're told.

Agents are the user accounts linked to a day plan's employee. Team leaders are
the accounts linked to the leader of that employee's team or to their manager,
plus Team Leader accounts whose name matches the plan's `team_lead` (the
roster's TL column). The person making the change is never notified.

Repeated edits don't pile up: while a notification about the same agent-day
(or a TL's day) is still unread, it is updated in place (`Notification.ref`).
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.identity.models import Role, User, user_roles
from app.modules.notifications.models import Notification
from app.modules.scheduling import dayplan as dp
from app.modules.scheduling.models import DaySchedulePlan
from app.modules.workforce.models import Employee, Team

KIND_PUBLISHED = "schedule_published"
KIND_CHANGED = "schedule_changed"
BODY_MAX = 1024


def fmt_day(d: date) -> str:
    return d.strftime("%a %d %b").replace(" 0", " ")


def _rng(start: int, end: int) -> str:
    return f"{dp.fmt_hm(start)}–{dp.fmt_hm(end)}"


def describe_change(before: dp.AgentDay | None, after: dp.AgentDay | None) -> str:
    """Short human summary of what changed on one agent's day."""
    if before is None and after is not None:
        return f"New schedule {_rng(after.shift_start, after.shift_end)}"
    if after is None:
        return "Schedule removed"
    assert before is not None
    parts: list[str] = []
    if (before.shift_start, before.shift_end) != (after.shift_start, after.shift_end):
        parts.append(
            f"Shift {_rng(before.shift_start, before.shift_end)} → "
            f"{_rng(after.shift_start, after.shift_end)}"
        )

    def blocks(name_of, old: list, new: list) -> None:
        old_by, new_by = {b.id: b for b in old}, {b.id: b for b in new}
        for bid, b in new_by.items():
            o = old_by.get(bid)
            if o is None:
                parts.append(f"+ {name_of(b)} {_rng(b.start, b.end)}")
            elif (o.start, o.end) != (b.start, b.end):
                if o.end - o.start == b.end - b.start:
                    parts.append(f"{name_of(b)} {dp.fmt_hm(o.start)} → {dp.fmt_hm(b.start)}")
                else:
                    parts.append(f"{name_of(b)} {_rng(o.start, o.end)} → {_rng(b.start, b.end)}")
        for bid, o in old_by.items():
            if bid not in new_by:
                parts.append(f"− {name_of(o)} {_rng(o.start, o.end)}")

    blocks(lambda b: b.label, before.breaks, after.breaks)
    blocks(lambda a: dp.ACTIVITIES[a.type]["label"], before.activities, after.activities)
    blocks(lambda o: f"OT {dp.CHANNELS[o.channel]['label']}", before.ot, after.ot)
    def lanes(d: dp.AgentDay) -> list[tuple[str, int, int]]:
        return [(c.channel, c.start, c.end) for c in sorted(d.channels, key=lambda c: c.start)]

    if not parts and lanes(before) != lanes(after):
        now = " · ".join(f"{dp.CHANNELS[ch]['label']} {_rng(s, e)}" for ch, s, e in lanes(after))
        parts.append(f"Channels now {now}")
    return "; ".join(parts) or "Schedule updated"


# ------------------------------------------------------------------ recipients


@dataclass
class Audience:
    agents: dict[str, set[uuid.UUID]] = field(default_factory=dict)  # agent_key → users
    leads: dict[str, set[uuid.UUID]] = field(default_factory=dict)  # agent_key → TL users


async def resolve_audience(
    db: AsyncSession, org_id: uuid.UUID, rows: Iterable[DaySchedulePlan]
) -> Audience:
    rows = list(rows)
    emp_ids = {r.employee_id for r in rows if r.employee_id}
    employees: dict[uuid.UUID, Employee] = {}
    leader_of_team: dict[uuid.UUID, uuid.UUID] = {}
    if emp_ids:
        employees = {
            e.id: e
            for e in (await db.execute(select(Employee).where(Employee.id.in_(emp_ids)))).scalars()
        }
        team_ids = {e.team_id for e in employees.values() if e.team_id}
        if team_ids:
            teams = await db.execute(select(Team.id, Team.leader_employee_id).where(
                Team.id.in_(team_ids), Team.leader_employee_id.is_not(None)
            ))
            for tid, lid in teams.all():
                if lid is not None:
                    leader_of_team[tid] = lid

    def lead_emps(e: Employee | None) -> set[uuid.UUID]:
        if e is None:
            return set()
        out = {e.manager_id} if e.manager_id else set()
        if e.team_id and e.team_id in leader_of_team:
            out.add(leader_of_team[e.team_id])
        return out - {e.id}

    wanted = emp_ids | {x for e in employees.values() for x in lead_emps(e)}
    users_by_emp: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    if wanted:
        linked = await db.execute(select(User.id, User.employee_id).where(
            User.employee_id.in_(wanted), User.is_active.is_(True),
            User.organization_id == org_id,
        ))
        for uid, eid in linked.all():
            if eid is not None:
                users_by_emp[eid].add(uid)

    names = {r.team_lead.strip().lower() for r in rows if r.team_lead.strip()}
    tl_by_name: dict[str, set[uuid.UUID]] = defaultdict(set)
    if names:
        named = await db.execute(
            select(User.id, User.full_name)
            .join(user_roles, user_roles.c.user_id == User.id)
            .join(Role, Role.id == user_roles.c.role_id)
            .where(
                Role.name == "Team Leader", User.is_active.is_(True),
                User.organization_id == org_id, func.lower(User.full_name).in_(names),
            )
        )
        for tl_id, name in named.all():
            tl_by_name[name.strip().lower()].add(tl_id)

    aud = Audience()
    for r in rows:
        emp = employees.get(r.employee_id) if r.employee_id else None
        agents = set(users_by_emp.get(r.employee_id, set())) if r.employee_id else set()
        leads = {u for le in lead_emps(emp) for u in users_by_emp.get(le, set())}
        leads |= tl_by_name.get(r.team_lead.strip().lower(), set())
        aud.agents.setdefault(r.agent_key, set()).update(agents)
        aud.leads.setdefault(r.agent_key, set()).update(leads - agents)
    return aud


# --------------------------------------------------------------- notifications


async def upsert_notification(
    db: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID, *,
    ref: str, kind: str, title: str, link: str, body: str, merge=None,
) -> None:
    """Update the user's unread notification with this `ref`, or create one.
    `merge(old_body)` builds the new body from the old one when updating."""
    existing = (await db.execute(
        select(Notification).where(
            Notification.user_id == user_id, Notification.ref == ref,
            Notification.read_at.is_(None),
        ).order_by(Notification.created_at.desc()).limit(1)
    )).scalar_one_or_none()
    if existing is None:
        db.add(Notification(
            organization_id=org_id, user_id=user_id, kind=kind, ref=ref, link=link,
            title=title, body=body[:BODY_MAX],
        ))
        return
    existing.kind, existing.title, existing.link = kind, title, link
    existing.body = (merge(existing.body) if merge else body)[-BODY_MAX:]
    existing.created_at = datetime.now(UTC)  # resurface it as the newest


def _merge_lines(new: dict[str, str]):
    """TL digests are one line per agent ("Name: change; change")."""

    def merge(old: str) -> str:
        lines: dict[str, str] = {}
        for line in old.splitlines():
            name, sep, text = line.partition(": ")
            if sep:
                lines[name] = text
        for name, text in new.items():
            lines[name] = f"{lines[name]}; {text}" if name in lines else text
        return "\n".join(f"{n}: {t}" for n, t in lines.items())

    return merge


async def notify_changes(
    db: AsyncSession, org_id: uuid.UUID, plan_date: date,
    changes: list[tuple[DaySchedulePlan, str]], *, actor: User,
) -> int:
    """Tell agents (and their TLs) that a *published* day changed. Returns users notified."""
    if not changes:
        return 0
    aud = await resolve_audience(db, org_id, [row for row, _ in changes])
    link = f"/scheduling?date={plan_date.isoformat()}"
    day = fmt_day(plan_date)
    notified: set[uuid.UUID] = set()
    per_lead: dict[uuid.UUID, dict[str, str]] = defaultdict(dict)
    for row, text in changes:
        for uid in aud.agents.get(row.agent_key, set()) - {actor.id}:
            await upsert_notification(
                db, org_id, uid, ref=f"schedule:{plan_date.isoformat()}:{row.agent_key}",
                kind=KIND_CHANGED, title=f"Your schedule changed · {day}", link=link,
                body=text, merge=lambda old, t=text: f"{old}; {t}",
            )
            notified.add(uid)
        for uid in aud.leads.get(row.agent_key, set()) - {actor.id}:
            per_lead[uid][row.agent_name or row.agent_key] = text
    for uid, lines in per_lead.items():
        merge = _merge_lines(lines)
        body = merge("")
        await upsert_notification(
            db, org_id, uid, ref=f"schedule-team:{plan_date.isoformat()}", kind=KIND_CHANGED,
            title=f"Team schedule changed · {day}", link=link, body=body, merge=merge,
        )
        notified.add(uid)
    return len(notified)


async def notify_published(
    db: AsyncSession, org_id: uuid.UUID, rows: list[DaySchedulePlan], *, actor: User
) -> int:
    """One notification per agent for their newly published days, one digest per TL."""
    if not rows:
        return 0
    aud = await resolve_audience(db, org_id, rows)
    by_agent: dict[str, list[DaySchedulePlan]] = defaultdict(list)
    for r in rows:
        by_agent[r.agent_key].append(r)
    notified: set[uuid.UUID] = set()
    lead_agents: dict[uuid.UUID, dict[str, list[date]]] = defaultdict(dict)
    for key, mine in by_agent.items():
        dates = sorted(r.plan_date for r in mine)
        span = fmt_day(dates[0])
        if len(dates) > 1:
            span += f" – {fmt_day(dates[-1])}"
        n = f"{len(dates)} day{'s' if len(dates) > 1 else ''}"
        link = f"/scheduling?date={dates[0].isoformat()}"
        for uid in aud.agents.get(key, set()) - {actor.id}:
            await upsert_notification(
                db, org_id, uid, ref=f"schedule-publish:{key}", kind=KIND_PUBLISHED,
                title="Your schedule is published", link=link,
                body=f"{span} · {n}. Open Scheduling to see your shifts.",
            )
            notified.add(uid)
        for uid in aud.leads.get(key, set()) - {actor.id}:
            lead_agents[uid][mine[0].agent_name or key] = dates
    for uid, agents in lead_agents.items():
        dates = sorted({d for ds in agents.values() for d in ds})
        names = sorted(agents)
        shown = ", ".join(names[:8]) + (f" +{len(names) - 8} more" if len(names) > 8 else "")
        await upsert_notification(
            db, org_id, uid, ref="schedule-publish-team", kind=KIND_PUBLISHED,
            title="Team schedules published",
            link=f"/scheduling?date={dates[0].isoformat()}",
            body=f"{fmt_day(dates[0])} – {fmt_day(dates[-1])} · {len(names)} agent"
            f"{'s' if len(names) > 1 else ''}: {shown}",
        )
        notified.add(uid)
    return len(notified)
