"""Schedule-change request parser.

Turns a free-text message ("Priya E1004 is sick today") into the structured fields the
Scheduling and Real-Time tabs raise for approval. Two implementations share one output
contract (`ParsedRequest`):

* an LLM prompt (`PROMPT`) that `service.parse_schedule_request` sends to Claude when
  ANTHROPIC_API_KEY is configured, and
* the deterministic rule-based parser below, used when no key is set or the LLM
  answer is unusable — so the feature always works offline.

Whatever produced the result, `normalise` re-enforces the contract server-side: only
the allowed actions, an employee ID only if it literally appears in the message
(never a guess), and the raw message unedited.
"""
from __future__ import annotations

import json
import re
from datetime import date, timedelta
from typing import Any

ACTIONS = ("Mark Leave", "Shift Swap", "Change Shift Timing", "Mark Absence", "Cancel Leave", "Other")
CONFIDENCE = ("High", "Medium", "Low")

# Default schedule field for each action ("infer the closest match from the action").
FIELD_FOR_ACTION = {
    "Mark Leave": "Planned Leave (HC)",
    "Cancel Leave": "Planned Leave (HC)",
    "Mark Absence": "Absence & Sickness (HC)",
    "Change Shift Timing": "Shift Length (Hours)",
    "Shift Swap": "Shift Assignment",
    "Other": "",
}

PROMPT = """You are a schedule-change request parser for a workforce management tool.

Read the message below and extract the following fields as JSON only
(no explanation, no extra text):

- employee_name
- employee_id
- action (one of: "Mark Leave", "Shift Swap", "Change Shift Timing",
  "Mark Absence", "Cancel Leave", "Other")
- date_or_week (the specific date, or week label like "WK-3", if mentioned;
  if it says "today" or "tomorrow", resolve it to an actual date using
  today's date: {current_date})
- field_to_change (the schedule field affected, e.g. "Planned Leave (HC)",
  "Shift Length (Hours)", "Absence & Sickness (HC)" - infer the closest
  match from the action)
- new_value (the value to set, if applicable - e.g. leave = mark as 1/Yes;
  otherwise leave blank)
- raw_message (the original message, unedited)
- confidence ("High", "Medium", or "Low" - how confident you are that
  employee_id and action were both clearly stated)

If employee_id is not explicitly mentioned in the message, set it to
null and set confidence to "Low" - do not guess an ID.

Message:
"{trigger_message_text}"
"""


def build_prompt(message: str, today: date) -> str:
    # plain replace (not str.format) so braces in the message can't break the template
    return PROMPT.replace("{current_date}", today.isoformat()).replace("{trigger_message_text}", message)


# --------------------------------------------------------------------------- #
# Employee ID + name
# --------------------------------------------------------------------------- #
_NOT_ID_PREFIX = {"WK", "WEEK", "W", "Q", "FY", "H", "SHIFT", "DAY", "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"}

# "ID: E1004", "emp id 1004", "employee no. E-1004", "agent code A12"
_ID_LABELLED = re.compile(
    r"\b(?:employee|emp|staff|agent|associate)?\s*(?:id|no\.?|number|code)\b\s*[:#=\-]?\s*([A-Za-z]{0,6}-?\d{2,10})\b",
    re.I,
)
# a bare code-looking token: E1004, AGS-20431, a05
_ID_TOKEN = re.compile(r"\b([A-Za-z]{1,6}-?\d{2,10})\b")


def _norm_id(raw: str) -> str:
    return re.sub(r"\s+", "", raw).upper()


def extract_employee_id(text: str) -> str | None:
    m = _ID_LABELLED.search(text)
    if m:
        return _norm_id(m.group(1))
    for tok in _ID_TOKEN.finditer(text):
        prefix = re.match(r"[A-Za-z]+", tok.group(1))
        if prefix and prefix.group(0).upper() in _NOT_ID_PREFIX:
            continue  # week labels ("WK-3") and the like aren't employee IDs
        if _looks_like_time_or_date(text, tok):
            continue
        return _norm_id(tok.group(1))
    return None


def _looks_like_time_or_date(text: str, tok: re.Match[str]) -> bool:
    after = text[tok.end(): tok.end() + 3].lower()
    return after.startswith(("am", "pm", "st ", "nd ", "rd ", "th "))


_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
_NAME_STOP = {
    *(w.capitalize() for w in _WEEKDAYS), *(m.capitalize() for m in _MONTHS),
    "Please", "Hi", "Hello", "Hey", "Team", "Sir", "Madam", "Thanks", "Thank", "Regards", "Leave", "Shift", "Sick",
    "Today", "Tomorrow", "Yesterday", "Week", "Wk", "Id", "Emp", "Employee", "Agent", "Request", "Kindly", "Need",
    "Can", "Could", "Would", "Will", "I", "We", "The", "This", "That", "My", "Our", "Sorry", "Also", "And", "For",
    "Pto", "Wfm", "Rta", "Hr", "Tl", "Om", "Am", "Pm", "Monday", "Absent", "Unwell", "Ill", "Swap", "Cancel",
}
_NAME = r"([A-Z][a-z'’\-]+(?:\s+[A-Z][a-z'’\-]+){0,2})"


def _clean_name(raw: str) -> str | None:
    words = [w for w in raw.split() if w not in _NAME_STOP]
    return " ".join(words) if words else None


def extract_employee_name(text: str, employee_id: str | None) -> str | None:
    candidates: list[str] = []
    # "I am Priya Sharma", "this is Priya", "my name is …", "Name: …"
    candidates += re.findall(r"(?:\bI\s*am|\bI['’]m|\bthis\s+is|\bmy\s+name\s+is|\bname\s*[:\-])\s+" + _NAME, text)
    # "Priya Sharma (E1004)", "Priya Sharma, ID E1004", "Priya Sharma - E1004"
    candidates += re.findall(_NAME + r"\s*[\(\[,\-–:]\s*(?i:(?:employee|emp|staff|agent)?\s*(?:id|no\.?|number|code)?\s*[:#=\-]?\s*)?[A-Za-z]{0,6}-?\d{2,10}\b", text)
    # "E1004 Priya Sharma", "ID: E1004 - Priya Sharma"
    if employee_id:
        # (?i:…) only on the ID — the name part must stay case-sensitive so it stops at "wants", "is", …
        candidates += re.findall("(?i:" + re.escape(employee_id) + r")\s*[\)\]\-–,:]?\s*" + _NAME, text)
    # "for Priya Sharma", "of Priya", "regarding …"
    candidates += re.findall(r"\b(?:for|of|from|regarding|re)\s*:?\s+" + _NAME, text)
    for raw in candidates:
        name = _clean_name(raw)
        if name:
            return name
    return None


# --------------------------------------------------------------------------- #
# Dates / weeks
# --------------------------------------------------------------------------- #
_MONTH_RE = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
_ORD = r"(?:st|nd|rd|th)?"
_DATE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b"), "ymd"),
    (re.compile(r"\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b"), "dmy"),
    (re.compile(r"\b(\d{1,2})" + _ORD + r"\s+(?:of\s+)?" + _MONTH_RE + r"\b(?:,?\s+(\d{4}))?", re.I), "d_mon"),
    (re.compile(r"\b" + _MONTH_RE + r"\.?\s+(\d{1,2})" + _ORD + r"\b(?:,?\s+(\d{4}))?", re.I), "mon_d"),
]
_REL = re.compile(
    r"\b(day\s+after\s+tomorrow|tomorrow|today|tonight|yesterday|"
    r"(?:(next|this|coming)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b",
    re.I,
)
_WEEK = re.compile(r"\b(?:wk|week)[\s\-_#]*(\d{1,2})\b", re.I)


def _mk(y: int, m: int, d: int) -> date | None:
    try:
        return date(y, m, d)
    except ValueError:
        return None


def _month_num(name: str) -> int:
    return _MONTHS.index(name[:3].lower()) + 1


def _yearless(m: int, d: int, today: date) -> date | None:
    """A date with no year means the next occurrence on or after (roughly) today."""
    cand = _mk(today.year, m, d)
    if cand is not None and cand < today - timedelta(days=30):
        cand = _mk(today.year + 1, m, d)
    return cand


def find_dates(text: str, today: date) -> list[tuple[int, date]]:
    """All dates in the message as (position, date), in reading order."""
    found: list[tuple[int, date]] = []
    for pat, kind in _DATE_PATTERNS:
        for m in pat.finditer(text):
            g = m.groups()
            d: date | None = None
            if kind == "ymd":
                d = _mk(int(g[0]), int(g[1]), int(g[2]))
            elif kind == "dmy":  # day-first, the convention for these rosters
                y = int(g[2]) + (2000 if int(g[2]) < 100 else 0)
                d = _mk(y, int(g[1]), int(g[0]))
            elif kind == "d_mon":
                d = _mk(int(g[2]), _month_num(g[1]), int(g[0])) if g[2] else _yearless(_month_num(g[1]), int(g[0]), today)
            elif kind == "mon_d":
                d = _mk(int(g[2]), _month_num(g[0]), int(g[1])) if g[2] else _yearless(_month_num(g[0]), int(g[1]), today)
            if d:
                found.append((m.start(), d))
    for m in _REL.finditer(text):
        word = m.group(1).lower()
        d = None
        if word.startswith("day after"):
            d = today + timedelta(days=2)
        elif word in ("tomorrow",):
            d = today + timedelta(days=1)
        elif word in ("today", "tonight"):
            d = today
        elif word == "yesterday":
            d = today - timedelta(days=1)
        else:  # a weekday name → its next occurrence; on that weekday itself it means a week
            # from now ("today" is how you'd say today), unless the message says "this <weekday>"
            target = _WEEKDAYS.index(m.group(3).lower())
            ahead = (target - today.weekday()) % 7
            if ahead == 0 and (m.group(2) or "").lower() != "this":
                ahead = 7
            d = today + timedelta(days=ahead)
        found.append((m.start(), d))
    found.sort(key=lambda t: t[0])
    dedup: list[tuple[int, date]] = []
    for pos, d in found:
        if not any(abs(pos - p) < 3 and d == dd for p, dd in dedup):
            dedup.append((pos, d))
    return dedup


def extract_date_or_week(text: str, today: date) -> str | None:
    dates = find_dates(text, today)
    if dates:
        first, last = dates[0][1], dates[-1][1]
        ranged = len(dates) >= 2 and re.search(r"\b(?:to|till|until|through|thru)\b|[-–]", text[dates[0][0]:dates[-1][0]])
        return f"{first.isoformat()} to {last.isoformat()}" if ranged and first != last else first.isoformat()
    week = _WEEK.search(text)
    if week:
        return f"WK-{int(week.group(1))}"
    return None


# --------------------------------------------------------------------------- #
# Action
# --------------------------------------------------------------------------- #
_LV = r"(?:leave|pto|vacation|holiday|time\s+off|day\s+off|days\s+off)"
# (action, regex, strong?) — first match wins, so order matters: "leave early" is a shift
# timing change, "sick leave" is an absence, "cancel my leave" is a cancellation.
_ACTION_RULES: list[tuple[str, re.Pattern[str], bool]] = [
    ("Cancel Leave", re.compile(r"\b(?:cancel(?:l?ed|l?ing)?|revoke|withdraw|retract|undo|call\s+off)\b.{0,30}\b" + _LV + r"\b|\b" + _LV + r"\b.{0,30}\b(?:cancel(?:l?ed)?|revoked|withdrawn|no\s+longer\s+needed)\b|\bno\s+longer\s+(?:taking|need|going)\b", re.I), True),
    ("Shift Swap", re.compile(r"\b(?:swap(?:ping|ped)?|exchange|trade|switch(?:ing)?\s+shifts?)\b", re.I), True),
    ("Change Shift Timing", re.compile(
        r"\b(?:change|move|shift|reschedul\w*|adjust|extend|shorten|modify|update|alter)\b.{0,25}\b(?:shift|timings?|start|end|hours|schedule)\b"
        r"|\bshift\s+(?:start|end|time|timings?|hours|changes?)\b"
        r"|\b(?:leave|log\s*out|finish|end)\s+(?:early|earlier|late|later)\b"
        r"|\b(?:start|come\s+in|report|log\s*in|join)\s+(?:at|from|by|late|early|later|earlier)\b"
        r"|\bhalf[\s-]day\b", re.I), True),
    ("Mark Absence", re.compile(
        r"\b(?:sick|unwell|ill|illness|fever|not\s+feeling\s+well|absent|absence|no[\s-]?show|"
        r"won['’]?t\s+be\s+(?:able\s+to\s+)?(?:come|coming|attend|make)|can['’]?t\s+(?:come|make\s+it|attend|work)|"
        r"not\s+(?:coming|able\s+to\s+come)|hospital|medical)\b", re.I), True),
    ("Mark Absence", re.compile(r"\bemergency\b", re.I), False),
    ("Mark Leave", re.compile(r"\b(?:leave|pto|vacation|holiday|time\s+off|days?\s+off|off\s+(?:on|from)|out\s+of\s+office|ooo)\b", re.I), True),
]


def detect_action(text: str) -> tuple[str, bool]:
    """(action, clearly stated?). "Other" when nothing matches."""
    for action, pat, strong in _ACTION_RULES:
        if pat.search(text):
            return action, strong
    return "Other", False


# Which AttendanceCode category to attach, in preference order — used only by the
# automation apply path (attendance codes aren't part of the documented JSON contract).
LEAVE_CATEGORIES = ["leave", "vacation"]
_SICK_WORDS = re.compile(r"\b(sick|unwell|ill|fever|hospital|medical)\b", re.I)


def absence_categories(text: str) -> list[str]:
    return ["sick", "absent"] if _SICK_WORDS.search(text) else ["absent", "sick"]


# --------------------------------------------------------------------------- #
# New value
# --------------------------------------------------------------------------- #
_TIME_RANGE = re.compile(
    r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|till|until|-|–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b", re.I
)
_HOURS = re.compile(r"\b(\d{1,2}(?:\.\d+)?)\s*(?:hours?|hrs?)\b", re.I)


def _minutes(h: int, m: int, ap: str | None) -> int:
    if ap:
        h = h % 12 + (12 if ap.lower() == "pm" else 0)
    return h * 60 + m


def resolve_clock_range(text: str) -> tuple[int, int] | None:
    """The first valid explicit time window in `text`, as (start, end) minutes since
    midnight (end may exceed 1440 for a window that crosses midnight). None if the
    message states no clear clock-time window (a duration like "6 hours" isn't one —
    it says how long, not when). Used only by the automation apply path, which needs
    real start/end times to move a shift; the documented parser contract only ever
    reports a duration (see `shift_length_hours`), never a resolved clock range."""
    for m in _TIME_RANGE.finditer(text):
        h1, m1, ap1, h2, m2, ap2 = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5), m.group(6)
        if not (m1 or m2 or ap1 or ap2):
            continue  # "3-5 July" is a date range, not a time window
        ap1 = ap1 or ap2  # "9 to 6pm" — the meridiem applies to both ends unless that makes no sense
        start, end = _minutes(int(h1), int(m1 or 0), ap1), _minutes(int(h2), int(m2 or 0), ap2)
        if end <= start:
            start = _minutes(int(h1), int(m1 or 0), None) if not ap1 else start
            if end <= start:
                end += 24 * 60
        if 1 <= (end - start) / 60 <= 16:
            return start, end
    return None


def shift_length_hours(text: str) -> str:
    """Length in hours for a shift-timing message: from a time window, else "N hours"; "" if neither."""
    window = resolve_clock_range(text)
    if window:
        return f"{(window[1] - window[0]) / 60:g}"
    h = _HOURS.search(text)
    return f"{float(h.group(1)):g}" if h else ""


def new_value_for(action: str, text: str) -> str:
    if action in ("Mark Leave", "Mark Absence"):
        return "1"
    if action == "Cancel Leave":
        return "0"
    if action == "Change Shift Timing":
        return shift_length_hours(text)
    return ""


# --------------------------------------------------------------------------- #
# Public entry points
# --------------------------------------------------------------------------- #
def parse_with_rules(message: str, today: date) -> dict[str, Any]:
    employee_id = extract_employee_id(message)
    action, strong = detect_action(message)
    if employee_id is None:
        confidence = "Low"
    elif action != "Other" and strong:
        confidence = "High"
    else:
        confidence = "Medium"
    return {
        "employee_name": extract_employee_name(message, employee_id),
        "employee_id": employee_id,
        "action": action,
        "date_or_week": extract_date_or_week(message, today),
        "field_to_change": FIELD_FOR_ACTION[action],
        "new_value": new_value_for(action, message),
        "raw_message": message,
        "confidence": confidence,
    }


def _norm_token(s: str) -> str:
    return re.sub(r"[\s\-_]", "", s).upper()


def normalise(data: dict[str, Any], message: str) -> dict[str, Any]:
    """Enforce the output contract on any parser's answer (LLM output is untrusted)."""
    def text(key: str) -> str | None:
        v = data.get(key)
        if v is None:
            return None
        s = str(v).strip()
        return s or None

    action = text("action")
    if action not in ACTIONS:
        action = "Other"

    # never trust an ID that isn't literally in the message
    employee_id = text("employee_id")
    if employee_id and _norm_token(employee_id) not in _norm_token(message):
        employee_id = None
    if employee_id:
        employee_id = _norm_id(employee_id)

    confidence = text("confidence")
    if confidence not in CONFIDENCE:
        confidence = "Medium"
    if employee_id is None:
        confidence = "Low"  # the contract: no explicit ID ⇒ Low

    date_or_week = text("date_or_week")
    return {
        "employee_name": text("employee_name"),
        "employee_id": employee_id,
        "action": action,
        "date_or_week": date_or_week,
        "field_to_change": text("field_to_change") or FIELD_FOR_ACTION[action],
        "new_value": text("new_value") or "",
        "raw_message": message,
        "confidence": confidence,
    }


def extract_json(reply: str) -> dict[str, Any] | None:
    """Pull the JSON object out of an LLM reply, tolerating code fences and stray prose."""
    start, end = reply.find("{"), reply.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(reply[start: end + 1])
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None
