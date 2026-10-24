"""Omni-channel day plans: domain parity with the frontend + API integration.

The domain cases mirror `frontend/src/lib/domain/channels.test.ts` so the
server and the Scheduling UI enforce the same rules.
"""

from __future__ import annotations

from httpx import AsyncClient

from app.modules.scheduling import dayplan as dp
from tests.conftest import login
from tests.helpers import create_employees, create_structure

DATE = "2026-10-26"
BASE = f"/api/v1/scheduling/day-plans/{DATE}"


def m(hhmm: str) -> int:
    h, mm = hhmm.split(":")
    return int(h) * 60 + int(mm)


def early_day(**over) -> dp.AgentDay:
    """07:00–15:30 Early pattern: break 09:00 (b1), lunch 11:00–11:30 (b2), break 13:00 (b3)."""
    d = dp.AgentDay(
        m("07:00"),
        m("15:30"),
        [
            dp.BreakSeg("b1", "break", "Morning Break", m("09:00"), m("09:15")),
            dp.BreakSeg("b2", "lunch", "Lunch", m("11:00"), m("11:30")),
            dp.BreakSeg("b3", "break", "Afternoon Break", m("13:00"), m("13:15")),
        ],
        [
            dp.ChannelSeg("p", "phone", m("07:00"), m("11:00")),
            dp.ChannelSeg("c", "chat", m("11:00"), m("15:30")),
        ],
    )
    for k, v in over.items():
        setattr(d, k, v)
    return d


# ---------------------------------------------------------------- domain parity


def test_timeline_is_contiguous_and_breaks_cut_channels() -> None:
    tl = [t for t in dp.day_timeline(early_day()) if t.kind != "ot"]
    assert sum(t.end - t.start for t in tl) == 8.5 * 60
    assert all(b.start == a.end for a, b in zip(tl, tl[1:]))
    assert len([t for t in tl if t.kind == "channel" and t.channel == "phone"]) == 2


def test_validate_day_rules() -> None:
    assert dp.validate_day(early_day()) == []
    bad = early_day(
        channels=[
            dp.ChannelSeg("x", "phone", m("06:00"), m("10:00")),
            dp.ChannelSeg("y", "chat", m("09:00"), m("15:30")),
        ],
        ot=[dp.ChannelSeg("o", "phone", m("14:00"), m("16:00"))],
    )
    errs = " ".join(dp.validate_day(bad))
    assert (
        "inside the shift" in errs
        and "overlap each other" in errs
        and "overlaps the contracted shift" in errs
    )


def test_aux_move_and_resize_bounds() -> None:
    d = early_day()
    assert dp.edit_bounds(d, dp.EditOp("aux-move", "b2")) == (m("09:15"), m("12:30"))
    moved = dp.apply_edit(d, dp.EditOp("aux-move", "b2"), m("14:00"))
    assert (moved.breaks[1].start, moved.breaks[1].end) == (m("12:30"), m("13:00"))
    longer = dp.apply_edit(d, dp.EditOp("aux-resize", "b2", "end"), m("11:45"))
    assert longer.breaks[1].end == m("11:45")
    assert dp.apply_edit(d, dp.EditOp("aux-resize", "b2", "end"), m("10:00")).breaks[1].end == m(
        "11:05"
    )


def test_channel_boundary_moves_both_blocks() -> None:
    d = dp.apply_edit(early_day(), dp.EditOp("channel-resize", "p", "end"), m("12:30"))
    assert [(c.id, c.start, c.end) for c in d.channels] == [
        ("p", m("07:00"), m("12:30")),
        ("c", m("12:30"), m("15:30")),
    ]


def test_shift_resize_keeps_breaks_on_the_clock_and_respects_ot() -> None:
    d = early_day(ot=[dp.ChannelSeg("o", "email", m("16:00"), m("17:00"))])
    longer = dp.apply_edit(d, dp.EditOp("shift-resize", edge="start"), m("06:00"))
    assert longer.shift_start == m("06:00") and longer.channels[0].start == m("06:00")
    assert longer.breaks[0].start == m("09:00")
    assert dp.apply_edit(d, dp.EditOp("shift-resize", edge="end"), m("17:00")).shift_end == m(
        "16:00"
    )
    assert dp.apply_edit(d, dp.EditOp("shift-resize", edge="end"), m("12:00")).shift_end == m(
        "13:15"
    )


def test_overtime_placement_and_merge() -> None:
    d = early_day()
    assert dp.propose_overtime(d, "chat", "after", 60) == (m("15:30"), m("16:30"))
    assert dp.propose_overtime(d, "chat", "before", 90) == (m("05:30"), m("07:00"))
    assert "Overlaps shift" in dp.propose_overtime(d, "chat", "custom", 0, m("15:00"), m("16:00"))
    with_ot = early_day(ot=[dp.ChannelSeg("a", "chat", m("15:30"), m("16:30"))])
    assert dp.propose_overtime(with_ot, "chat", "after", 60) == (m("16:30"), m("17:30"))
    merged = dp.with_overtime_added(with_ot, dp.ChannelSeg("n", "chat", m("16:30"), m("17:30")))
    assert [(o.id, o.start, o.end) for o in merged.ot] == [("a", m("15:30"), m("17:30"))]


def test_mark_aux_layers_and_clashes() -> None:
    d = early_day()
    extra = dp.mark_aux(d, "break", m("14:00"), 15, False, "x1")
    assert isinstance(extra, dp.AgentDay) and any(b.id == "x1" for b in extra.breaks)
    assert "Clashes with Lunch" in dp.mark_aux(d, "lunch", m("11:15"), 30, False, "x")
    assert isinstance(
        dp.mark_aux(d, "meeting", m("11:15"), 30, False, "x"), dp.AgentDay
    )  # overlay may cover lunch
    loa = dp.mark_aux(d, "loa", 0, 0, True, "x")
    assert (loa.activities[0].start, loa.activities[0].end) == (m("07:00"), m("15:30"))
    assert "Outside shift" in dp.mark_aux(d, "meeting", m("15:15"), 30, False, "x")


def test_move_day_and_equivalent_op() -> None:
    d = early_day(activities=[dp.ActivitySeg("mt", "meeting", m("10:00"), m("10:30"))])
    moved = dp.move_day(d, 30)
    assert (moved.shift_start, moved.activities[0].start, moved.breaks[0].start) == (
        m("07:30"),
        m("10:30"),
        m("09:30"),
    )
    assert dp.move_day(d, -24 * 60).shift_start == 0
    other = early_day(activities=[dp.ActivitySeg("z", "meeting", m("10:00"), m("10:45"))])
    assert dp.equivalent_op(d, dp.EditOp("activity-move", "mt"), other) == dp.EditOp(
        "activity-move", "z"
    )
    assert dp.equivalent_op(d, dp.EditOp("channel-resize", "p", "end"), other) is None


def test_coverage_excludes_activity_time() -> None:
    d = early_day(
        channels=[dp.ChannelSeg("p", "phone", m("07:00"), m("15:30"))],
        breaks=[],
        activities=[dp.ActivitySeg("mt", "meeting", m("10:00"), m("10:30"))],
    )
    cov = dp.coverage([dp.day_timeline(d)], (m("10:00"), m("11:00")))
    assert [s["phone"] for s in cov] == [0, 1] and [s["activity"] for s in cov] == [1, 0]


def test_default_channels_match_frontend_alignment() -> None:
    # Same hash buckets as the frontend's defaultChannelSegments.
    assert dp.default_channels("a01", m("07:00"), m("15:30"))[0].start == m("07:00")
    assert {len(dp.default_channels(f"a{i:02d}", 420, 930)) for i in range(1, 31)} <= {1, 2}


# ------------------------------------------------------------------- API helpers


def plan_json(key: str, **over) -> dict:
    body = {
        "agent_key": key,
        "agent_name": f"Agent {key}",
        "team": "Alpha",
        "shift_start": m("07:00"),
        "shift_end": m("15:30"),
        "breaks": [
            {
                "id": "b1",
                "type": "break",
                "label": "Morning Break",
                "start": m("09:00"),
                "end": m("09:15"),
            },
            {"id": "b2", "type": "lunch", "label": "Lunch", "start": m("11:00"), "end": m("11:30")},
            {
                "id": "b3",
                "type": "break",
                "label": "Afternoon Break",
                "start": m("13:00"),
                "end": m("13:15"),
            },
        ],
        "channels": [{"id": "p", "channel": "phone", "start": m("07:00"), "end": m("15:30")}],
        "overtime": [],
        "activities": [],
    }
    body.update(over)
    return body


async def seed(client: AsyncClient, headers: dict, *keys: str) -> dict[str, dict]:
    resp = await client.put(
        BASE, headers=headers, json={"items": [plan_json(k) for k in keys], "detail": "seed"}
    )
    assert resp.status_code == 200, resp.text
    return {r["agent_key"]: r for r in resp.json()["data"]}


# ---------------------------------------------------------------------- API


async def test_save_list_and_versioning(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    saved = await seed(client, h, "a01", "a02")
    assert saved["a01"]["version"] == 1 and saved["a01"]["channels"][0]["channel"] == "phone"

    listed = (await client.get(BASE, headers=h)).json()["data"]
    assert [r["agent_key"] for r in listed] == ["a01", "a02"]
    assert (await client.get("/api/v1/scheduling/day-plans/2026-10-27", headers=h)).json()[
        "data"
    ] == []

    # update with the right base_version bumps it…
    upd = await client.put(
        BASE,
        headers=h,
        json={
            "items": [
                plan_json(
                    "a01",
                    shift_end=m("16:00"),
                    base_version=1,
                    channels=[
                        {"id": "p", "channel": "phone", "start": m("07:00"), "end": m("16:00")}
                    ],
                )
            ]
        },
    )
    assert upd.status_code == 200, upd.text
    assert upd.json()["data"][0]["version"] == 2
    # …a stale base_version is rejected with 409 and nothing changes
    stale = await client.put(BASE, headers=h, json={"items": [plan_json("a01", base_version=1)]})
    assert stale.status_code == 409 and stale.json()["error"]["details"]["stale"] == ["a01"]


async def test_save_rejects_rule_breaking_days_all_or_nothing(
    client: AsyncClient, admin: dict
) -> None:
    h = admin["headers"]
    bad = plan_json(
        "a02", overtime=[{"id": "o", "channel": "chat", "start": m("15:00"), "end": m("16:00")}]
    )
    resp = await client.put(BASE, headers=h, json={"items": [plan_json("a01"), bad]})
    assert resp.status_code == 422
    details = resp.json()["error"]["details"]
    assert (
        details[0]["agent_key"] == "a02"
        and "overlaps the contracted shift" in details[0]["errors"][0]
    )
    assert (await client.get(BASE, headers=h)).json()["data"] == []  # a01 not saved either


async def test_links_employee_by_code_and_resets(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    ids = await create_structure(client, h)
    emps = await create_employees(
        client, h, ids["team"]["id"], ids["lob"]["id"], count=1
    )  # code E000
    saved = await seed(client, h, "e000", "a01")
    assert saved["e000"]["employee_id"] == emps[0]["id"] and saved["a01"]["employee_id"] is None
    assert (await client.delete(f"{BASE}/a01", headers=h)).status_code == 200
    assert [r["agent_key"] for r in (await client.get(BASE, headers=h)).json()["data"]] == ["e000"]
    assert (await client.delete(f"{BASE}/a01", headers=h)).status_code == 404


async def test_edit_with_followers_bulk_drag(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await seed(client, h, "a01", "a02", "a03")
    resp = await client.post(
        f"{BASE}/edit",
        headers=h,
        json={
            "agent_key": "a01",
            "op": {"kind": "aux-move", "seg_id": "b2"},
            "value": m("11:30"),
            "followers": ["a02"],
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert {r["agent_key"] for r in data["saved"]} == {"a01", "a02"}
    lunch = {r["agent_key"]: next(b for b in r["breaks"] if b["id"] == "b2") for r in data["saved"]}
    assert all((b["start"], b["end"]) == (m("11:30"), m("12:00")) for b in lunch.values())
    a03 = (await client.get(BASE, headers=h, params={"agent_keys": "a03"})).json()["data"][0]
    assert next(b for b in a03["breaks"] if b["id"] == "b2")["start"] == m("11:00")

    missing = await client.post(
        f"{BASE}/edit",
        headers=h,
        json={"agent_key": "a01", "op": {"kind": "aux-move", "seg_id": "nope"}, "value": 0},
    )
    assert missing.status_code == 404


async def test_move_and_resize_shift(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await seed(client, h, "a01", "a02")
    mv = await client.post(
        f"{BASE}/move", headers=h, json={"agent_keys": ["a01", "a02"], "delta": 15}
    )
    assert all(
        r["shift_start"] == m("07:15") and r["breaks"][0]["start"] == m("09:15")
        for r in mv.json()["data"]["saved"]
    )
    rs = await client.post(
        f"{BASE}/resize-shift", headers=h, json={"agent_keys": ["a01"], "edge": "end", "delta": 30}
    )
    r = rs.json()["data"]["saved"][0]
    assert (
        r["shift_end"] == m("16:15")
        and r["channels"][-1]["end"] == m("16:15")
        and r["version"] == 3
    )


async def test_mark_aux_staggered_with_skips(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await seed(client, h, "a01", "a02", "a03")
    await client.post(
        f"{BASE}/mark-aux",
        headers=h,
        json={"agent_keys": ["a03"], "kind": "training", "start": m("10:30"), "length": 60},
    )
    resp = await client.post(
        f"{BASE}/mark-aux",
        headers=h,
        json={
            "agent_keys": ["a01", "a02", "a03"],
            "kind": "meeting",
            "start": m("10:00"),
            "length": 30,
            "note": "Q3 update",
            "stagger": {"group_size": 2, "every": 30},
        },
    )
    data = resp.json()["data"]
    starts = {r["agent_key"]: r["activities"][0]["start"] for r in data["saved"]}
    assert starts == {"a01": m("10:00"), "a02": m("10:00")}
    assert data["skipped"] == [{"agent_key": "a03", "reason": "Clashes with Training 10:30–11:30"}]
    assert data["saved"][0]["activities"][0]["note"] == "Q3 update"

    brk = await client.post(
        f"{BASE}/mark-aux",
        headers=h,
        json={"agent_keys": ["a01"], "kind": "break", "start": m("14:00"), "length": 15},
    )
    assert any(
        b["start"] == m("14:00") and b["type"] == "break"
        for b in brk.json()["data"]["saved"][0]["breaks"]
    )
    loa = await client.post(
        f"{BASE}/mark-aux",
        headers=h,
        json={"agent_keys": ["a02"], "kind": "loa", "start": 0, "full_shift": True},
    )
    assert loa.json()["data"]["skipped"][0]["reason"].startswith("Clashes with Meeting")

    un = await client.post(
        f"{BASE}/unmark", headers=h, json={"agent_keys": ["a01", "a02"], "at": m("10:15")}
    )
    assert all(r["activities"] == [] for r in un.json()["data"]["saved"])


async def test_add_overtime_per_channel(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await seed(client, h, "a01", "a02")
    first = await client.post(
        f"{BASE}/overtime",
        headers=h,
        json={"agent_keys": ["a01", "a02"], "channel": "email", "timing": "after", "duration": 60},
    )
    assert all(
        r["overtime"][0] | {"id": None}
        == {"id": None, "channel": "email", "start": m("15:30"), "end": m("16:30")}
        for r in first.json()["data"]["saved"]
    )
    chained = await client.post(
        f"{BASE}/overtime",
        headers=h,
        json={"agent_keys": ["a01"], "channel": "email", "timing": "after", "duration": 30},
    )
    ot = chained.json()["data"]["saved"][0]["overtime"]
    assert len(ot) == 1 and (ot[0]["start"], ot[0]["end"]) == (m("15:30"), m("17:00"))  # merged
    clash = await client.post(
        f"{BASE}/overtime",
        headers=h,
        json={
            "agent_keys": ["a02"],
            "channel": "chat",
            "timing": "custom",
            "start": m("16:00"),
            "end": m("17:00"),
        },
    )
    assert clash.json()["data"]["skipped"][0]["reason"] == "Clashes with OT 15:30–16:30"


async def test_coverage_and_export(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await seed(client, h, "a01")
    await client.post(
        f"{BASE}/mark-aux",
        headers=h,
        json={"agent_keys": ["a01"], "kind": "meeting", "start": m("10:00"), "length": 30},
    )
    cov = (await client.get(f"{BASE}/coverage", headers=h)).json()["data"]
    slot = next(s for s in cov if s["start"] == m("10:00"))
    assert (slot["phone"], slot["activity"]) == (0, 1)

    sheets = (await client.get(f"{BASE}/export", headers=h)).json()["data"]
    assert list(sheets) == [
        "Schedule segments",
        "Agent summary",
        "Interval grid (15 min)",
        "Channel coverage",
        "Legend",
    ]
    assert sheets["Interval grid (15 min)"][0]["10:15"] == "MTG"
    assert sheets["Agent summary"][0]["Meeting min"] == 30

    csv = await client.get(f"{BASE}/export", headers=h, params={"format": "csv"})
    assert csv.status_code == 200 and csv.headers["content-type"].startswith("text/csv")
    assert "=== Schedule segments ===" in csv.text and "MTG" in csv.text


async def test_permissions_and_audit(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await seed(client, h, "a01")
    await client.post(
        "/api/v1/users",
        headers=h,
        json={
            "email": "agent@test.dev",
            "password": "Agent@12345",
            "full_name": "Agent",
            "role_names": ["Employee"],
        },
    )
    agent = await login(client, "agent@test.dev", "Agent@12345")
    assert (await client.get(BASE, headers=agent)).status_code == 200  # schedule:read
    denied = await client.post(
        f"{BASE}/move", headers=agent, json={"agent_keys": ["a01"], "delta": 15}
    )
    assert denied.status_code == 403

    audit = (await client.get("/api/v1/audit", headers=h)).json()["data"]
    items = audit["items"] if isinstance(audit, dict) else audit
    assert any(a["action"] == "dayplan.save" and a["note"] == "seed" for a in items)
