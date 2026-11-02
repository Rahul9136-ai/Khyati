# ruff: noqa: E501  (long lines are inline-styled email HTML)
"""The report dashboard, built on the server so it can go out with nobody signed in:
figures from published schedules, attendance and queue actuals, rendered as
email-safe HTML (tables and inline styles; no scripts or remote images).

Totals only: no named individuals, since these go to lists of people.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from html import escape

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.reporting import service
from app.modules.scheduling import dayplan_service as days
from app.modules.scheduling import labour_law, settings_service
from app.modules.workforce.models import Organization

FREQUENCY_LABEL = {"daily": "Daily", "weekly": "Weekly", "mtd": "Month to date"}
WHOLE_DAY = ("absence", "leave", "loa", "off")
BLUE, GOOD, BAD = "#2a78d6", "#0a7d0a", "#c93534"
INK, MUTED, LINE, SURFACE, PAGE = "#0b0b0b", "#52514e", "#e6e5e0", "#fcfcfb", "#f1f0ec"


def period_for(frequency: str, today: date) -> tuple[date, date]:
    """daily = yesterday · weekly = the 7 days to yesterday · mtd = the 1st to
    yesterday (on the 1st itself: the whole of last month)."""
    end = today - timedelta(days=1)
    if frequency == "daily":
        return end, end
    if frequency == "weekly":
        return today - timedelta(days=7), end
    return end.replace(day=1), end


@dataclass
class Bucket:
    scheduled_people: set = field(default_factory=set)
    working_days: int = 0
    work_mins: int = 0
    ot_mins: int = 0
    week_off: int = 0
    leave: int = 0
    absence: int = 0


@dataclass
class ReportData:
    org: str
    frequency: str
    lob: str
    start: date
    end: date
    total: Bucket
    by_lob: dict[str, Bucket]
    by_date: dict[date, Bucket]
    queues: list[dict]
    offered: float
    handled: float
    sl_pct: float | None
    sl_target: float | None
    aht: float | None
    occupancy: float | None
    sl_by_date: dict[date, float]
    att_records: int
    att_absent: int
    att_late: int
    att_late_mins: int


def _add(b: Bucket, key: str, day, status: str) -> None:
    b.scheduled_people.add(key)
    if status == "off":
        b.week_off += 1
    elif status == "absence":
        b.absence += 1
    elif status in ("leave", "loa"):
        b.leave += 1
    else:
        b.working_days += 1
    b.work_mins += labour_law.worked_minutes(day)
    b.ot_mins += sum(o.end - o.start for o in day.ot)


def _status(day) -> str:
    for kind in WHOLE_DAY:
        for a in day.activities:
            if a.type == kind and a.start <= day.shift_start and a.end >= day.shift_end:
                return kind
    return "working"


def _weighted(rows: list[dict], key: str, weight: str) -> float | None:
    den = sum(r[weight] for r in rows if r[key] is not None)
    return sum(r[key] * r[weight] for r in rows if r[key] is not None) / den if den else None


async def build(
    db: AsyncSession, org_id: uuid.UUID, frequency: str, start: date, end: date, lob: str = ""
) -> ReportData:
    wanted = lob.strip().lower()
    rules = await settings_service.get_value(db, org_id, "agent_rules") or {}
    lob_of = {k: (v or {}).get("lob") or "" for k, v in rules.items()}
    actuals = await service.performance_actuals(db, org_id, start, end)
    att_lob = {a["employee_code"]: a["lob"] for a in actuals["attendance"]}

    total, by_lob, by_date = Bucket(), defaultdict(Bucket), defaultdict(Bucket)
    for row in await days.list_range(db, org_id, start, end, None):
        if row.published_at is None:
            continue  # drafts aren't results to report to anyone
        name = lob_of.get(row.agent_key) or att_lob.get(row.agent_key) or "Unassigned"
        if wanted and name.lower() != wanted:
            continue
        day = days.row_to_day(row)
        status = _status(day)
        for bucket in (total, by_lob[name], by_date[row.plan_date]):
            _add(bucket, row.agent_key, day, status)

    queues = [
        q
        for q in actuals["queues"]
        if not wanted or wanted in (q["lob"].lower(), q["queue"].lower())
    ]
    sl_rows: dict[date, list[dict]] = defaultdict(list)
    for q in queues:
        sl_rows[date.fromisoformat(q["date"])].append(q)
    attendance = [
        a
        for a in actuals["attendance"]
        if not wanted or (lob_of.get(a["employee_code"]) or a["lob"]).lower() == wanted
    ]
    org = await db.get(Organization, org_id)
    return ReportData(
        org=org.name if org else "",
        frequency=frequency,
        lob=lob,
        start=start,
        end=end,
        total=total,
        by_lob=dict(sorted(by_lob.items())),
        by_date=dict(by_date),
        queues=queues,
        offered=sum(q["offered"] for q in queues),
        handled=sum(q["handled"] for q in queues),
        sl_pct=_weighted(queues, "service_level_pct", "offered"),
        sl_target=_weighted(queues, "sl_target_pct", "offered"),
        aht=_weighted(queues, "aht_seconds", "handled"),
        occupancy=_weighted(queues, "occupancy_pct", "offered"),
        sl_by_date={
            d: v
            for d, rows in sl_rows.items()
            if (v := _weighted(rows, "service_level_pct", "offered")) is not None
        },
        att_records=len(attendance),
        att_absent=sum(a["category"] in ("absent", "sick") for a in attendance),
        att_late=sum(a["minutes_late"] > 0 for a in attendance),
        att_late_mins=sum(a["minutes_late"] for a in attendance),
    )


# ------------------------------------------------------------------ rendering


def _d(value: date) -> str:
    return f"{value.day} {value:%b %Y}"


def period_label(data: ReportData) -> str:
    return _d(data.start) if data.start == data.end else f"{_d(data.start)} – {_d(data.end)}"


def subject(name: str, data: ReportData) -> str:
    return f"{name} · {period_label(data)}"


def _hrs(mins: float) -> str:
    return f"{mins / 60:,.1f}h"


def _tile(label: str, value: str, note: str = "") -> str:
    extra = (
        f'<div style="font-size:12px;color:{MUTED};margin-top:2px;">{note}</div>' if note else ""
    )
    return (
        f'<div style="display:inline-block;width:33.3%;min-width:160px;box-sizing:border-box;'
        f'vertical-align:top;padding:6px;"><div style="background:{SURFACE};min-height:62px;'
        f'border:1px solid {LINE};border-radius:10px;padding:12px 14px;">'
        f'<div style="font-size:12px;color:{MUTED};">{escape(label)}</div>'
        f'<div style="font-size:24px;font-weight:700;color:{INK};margin-top:4px;">{escape(value)}</div>'
        f"{extra}</div></div>"
    )


def _tiles(items: list[tuple[str, str, str]]) -> str:
    return f'<div style="font-size:0;">{"".join(_tile(*t) for t in items)}</div>'


def _heading(text: str, note: str = "") -> str:
    sub = (
        f'<div style="font-size:12px;color:{MUTED};margin-top:2px;">{escape(note)}</div>'
        if note
        else ""
    )
    return (
        f'<div style="padding:22px 6px 6px;"><div style="font-size:16px;font-weight:700;'
        f'color:{INK};">{escape(text)}</div>{sub}</div>'
    )


def _empty(text: str) -> str:
    return (
        f'<div style="margin:6px;padding:14px;border:1px dashed {LINE};border-radius:10px;'
        f'font-size:13px;color:{MUTED};">{escape(text)}</div>'
    )


def _bars(values: dict[date, float], fmt, unit_max: float | None = None) -> str:
    """One series by day, as table cells so it survives email clients: one hue,
    rounded at the data end, with a value on the highest bar and a title per bar."""
    if not values:
        return ""
    top = unit_max or max(values.values()) or 1
    peak = max(values, key=lambda d: values[d])
    height = 110
    bars, labels = [], []
    step = max(1, len(values) // 10)
    for i, (d, v) in enumerate(sorted(values.items())):
        h = max(2, round(v / top * height)) if v else 0
        tip = escape(f"{_d(d)}: {fmt(v)}")
        label = (
            f'<div style="font-size:11px;color:{MUTED};padding-bottom:2px;white-space:nowrap;">{escape(fmt(v))}</div>'
            if d == peak
            else ""
        )
        bar = (
            f'<div title="{tip}" style="height:{h}px;background:{BLUE};border-radius:4px 4px 0 0;font-size:0;">&nbsp;</div>'
            if h
            else ""
        )
        bars.append(
            f'<td valign="bottom" align="center" title="{tip}" style="padding:0 1px;">{label}{bar}</td>'
        )
        text = f"{d.day}" if i % step == 0 else ""
        labels.append(
            f'<td align="center" style="font-size:11px;color:{MUTED};padding-top:4px;">{text}</td>'
        )
    return (
        f'<div style="margin:6px;padding:12px;background:{SURFACE};border:1px solid {LINE};border-radius:10px;">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;">'
        f'<tr style="height:{height + 18}px;">{"".join(bars)}</tr><tr>{"".join(labels)}</tr></table></div>'
    )


def _table(headers: list[str], rows: list[list[str]]) -> str:
    head = "".join(
        f'<th align="{"left" if i == 0 else "right"}" style="padding:8px 10px;font-size:12px;'
        f'font-weight:600;color:{MUTED};border-bottom:1px solid {LINE};">{escape(h)}</th>'
        for i, h in enumerate(headers)
    )
    body = "".join(
        "<tr>"
        + "".join(
            f'<td align="{"left" if i == 0 else "right"}" style="padding:8px 10px;font-size:13px;'
            f'color:{INK};border-bottom:1px solid {LINE};{"font-weight:600;" if i == 0 else ""}">{escape(c)}</td>'
            for i, c in enumerate(r)
        )
        + "</tr>"
        for r in rows
    )
    return (
        f'<div style="margin:6px;background:{SURFACE};border:1px solid {LINE};border-radius:10px;overflow-x:auto;">'
        f'<table width="100%" cellpadding="0" cellspacing="0"><tr>{head}</tr>{body}</table></div>'
    )


def _sl_note(data: ReportData) -> str:
    if data.sl_pct is None or data.sl_target is None:
        return ""
    gap = data.sl_pct - data.sl_target
    met = gap >= 0
    return (
        f'<span style="color:{GOOD if met else BAD};font-weight:600;">{"▲ met" if met else "▼ below"}</span>'
        f" target {data.sl_target:.0f}%"
    )


def render(name: str, data: ReportData) -> str:
    t = data.total
    scope = data.lob or "All LOBs"
    answered = f"{data.handled / data.offered * 100:.1f}% handled" if data.offered else ""
    results = (
        _tiles(
            [
                (
                    "Service level",
                    f"{data.sl_pct:.1f}%" if data.sl_pct is not None else "—",
                    _sl_note(data),
                ),
                ("Contacts offered", f"{data.offered:,.0f}", answered),
                ("AHT", f"{data.aht:,.0f}s" if data.aht is not None else "—", ""),
                ("Occupancy", f"{data.occupancy:.1f}%" if data.occupancy is not None else "—", ""),
                ("Contacts handled", f"{data.handled:,.0f}", ""),
            ]
        )
        if data.queues
        else _empty("No recorded queue results for this period.")
    )
    sl_chart = ""
    if len(data.sl_by_date) > 1:
        sl_chart = _heading("Service level by day", "Recorded, % of contacts") + _bars(
            data.sl_by_date, lambda v: f"{v:.1f}%", 100
        )
    staffing = (
        _tiles(
            [
                ("Agents scheduled", f"{len(t.scheduled_people):,}", ""),
                ("Planned work", _hrs(t.work_mins), "scheduled, not logged"),
                ("Overtime", _hrs(t.ot_mins), ""),
                ("Week off days", f"{t.week_off:,}", ""),
                ("Leave days", f"{t.leave:,}", ""),
                ("Absence days", f"{t.absence:,}", ""),
            ]
        )
        if t.scheduled_people
        else _empty("No published schedules for this period.")
    )
    hours = {d: b.work_mins / 60 for d, b in data.by_date.items()}
    hours_chart = ""
    if len(hours) > 1:
        hours_chart = _heading("Planned work hours by day", "From published schedules") + _bars(
            hours, lambda v: f"{v:,.0f}h"
        )
    lob_rows = [
        [
            n,
            f"{len(b.scheduled_people):,}",
            _hrs(b.work_mins),
            _hrs(b.ot_mins),
            f"{b.week_off:,}",
            f"{b.leave:,}",
            f"{b.absence:,}",
        ]
        for n, b in data.by_lob.items()
    ]
    lob_table = (
        _heading("By LOB")
        + _table(
            ["LOB", "Agents", "Planned work", "Overtime", "Week off", "Leave", "Absence"], lob_rows
        )
        if lob_rows
        else ""
    )
    queue_sum: dict[str, dict] = {}
    for q in data.queues:
        queue_sum.setdefault(q["queue"], {"rows": [], "lob": q["lob"]})["rows"].append(q)
    queue_rows = []
    for qn, v in sorted(queue_sum.items()):
        rows = v["rows"]
        sl = _weighted(rows, "service_level_pct", "offered")
        aht = _weighted(rows, "aht_seconds", "handled")
        queue_rows.append(
            [
                qn,
                f"{sum(r['offered'] for r in rows):,.0f}",
                f"{sum(r['handled'] for r in rows):,.0f}",
                f"{sl:.1f}%" if sl is not None else "—",
                f"{aht:,.0f}s" if aht is not None else "—",
            ]
        )
    queue_table = (
        _heading("By queue") + _table(["Queue", "Offered", "Handled", "SL", "AHT"], queue_rows)
        if queue_rows
        else ""
    )
    attendance = (
        _tiles(
            [
                ("Attendance records", f"{data.att_records:,}", ""),
                ("Absences recorded", f"{data.att_absent:,}", ""),
                ("Late arrivals", f"{data.att_late:,}", f"{data.att_late_mins:,} minutes in total"),
            ]
        )
        if data.att_records
        else _empty("No attendance records for this period.")
    )
    org = f"{escape(data.org)} · " if data.org else ""
    return f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(subject(name, data))}</title></head>
<body style="margin:0;padding:0;background:{PAGE};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{PAGE};"><tr><td align="center" style="padding:20px 10px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:720px;table-layout:fixed;">
<tr><td style="background:#0d366b;border-radius:14px;padding:22px 24px;">
<div style="font-size:12px;letter-spacing:.06em;color:#b7d3f6;">{org}{escape(FREQUENCY_LABEL.get(data.frequency, data.frequency).upper())} REPORT</div>
<div style="font-size:24px;font-weight:700;color:#ffffff;margin-top:6px;">{escape(name)}</div>
<div style="font-size:14px;color:#cde2fb;margin-top:6px;">{escape(period_label(data))} · {escape(scope)}</div>
</td></tr>
<tr><td style="padding:4px 0;">
{_heading("Contact-centre results", "Recorded queue actuals")}{results}{sl_chart}{queue_table}
{_heading("Staffing", "From published schedules: planned, not time logged by a phone system")}{staffing}{hours_chart}{lob_table}
{_heading("Attendance", "Recorded attendance")}{attendance}
</td></tr>
<tr><td style="padding:18px 8px;font-size:12px;line-height:1.5;color:{MUTED};">
Adherence and per-agent calls / AHT aren't included: they need a phone-system feed. Unpublished draft schedules aren't counted.<br>Sent automatically by Purvi.AI WFM.
</td></tr></table></td></tr></table></body></html>"""


def render_text(name: str, data: ReportData) -> str:
    t = data.total
    lines = [
        name,
        f"{FREQUENCY_LABEL.get(data.frequency, data.frequency)} report · {period_label(data)} · {data.lob or 'All LOBs'}",
        "",
        f"Service level: {data.sl_pct:.1f}%"
        if data.sl_pct is not None
        else "Service level: no recorded results",
        f"Contacts offered: {data.offered:,.0f} · handled: {data.handled:,.0f}",
        f"Agents scheduled: {len(t.scheduled_people):,}",
        f"Planned work: {_hrs(t.work_mins)} · overtime: {_hrs(t.ot_mins)}",
        f"Week off days: {t.week_off:,} · leave: {t.leave:,} · absence: {t.absence:,}",
        f"Attendance records: {data.att_records:,} · absences: {data.att_absent:,} · late arrivals: {data.att_late:,}",
    ]
    return "\n".join(lines)
