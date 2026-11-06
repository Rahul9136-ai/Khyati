"""Capacity Planning engine — port of frontend/src/lib/capacity/engine.ts.

`run_engine(dataset, config)` normalises and joins the 14 input sheets,
computes HC Based (Production / QCA) and Volume Based results per
Customer × Service Line × Location × Month and logs every data exception.
Iteration and summation order mirror the TypeScript so both give identical
floating-point results (tests/test_capacity_parity.py).

`dataset` maps sheet id → {"rows": [{"__row": n, <column>: value, …}],
"monthColumns": [...] (forecast only)}.
"""

from __future__ import annotations

import math
import re
from typing import Any, cast

from app.modules.capacity.calc import (
    base_fte_transaction,
    canon_location,
    flat_ramp_production,
    hc_production,
    hc_qca,
    js_str,
    key_of,
    location_key,
    merged_config,
    month_label,
    month_start,
    norm_approved,
    num,
    parse_date,
    parse_month,
    safe_div,
    sl_key,
    treatment_for,
    volume_based,
)

RAMP_WEEKS = 16
SAMPLING_WEEKS = 12
PROD_CATEGORIES = {"02. PRODUCTION", "12. TRAINEE [DU & CUSTOMER SPECIFIC]"}
QA_CATEGORY = "02. QA"

_UNITS_PREFIX = re.compile(r"^units\s*_\s*", re.I)

SHEET_LABEL = {
    "userMapping": "User Mapping",
    "forecast": "Forecast Details",
    "target": "Target Details",
    "ramp": "Ramp Grid",
    "hiring": "Hiring (RR)",
    "budgetBuffer": "Budgeted Buffer",
    "actualShrinkage": "Actual Shrinkage",
    "actualAttrition": "Actual Attrition",
    "budgetAttrition": "Budgeted Attrition",
    "budgetQca": "Budgeted QCA %",
    "trainingDays": "Training Days",
    "designationType": "Designation Type",
    "sampling": "Sampling Grid",
    "workingDays": "Working Days",
}


def _str(v: Any) -> str:
    return "" if v is None else js_str(v).strip()


def _fmt2(v: float) -> str:
    """JS `+v.toFixed(2)` printed with String()."""
    r = round(v + 0.0, 2)
    return js_str(float(r))


def ratio_of(r: dict[str, Any]) -> float | None:
    """Budgeted Attrition / QCA %: Numerator ÷ Denominator."""
    return safe_div(num(r.get("Numerator")), num(r.get("Denominator")))


def _rows(ds: dict[str, Any], sheet: str) -> list[dict[str, Any]]:
    return (ds.get(sheet) or {}).get("rows") or []


def _monthly_get(lookup: dict[str, dict[str, Any]], key: str, month: str, carry: bool):
    m = lookup.get(key)
    if m is None:
        return None, None
    if month in m:
        return m[month], None
    if not carry:
        return None, None
    best = None
    for mk in m:
        if mk < month and (best is None or mk > best):
            best = mk
    return (m[best], best) if best else (None, None)


def run_engine(ds: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:  # noqa: C901, PLR0912, PLR0915
    cfg = merged_config(config)
    ex: list[dict[str, Any]] = []

    def log(**e: Any) -> None:
        ex.append({"row": None, **e})

    cust_name: dict[str, str] = {}
    sl_name: dict[str, str] = {}

    variants: dict[str, dict[str, Any]] = {}

    def note_variant(sheet: str, field: str, raw: str, to: str) -> None:
        if not raw or raw == to:
            return
        vid = f"{sheet}|{field}|{raw}"
        if vid in variants:
            variants[vid]["count"] += 1
        else:
            variants[vid] = {"sheet": sheet, "count": 1, "to": to, "field": field}

    unknown_loc: dict[str, dict[str, Any]] = {}

    def loc_of(sheet: str, raw: Any, row: int, field: str = "Location") -> str:
        s = _str(raw)
        c = canon_location(s)
        if c:
            note_variant(SHEET_LABEL[sheet], field, s, c)
            return c
        if s:
            u = unknown_loc.setdefault(f"{sheet}|{s}", {"sheet": SHEET_LABEL[sheet], "rows": []})
            u["rows"].append(row)
        return s

    def sl_of(sheet: str, raw: Any, field: str) -> str:
        s = _str(raw)
        canonical = sl_name.get(sl_key(s))
        if canonical and canonical != s:
            note_variant(SHEET_LABEL[sheet], field, s, canonical)
        return s

    # ---- Working Days → horizon
    wdays: dict[str, float] = {}
    for r in _rows(ds, "workingDays"):
        m = parse_month(r.get("Month"))
        d = num(r.get("Days"))
        if not m:
            log(
                code="unparsable-month",
                severity="error",
                sheet="Working Days",
                row=r["__row"],
                issue="Month can't be parsed as Mon'YY",
                value=_str(r.get("Month")),
                action="Row ignored",
            )
            continue
        if d is None or d <= 0:
            log(
                code="non-numeric",
                severity="error",
                sheet="Working Days",
                row=r["__row"],
                issue="Days missing, zero or not a number",
                value=_str(r.get("Days")),
                action="Month has no W.days — Base FTE blank",
            )
            continue
        wdays[m] = d
    month_cols = []
    for c in (ds.get("forecast") or {}).get("monthColumns") or []:
        month_cols.append((c, parse_month(_UNITS_PREFIX.sub("", c))))
    for col, mk in month_cols:
        if not mk:
            log(
                code="unparsable-month",
                severity="error",
                sheet="Forecast Details",
                issue="Month column can't be parsed as Mon'YY",
                value=col,
                action="Column ignored",
            )
    months = sorted(wdays)
    if not months:
        months = sorted({mk for _, mk in month_cols if mk})
    horizon = set(months)
    first_month = months[0] if months else None
    last_month = months[-1] if months else None

    # ---- Designation Type
    user_type_of: dict[str, str] = {}
    for r in _rows(ds, "designationType"):
        desig = key_of(r.get("Designation"))
        if desig and desig not in user_type_of:
            user_type_of[desig] = _str(r.get("User Type"))

    # ---- Target Details
    targets: dict[str, dict[str, Any]] = {}
    zero_peak_targets = 0
    for r in _rows(ds, "target"):
        t = key_of(r.get("TaskNo"))
        if not t:
            continue
        if t in targets:
            log(
                code="duplicate-lookup",
                severity="warning",
                sheet="Target Details",
                row=r["__row"],
                issue="TaskNo is not unique",
                value=_str(r.get("TaskNo")),
                action="First row used",
            )
            continue
        peak = num(r.get("Peak Target Prod"))
        peak_qca = num(r.get("Peak Target QCA"))
        if peak is None or peak <= 0:
            zero_peak_targets += 1
        targets[t] = {
            "peak": peak if peak is not None and peak > 0 else None,
            "peakQca": peak_qca if peak_qca is not None and peak_qca > 0 else None,
            "row": r["__row"],
        }

    # ---- Ramp Grid
    ramp_grid: dict[str, list[float]] = {}
    for r in _rows(ds, "ramp"):
        gid = f"{key_of(r.get('TaskNo'))}|{key_of(r.get('User Type'))}"
        if gid in ramp_grid:
            continue
        ramp_grid[gid] = [(num(r.get(f"Week {i + 1} %")) or 0) / 100 for i in range(RAMP_WEEKS)]

    # ---- Forecast
    keys: dict[str, dict[str, str]] = {}
    fc: dict[str, dict[str, Any]] = {}

    def ensure_key(cust: str, sl: str, loc: str) -> dict[str, str]:
        ck, sk, lk = key_of(cust), sl_key(sl), location_key(loc)
        k = f"{ck}|{sk}|{lk}"
        info = keys.get(k)
        if info is None:
            cust_name.setdefault(ck, cust) if ck else None
            sl_name.setdefault(sk, sl) if sk else None
            info = {
                "key": k,
                "customer": cust_name.get(ck, cust),
                "serviceLine": sl_name.get(sk, sl),
                "location": canon_location(loc) or loc,
            }
            keys[k] = info
        return info

    def where(info: dict[str, str]) -> dict[str, str]:
        return {
            "customer": info["customer"],
            "serviceLine": info["serviceLine"],
            "location": info["location"],
        }

    dup_seen: dict[str, int] = {}
    for r in _rows(ds, "forecast"):
        cust = _str(r.get("Customer Name"))
        sl = sl_of("forecast", r.get("SERVICE_LINE"), "SERVICE_LINE")
        loc = loc_of("forecast", r.get("Location"), r["__row"])
        bill_type = _str(r.get("BILL_TYPE"))
        treatment = treatment_for(cfg, bill_type)
        task_no = _str(r.get("TASK_NUMBER (New)"))
        info = ensure_key(cust, sl, loc)

        if treatment == "exclude":
            vals = [num(r.get(c)) or 0 for c, _ in month_cols]
            neg = " (incl. negatives)" if any(v < 0 for v in vals) else ""
            log(
                code="additional-billing",
                severity="warning",
                sheet="Forecast Details",
                row=r["__row"],
                **where(info),
                issue=f'BILL_TYPE "{bill_type}" holds money values{neg}',
                value=", ".join(_fmt2(v) for v in vals),
                action="Excluded from volume and Base FTE (§7 Q1)",
            )
            continue

        dup_id = f"{key_of(task_no)}|{location_key(loc)}"
        if dup_id in dup_seen:
            log(
                code="forecast-duplicate",
                severity="warning",
                sheet="Forecast Details",
                row=r["__row"],
                **where(info),
                issue="Duplicate Forecast row on TASK_NUMBER + Location",
                value=f"{task_no} @ {loc} (rows {dup_seen[dup_id]} & {r['__row']})",
                action="Units summed",
            )
        else:
            dup_seen[dup_id] = r["__row"]

        target = targets.get(key_of(task_no))
        if target is None:
            tx = treatment == "transaction"
            log(
                code="forecast-task-missing",
                severity="error" if tx else "warning",
                sheet="Forecast Details",
                row=r["__row"],
                **where(info),
                issue="TASK_NUMBER not found in Target Details — no peak target",
                value=task_no,
                action="Base FTE not computed for this key — flagged, not defaulted to 0"
                if tx
                else f"No peak needed for {bill_type} Base FTE; volume-based figures for this task "
                "have no peak",
            )
        elif (
            target["peak"] is None
            and treatment == "transaction"
            and any((num(r.get(c)) or 0) != 0 for c, _ in month_cols)
        ):
            log(
                code="peak-target-invalid",
                severity="error",
                sheet="Forecast Details",
                row=r["__row"],
                **where(info),
                issue=f"Peak Target Prod is 0 / blank in Target Details (row {target['row']})",
                value=task_no,
                action="Base FTE not computed for this key — flagged, not defaulted to 0 or ∞",
            )

        acc = fc.setdefault(info["key"], {"info": info, "tasks": {}})
        task = acc["tasks"].get(key_of(task_no))
        if task is None:
            task = {
                "taskNo": task_no,
                "billType": bill_type,
                "treatment": treatment,
                "peak": target["peak"] if target else None,
                "peakQca": target["peakQca"] if target else None,
                "rows": [],
                "units": {},
            }
            acc["tasks"][key_of(task_no)] = task
        task["rows"].append(r["__row"])
        for col, mk in month_cols:
            if not mk:
                continue
            raw = r.get(col)
            u = num(raw)
            if raw is not None and raw != "" and u is None:
                log(
                    code="non-numeric",
                    severity="error",
                    sheet="Forecast Details",
                    row=r["__row"],
                    **where(info),
                    month=month_label(mk),
                    issue=f"Units for {col} not a number",
                    value=_str(raw),
                    action="Treated as 0",
                )
            task["units"][mk] = task["units"].get(mk, 0) + (u or 0)

    # ---- User Mapping
    roster: dict[str, dict[str, list[dict[str, Any]]]] = {}
    roster_prod: list[dict[str, str]] = []
    roster_qa: list[dict[str, str]] = []
    for r in _rows(ds, "userMapping"):
        if key_of(r.get("Employment Status")) != "ACTIVE":
            continue
        cat = key_of(r.get("Employee Category"))
        is_prod = cat in PROD_CATEGORIES
        is_qa = cat == QA_CATEGORY
        if not is_prod and not is_qa:
            continue
        cust = _str(r.get("Customer Name"))
        sl = sl_of("userMapping", r.get("Service Line"), "Service Line")
        loc = loc_of("userMapping", r.get("City"), r["__row"], "City")
        info = ensure_key(cust, sl, loc)
        job = _str(r.get("Job Name"))
        utype = user_type_of.get(key_of(job))
        if utype is None:
            log(
                code="job-not-in-designation",
                severity="warning",
                sheet="User Mapping",
                row=r["__row"],
                **where(info),
                issue="Job Name missing from Designation Type",
                value=job,
                action="No user type — counted in HC, treated as BAU (not ramp)",
            )
        dop = parse_date(r.get("Date of Production"))
        if not dop and is_prod:
            log(
                code="missing-dop",
                severity="warning",
                sheet="User Mapping",
                row=r["__row"],
                **where(info),
                issue="Date of Production missing",
                value=_str(r.get("Emp Id")),
                action="Counted in HC, treated as BAU (not ramp)",
            )
        person: dict[str, Any] = {
            "type": utype or "",
            "dop": dop,
            "specialty": _str(r.get("Specialty")),
            "row": r["__row"],
        }
        g = roster.setdefault(info["key"], {"prod": [], "qa": []})
        if is_prod:
            g["prod"].append(person)
            roster_prod.append(where(info))
        else:
            g["qa"].append(person)
            roster_qa.append(where(info))

    # ---- Hiring
    add_prod: dict[str, float] = {}
    add_qca: dict[str, float] = {}
    hiring_counts: list[dict[str, Any]] = []
    expected_sno = 1
    for r in _rows(ds, "hiring"):
        sno = num(r.get("S.No"))
        if sno != expected_sno:
            log(
                code="sno-gap",
                severity="warning",
                sheet="Hiring (RR)",
                row=r["__row"],
                issue=f"S.No breaks the running number (expected {expected_sno})",
                value=_str(r.get("S.No")),
                action="S.No = previous + 1 used for display",
            )
        expected_sno += 1
        appr, typo = norm_approved(r.get("Approved Status"))
        cust = _str(r.get("Customer Name"))
        sl = sl_of("hiring", r.get("SL-As Per EM"), "SL-As Per EM")
        loc = loc_of("hiring", r.get("Location"), r["__row"])
        info = ensure_key(cust, sl, loc)
        if typo:
            log(
                code="approved-typo",
                severity="info",
                sheet="Hiring (RR)",
                row=r["__row"],
                **where(info),
                issue="Approved Status typo",
                value=_str(r.get("Approved Status")),
                action="Treated as Approved",
            )
        status = key_of(r.get("Status"))
        month = parse_month(r.get("Due to delivery month"))
        desig = _str(r.get("Designation"))
        utype = user_type_of.get(key_of(desig))
        if utype is None:
            log(
                code="hiring-designation-missing",
                severity="warning",
                sheet="Hiring (RR)",
                row=r["__row"],
                **where(info),
                issue="Designation missing from Designation Type",
                value=desig,
                action="Counted as a production (non-QCA) addition",
            )
        is_qca = key_of(utype) == "QCA"
        opening = num(r.get("Opening")) or 0
        if appr != "Approved" or status != "OPEN":
            log(
                code="hiring-not-approved",
                severity="info",
                sheet="Hiring (RR)",
                row=r["__row"],
                **where(info),
                issue="Not Approved + OPEN",
                value=f"{_str(r.get('Approved Status'))} / {_str(r.get('Status'))}",
                action="Not counted as an addition",
            )
            continue
        if not month:
            log(
                code="unparsable-month",
                severity="error",
                sheet="Hiring (RR)",
                row=r["__row"],
                **where(info),
                issue="Due to delivery month can't be parsed",
                value=_str(r.get("Due to delivery month")),
                action="Not counted as an addition",
            )
            hiring_counts.append(
                {
                    **where(info),
                    "month": None,
                    "opening": opening,
                    "qca": is_qca,
                    "inHorizon": False,
                }
            )
            continue
        in_h = month in horizon
        hiring_counts.append(
            {**where(info), "month": month, "opening": opening, "qca": is_qca, "inHorizon": in_h}
        )
        if not in_h:
            before = first_month is not None and month < first_month
            log(
                code="hiring-before-horizon" if before else "hiring-after-horizon",
                severity="warning",
                sheet="Hiring (RR)",
                row=r["__row"],
                **where(info),
                month=month_label(month),
                issue=(
                    "Due month falls before the forecast starts "
                    f"({month_label(first_month or month)})"
                    if before
                    else "Due month falls after the forecast ends "
                    f"({month_label(last_month) if last_month else ''})"
                ),
                value=month_label(month),
                action="Not added to any month",
            )
            continue
        target_map = add_qca if is_qca else add_prod
        aid = f"{info['key']}|{month}"
        target_map[aid] = target_map.get(aid, 0) + opening

    # ---- monthly budgets
    buffer: dict[str, dict[str, dict[str, float | None]]] = {}
    for r in _rows(ds, "budgetBuffer"):
        m = parse_month(r.get("Month"))
        if not m:
            log(
                code="unparsable-month",
                severity="error",
                sheet="Budgeted Buffer",
                row=r["__row"],
                issue="Month can't be parsed",
                value=_str(r.get("Month")),
                action="Row ignored",
            )
            continue
        k = (
            f"{key_of(r.get('Customer Name'))}|{sl_key(sl_of('budgetBuffer', r.get('SL'), 'SL'))}|"
            f"{location_key(loc_of('budgetBuffer', r.get('Location'), r['__row']))}"
        )
        mm = buffer.setdefault(k, {})
        if m in mm:
            log(
                code="duplicate-lookup",
                severity="warning",
                sheet="Budgeted Buffer",
                row=r["__row"],
                issue="Duplicate Customer × SL × Location × Month",
                value=k.replace("|", " × ") + f" × {month_label(m)}",
                action="First row used",
            )
            continue
        mm[m] = {
            "shr": num(r.get("Shrinkage %")),
            "glide": num(r.get("Glide Buffer %")),
            "growth": num(r.get("Growth Buffer %")),
        }
    bud_attr: dict[str, dict[str, float | None]] = {}
    for r in _rows(ds, "budgetAttrition"):
        m = parse_month(r.get("Month"))
        if not m:
            log(
                code="unparsable-month",
                severity="error",
                sheet="Budgeted Attrition",
                row=r["__row"],
                issue="Month can't be parsed",
                value=_str(r.get("Month")),
                action="Row ignored",
            )
            continue
        ratio = ratio_of(r)
        if ratio is None:
            log(
                code="div-by-zero",
                severity="warning",
                sheet="Budgeted Attrition",
                row=r["__row"],
                issue="Attrition % = Numerator ÷ Denominator can't be computed",
                value=f"{_str(r.get('Numerator'))} ÷ {_str(r.get('Denominator'))}",
                action="Budgeted attrition blank (Actual used if present)",
            )
        k = (
            f"{key_of(r.get('Customer Name'))}|"
            f"{sl_key(sl_of('budgetAttrition', r.get('SL'), 'SL'))}|"
            f"{location_key(loc_of('budgetAttrition', r.get('Location'), r['__row']))}"
        )
        bud_attr.setdefault(k, {}).setdefault(m, ratio)
    bud_qca: dict[str, dict[str, float | None]] = {}
    for r in _rows(ds, "budgetQca"):
        m = parse_month(r.get("Month"))
        if not m:
            log(
                code="unparsable-month",
                severity="error",
                sheet="Budgeted QCA %",
                row=r["__row"],
                issue="Month can't be parsed",
                value=_str(r.get("Month")),
                action="Row ignored",
            )
            continue
        ratio = ratio_of(r)
        if ratio is None:
            log(
                code="div-by-zero",
                severity="warning",
                sheet="Budgeted QCA %",
                row=r["__row"],
                issue="QCA % = Numerator ÷ Denominator can't be computed",
                value=f"{_str(r.get('Numerator'))} ÷ {_str(r.get('Denominator'))}",
                action="Budgeted QCA % blank",
            )
        k = f"{key_of(r.get('Customer Name'))}|{sl_key(sl_of('budgetQca', r.get('SL'), 'SL'))}"
        bud_qca.setdefault(k, {}).setdefault(m, ratio)
    act_shr: dict[str, float | None] = {}
    for r in _rows(ds, "actualShrinkage"):
        k = (
            f"{key_of(r.get('Customer Name'))}|"
            f"{sl_key(sl_of('actualShrinkage', r.get('Service Line'), 'Service Line'))}|"
            f"{location_key(loc_of('actualShrinkage', r.get('Location'), r['__row']))}"
        )
        act_shr.setdefault(k, num(r.get("Last 3 month cum trend - %")))
    act_attr: dict[str, float | None] = {}
    for r in _rows(ds, "actualAttrition"):
        desg = "QCA" if key_of(r.get("Desg")) == "QCA" else "PROD"
        k = (
            f"{desg}|{key_of(r.get('Customer Name'))}|"
            f"{sl_key(sl_of('actualAttrition', r.get('Vertical'), 'Vertical'))}|"
            f"{location_key(loc_of('actualAttrition', r.get('Location'), r['__row']))}"
        )
        act_attr.setdefault(k, num(r.get("Last 3 month cum trend - %")))
    sampling: dict[str, list[float]] = {}
    for r in _rows(ds, "sampling"):
        k = "|".join(
            [
                key_of(r.get("User Type")),
                key_of(r.get("Customer Name")),
                sl_key(r.get("Service Line")),
                key_of(r.get("Specialty")),
            ]
        )
        if k not in sampling:
            sampling[k] = [num(r.get(f"Week-{i + 1}")) or 0 for i in range(SAMPLING_WEEKS)] + [
                num(r.get("BAU")) or 0
            ]

    # ---- per key × month
    out: list[dict[str, Any]] = []
    missing_budget: dict[str, dict[str, Any]] = {}

    def note_missing(info: dict[str, str], what: str, month: str, carried: bool) -> None:
        e = missing_budget.setdefault(
            f"{info['key']}|{what}|{str(carried).lower()}",
            {"info": info, "what": [], "months": [], "carried": carried},
        )
        if what not in e["what"]:
            e["what"].append(what)
        lab = month_label(month)
        if lab not in e["months"]:
            e["months"].append(lab)

    missing_sampling: dict[str, dict[str, Any]] = {}

    for info in sorted(
        keys.values(),
        key=lambda i: (i["customer"].lower(), i["serviceLine"].lower(), i["location"].lower()),
    ):
        key_acc = fc.get(info["key"])
        ck, sk = info["key"].split("|")[:2]
        team = roster.get(info["key"], {"prod": [], "qa": []})
        tasks = list(key_acc["tasks"].values()) if key_acc else []

        for month in months:
            wd = wdays.get(month)
            flags: list[str] = []
            contribs: list[dict[str, Any]] = []
            volume = 0.0
            equiv = 0.0
            base_fte: float | None = 0.0
            blank_reason: str | None = None
            tx_units = 0.0
            tx_units_per_peak = 0.0
            for t in tasks:
                units = t["units"].get(month, 0)
                volume += units
                fte: float | None = None
                if wd is None:
                    blank_reason = f"No W.days for {month_label(month)}"
                elif t["treatment"] == "transaction":
                    if t["peak"] is None:
                        if units != 0:
                            if cfg["missingPeakMode"] == "blank-key":
                                blank_reason = f"Task {t['taskNo']} has no peak target"
                            flags.append(f"Task {t['taskNo']}: no peak target")
                        else:
                            fte = 0
                    else:
                        fte = base_fte_transaction(units, wd, t["peak"])
                        tx_units += units
                        tx_units_per_peak += units / t["peak"]
                    equiv += units
                elif t["treatment"] == "fte":
                    fte = units
                    if t["peak"] is not None:
                        equiv += units * t["peak"] * wd
                elif t["treatment"] == "hourly":
                    fte = safe_div(units, wd * cfg["hoursPerDay"])
                    if t["peak"] is not None and fte is not None:
                        equiv += fte * t["peak"] * wd
                if fte is not None and base_fte is not None:
                    base_fte += fte
                contribs.append(
                    {
                        "taskNo": t["taskNo"],
                        "billType": t["billType"],
                        "treatment": t["treatment"],
                        "units": units,
                        "peak": t["peak"],
                        "baseFte": fte,
                        "sourceRows": t["rows"],
                    }
                )
            if blank_reason:
                base_fte = None

            peaks = [t["peak"] for t in tasks if t["peak"] is not None]
            peak = (
                tx_units / tx_units_per_peak
                if tx_units_per_peak > 0
                else (sum(peaks) / len(peaks) if peaks else None)
            )
            qca_w = [
                t
                for t in tasks
                if t["peakQca"] is not None
                and t["treatment"] == "transaction"
                and t["units"].get(month, 0) > 0
            ]
            qca_wsum = sum(t["units"].get(month, 0) for t in qca_w)
            qca_all = [t["peakQca"] for t in tasks if t["peakQca"] is not None]
            if qca_wsum > 0:
                s = 0.0
                for t in qca_w:
                    s += t["peakQca"] * t["units"].get(month, 0)
                peak_qca = s / qca_wsum
            else:
                peak_qca = (sum(qca_all) / len(qca_all)) if qca_all else None

            bb, bb_from = _monthly_get(buffer, info["key"], month, cfg["carryForwardBudget"])
            ba, ba_from = _monthly_get(bud_attr, info["key"], month, cfg["carryForwardBudget"])
            bq, bq_from = _monthly_get(bud_qca, f"{ck}|{sk}", month, cfg["carryForwardBudget"])
            carried = bool(bb_from or ba_from or bq_from)
            if bb_from:
                note_missing(info, "Budgeted Buffer", month, True)
            elif not bb:
                note_missing(info, "Budgeted Buffer", month, False)
            if ba_from:
                note_missing(info, "Budgeted Attrition", month, True)
            elif ba is None:
                note_missing(info, "Budgeted Attrition", month, False)
            if bq_from:
                note_missing(info, "Budgeted QCA %", month, True)
            elif bq is None:
                note_missing(info, "Budgeted QCA %", month, False)
            if carried:
                flags.append(
                    f"Budget carried forward from {month_label(bb_from or ba_from or bq_from)}"
                )

            shrink_a = act_shr.get(info["key"])
            attr_prod_a = act_attr.get(f"PROD|{info['key']}")
            attr_qca_a = act_attr.get(f"QCA|{info['key']}")
            actual_hc = len(team["prod"])
            actual_qa = len(team["qa"])
            addition_prod = add_prod.get(f"{info['key']}|{month}", 0)
            addition_qca = add_qca.get(f"{info['key']}|{month}", 0)

            prod = hc_production(
                base_fte=base_fte,
                shrink_b=bb["shr"] if bb else None,
                shrink_a=shrink_a,
                glide_b=bb["glide"] if bb else None,
                glide_a=cfg["glideActualPct"],
                growth=bb["growth"] if bb else None,
                actual_hc=actual_hc,
                attr_b=ba,
                attr_a=attr_prod_a,
                snp=cfg["snpPct"],
                addition=addition_prod,
            )
            qca = hc_qca(
                budget_qca_pct=bq,
                projected_prod_hc=cast(float, prod["projectedHc"]),
                actual_qa=actual_qa,
                attr_b=ba,
                attr_a=attr_qca_a,
                snp=cfg["snpPct"],
                addition=addition_qca,
                mode=cfg["qcaAttritionMode"],
            )

            # ---- volume based
            ramp_trainee = 0
            ramp_lateral = 0
            ramp_prod_grid: float | None = 0.0
            samp_w = 0.0
            samp_sum = 0.0
            ms = month_start(month)

            def grid_for(utype: str, week: int, _tasks=tasks, _month=month) -> float | None:
                rows = []
                for t in _tasks:
                    g = ramp_grid.get(f"{key_of(t['taskNo'])}|{key_of(utype)}")
                    if g:
                        rows.append(
                            (g, t["units"].get(_month, 0) if t["treatment"] == "transaction" else 0)
                        )
                if not rows:
                    return None
                wsum = 0.0
                for _, w in rows:
                    wsum += w
                acc_v = 0.0
                if wsum > 0:
                    for g, w in rows:
                        acc_v += g[week - 1] * w
                    return acc_v / wsum
                for g, _ in rows:
                    acc_v += g[week - 1]
                return acc_v / len(rows)

            for usr in team["prod"]:
                t = key_of(usr["type"])
                week: int | None = None
                if usr["dop"] and t in ("TRAINEE", "LATERAL"):
                    w = math.floor((ms - usr["dop"]).days / 7) + 1
                    week = max(1, w)
                    if week > RAMP_WEEKS:
                        week = None
                user_prod: float | None = None if peak is None or wd is None else peak * wd
                if week is not None:
                    if t == "TRAINEE":
                        ramp_trainee += 1
                    else:
                        ramp_lateral += 1
                    pct = grid_for(usr["type"], week)
                    if pct is None or user_prod is None:
                        ramp_prod_grid = None
                        user_prod = None
                    else:
                        user_prod = user_prod * pct
                        if ramp_prod_grid is not None:
                            ramp_prod_grid += user_prod
                if cfg["samplingMode"] == "grid" and user_prod is not None:
                    grid: list[float] | None = None
                    for ty in ("TRAINEE", "LATERAL") if t == "TRAINEE" else ("LATERAL", "TRAINEE"):
                        grid = sampling.get("|".join([ty, ck, sk, key_of(usr["specialty"])]))
                        if grid:
                            break
                    if not grid:
                        s_pct = cfg["samplingFlatPct"]
                        ms_entry = missing_sampling.setdefault(
                            info["key"], {"info": info, "users": 0}
                        )
                        ms_entry["users"] += 1
                    else:
                        s_pct = (
                            grid[week - 1]
                            if week is not None and week <= SAMPLING_WEEKS
                            else grid[SAMPLING_WEEKS]
                        )
                    samp_w += user_prod
                    samp_sum += user_prod * s_pct
            if (
                ramp_prod_grid is not None
                and ramp_trainee + ramp_lateral > 0
                and (peak is None or wd is None)
            ):
                ramp_prod_grid = None
            if cfg["rampMode"] == "flat":
                ramp_production = (
                    None
                    if wd is None
                    else flat_ramp_production(
                        ramp_trainee + ramp_lateral, cfg["rampFlatUnitsPerDay"], wd
                    )
                )
            else:
                ramp_production = ramp_prod_grid
            src = cfg["volumeShrinkageSource"]
            shrink_vol = (
                prod["shrinkage"]
                if src == "min"
                else (
                    (bb["shr"] if bb and bb["shr"] is not None else 0)
                    if src == "budget"
                    else (shrink_a or 0)
                )
            )
            if cfg["samplingMode"] == "flat":
                sampling_pct = cfg["samplingFlatPct"]
            elif samp_w > 0:
                sampling_pct = samp_sum / samp_w
            else:
                sampling_pct = None if team["prod"] else cfg["samplingFlatPct"]
            vol = volume_based(
                forecast_volume=volume if cfg["volumeForecastBasis"] == "units" else equiv,
                actual_hc=actual_hc,
                ramp_trainee=ramp_trainee,
                ramp_lateral=ramp_lateral,
                ramp_production=ramp_production,
                peak=peak,
                wdays=wd or 0,
                shrinkage_pct=float(shrink_vol or 0),
                sampling_pct=sampling_pct,
                actual_qca=actual_qa,
                peak_qca=peak_qca,
            )
            if wd is None:
                flags.append(f"No W.days for {month_label(month)}")

            out.append(
                {
                    **info,
                    "month": month,
                    "monthLabel": month_label(month),
                    "forecastVolume": volume,
                    "peakTarget": peak,
                    "peakTargetQca": peak_qca,
                    "wdays": wd,
                    "baseFte": base_fte,
                    "baseFteBlankReason": blank_reason,
                    "shrinkB": bb["shr"] if bb else None,
                    "shrinkA": shrink_a,
                    "glideB": bb["glide"] if bb else None,
                    "glideA": cfg["glideActualPct"],
                    "growthB": bb["growth"] if bb else None,
                    "attrB": ba,
                    "attrProdA": attr_prod_a,
                    "attrQcaA": attr_qca_a,
                    "budgetQcaPct": bq,
                    "actualHc": actual_hc,
                    "actualQa": actual_qa,
                    "additionProd": addition_prod,
                    "additionQca": addition_qca,
                    "budgetCarried": carried,
                    "prod": prod,
                    "qca": qca,
                    "vol": vol,
                    "tasks": contribs,
                    "flags": flags,
                }
            )

    # ---- roll-up exceptions
    for e in missing_budget.values():
        ms_list = e["months"]
        span = (
            ms_list[0]
            if len(ms_list) == 1
            else f"{ms_list[0]}–{ms_list[-1]} ({len(ms_list)} months)"
        )
        i = e["info"]
        log(
            code="no-budget-month",
            severity="warning",
            sheet=", ".join(e["what"]),
            **where(i),
            issue="No budget row for these forecast months"
            if e["carried"]
            else "No budget row for this key at all",
            value=f"{i['customer']} × {i['serviceLine']} × {i['location']}: {span}",
            action="Last budget month carried forward (§7 Q7) — rows flagged"
            if e["carried"]
            else "Budgeted value missing → Actual used if present, else 0",
        )
    for miss in missing_sampling.values():
        log(
            code="missing-lookup",
            severity="warning",
            sheet="Sampling Grid",
            **where(miss["info"]),
            issue="No Sampling Grid row for (User Type, Customer, SL, Specialty)",
            value=f"{miss['users']} user-months",
            action=f"Flat {round(cfg['samplingFlatPct'] * 100)}% used",
        )
    if zero_peak_targets:
        log(
            code="peak-target-invalid",
            severity="info",
            sheet="Target Details",
            issue="Target rows with Peak Target Prod = 0 / blank",
            value=f"{zero_peak_targets} rows",
            action="Only a problem where a transaction forecast uses the task — "
            "those rows are listed separately",
        )
    for unk in unknown_loc.values():
        log(
            code="unknown-location",
            severity="warning",
            sheet=unk["sheet"],
            row=unk["rows"][0],
            issue="Location not in the §3 location map",
            value=f"{len(unk['rows'])} row(s)",
            action="Original value used as the key — may not join",
        )
    for vid, v in variants.items():
        raw = vid.split("|")[2]
        log(
            code="spelling-variant",
            severity="info",
            sheet=v["sheet"],
            issue=f"{v['field']} spelling variant",
            value=f"{raw} → {v['to']} ({v['count']} rows)",
            action="Normalised by the §3 maps",
        )

    return {
        "months": months,
        "rows": out,
        "exceptions": ex,
        "counts": {"rosterProd": roster_prod, "rosterQa": roster_qa, "hiring": hiring_counts},
    }
