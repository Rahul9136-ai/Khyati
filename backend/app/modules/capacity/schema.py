"""The 14 Capacity Planning input sheets — port of frontend/src/lib/capacity/schema.ts.

Used to validate rows a connected tool sends and to store values in the same
shape the browser's Excel importer produces (numbers as numbers, dates as
YYYY-MM-DD, months as Mon'YY), so the screens and the API read the same data.
"""

from __future__ import annotations

import re
from typing import Any

from app.modules.capacity.calc import js_str, month_label, num, parse_date, parse_month

RAMP_WEEKS = 16
SAMPLING_WEEKS = 12

_TASK = [
    "ProjectID",
    "ProjectName",
    "DeliveryUnit",
    "Customer Name",
    "Vertical",
    "ServiceLine",
    "SubFunction",
    "Specialty",
    "BillingType",
    "CustomerLocation",
    "Customer FacilityPractice Hospital",
    "TaskNo",
    "CustomerProcess",
    "BillingSoftware",
    "EndCustomerName",
]


def _t(*names: str) -> list[tuple[str, str]]:
    return [(n, "text") for n in names]


def _n(*names: str) -> list[tuple[str, str]]:
    return [(n, "number") for n in names]


def _p(*names: str) -> list[tuple[str, str]]:
    return [(n, "pct") for n in names]


SHEETS: dict[str, dict[str, Any]] = {
    "userMapping": {
        "label": "User Mapping",
        "columns": [
            *_t("Emp Id"),
            ("DOJ", "date"),
            ("Date of Production", "date"),
            *_t(
                "Emp Name",
                "Job Name",
                "Customer Name",
                "Service Line",
                "4C",
                "Service Line Classification",
                "Employee Category",
                "SBU",
                "BU",
                "Division",
                "Department",
                "Sub-Department",
                "Specialty",
                "Country",
                "Legal Entity",
                "Business Unit",
                "Location",
                "City",
                "Employment Type",
                "Employment Status",
                "New Joinee Confirmation Status",
            ),
            ("Probation Confirmation Date", "date"),
            *_t("User Status"),
        ],
    },
    "forecast": {
        "label": "Forecast Details",
        "monthColumns": True,
        "columns": _t(
            "Customer Name",
            "SERVICE_LINE",
            "SPECIALTY",
            "SUB_FUNCTION",
            "BILL_TYPE",
            "PROJECT_NUMBER (New)",
            "TASK_NUMBER (New)",
            "Geo",
            "Location",
        ),
    },
    "target": {
        "label": "Target Details",
        "columns": [
            *_t(*_TASK),
            *_n(
                "Peak Target Prod",
                "Peak Week -Lateral",
                "Peak Week - Training",
                "Peak Target QCA",
                "Peak Week -QCA",
            ),
        ],
    },
    "ramp": {
        "label": "Ramp Grid",
        "columns": [
            *_t(*_TASK),
            *_t("User Type"),
            *_n(*[f"Week {i + 1} %" for i in range(RAMP_WEEKS)]),
        ],
    },
    "hiring": {
        "label": "Hiring (RR)",
        "columns": [
            *_n("S.No"),
            *_t("Type", "RR Number", "PS RR Number"),
            *_n("Opening"),
            *_t("Entity", "Vertical", "SL-As Per EM", "4C", "Location", "Geo", "SBU_1"),
            ("Requested date", "date"),
            ("Requested month", "month"),
            *_t("Designation", "Grade", "Specialty", "Employee Matrix-Specialty"),
            ("Due to deliver", "date"),
            ("Due to delivery month", "month"),
            *_t(
                "TAT Status",
                "BRD Status",
                "Category",
                "Type of hiring",
                "Customer Name",
                "Sub-Project",
                "Approved Status",
                "Status",
                "New Department",
                "SBU_2",
                "BU",
                "Division",
                "Original cat",
            ),
        ],
    },
    "budgetBuffer": {
        "label": "Budgeted Buffer",
        "columns": [
            *_t("Finacial Year", "Country", "Customer Name", "SL", "Location", "Department"),
            ("Month", "month"),
            *_n("Base FTE", "Required FTE", "Buffer HC"),
            *_p("Buffer %"),
            *_n("Shrinkage", "Prod Buffer", "Glidepath+Complexity+Review", "Growth Buffer"),
            *_p("Shrinkage %", "Prod Buffer %", "Glide Buffer %", "Growth Buffer %"),
        ],
    },
    "actualShrinkage": {
        "label": "Actual Shrinkage",
        "columns": [
            *_t("DU", "Country", "Customer Name", "Service Line", "Location"),
            *_p("M1", "M2", "M3", "Last 3 month cum trend - %"),
        ],
    },
    "actualAttrition": {
        "label": "Actual Attrition",
        "columns": [
            *_t("Country", "Desg", "Customer Name", "Vertical", "Location"),
            *_p("M1", "M2", "M3", "Last 3 month cum trend - %"),
        ],
    },
    "budgetAttrition": {
        "label": "Budgeted Attrition",
        "columns": [
            *_t("Year", "KPI", "Country", "Customer Name", "SL", "Location", "Department"),
            ("Month", "month"),
            *_n("Denominator", "Numerator"),
        ],
    },
    "budgetQca": {
        "label": "Budgeted QCA %",
        "columns": [
            *_t("Year", "KPI", "Country", "Customer Name", "SL", "Deparment"),
            ("Month", "month"),
            *_n("Denominator", "Numerator"),
        ],
    },
    "trainingDays": {
        "label": "Training Days",
        "columns": [*_t("Customer Name", "Vertical"), *_n("Lateral", "Trainee", "QCA")],
    },
    "designationType": {
        "label": "Designation Type",
        "columns": _t("DU", "Designation", "User Type"),
    },
    "sampling": {
        "label": "Sampling Grid",
        "columns": [
            *_t("User Type", "Customer Name", "Service Line", "Specialty"),
            *_p(*[f"Week-{i + 1}" for i in range(SAMPLING_WEEKS)]),
            *_p("BAU"),
        ],
    },
    "workingDays": {"label": "Working Days", "columns": [("Month", "month"), ("Days", "number")]},
}
SHEET_IDS = list(SHEETS)
MONTH_COLUMN = re.compile(r"^units\s*_\s*", re.I)

#: Business keys a connected tool can use to find a row to update (PATCH … "match").
SUGGESTED_KEYS: dict[str, list[str]] = {
    "userMapping": ["Emp Id"],
    "forecast": ["TASK_NUMBER (New)", "Location"],
    "target": ["TaskNo"],
    "ramp": ["TaskNo", "User Type"],
    "hiring": ["RR Number", "PS RR Number"],
    "budgetBuffer": ["Customer Name", "SL", "Location", "Month"],
    "actualShrinkage": ["Customer Name", "Service Line", "Location"],
    "actualAttrition": ["Desg", "Customer Name", "Vertical", "Location"],
    "budgetAttrition": ["Customer Name", "SL", "Location", "Month"],
    "budgetQca": ["Customer Name", "SL", "Month"],
    "trainingDays": ["Customer Name", "Vertical"],
    "designationType": ["Designation"],
    "sampling": ["User Type", "Customer Name", "Service Line", "Specialty"],
    "workingDays": ["Month"],
}


def column_types(sheet: str, month_columns: list[str] | None = None) -> dict[str, str]:
    types = dict(SHEETS[sheet]["columns"])
    for c in month_columns or []:
        types[c] = "number"
    return types


def convert(value: Any, ctype: str) -> Any:
    """A cell as the browser importer stores it."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        value = js_str(value)
    if ctype in ("number", "pct"):
        n = num(value)
        if n is None:
            return js_str(value).strip()
        return int(n) if isinstance(value, int) else n
    if ctype == "date":
        d = parse_date(value)
        return d.isoformat() if d else js_str(value).strip()
    if ctype == "month":
        m = parse_month(value)
        return month_label(m) if m else js_str(value).strip()
    return js_str(value).strip() if isinstance(value, str) else js_str(value)


def describe() -> list[dict[str, Any]]:
    """For GET /capacity/schema: what each sheet holds."""
    return [
        {
            "id": sid,
            "label": s["label"],
            "columns": [{"name": n, "type": t} for n, t in s["columns"]],
            "monthColumns": "Units _ Mon'YY (one per month, e.g. \"Units _ Sep'26\")"
            if s.get("monthColumns")
            else None,
            "matchKeys": SUGGESTED_KEYS[sid],
        }
        for sid, s in SHEETS.items()
    ]
