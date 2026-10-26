"""Country labour law: preset parity with the frontend, rule engine, and API.

The rule cases mirror `frontend/src/lib/domain/labourLaw.test.ts` (same days,
same expected rules and messages) so UI and API flag identical issues.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from httpx import AsyncClient

from app.modules.scheduling import dayplan as dp
from app.modules.scheduling import labour_law as ll
from tests.conftest import login
from tests.test_dayplan import BASE, m, plan_json

FRONTEND_COPY = Path(__file__).resolve().parents[2] / "frontend/src/lib/domain/labourLaws.json"


def base_day() -> dp.AgentDay:
    """07:00–15:30, breaks 09:00 (15m) · lunch 11:00 (30m) · 13:00 (15m) → 7h30 worked."""
    return dp.AgentDay(
        m("07:00"),
        m("15:30"),
        [
            dp.BreakSeg("b1", "break", "Morning Break", m("09:00"), m("09:15")),
            dp.BreakSeg("b2", "lunch", "Lunch", m("11:00"), m("11:30")),
            dp.BreakSeg("b3", "break", "Afternoon Break", m("13:00"), m("13:15")),
        ],
        [dp.ChannelSeg("p", "phone", m("07:00"), m("15:30"))],
    )


def with_ot(mins: int) -> dp.AgentDay:
    d = base_day()
    d.ot = [dp.ChannelSeg("o", "phone", m("15:30"), m("15:30") + mins)]
    return d


def rules(code: str, day: dp.AgentDay | None = None) -> list[str]:
    return [i["rule"] for i in ll.check_compliance(day or base_day(), ll.preset(code))]


# ------------------------------------------------------------------ presets


@pytest.mark.skipif(not FRONTEND_COPY.exists(), reason="frontend not checked out next to backend")
def test_presets_identical_to_frontend_copy() -> None:
    assert ll.PRESETS_PATH.read_bytes() == FRONTEND_COPY.read_bytes()


def test_presets_well_formed() -> None:
    laws = ll.presets()
    assert len(laws) >= 15 and len({law["code"] for law in laws}) == len(laws)
    for law in laws:
        assert law["name"] and law["source"] and law["notes"]
    assert ll.effective_law("DE", {"maxDailyHours": 9, "code": "XX"})["maxDailyHours"] == 9
    assert ll.effective_law("DE", {"code": "XX"})["code"] == "DE"  # identity can't be overridden
    assert ll.effective_law(None) is None
    assert [ll.fmt_duration(x) for x in (450, 480, 45)] == ["7h30", "8h", "0h45"]


# ------------------------------------------------------- rule-engine parity


@pytest.mark.parametrize(
    "code", ["DE", "GB", "FR", "ES", "IN", "US", "US-CA", "CA", "AU", "AE", "SG", "MX"]
)
def test_standard_shift_compliant(code: str) -> None:
    assert ll.check_compliance(base_day(), ll.preset(code)) == []


def test_sixty_minute_meal_countries() -> None:
    for code in ("PH", "BR", "ZA"):
        assert rules(code) == ["breakRules"]
    msg = ll.check_compliance(base_day(), ll.preset("PH"))[0]["message"]
    assert msg == "Needs one break of ≥60 min after 5h worked — longest is 30 min"


def test_full_shift_absence_has_nothing_to_check() -> None:
    d = base_day()
    d.activities = [dp.ActivitySeg("a", "absence", m("07:00"), m("15:30"))]
    assert rules("PH", d) == []


def test_week_off_is_not_work() -> None:
    d = base_day()
    off = dp.mark_aux(d, "off", m("07:00"), 30, True, "week-off", "Week off")
    assert [(a.type, a.start, a.end) for a in off.activities] == [("off", m("07:00"), m("15:30"))]
    assert rules("PH", off) == []


def test_germany_daily_max_and_continuous() -> None:
    assert rules("DE", with_ot(120)) == []
    assert rules("DE", with_ot(180)) == ["maxDailyHours"]
    assert rules("DE", with_ot(240)) == ["maxDailyHours", "maxContinuousWorkHours"]
    assert (
        ll.check_compliance(with_ot(180), ll.preset("DE"))[0]["message"]
        == "Works 10h30 — max 10h a day"
    )


def test_uae_overtime() -> None:
    assert rules("AE", with_ot(180)) == [
        "maxDailyHours",
        "maxDailyOtHours",
        "maxContinuousWorkHours",
    ]
    assert (
        ll.check_compliance(with_ot(180), ll.preset("AE"))[1]["message"]
        == "3h overtime — max 2h a day"
    )
    assert rules("AE", with_ot(90)) == []


def test_germany_short_breaks_dont_count() -> None:
    d = with_ot(120)
    d.breaks = [
        dp.BreakSeg("x", "break", "Break", m("09:00"), m("09:10")),
        dp.BreakSeg("y", "lunch", "Lunch", m("11:00"), m("11:30")),
    ]
    assert rules("DE", d) == ["breakRules"]
    msg = ll.check_compliance(d, ll.preset("DE"))[0]["message"]
    assert msg == "Needs ≥45 min of breaks after 9h worked — has 30 min"


def test_india_spread_and_continuous() -> None:
    assert rules("IN", with_ot(150)) == ["maxSpreadHours", "maxContinuousWorkHours"]
    assert rules("IN", with_ot(60)) == []


def test_gap_between_shift_and_ot_resets_clock() -> None:
    d = base_day()
    d.ot = [dp.ChannelSeg("o", "phone", m("16:30"), m("20:00"))]
    assert rules("DE", d) == ["maxDailyHours"]


# ---------------------------------------------------------------------- API


async def test_policy_lifecycle_and_validation(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    laws = (await client.get("/api/v1/scheduling/labour-laws", headers=h)).json()["data"]
    assert "not legal advice" in laws["disclaimer"] and any(x["code"] == "DE" for x in laws["laws"])

    empty = (await client.get("/api/v1/scheduling/labour-law", headers=h)).json()["data"]
    assert empty == {
        "country_code": None,
        "overrides": {},
        "version": 0,
        "effective": None,
        "disclaimer": laws["disclaimer"],
    }

    saved = await client.put(
        "/api/v1/scheduling/labour-law",
        headers=h,
        json={"country_code": "DE", "overrides": {"maxDailyHours": 9}},
    )
    assert saved.status_code == 200, saved.text
    data = saved.json()["data"]
    assert data["version"] == 1 and data["overrides"] == {"maxDailyHours": 9}
    assert (
        data["effective"]["maxDailyHours"] == 9 and data["effective"]["maxContinuousWorkHours"] == 6
    )

    # switching country clears nothing implicitly — the client sends what it wants
    again = await client.put(
        "/api/v1/scheduling/labour-law", headers=h, json={"country_code": "PH"}
    )
    assert again.json()["data"]["version"] == 2 and again.json()["data"]["overrides"] == {}
    none = await client.put(
        "/api/v1/scheduling/labour-law",
        headers=h,
        json={"country_code": None, "overrides": {"maxDailyHours": 5}},
    )
    assert none.json()["data"]["overrides"] == {} and none.json()["data"]["effective"] is None

    bad_country = await client.put(
        "/api/v1/scheduling/labour-law", headers=h, json={"country_code": "XX"}
    )
    assert (
        bad_country.status_code == 422 and "DE" in bad_country.json()["error"]["details"]["known"]
    )
    bad_field = await client.put(
        "/api/v1/scheduling/labour-law",
        headers=h,
        json={"country_code": "DE", "overrides": {"bogus": 1}},
    )
    assert bad_field.status_code == 422


async def test_compliance_and_export(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    long_day = plan_json(
        "a02", overtime=[{"id": "o", "channel": "phone", "start": m("15:30"), "end": m("18:30")}]
    )
    await client.put(BASE, headers=h, json={"items": [plan_json("a01"), long_day]})

    none = (await client.get(f"{BASE}/compliance", headers=h)).json()["data"]
    assert none["law"] is None and all(a["compliant"] for a in none["agents"])

    await client.put("/api/v1/scheduling/labour-law", headers=h, json={"country_code": "DE"})
    de = (await client.get(f"{BASE}/compliance", headers=h)).json()["data"]
    by_key = {a["agent_key"]: a for a in de["agents"]}
    assert de["country_code"] == "DE" and by_key["a01"]["compliant"]
    assert by_key["a02"]["worked_minutes"] == 630
    assert [i["rule"] for i in by_key["a02"]["issues"]] == ["maxDailyHours"]

    ph = (await client.get(f"{BASE}/compliance", headers=h, params={"country": "PH"})).json()[
        "data"
    ]
    assert not any(a["compliant"] for a in ph["agents"])

    sheets = (await client.get(f"{BASE}/export", headers=h)).json()["data"]
    assert sheets["Labour-law rules"][0] == {"Rule": "Country", "Value": "Germany"}
    status = {r["Agent ID"]: r["Status"] for r in sheets["Labour-law compliance"]}
    assert status == {"a01": "Compliant", "a02": "Issues"}
    csv = await client.get(f"{BASE}/export", headers=h, params={"format": "csv"})
    assert "=== Labour-law compliance ===" in csv.text


async def test_permissions_and_audit(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
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
    assert (await client.get("/api/v1/scheduling/labour-law", headers=agent)).status_code == 200
    denied = await client.put(
        "/api/v1/scheduling/labour-law", headers=agent, json={"country_code": "DE"}
    )
    assert denied.status_code == 403

    await client.put("/api/v1/scheduling/labour-law", headers=h, json={"country_code": "FR"})
    audit = (await client.get("/api/v1/audit", headers=h)).json()["data"]
    items = audit["items"] if isinstance(audit, dict) else audit
    entry = next(a for a in items if a["action"] == "scheduling_policy.labour_law")
    assert entry["after"]["country_code"] == "FR"
