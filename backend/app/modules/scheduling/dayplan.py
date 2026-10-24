"""Omni-channel day plans — pure domain logic (no DB, no HTTP).

A Python port of the frontend's `src/lib/domain/channels.ts`, so the server
enforces exactly the rules the Scheduling UI does and can perform the same
operations (move/resize, OT, mark AUX, bulk move) for API callers:

* An agent's day is a contracted shift split into channel blocks
  (phone / chat / email) at minute precision, with break/lunch segments cut
  out of them, overtime (OT) blocks outside the shift, and an overlay layer of
  off-phone activities (meeting, training, coaching, LOA, absence, other).
* All times are minutes from midnight (0..1440).

Keep this module and `channels.ts` in step — `tests/test_dayplan.py` mirrors
the frontend's `channels.test.ts` cases.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from typing import Literal

Channel = Literal["phone", "chat", "email"]
ActivityType = Literal["meeting", "training", "coaching", "loa", "absence", "other"]
BreakType = Literal["break", "lunch"]
AuxKind = Literal["break", "lunch", "meeting", "training", "coaching", "loa", "absence", "other"]
Edge = Literal["start", "end"]

DAY_MINUTES = 24 * 60
AUX_SNAP = 5
MIN_LEN = {"aux": 5, "channel": 15, "ot": 15, "shift": 60}
#: Default operating window (matches the frontend's 07:00–19:00 intervals).
OPERATING_DAY = (7 * 60, 19 * 60)

CHANNELS: dict[str, dict[str, str]] = {
    "phone": {"label": "Phone", "short": "PH"},
    "chat": {"label": "Chat", "short": "CH"},
    "email": {"label": "Email", "short": "EM"},
}
ACTIVITIES: dict[str, dict] = {
    "meeting": {"label": "Meeting", "short": "MTG", "full_shift": False},
    "training": {"label": "Training", "short": "TRN", "full_shift": False},
    "coaching": {"label": "Coaching", "short": "COA", "full_shift": False},
    "loa": {"label": "LOA", "short": "LOA", "full_shift": True},
    "absence": {"label": "Absence", "short": "ABS", "full_shift": True},
    "other": {"label": "Other", "short": "OTH", "full_shift": False},
}


def fmt_hm(mins: int) -> str:
    return f"{mins // 60:02d}:{mins % 60:02d}"


# --------------------------------------------------------------------------- model


@dataclass
class BreakSeg:
    id: str
    type: BreakType
    label: str
    start: int
    end: int


@dataclass
class ChannelSeg:
    id: str
    channel: Channel
    start: int
    end: int


@dataclass
class ActivitySeg:
    id: str
    type: ActivityType
    start: int
    end: int
    note: str | None = None


@dataclass
class AgentDay:
    """One agent's day in absolute minutes — the unit every edit operates on."""

    shift_start: int
    shift_end: int
    breaks: list[BreakSeg] = field(default_factory=list)
    channels: list[ChannelSeg] = field(default_factory=list)
    ot: list[ChannelSeg] = field(default_factory=list)
    activities: list[ActivitySeg] = field(default_factory=list)

    def copy(self) -> AgentDay:
        return AgentDay(
            self.shift_start,
            self.shift_end,
            [replace(b) for b in self.breaks],
            [replace(c) for c in self.channels],
            [replace(o) for o in self.ot],
            [replace(a) for a in self.activities],
        )

    def sorted(self) -> AgentDay:
        d = self.copy()
        for lst in (d.breaks, d.channels, d.ot, d.activities):
            lst.sort(key=lambda x: x.start)
        return d


@dataclass
class TimelineSeg:
    kind: Literal["channel", "break", "lunch", "unassigned", "ot", "activity"]
    start: int
    end: int
    label: str
    channel: Channel | None = None
    activity: ActivityType | None = None
    seg_id: str | None = None


def _clamp(v: int, lo: int, hi: int) -> int:
    return min(hi, max(lo, v))


#: Any block on a day — all share `id`, `start`, `end`.
Block = BreakSeg | ChannelSeg | ActivitySeg


def _overlapping(items: Sequence[Block]) -> bool:
    s = sorted(items, key=lambda x: x.start)
    return any(b.start < a.end for a, b in zip(s, s[1:]))


# ---------------------------------------------------------------------- validation


def validate_day(day: AgentDay) -> list[str]:
    """Every rule the UI enforces. Empty list = valid."""
    s, e = day.shift_start, day.shift_end
    errs: list[str] = []
    if not (0 <= s < e <= DAY_MINUTES):
        errs.append("Shift must start before it ends, within the calendar day.")
        return errs
    if e - s < MIN_LEN["shift"]:
        errs.append(f"Shift must be at least {MIN_LEN['shift']} min.")
    groups: tuple[tuple[str, Sequence[Block], bool], ...] = (
        ("Channel block", day.channels, True),
        ("Break", day.breaks, True),
        ("Activity", day.activities, True),
        ("OT block", day.ot, False),
    )
    for kind, items, inside in groups:
        for i, x in enumerate(items, 1):
            if x.end <= x.start:
                errs.append(f"{kind} {i}: end must be after start.")
            elif x.start < 0 or x.end > DAY_MINUTES:
                errs.append(f"{kind} {i} must fall within the calendar day.")
            elif inside and (x.start < s or x.end > e):
                errs.append(f"{kind} {i} must sit inside the shift ({fmt_hm(s)}–{fmt_hm(e)}).")
            elif not inside and x.start < e and x.end > s:
                errs.append(
                    f"{kind} {i} overlaps the contracted shift — OT must be before or after it."
                )
        if _overlapping(items):
            errs.append(f"{kind}s overlap each other.")
        ids = [x.id for x in items]
        if len(ids) != len(set(ids)):
            errs.append(f"{kind} ids must be unique.")
    return errs


# ------------------------------------------------------------------- default plan


def _hash(s: str) -> int:
    h = 7
    for ch in s:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return h


def default_channels(agent_key: str, shift_start: int, shift_end: int) -> list[ChannelSeg]:
    """Same deterministic starting alignment as the frontend's defaultChannelSegments."""
    s, e = shift_start, shift_end
    mid = s + round((e - s) / 2 / 15) * 15
    bucket = _hash(agent_key) % 10
    if bucket <= 4:
        return [ChannelSeg("d1", "phone", s, e)]
    if bucket <= 6:
        return [ChannelSeg("d1", "phone", s, mid), ChannelSeg("d2", "chat", mid, e)]
    if bucket == 7:
        return [ChannelSeg("d1", "phone", s, mid), ChannelSeg("d2", "email", mid, e)]
    if bucket == 8:
        return [ChannelSeg("d1", "chat", s, e)]
    return [ChannelSeg("d1", "email", s, e)]


# ------------------------------------------------------------------------ timeline


def _subtract(start: int, end: int, cuts: list) -> list[tuple[int, int]]:
    pieces = [(start, end)]
    for c in cuts:
        nxt: list[tuple[int, int]] = []
        for a, b in pieces:
            if c.end <= a or c.start >= b:
                nxt.append((a, b))
                continue
            if c.start > a:
                nxt.append((a, c.start))
            if c.end < b:
                nxt.append((c.end, b))
        pieces = nxt
    return pieces


def day_timeline(day: AgentDay) -> list[TimelineSeg]:
    """Contiguous base segments (channel / break / lunch / unassigned / OT) plus
    overlay activity segments (which don't cut the base layer)."""
    s, e = day.shift_start, day.shift_end
    brks = [b for b in day.breaks if b.end > s and b.start < e]
    out: list[TimelineSeg] = []
    for c in day.channels:
        for a, b in _subtract(max(s, c.start), min(e, c.end), brks):
            out.append(
                TimelineSeg(
                    "channel", a, b, CHANNELS[c.channel]["label"], channel=c.channel, seg_id=c.id
                )
            )
    for a, b in _subtract(s, e, [*brks, *day.channels]):
        out.append(TimelineSeg("unassigned", a, b, "Unassigned"))
    for br in brks:
        out.append(TimelineSeg(br.type, br.start, br.end, br.label, seg_id=br.id))
    for o in day.ot:
        out.append(
            TimelineSeg(
                "ot",
                o.start,
                o.end,
                f"OT · {CHANNELS[o.channel]['label']}",
                channel=o.channel,
                seg_id=o.id,
            )
        )
    for x in day.activities:
        label = ACTIVITIES[x.type]["label"] + (f" · {x.note}" if x.note else "")
        out.append(TimelineSeg("activity", x.start, x.end, label, activity=x.type, seg_id=x.id))
    out.sort(key=lambda t: t.start)
    return out


def primary_channel(day: AgentDay) -> Channel:
    mins = {"phone": 0, "chat": 0, "email": 0}
    for c in day.channels:
        mins[c.channel] += c.end - c.start
    best: Channel = "phone"
    for ch in ("phone", "chat", "email"):
        if mins[ch] > mins[best]:
            best = ch  # type: ignore[assignment]
    return best


# ------------------------------------------------------------ move / resize (EditOp)


@dataclass(frozen=True)
class EditOp:
    """kind ∈ aux-move | aux-resize | channel-resize | ot-resize | activity-move |
    activity-resize | shift-resize."""

    kind: str
    seg_id: str | None = None
    edge: Edge | None = None


def _op_list(day: AgentDay, op: EditOp) -> Sequence[Block]:
    if op.kind == "channel-resize":
        return day.channels
    if op.kind == "ot-resize":
        return day.ot
    if op.kind in ("activity-move", "activity-resize"):
        return day.activities
    return day.breaks


def find_block(day: AgentDay, op: EditOp) -> Block | None:
    """The block an op addresses (None if absent, or for shift-resize)."""
    if op.kind == "shift-resize":
        return None
    return next((x for x in _op_list(day, op) if x.id == op.seg_id), None)


def edit_value(day: AgentDay, op: EditOp) -> int:
    if op.kind == "shift-resize":
        return day.shift_start if op.edge == "start" else day.shift_end
    me = next((x for x in _op_list(day, op) if x.id == op.seg_id), None)
    if me is None:
        return 0
    return me.start if op.kind in ("aux-move", "activity-move") or op.edge == "start" else me.end


def edit_bounds(day: AgentDay, op: EditOp) -> tuple[int, int]:
    """[lo, hi] the dragged value may take — blocks stay inside their shift (OT
    outside), never pass a neighbour, and keep a minimum length."""
    s, e = day.shift_start, day.shift_end
    v = edit_value(day, op)

    if op.kind == "shift-resize":
        inner: list[Block] = [*day.breaks, *day.activities]
        if op.edge == "start":
            ot_before = [o.end for o in day.ot if o.end <= s]
            first_inner = min([e, *(x.start for x in inner)])
            return max([0, *ot_before]), min(first_inner, e - MIN_LEN["shift"])
        ot_after = [o.start for o in day.ot if o.start >= e]
        last_inner = max([s, *(x.end for x in inner)])
        return max(last_inner, s + MIN_LEN["shift"]), min([DAY_MINUTES, *ot_after])

    if op.kind in ("aux-move", "aux-resize", "activity-move", "activity-resize"):
        lst = _op_list(day, op)
        me = next((x for x in lst if x.id == op.seg_id), None)
        if me is None:
            return v, v
        others = [x for x in lst if x.id != op.seg_id]
        prev_end = max([s, *(x.end for x in others if x.end <= me.start)])
        next_start = min([e, *(x.start for x in others if x.start >= me.end)])
        if op.kind in ("aux-move", "activity-move"):
            return prev_end, next_start - (me.end - me.start)
        return (
            (prev_end, me.end - MIN_LEN["aux"])
            if op.edge == "start"
            else (me.start + MIN_LEN["aux"], next_start)
        )

    if op.kind == "channel-resize":
        me = next((c for c in day.channels if c.id == op.seg_id), None)
        if me is None:
            return v, v
        others = [c for c in day.channels if c.id != op.seg_id]
        if op.edge == "start":
            adj = next((c for c in others if c.end == me.start), None)
            floor = (
                adj.start + MIN_LEN["channel"]
                if adj
                else max([s, *(c.end for c in others if c.end <= me.start)])
            )
            return floor, me.end - MIN_LEN["channel"]
        adj = next((c for c in others if c.start == me.end), None)
        ceil = (
            adj.end - MIN_LEN["channel"]
            if adj
            else min([e, *(c.start for c in others if c.start >= me.end)])
        )
        return me.start + MIN_LEN["channel"], ceil

    # ot-resize
    me = next((o for o in day.ot if o.id == op.seg_id), None)
    if me is None:
        return v, v
    others = [o for o in day.ot if o.id != op.seg_id]
    before_shift = me.end <= s
    if op.edge == "start":
        floor = max([0 if before_shift else e, *(o.end for o in others if o.end <= me.start)])
        return floor, me.end - MIN_LEN["ot"]
    ceil = min(
        [s if before_shift else DAY_MINUTES, *(o.start for o in others if o.start >= me.end)]
    )
    return me.start + MIN_LEN["ot"], ceil


def apply_edit(day: AgentDay, op: EditOp, value: int) -> AgentDay:
    """Apply one move/resize (value clamped to edit_bounds), returning a new day."""
    lo, hi = edit_bounds(day, op)
    v = _clamp(value, lo, hi)
    nxt = day.copy()

    if op.kind == "shift-resize":
        old = day.shift_start if op.edge == "start" else day.shift_end
        if op.edge == "start":
            nxt.shift_start = v
        else:
            nxt.shift_end = v
        chans = []
        for c in nxt.channels:
            if op.edge == "start" and c.start == old:
                c.start = v
            elif op.edge == "end" and c.end == old:
                c.end = v
            c.start, c.end = max(c.start, nxt.shift_start), min(c.end, nxt.shift_end)
            if c.end > c.start:
                chans.append(c)
        nxt.channels = chans
        return nxt
    if op.kind in ("aux-move", "activity-move"):
        b = next(x for x in _op_list(nxt, op) if x.id == op.seg_id)
        b.end, b.start = v + (b.end - b.start), v
        return nxt
    if op.kind in ("aux-resize", "ot-resize", "activity-resize"):
        item = next(x for x in _op_list(nxt, op) if x.id == op.seg_id)
        setattr(item, op.edge or "end", v)
        return nxt
    me = next(c for c in nxt.channels if c.id == op.seg_id)
    if op.edge == "start":
        adj = next((c for c in nxt.channels if c.id != me.id and c.end == me.start), None)
        if adj:
            adj.end = v
        me.start = v
    else:
        adj = next((c for c in nxt.channels if c.id != me.id and c.start == me.end), None)
        if adj:
            adj.start = v
        me.end = v
    return nxt


def equivalent_op(source: AgentDay, op: EditOp, target: AgentDay) -> EditOp | None:
    """The same edit on another agent's day (bulk drag): shift edges always match;
    breaks by segment id; activities by type + start time; channel/OT never."""
    if op.kind == "shift-resize":
        return op
    if op.kind in ("aux-move", "aux-resize"):
        return op if any(b.id == op.seg_id for b in target.breaks) else None
    if op.kind in ("activity-move", "activity-resize"):
        src = next((x for x in source.activities if x.id == op.seg_id), None)
        match = src and next(
            (x for x in target.activities if x.type == src.type and x.start == src.start), None
        )
        return replace(op, seg_id=match.id) if match else None
    return None


def move_day(day: AgentDay, delta: int) -> AgentDay:
    """Move the whole day (shift, channels, breaks, activities, OT) by `delta`
    minutes, clamped so nothing leaves the calendar day."""
    first = min([day.shift_start, *(o.start for o in day.ot)])
    last = max([day.shift_end, *(o.end for o in day.ot)])
    d = _clamp(delta, -first, DAY_MINUTES - last)
    nxt = day.copy()
    nxt.shift_start += d
    nxt.shift_end += d
    for lst in (nxt.breaks, nxt.channels, nxt.ot, nxt.activities):
        for x in lst:
            x.start += d
            x.end += d
    return nxt


def describe_edit(before: AgentDay, after: AgentDay, op: EditOp) -> str:
    if op.kind == "shift-resize":
        return (
            f"Shift {fmt_hm(before.shift_start)}–{fmt_hm(before.shift_end)} → "
            f"{fmt_hm(after.shift_start)}–{fmt_hm(after.shift_end)}"
        )
    a = next(x for x in _op_list(before, op) if x.id == op.seg_id)
    b = next(x for x in _op_list(after, op) if x.id == op.seg_id)
    if isinstance(b, ChannelSeg):
        name = ("OT " if op.kind == "ot-resize" else "") + CHANNELS[b.channel]["label"]
    elif isinstance(b, ActivitySeg):
        name = ACTIVITIES[b.type]["label"]
    else:
        name = b.label
    return f"{name} {fmt_hm(a.start)}–{fmt_hm(a.end)} → {fmt_hm(b.start)}–{fmt_hm(b.end)}"


# ------------------------------------------------------------------- OT & AUX


def propose_overtime(
    day: AgentDay,
    channel: Channel,
    timing: Literal["after", "before", "custom"],
    duration: int,
    start: int | None = None,
    end: int | None = None,
) -> tuple[int, int] | str:
    """Where a requested OT block lands, or why it can't (same as proposeOvertime)."""
    s, e = day.shift_start, day.shift_end
    if timing == "after":
        st = max([e, *(o.end for o in day.ot if o.start >= e)])
        en = st + duration
    elif timing == "before":
        en = min([s, *(o.start for o in day.ot if o.end <= s)])
        st = en - duration
    else:
        st, en = start or 0, end or 0
    if en - st < MIN_LEN["ot"]:
        return f"OT must be at least {MIN_LEN['ot']} min"
    if st < 0 or en > DAY_MINUTES:
        return "Would run past midnight"
    if st < e and en > s:
        return f"Overlaps shift {fmt_hm(s)}–{fmt_hm(e)}"
    clash = next((o for o in day.ot if st < o.end and en > o.start), None)
    if clash:
        return f"Clashes with OT {fmt_hm(clash.start)}–{fmt_hm(clash.end)}"
    return st, en


def with_overtime_added(day: AgentDay, seg: ChannelSeg) -> AgentDay:
    """Add an OT block, merging it with touching OT on the same channel."""
    merged = replace(seg)
    rest: list[ChannelSeg] = []
    for o in day.ot:
        if o.channel == merged.channel and (o.end == merged.start or o.start == merged.end):
            merged = ChannelSeg(
                o.id, merged.channel, min(o.start, merged.start), max(o.end, merged.end)
            )
        else:
            rest.append(replace(o))
    nxt = day.copy()
    nxt.ot = sorted([*rest, merged], key=lambda x: x.start)
    return nxt


def mark_aux(
    day: AgentDay,
    kind: AuxKind,
    start: int,
    length: int,
    full_shift: bool,
    seg_id: str,
    note: str | None = None,
) -> AgentDay | str:
    """Mark any AUX (break/lunch → break layer; activities → overlay). Returns the
    new day, or the reason it can't be placed (same rules as markAux)."""
    s, e = day.shift_start, day.shift_end
    fr, to = (s, e) if full_shift else (start, start + length)
    if to - fr < MIN_LEN["aux"]:
        return f"Must be at least {MIN_LEN['aux']} min"
    if fr < s or to > e:
        return f"Outside shift {fmt_hm(s)}–{fmt_hm(e)}"
    nxt = day.copy()
    if kind in ("break", "lunch"):
        clash = next((b for b in day.breaks if fr < b.end and to > b.start), None)
        if clash:
            return f"Clashes with {clash.label} {fmt_hm(clash.start)}–{fmt_hm(clash.end)}"
        nxt.breaks.append(BreakSeg(seg_id, kind, "Lunch" if kind == "lunch" else "Break", fr, to))  # type: ignore[arg-type]
        nxt.breaks.sort(key=lambda b: b.start)
    else:
        act = next((x for x in day.activities if fr < x.end and to > x.start), None)
        if act:
            name = ACTIVITIES[act.type]["label"]
            return f"Clashes with {name} {fmt_hm(act.start)}–{fmt_hm(act.end)}"
        nxt.activities.append(ActivitySeg(seg_id, kind, fr, to, note or None))  # type: ignore[arg-type]
        nxt.activities.sort(key=lambda x: x.start)
    return nxt


def unmark_activities_at(day: AgentDay, at: int) -> AgentDay:
    nxt = day.copy()
    nxt.activities = [x for x in nxt.activities if not (x.start <= at < x.end)]
    return nxt


def staggered_window(
    i: int, start: int, length: int, group_size: int, every: int
) -> tuple[int, int]:
    wave = i // max(1, group_size)
    s = start + wave * every
    return s, s + length


# ---------------------------------------------------------- coverage & export


def timeline_window(days: list[AgentDay]) -> tuple[int, int]:
    lo, hi = OPERATING_DAY
    for d in days:
        lo, hi = min(lo, d.shift_start), max(hi, d.shift_end)
        for o in d.ot:
            lo, hi = min(lo, o.start), max(hi, o.end)
    return (lo // 60) * 60, math.ceil(hi / 60) * 60


def coverage(timelines: list[list[TimelineSeg]], window: tuple[int, int]) -> list[dict]:
    """Minute-weighted heads per channel per 30-min slot; time under an activity
    doesn't count (tallied as `activity` heads instead)."""
    lo, hi = window
    slots = [
        {"start": lo + i * 30, "phone": 0.0, "chat": 0.0, "email": 0.0, "ot": 0.0, "activity": 0.0}
        for i in range(math.ceil((hi - lo) / 30))
    ]

    def add(a: int, b: int, key: str, also_ot: bool = False) -> None:
        for slot in slots:
            ov = min(b, slot["start"] + 30) - max(a, slot["start"])
            if ov > 0:
                slot[key] += ov / 30
                if also_ot:
                    slot["ot"] += ov / 30

    for tl in timelines:
        acts = [t for t in tl if t.kind == "activity"]
        for t in acts:
            add(t.start, t.end, "activity")
        for t in tl:
            if t.channel is None:
                continue
            for a, b in _subtract(t.start, t.end, acts):
                add(a, b, t.channel, also_ot=t.kind == "ot")
    for slot in slots:
        for k in ("phone", "chat", "email", "ot", "activity"):
            slot[k] = round(slot[k], 1)
    return slots


def _code(t: TimelineSeg) -> str:
    if t.kind == "channel":
        return CHANNELS[t.channel]["short"]  # type: ignore[index]
    if t.kind == "ot":
        return f"OT-{CHANNELS[t.channel]['short']}"  # type: ignore[index]
    if t.kind == "activity":
        return ACTIVITIES[t.activity]["short"]  # type: ignore[index]
    return {"break": "BRK", "lunch": "LUN", "unassigned": "—"}[t.kind]


@dataclass
class ExportAgent:
    key: str
    name: str
    team: str
    day: AgentDay


def export_sheets(agents: list[ExportAgent]) -> dict[str, list[dict]]:
    """Same five sheets as the frontend export: segments, agent summary,
    15-min interval grid, channel coverage, legend."""
    window = timeline_window([a.day for a in agents])
    tls = [(a, day_timeline(a.day)) for a in agents]

    def shift(a: ExportAgent) -> str:
        return f"{fmt_hm(a.day.shift_start)}–{fmt_hm(a.day.shift_end)}"

    def type_of(t: TimelineSeg) -> str:
        return {
            "ot": "Overtime",
            "channel": "Channel work",
            "activity": "Activity (overlay)",
            "unassigned": "Unassigned",
            "lunch": "Lunch",
            "break": "Break",
        }[t.kind]

    segments = [
        {
            "Agent": a.name,
            "Agent ID": a.key,
            "Team": a.team,
            "Shift": shift(a),
            "Activity": (
                CHANNELS[t.channel]["label"]
                if t.kind in ("channel", "ot") and t.channel
                else ACTIVITIES[t.activity]["label"]
                if t.kind == "activity" and t.activity
                else t.label
            ),
            "Type": type_of(t),
            "Code": _code(t),
            "Note": " · ".join(t.label.split(" · ")[1:]) if t.kind == "activity" else "",
            "Start": fmt_hm(t.start),
            "End": fmt_hm(t.end),
            "Duration (min)": t.end - t.start,
        }
        for a, tl in tls
        for t in tl
    ]

    summary = []
    for a, tl in tls:

        def mins(pred: Callable[[TimelineSeg], bool], tl: list[TimelineSeg] = tl) -> int:
            return sum(t.end - t.start for t in tl if pred(t))

        row = {
            "Agent": a.name,
            "Agent ID": a.key,
            "Team": a.team,
            "Shift": shift(a),
            "Primary channel": CHANNELS[primary_channel(a.day)]["label"],
            "Phone hrs": round(
                mins(lambda t: t.kind == "channel" and t.channel == "phone") / 60, 2
            ),
            "Chat hrs": round(mins(lambda t: t.kind == "channel" and t.channel == "chat") / 60, 2),
            "Email hrs": round(
                mins(lambda t: t.kind == "channel" and t.channel == "email") / 60, 2
            ),
            "Break/lunch min": mins(lambda t: t.kind in ("break", "lunch")),
            "Unassigned min": mins(lambda t: t.kind == "unassigned"),
            "OT hrs": round(mins(lambda t: t.kind == "ot") / 60, 2),
        }
        for key, meta in ACTIVITIES.items():
            row[f"{meta['label']} min"] = sum(
                t.end - t.start for t in tl if t.kind == "activity" and t.activity == key
            )
        summary.append(row)

    grid = []
    for a, tl in tls:
        row = {"Agent": a.name, "Shift": shift(a)}
        for t_ in range(window[0], window[1], 15):
            hit = [t for t in tl if t.start <= t_ < t.end]
            seg = (
                next((t for t in hit if t.kind == "activity"), None)
                or next((t for t in hit if t.kind in ("break", "lunch")), None)
                or (hit[0] if hit else None)
            )
            row[fmt_hm(t_)] = _code(seg) if seg else ""
        grid.append(row)

    cov = [
        {
            "Interval": f"{fmt_hm(s['start'])}–{fmt_hm(s['start'] + 30)}",
            "Phone HC": s["phone"],
            "Chat HC": s["chat"],
            "Email HC": s["email"],
            "Total HC": round(s["phone"] + s["chat"] + s["email"], 1),
            "of which OT": s["ot"],
            "In activities": s["activity"],
        }
        for s in coverage([tl for _, tl in tls], window)
    ]

    legend = (
        [{"Code": m["short"], "Meaning": f"{m['label']} (in shift)"} for m in CHANNELS.values()]
        + [
            {"Code": f"OT-{m['short']}", "Meaning": f"Overtime on {m['label']}"}
            for m in CHANNELS.values()
        ]
        + [{"Code": "BRK", "Meaning": "Break"}, {"Code": "LUN", "Meaning": "Lunch"}]
        + [
            {
                "Code": m["short"],
                "Meaning": f"{m['label']} — overlay activity, agent off the channel",
            }
            for m in ACTIVITIES.values()
        ]
        + [{"Code": "—", "Meaning": "On shift, no channel assigned"}]
    )
    return {
        "Schedule segments": segments,
        "Agent summary": summary,
        "Interval grid (15 min)": grid,
        "Channel coverage": cov,
        "Legend": legend,
    }
