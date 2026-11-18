"""Overtime breaks: the work_compliance rule that gives overtime its own breaks.
The placement mirrors frontend/src/lib/domain/otBreaks.ts (same inputs → same
times, see frontend otBreaks.test.ts); coverage and the schedule export show
them apart from overtime worked."""

from __future__ import annotations

from httpx import AsyncClient

from app.modules.scheduling import dayplan as dp
from app.modules.scheduling import labour_law
from tests.test_dayplan import BASE, early_day, m, plan_json

RULE = dp.OtBreakRule(120, 15, paid=False)
SETTINGS = "/api/v1/scheduling/settings/work_compliance"
COMPLIANCE = {
    "breakRequiredAfterHours": 3, "maxContinuousWorkHours": 3, "lunchRequiredAfterHours": 6,
    "minLunchMinutes": 30, "maxConsecutiveWorkDays": 6, "minDaysOffPerWeek": 1, "maxWeeklyHours": 48,
    "minRestBetweenShiftsHours": 11, "otBreakEveryMinutes": 120, "otBreakMinutes": 15, "otBreakPaid": False,
}


def ot(*spans: tuple[str, str]) -> list[dp.ChannelSeg]:
    return [dp.ChannelSeg(f"o{i}", "phone", m(a), m(b)) for i, (a, b) in enumerate(spans)]


def spans(xs) -> list[tuple[int, int]]:
    return [(x.start, x.end) for x in xs]


def test_rule_from_compliance() -> None:
    assert dp.ot_break_rule_of(None) is None
    assert dp.ot_break_rule_of({"otBreakEveryMinutes": None}) is None
    assert dp.ot_break_rule_of({"otBreakEveryMinutes": 60, "otBreakMinutes": 60}) is None
    assert dp.ot_break_rule_of(COMPLIANCE) == RULE
    assert dp.ot_break_rule_of({**COMPLIANCE, "otBreakPaid": True}).paid is True


def test_placement_matches_the_frontend() -> None:
    assert dp.ot_breaks(ot(("17:00", "18:30")), RULE) == []
    assert spans(dp.ot_breaks(ot(("17:00", "19:00")), RULE)) == [(m("17:55"), m("18:10"))]
    assert spans(dp.ot_breaks(ot(("17:00", "20:00")), RULE)) == [(m("18:25"), m("18:40"))]
    assert spans(dp.ot_breaks(ot(("17:00", "21:00")), RULE)) == [
        (m("18:15"), m("18:30")),
        (m("19:35"), m("19:50")),
    ]
    # touching blocks are one stretch; OT before and after the shift are apart
    assert len(dp.ot_breaks(ot(("17:00", "18:00"), ("18:00", "19:00")), RULE)) == 1
    assert spans(dp.ot_breaks(ot(("05:00", "07:00"), ("15:30", "17:30")), RULE)) == [
        (m("05:55"), m("06:10")),
        (m("16:25"), m("16:40")),
    ]


def test_timeline_coverage_and_worked_time() -> None:
    day = early_day(ot=ot(("15:30", "17:30")), ot_break_rule=RULE)
    tl = dp.day_timeline(day)
    assert spans(t for t in tl if t.kind == "ot") == [(m("15:30"), m("16:25")), (m("16:40"), m("17:30"))]
    brk = next(t for t in tl if t.kind == "ot-break")
    assert (brk.start, brk.end, brk.paid, brk.label) == (m("16:25"), m("16:40"), False, "OT break (unpaid)")
    cov = dp.coverage([tl], dp.timeline_window([day]))
    assert next(s for s in cov if s["start"] == m("16:30"))["phone"] == 0.7  # 16:40–17:00 of the slot (10 of its 30 min are the OT break)
    assert labour_law.worked_minutes(early_day(ot=ot(("15:30", "17:30")))) - labour_law.worked_minutes(day) == 15
    assert dp.ot_minutes(day) == {"scheduled": 120, "breaks": 15, "worked": 105, "paid": 105}
    paid = early_day(ot=ot(("15:30", "17:30")), ot_break_rule=dp.OtBreakRule(120, 15, True))
    assert dp.ot_minutes(paid)["paid"] == 120
    assert day.copy().ot_break_rule == RULE


async def test_rule_is_validated(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    bad = await client.put(SETTINGS, headers=h, json={"value": {**COMPLIANCE, "otBreakMinutes": 2}})
    assert bad.status_code == 422, bad.text
    ok = await client.put(SETTINGS, headers=h, json={"value": COMPLIANCE})
    assert ok.status_code == 200, ok.text


async def test_export_and_coverage_show_ot_breaks(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    overtime = [{"id": "o1", "channel": "phone", "start": m("15:30"), "end": m("17:30")}]
    resp = await client.put(BASE, headers=h, json={"items": [plan_json("a01", overtime=overtime)]})
    assert resp.status_code == 200, resp.text

    # rule off: overtime has no breaks
    sheets = (await client.get(f"{BASE}/export", headers=h)).json()["data"]
    assert not any(r["Code"] == "OT-BRK" for r in sheets["Schedule segments"])
    assert sheets["Agent summary"][0]["OT hrs"] == 2 and sheets["Agent summary"][0]["OT break min"] == 0

    await client.put(SETTINGS, headers=h, json={"value": {**COMPLIANCE, "otBreakPaid": True}})
    sheets = (await client.get(f"{BASE}/export", headers=h)).json()["data"]
    seg = next(r for r in sheets["Schedule segments"] if r["Code"] == "OT-BRK")
    assert (seg["Type"], seg["Start"], seg["End"]) == ("OT break (paid)", "16:25", "16:40")
    summary = sheets["Agent summary"][0]
    assert (summary["OT hrs"], summary["OT break min"], summary["OT worked hrs"], summary["OT paid hrs"]) == (2, 15, 1.75, 2)
    assert sheets["Interval grid (15 min)"][0]["16:30"] == "OT-BRK"
    assert any(r["Code"] == "OT-BRK" for r in sheets["Legend"])

    cov = (await client.get(f"{BASE}/coverage", headers=h)).json()["data"]
    slot = next(s for s in cov if s["start"] == m("16:30"))
    assert (slot["phone"], slot["ot"]) == (0.7, 0.7)

    csv = await client.get(f"{BASE}/export", headers=h, params={"format": "csv"})
    assert "OT-BRK" in csv.text and "OT paid hrs" in csv.text
