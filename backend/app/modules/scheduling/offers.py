"""VTO / PTO / OT / Leave slots opened from the requirement vs the schedule.

Schedulers open slots for a date and queue (the Scheduling page suggests them
from each interval's over/under staffing: time off where it's over, OT where
it's short, full-day Leave where the whole day has room). Agents see the open
slots with how many are filled / left and claim them, first come first served.
A claim is written straight into the claimant's day plan — a VTO / PTO / Leave
activity, or an OT block — so coverage, exports and notifications (the TL
hears about it like any change to a published day) all follow. Cancelling a
claim takes it back out.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictError,
    NotFoundError,
    PermissionDeniedError,
    ValidationError,
)
from app.modules.identity.models import User
from app.modules.identity.service import record_audit
from app.modules.scheduling import dayplan as dp
from app.modules.scheduling import dayplan_service as days
from app.modules.scheduling import events, schedule_notify
from app.modules.scheduling.models import OfferClaim, ScheduleOffer
from app.modules.scheduling.schemas import OfferClaimIn, OfferPatchIn, OffersUpsertIn
from app.modules.workforce.models import Employee

KIND_LABEL = {"vto": "VTO", "pto": "PTO", "ot": "OT", "leave": "Leave"}
KIND_SLOTS_OPEN = "schedule_slots"
MIN_BLOCK = 5


def _rng(start: int, end: int) -> str:
    return f"{dp.fmt_hm(start)}–{dp.fmt_hm(end)}"


def _when(offer: ScheduleOffer) -> str:
    day = schedule_notify.fmt_day(offer.plan_date)
    return (
        f"{day} (full day)"
        if offer.kind == "leave"
        else f"{day} {_rng(offer.start_min, offer.end_min)}"
    )


def _claim_out(c: OfferClaim) -> dict:
    return {
        "id": c.id,
        "agent_key": c.agent_key,
        "agent_name": c.agent_name or c.agent_key,
        "start": c.start_min,
        "end": c.end_min,
        "status": c.status,
        "created_at": c.created_at,
    }


def offer_out(offer: ScheduleOffer, viewer_keys: set[str] | None = None) -> dict:
    """`viewer_keys` None = staff (every claim); else an agent's own roster ids."""
    active = [c for c in offer.claims if c.status == "filled"]
    mine = next((c for c in active if viewer_keys and c.agent_key in viewer_keys), None)
    shown = active if viewer_keys is None else [c for c in active if c.agent_key in viewer_keys]
    return {
        "id": offer.id,
        "plan_date": offer.plan_date,
        "queue_key": offer.queue_key,
        "queue_name": offer.queue_name or offer.queue_key,
        "kind": offer.kind,
        "start": offer.start_min,
        "end": offer.end_min,
        "capacity": offer.capacity,
        "filled": len(active),
        "left": max(0, offer.capacity - len(active)),
        "channel": offer.channel,
        "status": offer.status,
        "note": offer.note,
        "claims": [_claim_out(c) for c in shown],
        "mine": _claim_out(mine) if mine else None,
    }


async def _get(db: AsyncSession, org_id: uuid.UUID, offer_id: uuid.UUID) -> ScheduleOffer:
    offer = await db.get(ScheduleOffer, offer_id)
    if offer is None or offer.organization_id != org_id:
        raise NotFoundError("Slot not found")
    return offer


# ------------------------------------------------------------------ queries


async def list_offers(
    db: AsyncSession, org_id: uuid.UUID, user: User, start: date, end: date
) -> list[dict]:
    """Staff see every slot with every claim; agents see open slots they're
    eligible for (and any they've taken), with only their own claim."""
    days.check_range(start, end)
    rows = list(
        (
            await db.execute(
                select(ScheduleOffer)
                .where(
                    ScheduleOffer.organization_id == org_id,
                    ScheduleOffer.plan_date >= start,
                    ScheduleOffer.plan_date <= end,
                )
                .order_by(ScheduleOffer.plan_date, ScheduleOffer.start_min, ScheduleOffer.kind)
            )
        ).scalars()
    )
    if days.sees_everyone(user):
        return [offer_out(o) for o in rows]
    keys = await days.user_agent_keys(db, user)
    out = []
    for o in rows:
        mine = any(c.status == "filled" and c.agent_key in keys for c in o.claims)
        eligible = o.eligible is None or bool(keys & set(o.eligible))
        if mine or (o.status == "open" and eligible and keys):
            out.append(offer_out(o, keys))
    return out


# --------------------------------------------------------------- open / edit


async def upsert_offers(
    db: AsyncSession, org_id: uuid.UUID, body: OffersUpsertIn, *, actor: User
) -> dict:
    """Open slots, or update ones already open for the same date, queue, kind
    and times. Capacity never drops below what's already filled."""
    created = updated = 0
    saved: list[ScheduleOffer] = []
    fresh: list[tuple[ScheduleOffer, int]] = []  # (offer, newly available) → notify
    for item in body.items:
        start, end = (0, dp.DAY_MINUTES) if item.kind == "leave" else (item.start, item.end)
        if end - start < MIN_BLOCK:
            raise ValidationError(f"{KIND_LABEL[item.kind]} slot {_rng(start, end)} is too short")
        offer = (
            await db.execute(
                select(ScheduleOffer).where(
                    ScheduleOffer.organization_id == org_id,
                    ScheduleOffer.plan_date == item.plan_date,
                    ScheduleOffer.queue_key == item.queue_key,
                    ScheduleOffer.kind == item.kind,
                    ScheduleOffer.start_min == start,
                    ScheduleOffer.end_min == end,
                )
            )
        ).scalar_one_or_none()
        if offer is None:
            offer = ScheduleOffer(
                organization_id=org_id,
                plan_date=item.plan_date,
                queue_key=item.queue_key,
                kind=item.kind,
                start_min=start,
                end_min=end,
                created_by=actor.id,
                claims=[],
            )
            db.add(offer)
            created += 1
            before_left = 0
        else:
            updated += 1
            before_left = 0 if offer.status != "open" else offer_out(offer)["left"]
        filled = sum(c.status == "filled" for c in offer.claims)
        offer.capacity = max(item.capacity, filled)
        offer.queue_name = item.queue_name or offer.queue_name or item.queue_key
        offer.channel = item.channel if item.kind == "ot" else None
        offer.eligible = item.eligible
        offer.note = item.note
        offer.status = "open"
        saved.append(offer)
        gained = offer.capacity - filled - before_left
        if gained > 0:
            fresh.append((offer, gained))
    await db.flush()
    notified = await _notify_open(db, org_id, fresh, actor=actor) if body.notify else 0
    await events.slots_opened(db, org_id, saved, action="opened")
    await record_audit(
        db,
        actor=actor,
        action="offer.open",
        entity_type="schedule_offer",
        entity_id=",".join(sorted({o.plan_date.isoformat() for o in saved})),
        after={
            "created": created,
            "updated": updated,
            "slots": [f"{o.kind}:{o.queue_key}:{_when(o)}x{o.capacity}" for o in saved][:50],
        },
    )
    return {
        "created": created,
        "updated": updated,
        "notified": notified,
        "offers": [offer_out(o) for o in saved],
    }


async def _notify_open(
    db: AsyncSession, org_id: uuid.UUID, fresh: list[tuple[ScheduleOffer, int]], *, actor: User
) -> int:
    """One pop-up per eligible agent login: "Mon 26 Oct: 2 VTO · 1 OT" per date."""
    per_key: dict[str, dict[date, dict[str, int]]] = defaultdict(
        lambda: defaultdict(lambda: defaultdict(int))
    )
    anyone: dict[date, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for offer, n in fresh:
        if offer.eligible is None:
            anyone[offer.plan_date][offer.kind] += n
        for key in offer.eligible or []:
            per_key[key][offer.plan_date][offer.kind] += n
    users_by_key: dict[str, set[uuid.UUID]] = defaultdict(set)
    q = select(User.id, Employee.employee_code).join(Employee, Employee.id == User.employee_id)
    q = q.where(
        User.organization_id == org_id, User.is_active.is_(True), Employee.organization_id == org_id
    )
    if not anyone:
        q = q.where(Employee.employee_code.in_(list(per_key)))
    for uid, code in (await db.execute(q)).all():
        users_by_key[code].add(uid)

    def lines(by_date: dict[date, dict[str, int]]) -> dict[str, str]:
        return {
            schedule_notify.fmt_day(d): " · ".join(
                f"{n} {KIND_LABEL[k]}" for k, n in sorted(c.items())
            )
            for d, c in sorted(by_date.items())
        }

    notified = 0
    for key, uids in users_by_key.items():
        merged: dict[date, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        for src in (per_key.get(key, {}), anyone):
            for d, counts in src.items():
                for k, n in counts.items():
                    merged[d][k] += n
        if not merged:
            continue
        new = lines(merged)

        def merge(old: str, new: dict[str, str] = new) -> str:
            kept = dict(line.split(": ", 1) for line in old.splitlines() if ": " in line)
            kept.update(new)
            return "\n".join(f"{d}: {t}" for d, t in kept.items())

        for uid in uids - {actor.id}:
            await schedule_notify.upsert_notification(
                db,
                org_id,
                uid,
                ref="slots-open",
                kind=KIND_SLOTS_OPEN,
                title="New slots open — VTO / PTO / OT / Leave",
                link="/scheduling",
                body=merge(""),
                merge=merge,
            )
            notified += 1
    return notified


async def patch_offer(
    db: AsyncSession, org_id: uuid.UUID, offer_id: uuid.UUID, body: OfferPatchIn, *, actor: User
) -> ScheduleOffer:
    offer = await _get(db, org_id, offer_id)
    filled = sum(c.status == "filled" for c in offer.claims)
    before = {"capacity": offer.capacity, "status": offer.status}
    if body.capacity is not None:
        if body.capacity < filled:
            raise ValidationError(f"{filled} already taken — capacity can't go below that")
        offer.capacity = body.capacity
    if body.status is not None:
        offer.status = body.status
    await db.flush()
    await events.slots_opened(db, org_id, [offer], action="updated")
    await record_audit(
        db,
        actor=actor,
        action="offer.update",
        entity_type="schedule_offer",
        entity_id=offer.id,
        before=before,
        after={"capacity": offer.capacity, "status": offer.status},
    )
    return offer


async def delete_offer(
    db: AsyncSession, org_id: uuid.UUID, offer_id: uuid.UUID, *, actor: User
) -> None:
    offer = await _get(db, org_id, offer_id)
    if any(c.status == "filled" for c in offer.claims):
        raise ConflictError(
            "Agents have taken this slot — close it instead, or cancel their claims"
        )
    await db.delete(offer)
    await record_audit(
        db, actor=actor, action="offer.delete", entity_type="schedule_offer", entity_id=offer_id
    )


# ------------------------------------------------------------- claim / cancel


def _place(offer: ScheduleOffer, day: dp.AgentDay, seg_id: str) -> tuple[dp.AgentDay, int, int]:
    """The claimant's day with the slot written in, and the block's times."""
    s, e = day.shift_start, day.shift_end
    label = KIND_LABEL[offer.kind]
    if offer.kind == "leave":
        result = dp.mark_aux(day, "leave", s, e - s, True, seg_id, "Leave slot")
        lo, hi = s, e
    elif offer.kind in ("vto", "pto"):
        lo, hi = max(offer.start_min, s), min(offer.end_min, e)
        if hi - lo < MIN_BLOCK:
            raise ValidationError(
                f"You're not working {_rng(offer.start_min, offer.end_min)} that day"
            )
        result = dp.mark_aux(day, offer.kind, lo, hi - lo, False, seg_id, f"{label} slot")  # type: ignore[arg-type]
    else:
        lo, hi = offer.start_min, offer.end_min
        if lo < s < hi and hi <= e:
            hi = s  # the part before the shift
        elif lo < e < hi and lo >= s:
            lo = e  # the part after it
        elif lo < s and hi > e:
            lo = e  # straddles the whole shift: take the part after it
        if lo < e and hi > s:
            raise ValidationError(f"You're already working {_rng(offer.start_min, offer.end_min)}")
        channel = offer.channel or dp.primary_channel(day)
        placed = dp.propose_overtime(day, channel, "custom", 0, lo, hi)  # type: ignore[arg-type]
        if isinstance(placed, str):
            raise ValidationError(placed)
        result = dp.with_overtime_added(day, dp.ChannelSeg(seg_id, channel, lo, hi))  # type: ignore[arg-type]
    if isinstance(result, str):
        raise ValidationError(result)
    return result, lo, hi


async def claim(
    db: AsyncSession, org_id: uuid.UUID, offer_id: uuid.UUID, body: OfferClaimIn, *, user: User
) -> ScheduleOffer:
    offer = await _get(db, org_id, offer_id)
    staff = days.sees_drafts(user)
    when = _when(offer)
    if body.agent_key and not staff:
        if body.agent_key not in await days.user_agent_keys(db, user):
            raise PermissionDeniedError("You can only take slots for yourself")
    if body.agent_key:
        key = body.agent_key
    else:
        mine = await days.user_agent_keys(db, user)
        rows = await days.list_day_plans(db, org_id, offer.plan_date, sorted(mine)) if mine else []
        if not rows:
            raise ValidationError(
                f"You don't have a schedule on {schedule_notify.fmt_day(offer.plan_date)}"
            )
        key = rows[0].agent_key
    if offer.plan_date < date.today():
        raise ValidationError("This slot is in the past")
    if offer.status != "open":
        raise ConflictError("This slot is closed")
    if offer.eligible is not None and key not in offer.eligible:
        raise ValidationError(
            f"This slot is for agents skilled on {offer.queue_name or offer.queue_key}"
        )
    rows = await days.list_day_plans(db, org_id, offer.plan_date, [key])
    if not rows:
        raise ValidationError(
            f"No saved schedule for {key} on {schedule_notify.fmt_day(offer.plan_date)}"
        )
    row = rows[0]
    if not staff and row.published_at is None:
        raise ValidationError("Your schedule for that day isn't published yet")
    active = [c for c in offer.claims if c.status == "filled"]
    if any(c.agent_key == key for c in active):
        raise ConflictError("Already taken by this agent")
    if len(active) >= offer.capacity:
        raise ConflictError(f"No {KIND_LABEL[offer.kind]} slots left")

    seg_id = f"{offer.kind}{uuid.uuid4().hex[:10]}"
    after, lo, hi = _place(offer, days.row_to_day(row), seg_id)
    name = row.agent_name or key
    _, skipped = await days.apply_each(
        db,
        org_id,
        offer.plan_date,
        [key],
        actor=user,
        action="offer.claim",
        detail=f"{KIND_LABEL[offer.kind]} slot {when} taken by {name}",
        fn=lambda *_: after,
    )
    if skipped:
        raise ValidationError(skipped[0]["reason"])
    c = OfferClaim(
        organization_id=org_id,
        agent_key=key,
        agent_name=name,
        user_id=user.id,
        seg_id=seg_id,
        start_min=lo,
        end_min=hi,
        status="filled",
    )
    offer.claims.append(c)
    await db.flush()
    await db.refresh(c, ["created_at"])
    await events.slot_claim(db, org_id, "slot.claimed", offer, c)
    return offer


def _without_window(ot: list[dp.ChannelSeg], s: int, e: int) -> list[dp.ChannelSeg]:
    out: list[dp.ChannelSeg] = []
    for o in ot:
        if o.end <= s or o.start >= e:
            out.append(o)
            continue
        if o.start < s:
            out.append(dp.ChannelSeg(o.id, o.channel, o.start, s))
        if o.end > e:
            out.append(dp.ChannelSeg(f"{o.id}r" if o.start < s else o.id, o.channel, e, o.end))
    return out


async def cancel_claim(
    db: AsyncSession, org_id: uuid.UUID, claim_id: uuid.UUID, *, user: User
) -> ScheduleOffer:
    c = await db.get(OfferClaim, claim_id)
    if c is None or c.organization_id != org_id:
        raise NotFoundError("Claim not found")
    offer = await _get(db, org_id, c.offer_id)
    if c.status != "filled":
        raise ConflictError("Already cancelled")
    if not days.sees_drafts(user):
        if c.agent_key not in await days.user_agent_keys(db, user):
            raise PermissionDeniedError("You can only cancel your own slots")
        if offer.plan_date < date.today():
            raise ValidationError("This slot is in the past")

    rows = await days.list_day_plans(db, org_id, offer.plan_date, [c.agent_key])
    if rows:
        day = days.row_to_day(rows[0])
        if offer.kind == "ot":
            day.ot = _without_window(day.ot, c.start_min, c.end_min)
        else:
            day.activities = [a for a in day.activities if a.id != c.seg_id]
        await days.apply_each(
            db,
            org_id,
            offer.plan_date,
            [c.agent_key],
            actor=user,
            action="offer.cancel",
            detail=f"{KIND_LABEL[offer.kind]} slot {_when(offer)} given back by {c.agent_name}",
            fn=lambda *_: day,
        )
    c.status, c.cancelled_by, c.cancelled_at = "cancelled", user.id, datetime.now(UTC)
    await db.flush()
    await events.slot_claim(db, org_id, "slot.released", offer, c)
    return offer
