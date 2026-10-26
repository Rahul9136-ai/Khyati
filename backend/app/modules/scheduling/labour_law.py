"""Country labour-law presets + day-level compliance check for day plans.

Presets are in `labour_laws.json` — byte-identical to the frontend's
`src/lib/domain/labourLaws.json` (enforced by tests/test_labour_law.py) — and
`check_compliance` mirrors the frontend's `checkCompliance` so the UI and the
API flag exactly the same issues. Simplified statutory baselines, not legal
advice; only rules decidable from a single day are checked.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from app.modules.scheduling.dayplan import AgentDay

PRESETS_PATH = Path(__file__).with_name("labour_laws.json")

#: Fields an organisation may override (everything except identity + notes).
OVERRIDABLE = {
    "standardDailyHours",
    "maxDailyHours",
    "maxDailyOtHours",
    "maxSpreadHours",
    "maxContinuousWorkHours",
    "minBreakBlockMinutes",
    "breakRules",
    "standardWeeklyHours",
    "maxWeeklyHours",
    "minDailyRestHours",
}
NOT_WORKING = {"loa", "absence", "vto", "pto", "leave", "off"}


@cache
def _data() -> dict[str, Any]:
    return json.loads(PRESETS_PATH.read_text(encoding="utf-8"))


def disclaimer() -> str:
    return _data()["disclaimer"]


def presets() -> list[dict[str, Any]]:
    return _data()["laws"]


def preset(code: str) -> dict[str, Any] | None:
    return next((law for law in presets() if law["code"] == code), None)


def effective_law(
    code: str | None, overrides: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    base = preset(code) if code else None
    if base is None:
        return None
    return {**base, **{k: v for k, v in (overrides or {}).items() if k in OVERRIDABLE}}


def fmt_duration(mins: float) -> str:
    """ "7h30" / "8h" — same format as the frontend."""
    h = int(mins // 60)
    m = round(mins % 60)
    return f"{h}h{m:02d}" if m else f"{h}h"


@dataclass
class _Span:
    start: int
    end: int


def _subtract(pieces: list[_Span], cuts: list) -> list[_Span]:
    out = pieces
    for c in cuts:
        nxt: list[_Span] = []
        for p in out:
            if c.end <= p.start or c.start >= p.end:
                nxt.append(p)
                continue
            if c.start > p.start:
                nxt.append(_Span(p.start, c.start))
            if c.end < p.end:
                nxt.append(_Span(c.end, p.end))
        out = nxt
    return sorted(out, key=lambda x: x.start)


def _work_pieces(day: AgentDay) -> list[_Span]:
    off = [*day.breaks, *(a for a in day.activities if a.type in NOT_WORKING)]
    return _subtract(
        [_Span(day.shift_start, day.shift_end), *(_Span(o.start, o.end) for o in day.ot)], off
    )


def worked_minutes(day: AgentDay) -> int:
    return sum(w.end - w.start for w in _work_pieces(day))


def check_compliance(day: AgentDay, law: dict[str, Any]) -> list[dict[str, str]]:
    """Issues as [{"rule", "message"}]; empty = compliant with the daily rules."""
    s, e = day.shift_start, day.shift_end
    work = _work_pieces(day)
    worked = sum(w.end - w.start for w in work)
    if worked <= 0:
        return []

    min_block = law.get("minBreakBlockMinutes") or 0
    qualifying = [
        b for b in day.breaks if b.end - b.start >= min_block and b.start >= s and b.end <= e
    ]
    break_total = sum(b.end - b.start for b in qualifying)
    longest_break = max([0, *(b.end - b.start for b in qualifying)])
    issues: list[dict[str, str]] = []

    def add(rule: str, message: str) -> None:
        issues.append({"rule": rule, "message": message})

    max_daily = law.get("maxDailyHours")
    if max_daily is not None and worked > max_daily * 60:
        limit = fmt_duration(max_daily * 60)
        add("maxDailyHours", f"Works {fmt_duration(worked)} — max {limit} a day")

    max_ot = law.get("maxDailyOtHours")
    if max_ot is not None:
        ot_blocks = sum(o.end - o.start for o in day.ot)
        std = law.get("standardDailyHours")
        ot = max(ot_blocks, worked - std * 60 if std is not None else 0)
        if ot > max_ot * 60:
            limit = fmt_duration(max_ot * 60)
            add("maxDailyOtHours", f"{fmt_duration(ot)} overtime — max {limit} a day")

    max_spread = law.get("maxSpreadHours")
    if max_spread is not None:
        spread = work[-1].end - work[0].start
        if spread > max_spread * 60:
            limit = fmt_duration(max_spread * 60)
            add("maxSpreadHours", f"Working day spans {fmt_duration(spread)} — max {limit}")

    for continuous in (False, True):
        applicable = sorted(
            (
                r
                for r in law.get("breakRules", [])
                if bool(r["continuous"]) == continuous and worked > r["afterHours"] * 60
            ),
            key=lambda r: -r["minBreakMinutes"],
        )
        if not applicable:
            continue
        rule = applicable[0]
        have = longest_break if continuous else break_total
        need = rule["minBreakMinutes"]
        if have < need:
            after = fmt_duration(rule["afterHours"] * 60)
            if continuous:
                msg = f"Needs one break of ≥{need} min after {after} worked — longest is {have} min"
            else:
                msg = f"Needs ≥{need} min of breaks after {after} worked — has {have} min"
            add("breakRules", msg)

    max_cont = law.get("maxContinuousWorkHours")
    if max_cont is not None:
        # Wall-clock stretches between qualifying breaks / time off; short breaks don't reset it.
        gaps = [
            _Span(a.end, b.start)
            for a, b in zip(work, work[1:])
            if b.start > a.end
            and not any(br.start < b.start and br.end > a.end for br in day.breaks)
        ]
        stretches = _subtract(
            [_Span(work[0].start, work[-1].end)],
            [*qualifying, *(a for a in day.activities if a.type in NOT_WORKING), *gaps],
        )
        longest = max([0, *(x.end - x.start for x in stretches)])
        if longest > max_cont * 60:
            limit = fmt_duration(max_cont * 60)
            add(
                "maxContinuousWorkHours",
                f"Works {fmt_duration(longest)} without a qualifying break — max {limit}",
            )
    return issues


def compliance_sheets(agents: list, law: dict[str, Any]) -> dict[str, list[dict]]:
    """Same two extra export sheets as the frontend: per-agent compliance + the rules applied.
    `agents` are dayplan.ExportAgent."""
    from app.modules.scheduling.dayplan import fmt_hm

    def hrs(v: float | None) -> str:
        return "—" if v is None else fmt_duration(v * 60)

    rows = []
    for a in agents:
        issues = check_compliance(a.day, law)
        rows.append(
            {
                "Agent": a.name,
                "Agent ID": a.key,
                "Team": a.team,
                "Shift": f"{fmt_hm(a.day.shift_start)}–{fmt_hm(a.day.shift_end)}",
                "Worked": fmt_duration(worked_minutes(a.day)),
                "Status": "Issues" if issues else "Compliant",
                "Issues": "; ".join(i["message"] for i in issues),
            }
        )
    block = law.get("minBreakBlockMinutes")
    rules = [
        {"Rule": "Country", "Value": law["name"]},
        {"Rule": "Source", "Value": law["source"]},
        {"Rule": "Standard hours / day (OT after)", "Value": hrs(law.get("standardDailyHours"))},
        {"Rule": "Max hours / day incl. OT", "Value": hrs(law.get("maxDailyHours"))},
        {"Rule": "Max OT / day", "Value": hrs(law.get("maxDailyOtHours"))},
        {"Rule": "Max spread of the working day", "Value": hrs(law.get("maxSpreadHours"))},
        {"Rule": "Max work without a break", "Value": hrs(law.get("maxContinuousWorkHours"))},
        {
            "Rule": "Breaks shorter than this don't count",
            "Value": "—" if block is None else f"{block} min",
        },
        *(
            {
                "Rule": f"Break after {hrs(r['afterHours'])} worked",
                "Value": f"{r['minBreakMinutes']} min"
                + (" (one uninterrupted break)" if r["continuous"] else " (total)"),
            }
            for r in law.get("breakRules", [])
        ),
        {"Rule": "Standard hours / week (reference)", "Value": hrs(law.get("standardWeeklyHours"))},
        {"Rule": "Max hours / week (reference)", "Value": hrs(law.get("maxWeeklyHours"))},
        {
            "Rule": "Min daily rest between shifts (reference)",
            "Value": hrs(law.get("minDailyRestHours")),
        },
        {"Rule": "Notes", "Value": law["notes"]},
        {"Rule": "Disclaimer", "Value": disclaimer()},
    ]
    return {"Labour-law compliance": rows, "Labour-law rules": rules}
