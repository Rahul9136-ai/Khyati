"""Capacity Planning — normalisation, formulas and switches.

A line-for-line port of frontend/src/lib/capacity/{normalize,formulas,config}.ts.
The browser and this API must give the same numbers, so keep both in step:
tests/test_capacity_parity.py runs both engines on the same workbook and
compares every field.
"""

from __future__ import annotations

import math
import re
from datetime import UTC, date, datetime, timedelta
from typing import Any

Cell = str | int | float | None

# ---------------------------------------------------------------- normalisation (§3)


def js_str(v: Any) -> str:
    """String(v) as JavaScript would print it (1.0 → "1")."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e21:
        return str(int(v))
    return str(v)


_WS = re.compile(r"\s+")


def key_of(v: Any) -> str:
    return "" if v is None else _WS.sub(" ", js_str(v).strip()).upper()


LOCATION_MAP = {
    "CHENNAI": "Chennai",
    "TRICHY": "Trichy",
    "TIRUCHIRAPPALLI": "Trichy",
    "BENGALURU": "Bangalore",
    "BANGALORE": "Bangalore",
    "HYDERABAD": "Hyderabad",
    "COIMBATORE": "Coimbatore",
    "MUMBAI": "Mumbai",
    "NAVI MUMBAI": "Mumbai",
}


def canon_location(v: Any) -> str | None:
    k = key_of(v)
    return LOCATION_MAP.get(k) if k else None


def location_key(v: Any) -> str:
    c = canon_location(v)
    return key_of(c if c is not None else v)


def sl_key(v: Any) -> str:
    return key_of(v)


def norm_hiring_type(v: Any) -> str:
    k = key_of(v)
    if k in ("LATERALS", "LATERAL"):
        return "Lateral"
    if k in ("TRAINEE", "TRAINEES"):
        return "Trainee"
    return "" if v is None else js_str(v).strip()


def norm_approved(v: Any) -> tuple[str, bool]:
    """(value, typo) — `Apprvoed` is treated as Approved."""
    k = key_of(v)
    if k == "APPRVOED":
        return "Approved", True
    if k == "APPROVED":
        return "Approved", False
    return ("" if v is None else js_str(v).strip()), False


MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
_MON = re.compile(r"^([A-Za-z]{3})[A-Za-z]*\s*['’`\-\s/]\s*(\d{2}|\d{4})$")
_YM = re.compile(r"^(\d{4})-(\d{1,2})(?:-\d{1,2})?")


def excel_serial_to_date(serial: float) -> datetime:
    ms = round(serial * 86400000)
    return datetime(1899, 12, 30, tzinfo=UTC) + timedelta(milliseconds=ms)


def parse_month(v: Any) -> str | None:
    """`Sep'26` (and friends) → `2026-09`; None when unreadable."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if math.isfinite(v) and 20000 < v < 80000:
            d = excel_serial_to_date(v)
            return f"{d.year}-{d.month:02d}"
    s = js_str(v).strip()
    m = _MON.match(s)
    if m:
        mon = m.group(1).upper()
        if mon not in MONTHS:
            return None
        y = 2000 + int(m.group(2)) if len(m.group(2)) == 2 else int(m.group(2))
        return f"{y}-{MONTHS.index(mon) + 1:02d}"
    m = _YM.match(s)
    if m and 1 <= int(m.group(2)) <= 12:
        return f"{m.group(1)}-{int(m.group(2)):02d}"
    return None


def month_label(m: str) -> str:
    y, mo = m.split("-")
    return f"{MONTH_LABELS[int(mo) - 1]}'{y[-2:]}"


def month_start(m: str) -> date:
    y, mo = m.split("-")
    return date(int(y), int(mo), 1)


_ISO = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")
_DMY = re.compile(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$")


def parse_date(v: Any) -> date | None:
    if v is None or v == "":
        return None
    try:
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return excel_serial_to_date(v).date() if math.isfinite(v) else None
        s = js_str(v).strip()
        m = _ISO.match(s)
        if m:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        m = _DMY.match(s)
        if m:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        return datetime.fromisoformat(s).date()
    except (ValueError, OverflowError):
        return None


_NUM = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


def num(v: Any) -> float | None:
    """Number from a cell; None when blank or not numeric. `12%` → 0.12."""
    if v is None or v == "" or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    s = js_str(v).strip().replace(",", "")
    if s in ("", "-"):
        return None
    pct = s.endswith("%")
    body = s[:-1] if pct else s
    if not _NUM.match(body.strip()):
        return None
    n = float(body)
    if not math.isfinite(n):
        return None
    return n / 100 if pct else n


# ---------------------------------------------------------------- formulas (§4)


def safe_div(a: float | None, b: float | None) -> float | None:
    if a is None or b is None or not math.isfinite(a) or not math.isfinite(b) or b == 0:
        return None
    return a / b


def min_of(b: float | None, a: float | None) -> float | None:
    v = [x for x in (b, a) if x is not None and math.isfinite(x)]
    return min(v) if v else None


def max_of(b: float | None, a: float | None) -> float | None:
    v = [x for x in (b, a) if x is not None and math.isfinite(x)]
    return max(v) if v else None


def _nz(v: float | None) -> float:
    return 0.0 if v is None or not math.isfinite(v) else v


def base_fte_transaction(volume: float, wdays: float, peak: float) -> float | None:
    return safe_div(safe_div(volume, wdays), peak)


def hc_production(
    *,
    base_fte: float | None,
    shrink_b: float | None,
    shrink_a: float | None,
    glide_b: float | None,
    glide_a: float | None,
    growth: float | None,
    actual_hc: float,
    attr_b: float | None,
    attr_a: float | None,
    snp: float,
    addition: float,
) -> dict[str, float | None]:
    shrinkage = _nz(min_of(shrink_b, shrink_a))  # P5
    glide = _nz(min_of(glide_b, glide_a))  # P6
    growth_v = _nz(growth)  # P7
    overall = shrinkage + glide + growth_v  # P8
    buffer_hc = None if base_fte is None else base_fte * overall  # P9
    req = None if base_fte is None or buffer_hc is None else base_fte + buffer_hc  # P10
    attrition = _nz(max_of(attr_b, attr_a))  # P12
    attr_hc = actual_hc * attrition  # P14
    projected = actual_hc - attr_hc + addition  # P16
    return {
        "shrinkage": shrinkage,
        "glide": glide,
        "growth": growth_v,
        "overallBuffer": overall,
        "bufferHc": buffer_hc,
        "reqHcProd": req,
        "attrition": attrition,
        "snp": snp,
        "attritionHc": attr_hc,
        "projectedHc": projected,
        "capacityPct": safe_div(projected, req),  # P17
        "va": None if req is None else projected - req,  # P18
    }


def hc_qca(
    *,
    budget_qca_pct: float | None,
    projected_prod_hc: float,
    actual_qa: float,
    attr_b: float | None,
    attr_a: float | None,
    snp: float,
    addition: float,
    mode: str,
) -> dict[str, float | None]:
    pct = _nz(budget_qca_pct)
    req = projected_prod_hc * pct  # Q3
    attrition = _nz(max_of(attr_b, attr_a))  # Q5
    attr_hc = actual_qa * (snp if mode == "snp" else attrition)  # Q7
    projected = actual_qa - attr_hc + addition  # Q9
    return {
        "budgetQcaPct": pct,
        "projectedProdHc": projected_prod_hc,
        "reqQca": req,
        "attrition": attrition,
        "snp": snp,
        "attritionHc": attr_hc,
        "projectedQca": projected,
        "capacityPct": safe_div(projected, req),
        "va": projected - req,
    }


def flat_ramp_production(ramp_hc: float, units_per_day: float, wdays: float) -> float:
    return ramp_hc * units_per_day * wdays


def volume_based(
    *,
    forecast_volume: float,
    actual_hc: float,
    ramp_trainee: int,
    ramp_lateral: int,
    ramp_production: float | None,
    peak: float | None,
    wdays: float,
    shrinkage_pct: float,
    sampling_pct: float | None,
    actual_qca: float,
    peak_qca: float | None,
) -> dict[str, float | None]:
    total_ramp = ramp_trainee + ramp_lateral  # V5
    bau_hc = actual_hc - total_ramp  # V7
    bau_prod = None if peak is None else bau_hc * peak * wdays  # V8
    raw = None if ramp_production is None or bau_prod is None else ramp_production + bau_prod  # V9
    actual_prod = None if raw is None else raw * (1 - shrinkage_pct)  # V10
    va_units = None if actual_prod is None else actual_prod - forecast_volume  # V12
    to_audit = (
        None if actual_prod is None or sampling_pct is None else actual_prod * sampling_pct
    )  # V15
    qca_prod = None if peak_qca is None else actual_qca * peak_qca * wdays  # V17
    return {
        "forecastVolume": forecast_volume,
        "actualHc": actual_hc,
        "rampTrainee": ramp_trainee,
        "rampLateral": ramp_lateral,
        "totalRampHc": total_ramp,
        "rampProduction": ramp_production,
        "bauHc": bau_hc,
        "bauProduction": bau_prod,
        "rawProduction": raw,
        "actualProductivity": actual_prod,
        "capacityPct": safe_div(actual_prod, forecast_volume),  # V11
        "vaUnits": va_units,
        "vaHc": safe_div(safe_div(va_units, peak), wdays),  # V13
        "samplingPct": sampling_pct,
        "toBeAudited": to_audit,
        "actualQca": actual_qca,
        "qcaProduction": qca_prod,
        "qcaCapacityPct": safe_div(qca_prod, to_audit),  # V18
    }


# ---------------------------------------------------------------- switches (§7)

DEFAULT_CONFIG: dict[str, Any] = {
    "snpPct": 0.2,
    "billTypeTreatment": {
        "Transaction based - Hourly TAT": "transaction",
        "Transaction based - Days TAT": "transaction",
        "Transaction Slab based": "transaction",
        "Flat FTE": "fte",
        "FTE Slab Based": "fte",
        "Hourly FTE": "hourly",
        "Additional Billing - Flat Rate": "exclude",
    },
    "hoursPerDay": 8,
    "glideActualPct": None,
    "qcaAttritionMode": "snp",
    "rampMode": "grid",
    "rampFlatUnitsPerDay": 15,
    "samplingMode": "grid",
    "samplingFlatPct": 0.18,
    "volumeShrinkageSource": "min",
    "carryForwardBudget": True,
    "missingPeakMode": "blank-key",
    "volumeForecastBasis": "units",
    "thresholdLow": 0.95,
    "thresholdHigh": 1.05,
}

#: Allowed values for the enumerated switches (used to validate API input).
CONFIG_CHOICES: dict[str, tuple[Any, ...]] = {
    "qcaAttritionMode": ("snp", "attrition"),
    "rampMode": ("grid", "flat"),
    "samplingMode": ("grid", "flat"),
    "volumeShrinkageSource": ("min", "budget", "actual"),
    "carryForwardBudget": (True, False),
    "missingPeakMode": ("blank-key", "exclude-task"),
    "volumeForecastBasis": ("units", "equivalent"),
}
BILL_TREATMENTS = ("transaction", "fte", "hourly", "exclude")


def classify_bill_type(bill_type: str) -> str:
    k = bill_type.strip().upper()
    if "ADDITIONAL BILLING" in k:
        return "exclude"
    if k == "HOURLY FTE":
        return "hourly"
    if k in ("FLAT FTE", "FTE SLAB BASED") or ("FTE" in k and "TRANSACTION" not in k):
        return "fte"
    return "transaction"


def treatment_for(cfg: dict[str, Any], bill_type: str) -> str:
    table = cfg.get("billTypeTreatment") or {}
    if bill_type in table:
        return table[bill_type]
    for k, v in table.items():
        if k.strip().upper() == bill_type.strip().upper():
            return v
    return classify_bill_type(bill_type)


def merged_config(cfg: dict[str, Any] | None) -> dict[str, Any]:
    return {**DEFAULT_CONFIG, **(cfg or {})}
