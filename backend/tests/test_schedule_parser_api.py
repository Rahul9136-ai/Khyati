"""POST /ai/parse-schedule-request and raising the parsed request for approval."""
from __future__ import annotations

from datetime import date

import pytest
from httpx import AsyncClient

from app.modules.ai import service
from tests.helpers import create_employees, create_structure

URL = "/api/v1/ai/parse-schedule-request"


async def test_parses_with_rules_when_no_llm_key(client: AsyncClient, admin: dict) -> None:
    r = await client.post(URL, headers=admin["headers"], json={
        "message": "Priya Sharma (E9001) called in sick today", "current_date": "2026-06-26"})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["parser"] == "rules"
    p = data["parsed"]
    assert p["employee_id"] == "E9001" and p["employee_name"] == "Priya Sharma"
    assert p["action"] == "Mark Absence" and p["field_to_change"] == "Absence & Sickness (HC)"
    assert p["date_or_week"] == "2026-06-26"  # "today" resolved against the supplied date
    assert p["confidence"] == "High"
    assert data["matched_employee"] is None  # no such employee in the directory


async def test_missing_id_is_null_and_low_confidence(client: AsyncClient, admin: dict) -> None:
    r = await client.post(URL, headers=admin["headers"], json={"message": "Priya is sick today"})
    p = r.json()["data"]["parsed"]
    assert p["employee_id"] is None and p["confidence"] == "Low"


async def test_matches_directory_employee_by_id_only(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    ids = await create_structure(client, h)
    await create_employees(client, h, ids["team"]["id"], ids["lob"]["id"], count=2)  # E000, E001
    r = await client.post(URL, headers=h, json={"message": "e001 needs leave on 2026-07-03"})
    m = r.json()["data"]["matched_employee"]
    assert m is not None and m["employee_code"] == "E001" and m["name"] == "Emp1 Test"
    # a name with no ID never matches
    r = await client.post(URL, headers=h, json={"message": "Emp1 Test needs leave"})
    assert r.json()["data"]["matched_employee"] is None


async def test_validates_the_message(client: AsyncClient, admin: dict) -> None:
    assert (await client.post(URL, headers=admin["headers"], json={"message": ""})).status_code == 422
    assert (await client.post(URL, json={"message": "x"})).status_code in (401, 403)


async def test_llm_answer_is_used_but_cannot_invent_an_id(
    client: AsyncClient, admin: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict = {}

    async def fake_llm(message: str, today: date) -> dict:
        seen["today"] = today
        return {"employee_name": "Priya", "employee_id": "E7777", "action": "Mark Leave",
                "date_or_week": "2026-07-03", "field_to_change": "Planned Leave (HC)",
                "new_value": "1", "raw_message": "ignored", "confidence": "High"}

    monkeypatch.setattr(service, "_llm_parse_schedule_request", fake_llm)
    msg = "Priya wants leave on 3 July"  # no ID in the message
    r = await client.post(URL, headers=admin["headers"], json={"message": msg, "current_date": "2026-06-26"})
    data = r.json()["data"]
    assert data["parser"] == "claude" and seen["today"] == date(2026, 6, 26)
    assert data["parsed"]["employee_id"] is None       # E7777 isn't in the message → dropped
    assert data["parsed"]["confidence"] == "Low"
    assert data["parsed"]["raw_message"] == msg
    assert data["parsed"]["action"] == "Mark Leave"


async def test_falls_back_to_rules_when_the_llm_is_unusable(
    client: AsyncClient, admin: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def broken_llm(message: str, today: date) -> None:
        return None

    monkeypatch.setattr(service, "_llm_parse_schedule_request", broken_llm)
    r = await client.post(URL, headers=admin["headers"], json={"message": "E9001 sick today"})
    assert r.json()["data"]["parser"] == "rules"


@pytest.mark.parametrize("kind", ["leave_mark", "leave_cancel", "absence_mark", "shift_change", "shift_swap", "schedule_request"])
@pytest.mark.parametrize("source", ["intraday", "scheduling"])
async def test_parsed_requests_can_be_raised_for_approval(
    client: AsyncClient, admin: dict, source: str, kind: str
) -> None:
    r = await client.post("/api/v1/integrations/approvals", headers=admin["headers"], json={
        "source": source, "kind": kind, "title": "Mark Absence — Priya (E9001)",
        "summary": "message text", "payload": {"employee_code": "E9001", "action": "Mark Absence"},
    })
    assert r.status_code == 201, r.text
    d = r.json()["data"]
    assert d["kind"] == kind and d["source"] == source and d["status"] == "pending"
    assert d["payload"]["employee_code"] == "E9001"
