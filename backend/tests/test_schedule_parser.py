"""Schedule-change request parser: rule-based parsing + the output contract."""
from __future__ import annotations

from datetime import date

import pytest

from app.modules.ai.schedule_parser import (
    ACTIONS,
    absence_categories,
    build_prompt,
    extract_json,
    normalise,
    parse_with_rules,
    resolve_clock_range,
)

TODAY = date(2026, 6, 26)  # a Friday
KEYS = {"employee_name", "employee_id", "action", "date_or_week", "field_to_change",
        "new_value", "raw_message", "confidence"}


def parse(msg: str) -> dict:
    return parse_with_rules(msg, TODAY)


def test_output_has_exactly_the_contract_fields_and_keeps_raw_message_unedited() -> None:
    msg = "  Please mark leave for Priya Sharma (ID: E1004) tomorrow!  "
    out = parse(msg)
    assert set(out) == KEYS
    assert out["raw_message"] == msg  # not stripped, not edited


@pytest.mark.parametrize(
    ("msg", "action", "field", "value"),
    [
        ("Priya Sharma, ID E1004, needs leave on 2026-07-03", "Mark Leave", "Planned Leave (HC)", "1"),
        ("E1004 is taking PTO next Monday", "Mark Leave", "Planned Leave (HC)", "1"),
        ("Please cancel the leave for E1004 on 3 July", "Cancel Leave", "Planned Leave (HC)", "0"),
        ("E1004 leave is cancelled", "Cancel Leave", "Planned Leave (HC)", "0"),
        ("Priya (E1004) called in sick today", "Mark Absence", "Absence & Sickness (HC)", "1"),
        ("E1004 is unwell and won't be coming in", "Mark Absence", "Absence & Sickness (HC)", "1"),
        ("E1004 sick leave tomorrow", "Mark Absence", "Absence & Sickness (HC)", "1"),
        ("Swap shifts between E1004 and E1007 on Friday", "Shift Swap", "Shift Assignment", ""),
        ("E1004 wants to change shift timing on 2026-07-02 to 10am-7pm", "Change Shift Timing", "Shift Length (Hours)", "9"),
        ("E1004 needs to leave early today", "Change Shift Timing", "Shift Length (Hours)", ""),
        ("E1004 will work 6 hours instead, shift change tomorrow", "Change Shift Timing", "Shift Length (Hours)", "6"),
        ("Please update the roster for E1004", "Other", "", ""),
    ],
)
def test_action_field_and_value(msg: str, action: str, field: str, value: str) -> None:
    out = parse(msg)
    assert out["action"] == action
    assert out["field_to_change"] == field
    assert out["new_value"] == value
    assert out["action"] in ACTIONS


def test_no_employee_id_means_null_id_and_low_confidence() -> None:
    out = parse("Priya Sharma is sick today")
    assert out["employee_id"] is None
    assert out["confidence"] == "Low"
    assert out["action"] == "Mark Absence"  # the action is still extracted


def test_week_labels_and_dates_are_not_mistaken_for_ids() -> None:
    out = parse("Please mark leave for WK-3")
    assert out["employee_id"] is None and out["confidence"] == "Low"
    assert out["date_or_week"] == "WK-3"
    assert parse("leave in week 12 for E1004")["date_or_week"] == "WK-12"
    assert parse("leave on 2026-07-03")["employee_id"] is None


@pytest.mark.parametrize(
    ("msg", "expected"),
    [
        ("E1004 sick today", "2026-06-26"),
        ("E1004 sick tomorrow", "2026-06-27"),
        ("E1004 leave the day after tomorrow", "2026-06-28"),
        ("E1004 leave on Monday", "2026-06-29"),
        ("E1004 leave next Friday", "2026-07-03"),
        ("E1004 leave on Friday", "2026-07-03"),        # today is a Friday → a week from now
        ("E1004 leave this Friday", "2026-06-26"),      # …unless it says "this"
        ("E1004 leave on 2026-07-03", "2026-07-03"),
        ("E1004 leave on 3 July", "2026-07-03"),
        ("E1004 leave on July 3rd 2026", "2026-07-03"),
        ("E1004 leave on 03/07/2026", "2026-07-03"),
        ("E1004 leave from 2026-07-03 to 2026-07-05", "2026-07-03 to 2026-07-05"),
        ("E1004 leave on 5 Jan", "2027-01-05"),  # no year, already past this year → next Jan
        ("E1004 needs leave", None),
    ],
)
def test_date_resolution_uses_the_given_today(msg: str, expected: str | None) -> None:
    assert parse(msg)["date_or_week"] == expected


@pytest.mark.parametrize(
    ("msg", "name", "emp_id"),
    [
        ("Priya Sharma (E1004) is sick today", "Priya Sharma", "E1004"),
        ("Priya Sharma (ID E1004) called in sick today", "Priya Sharma", "E1004"),
        ("Priya Sharma, Employee ID: E1004, needs leave", "Priya Sharma", "E1004"),
        ("Employee ID: e1004 - Priya Sharma wants leave", "Priya Sharma", "E1004"),
        ("I am Priya Sharma, emp id 1004, need leave tomorrow", "Priya Sharma", "1004"),
        ("Please mark leave for Priya Sharma, ID E-1004", "Priya Sharma", "E-1004"),
        ("Leave for E1004", None, "E1004"),
    ],
)
def test_name_and_id_extraction(msg: str, name: str | None, emp_id: str) -> None:
    out = parse(msg)
    assert out["employee_id"] == emp_id
    assert out["employee_name"] == name


def test_confidence_levels() -> None:
    assert parse("Priya (E1004) sick today")["confidence"] == "High"        # id + clear action
    assert parse("update the roster for E1004")["confidence"] == "Medium"   # id but no clear action
    assert parse("emergency at home for E1004")["confidence"] == "Medium"   # weakly-worded action
    assert parse("someone is sick")["confidence"] == "Low"                  # no id


# ---- contract enforcement on LLM output --------------------------------------------------
def test_normalise_rejects_ids_not_in_the_message() -> None:
    llm = {"employee_name": "Priya", "employee_id": "E9999", "action": "Mark Leave",
           "date_or_week": "2026-07-03", "field_to_change": "Planned Leave (HC)",
           "new_value": "1", "raw_message": "tampered", "confidence": "High"}
    out = normalise(llm, "Priya is taking leave on 3 July")
    assert out["employee_id"] is None       # invented ID dropped
    assert out["confidence"] == "Low"       # …and confidence forced down
    assert out["raw_message"] == "Priya is taking leave on 3 July"  # always the real message


def test_normalise_keeps_a_real_id_and_fixes_bad_enums() -> None:
    out = normalise({"employee_id": "e-1004", "action": "Fire them", "confidence": "Certain"},
                    "Please do something for E-1004")
    assert out["employee_id"] == "E-1004"
    assert out["action"] == "Other"
    assert out["confidence"] == "Medium"
    assert out["field_to_change"] == ""
    assert out["new_value"] == ""


def test_normalise_tolerates_nulls_numbers_and_blank_strings() -> None:
    out = normalise({"employee_name": " ", "employee_id": None, "action": "Mark Leave",
                     "new_value": 1, "date_or_week": None}, "leave")
    assert out["employee_name"] is None and out["new_value"] == "1"
    assert out["field_to_change"] == "Planned Leave (HC)"


def test_extract_json_handles_fences_prose_and_garbage() -> None:
    assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json('Sure! {"a": {"b": 2}} hope that helps') == {"a": {"b": 2}}
    assert extract_json("no json here") is None
    assert extract_json("{not: valid}") is None
    assert extract_json("[1, 2]") is None


# ---- automation-only helpers (not part of the documented JSON contract) -----------------
@pytest.mark.parametrize(
    ("msg", "expected"),
    [
        ("change shift timing to 10am-7pm", (600, 1140)),
        ("shift 9:30am to 6:00pm please", (570, 1080)),
        ("work 6 hours instead", None),           # a duration, not a clock-time window
        ("leave early today", None),               # no time given at all
        ("night shift 22:00-06:00", (1320, 1800)),  # crosses midnight — end is 06:00 *next* day
    ],
)
def test_resolve_clock_range(msg: str, expected: tuple[int, int] | None) -> None:
    assert resolve_clock_range(msg) == expected


def test_absence_categories_prefers_sick_wording() -> None:
    assert absence_categories("E1004 is sick today") == ["sick", "absent"]
    assert absence_categories("E1004 won't be coming in") == ["absent", "sick"]


def test_prompt_fills_placeholders_and_survives_braces_in_the_message() -> None:
    p = build_prompt('leave {for} E1004 "today"', TODAY)
    assert "2026-06-26" in p
    assert 'leave {for} E1004 "today"' in p
    assert "{current_date}" not in p and "{trigger_message_text}" not in p
    assert "do not guess an ID" in p
