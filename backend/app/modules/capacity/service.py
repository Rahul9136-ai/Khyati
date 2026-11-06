"""Capacity Planning — shared storage, API operations and webhook events.

Everything the Capacity Planning tab works on is stored per organisation, so
every browser and every connected tool (CRM, HR system…) sees and changes the
same data:

* the 14 input sheets — replaced whole (an Excel import, PUT) or edited row by
  row (cell edits in the app, PATCH from a CRM: update by row number or by a
  business key such as `Emp Id` / `TaskNo`, insert, delete);
* the switches (§7 open decisions);
* the results, recalculated on the server by the same engine as the browser.

Each change bumps that document's `version` (a stale `base_version` → 409),
is audited, and emits webhooks: `capacity.inputs.updated` /
`capacity.config.updated`, then `capacity.results.updated` with the new
monthly totals.
"""

from __future__ import annotations

import hashlib
import math
import uuid
from collections import OrderedDict
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.modules.capacity.calc import (
    BILL_TREATMENTS,
    CONFIG_CHOICES,
    DEFAULT_CONFIG,
    canon_location,
    key_of,
    merged_config,
    parse_month,
)
from app.modules.capacity.engine import run_engine
from app.modules.capacity.models import CapacityDocument
from app.modules.capacity.schema import MONTH_COLUMN, SHEET_IDS, SHEETS, column_types, convert
from app.modules.connect import webhooks
from app.modules.identity.service import record_audit

CONFIG_DOC = "config"
MAX_ROWS = 50_000
#: Changed rows included in a `capacity.inputs.updated` event (the rest: fetch the sheet).
EVENT_ROWS = 200


# ---------------------------------------------------------------- reading


async def _docs(db: AsyncSession, org: uuid.UUID) -> dict[str, CapacityDocument]:
    rows = (
        await db.execute(select(CapacityDocument).where(CapacityDocument.organization_id == org))
    ).scalars()
    return {d.doc: d for d in rows}


async def _doc(db: AsyncSession, org: uuid.UUID, doc: str) -> CapacityDocument | None:
    return (
        await db.execute(
            select(CapacityDocument).where(
                CapacityDocument.organization_id == org, CapacityDocument.doc == doc
            )
        )
    ).scalar_one_or_none()


def _check_sheet(sheet: str) -> None:
    if sheet not in SHEETS:
        raise NotFoundError(f"Unknown sheet '{sheet}' — use one of: {', '.join(SHEET_IDS)}")


def _results_version(docs: dict[str, CapacityDocument]) -> str:
    # the row id is in it too: a sheet removed and loaded again restarts at version 1
    sig = "|".join(f"{k}:{docs[k].id}:{docs[k].version}" for k in sorted(docs))
    return hashlib.sha1(sig.encode()).hexdigest()[:12] if sig else "empty"  # noqa: S324 - not security


async def state(db: AsyncSession, org: uuid.UUID) -> dict[str, Any]:
    """Versions of everything — cheap to poll; when `resultsVersion` changes, refetch."""
    docs = await _docs(db, org)
    return {
        "sheets": {
            sid: (
                {
                    "version": d.version,
                    "rows": len(d.data.get("rows") or []),
                    "updatedAt": d.updated_at,
                    "updatedBy": d.updated_by,
                    "fileName": d.data.get("fileName"),
                }
                if (d := docs.get(sid))
                else None
            )
            for sid in SHEET_IDS
        },
        "config": {
            "version": docs[CONFIG_DOC].version,
            "updatedAt": docs[CONFIG_DOC].updated_at,
            "updatedBy": docs[CONFIG_DOC].updated_by,
        }
        if CONFIG_DOC in docs
        else None,
        "resultsVersion": _results_version(docs),
    }


def _sheet_out(sid: str, d: CapacityDocument, rows: bool = True) -> dict[str, Any]:
    data = d.data
    out = {
        "id": sid,
        "label": SHEETS[sid]["label"],
        "version": d.version,
        "updatedAt": d.updated_at,
        "updatedBy": d.updated_by,
        "fileName": data.get("fileName", ""),
        "sheetName": data.get("sheetName", ""),
        "columns": data.get("columns") or [],
        "monthColumns": data.get("monthColumns"),
        "rowCount": len(data.get("rows") or []),
    }
    if rows:
        out["rows"] = data.get("rows") or []
    return out


async def get_sheet(db: AsyncSession, org: uuid.UUID, sheet: str) -> dict[str, Any]:
    _check_sheet(sheet)
    d = await _doc(db, org, sheet)
    if d is None:
        raise NotFoundError(f"'{SHEETS[sheet]['label']}' hasn't been loaded yet")
    return _sheet_out(sheet, d)


async def list_sheets(db: AsyncSession, org: uuid.UUID, include_rows: bool) -> list[dict[str, Any]]:
    docs = await _docs(db, org)
    return [_sheet_out(sid, docs[sid], include_rows) for sid in SHEET_IDS if sid in docs]


async def get_config(db: AsyncSession, org: uuid.UUID) -> tuple[dict[str, Any], int]:
    d = await _doc(db, org, CONFIG_DOC)
    return (merged_config(d.data if d else None), d.version if d else 0)


# ---------------------------------------------------------------- results (cached)

_cache: OrderedDict[tuple[uuid.UUID, str], dict[str, Any]] = OrderedDict()
_CACHE_SIZE = 8


async def results(db: AsyncSession, org: uuid.UUID) -> tuple[dict[str, Any], str]:
    docs = await _docs(db, org)
    rv = _results_version(docs)
    hit = _cache.get((org, rv))
    if hit is not None:
        _cache.move_to_end((org, rv))
        return hit, rv
    dataset = {
        sid: {"rows": d.data.get("rows") or [], "monthColumns": d.data.get("monthColumns")}
        for sid, d in docs.items()
        if sid in SHEETS
    }
    res = run_engine(dataset, docs[CONFIG_DOC].data if CONFIG_DOC in docs else None)
    _cache[(org, rv)] = res
    while len(_cache) > _CACHE_SIZE:
        _cache.popitem(last=False)
    return res, rv


def passes(
    row: dict[str, Any],
    customer: str | None,
    service_line: str | None,
    location: str | None,
    month: str | None,
) -> bool:
    if customer and key_of(row.get("customer")) != key_of(customer):
        return False
    if service_line and key_of(row.get("serviceLine")) != key_of(service_line):
        return False
    if location and key_of(canon_location(row.get("location")) or row.get("location")) != key_of(
        canon_location(location) or location
    ):
        return False
    if month:
        m = parse_month(month)
        if row.get("month") is not None and row.get("month") != m:
            return False
    return True


def summary_row(r: dict[str, Any]) -> dict[str, Any]:
    """One row of the Summary tab."""
    return {
        "customer": r["customer"],
        "serviceLine": r["serviceLine"],
        "location": r["location"],
        "month": r["month"],
        "monthLabel": r["monthLabel"],
        "reqHcProd": r["prod"]["reqHcProd"],
        "actualHc": r["actualHc"],
        "additions": r["additionProd"] + r["additionQca"],
        "projectedHc": r["prod"]["projectedHc"],
        "capacityPct": r["prod"]["capacityPct"],
        "va": r["prod"]["va"],
        "reqQca": r["qca"]["reqQca"],
        "projectedQca": r["qca"]["projectedQca"],
        "qcaCapacityPct": r["qca"]["capacityPct"],
        "qcaVa": r["qca"]["va"],
        "volumeCapacityPct": r["vol"]["capacityPct"],
        "vaUnits": r["vol"]["vaUnits"],
        "vaHc": r["vol"]["vaHc"],
        "flags": ([f"Base FTE blank: {r['baseFteBlankReason']}"] if r["baseFteBlankReason"] else [])
        + r["flags"],
    }


def _ratio(rows: list[dict[str, Any]], num_f, den_f) -> float | None:  # noqa: ANN001
    n = d = 0.0
    for r in rows:
        a, b = num_f(r), den_f(r)
        if a is not None and b is not None and b != 0:
            n += a
            d += b
    return n / d if d else None


def monthly_totals(res: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for m in res["months"]:
        rows = [r for r in res["rows"] if r["month"] == m]
        out.append(
            {
                "month": m,
                "reqHcProd": sum(r["prod"]["reqHcProd"] or 0 for r in rows),
                "projectedHc": sum(
                    r["prod"]["projectedHc"] for r in rows if r["prod"]["reqHcProd"] is not None
                ),
                "capacityPct": _ratio(
                    rows, lambda r: r["prod"]["projectedHc"], lambda r: r["prod"]["reqHcProd"]
                ),
                "reqQca": sum(r["qca"]["reqQca"] for r in rows),
                "projectedQca": sum(r["qca"]["projectedQca"] for r in rows),
                "qcaCapacityPct": _ratio(
                    rows, lambda r: r["qca"]["projectedQca"], lambda r: r["qca"]["reqQca"]
                ),
                "forecastVolume": sum(r["vol"]["forecastVolume"] for r in rows),
                "volumeCapacityPct": _ratio(
                    rows,
                    lambda r: r["vol"]["actualProductivity"],
                    lambda r: r["vol"]["forecastVolume"],
                ),
                "rowsNotCalculated": sum(1 for r in rows if r["baseFte"] is None),
            }
        )
    return out


def exception_counts(res: dict[str, Any]) -> dict[str, int]:
    c = {"error": 0, "warning": 0, "info": 0}
    for e in res["exceptions"]:
        c[e["severity"]] = c.get(e["severity"], 0) + 1
    return c


# ---------------------------------------------------------------- writing


def _check_version(d: CapacityDocument | None, base_version: int | None, what: str) -> None:
    current = d.version if d else 0
    if base_version is not None and base_version != current:
        raise ConflictError(
            f"{what} was changed by someone else — reload and retry", details={"version": current}
        )


def _clean_rows(sheet: str, rows: list[Any], month_columns: list[str]) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        raise ValidationError("'rows' must be a list of objects")
    if len(rows) > MAX_ROWS:
        raise ValidationError(f"At most {MAX_ROWS} rows per sheet")
    types = column_types(sheet, month_columns)
    out: list[dict[str, Any]] = []
    seen: set[int] = set()
    for i, raw in enumerate(rows):
        if not isinstance(raw, dict):
            raise ValidationError(f"Row {i + 1} isn't an object")
        unknown = [k for k in raw if k != "__row" and k not in types]
        if unknown:
            raise ValidationError(
                f"Row {i + 1}: unknown column(s) {', '.join(unknown[:5])} "
                f"for {SHEETS[sheet]['label']}",
                details={"allowed": list(types)},
            )
        rn = raw.get("__row")
        if rn is None:
            rn = i + 2  # as if row 1 held the header
        if not isinstance(rn, int) or isinstance(rn, bool) or rn < 1 or rn in seen:
            raise ValidationError(f"Row {i + 1}: '__row' must be a unique positive whole number")
        seen.add(rn)
        out.append({"__row": rn, **{c: convert(raw.get(c), t) for c, t in types.items()}})
    if sheet == "hiring":
        for i, r in enumerate(out):
            if r.get("S.No") is None:
                r["S.No"] = (
                    out[i - 1]["S.No"] if i and isinstance(out[i - 1]["S.No"], (int, float)) else i
                ) + 1
    return out


def _month_columns(sheet: str, given: list[str] | None, rows: list[Any]) -> list[str]:
    if not SHEETS[sheet].get("monthColumns"):
        return []
    cols = list(given or [])
    for r in rows:
        if isinstance(r, dict):
            for k in r:
                if MONTH_COLUMN.match(k) and k not in cols:
                    cols.append(k)
    for c in cols:
        if not MONTH_COLUMN.match(c) or not parse_month(MONTH_COLUMN.sub("", c)):
            raise ValidationError(f"Month column '{c}' must look like \"Units _ Sep'26\"")
    if not cols:
        raise ValidationError(
            'Forecast Details needs at least one month column, e.g. "Units _ Sep\'26"'
        )
    return cols


async def _after_change(db: AsyncSession, org: uuid.UUID) -> None:
    """Recalculate and tell subscribers the results changed."""
    res, rv = await results(db, org)
    await webhooks.emit(
        db,
        org,
        "capacity.results.updated",
        {
            "resultsVersion": rv,
            "rows": len(res["rows"]),
            "months": monthly_totals(res),
            "exceptions": exception_counts(res),
        },
    )


async def _save(
    db: AsyncSession,
    org: uuid.UUID,
    d: CapacityDocument | None,
    doc: str,
    data: dict[str, Any],
    actor,
) -> CapacityDocument:  # noqa: ANN001
    if d is None:
        d = CapacityDocument(organization_id=org, doc=doc, data=data, version=1)
        db.add(d)
    else:
        d.data = data
        d.version = d.version + 1
    d.updated_by = getattr(actor, "email", "") or ""
    await db.flush()
    await db.refresh(d, ["updated_at"])
    return d


async def put_sheet(
    db: AsyncSession,
    org: uuid.UUID,
    sheet: str,
    body: dict[str, Any],
    *,
    actor,  # noqa: ANN001
    emit_results: bool = True,
) -> dict[str, Any]:
    """Replace a whole sheet (an Excel import, or a full push from a connected tool)."""
    _check_sheet(sheet)
    d = await _doc(db, org, sheet)
    _check_version(d, body.get("base_version"), SHEETS[sheet]["label"])
    rows_in = body.get("rows")
    mcols = _month_columns(sheet, body.get("monthColumns"), rows_in or [])
    rows = _clean_rows(sheet, rows_in if rows_in is not None else [], mcols)
    data = {
        "columns": [c for c, _ in SHEETS[sheet]["columns"]] + mcols,
        "rows": rows,
        "monthColumns": mcols or None,
        "fileName": body.get("fileName") or "API",
        "sheetName": body.get("sheetName") or SHEETS[sheet]["label"],
    }
    d = await _save(db, org, d, sheet, data, actor)
    await webhooks.emit(
        db,
        org,
        "capacity.inputs.updated",
        {
            "sheet": sheet,
            "label": SHEETS[sheet]["label"],
            "version": d.version,
            "change": "replaced",
            "rows": len(rows),
            "updatedBy": d.updated_by,
            "fileName": data["fileName"],
        },
    )
    await record_audit(
        db,
        actor=actor,
        action="capacity.sheet.replace",
        entity_type="capacity_sheet",
        entity_id=sheet,
        after={"version": d.version, "rows": len(rows)},
    )
    if emit_results:
        await _after_change(db, org)
    return _sheet_out(sheet, d, rows=False)


async def put_workbook(
    db: AsyncSession,
    org: uuid.UUID,
    sheets: dict[str, dict[str, Any]],
    *,
    actor,  # noqa: ANN001
) -> list[dict[str, Any]]:
    """Replace several sheets in one go (a full workbook import); one results event."""
    if not sheets:
        raise ValidationError("No sheets given")
    for sid in sheets:
        _check_sheet(sid)
    out = [
        await put_sheet(db, org, sid, body, actor=actor, emit_results=False)
        for sid, body in sheets.items()
    ]
    await _after_change(db, org)
    return out


def _matches(row: dict[str, Any], match: dict[str, Any], types: dict[str, str]) -> bool:
    """Does the row have these values? Compared the way they're stored — months, dates, numbers and
    percentages normalised (2026-09 = Sep'26, "12%" = 0.12), text case-insensitive, locations
    canonical."""
    for k, v in match.items():
        want = convert(v, types.get(k, "text"))
        have = row.get(k)
        if k in ("Location", "City") and canon_location(want) and canon_location(have):
            if canon_location(want) != canon_location(have):
                return False
        elif isinstance(want, (int, float)) and isinstance(have, (int, float)):
            if not math.isclose(want, have, rel_tol=1e-12, abs_tol=1e-12):
                return False
        elif key_of(have) != key_of(want):
            return False
    return True


async def patch_rows(
    db: AsyncSession,
    org: uuid.UUID,
    sheet: str,
    body: dict[str, Any],
    *,
    actor,  # noqa: ANN001
) -> dict[str, Any]:
    """Edit rows: `upsert` [{row | match, values}] and `delete` [row numbers] /
    `deleteMatch` [{…}]."""
    _check_sheet(sheet)
    d = await _doc(db, org, sheet)
    if d is None:
        raise NotFoundError(
            f"'{SHEETS[sheet]['label']}' hasn't been loaded yet — PUT the sheet first"
        )
    _check_version(d, body.get("base_version"), SHEETS[sheet]["label"])
    mcols = list(d.data.get("monthColumns") or [])
    types = column_types(sheet, mcols)
    rows: list[dict[str, Any]] = [dict(r) for r in d.data.get("rows") or []]
    by_row = {r["__row"]: r for r in rows}
    changed: list[dict[str, Any]] = []
    updated = inserted = deleted = 0

    for i, op in enumerate(body.get("upsert") or []):
        if not isinstance(op, dict) or not isinstance(op.get("values"), dict):
            raise ValidationError(
                f"upsert[{i}] needs 'values' (and 'row' or 'match' to update an existing row)"
            )
        unknown = [k for k in op["values"] if k not in types]
        if unknown:
            raise ValidationError(
                f"upsert[{i}]: unknown column(s) {', '.join(unknown[:5])}",
                details={"allowed": list(types)},
            )
        target = None
        if op.get("row") is not None:
            target = by_row.get(op["row"])
            if target is None:
                raise NotFoundError(f"upsert[{i}]: row {op['row']} doesn't exist")
        elif isinstance(op.get("match"), dict) and op["match"]:
            bad = [k for k in op["match"] if k not in types]
            if bad:
                raise ValidationError(f"upsert[{i}]: unknown match column(s) {', '.join(bad)}")
            target = next((r for r in rows if _matches(r, op["match"], types)), None)
        values = {k: convert(v, types[k]) for k, v in op["values"].items()}
        if target is not None:
            target.update(values)
            updated += 1
            changed.append(target)
        else:
            new_row = max(by_row, default=1) + 1
            fresh = {
                "__row": new_row,
                **dict.fromkeys(types),
                **(op.get("match") or {}),
                **values,
            }
            fresh = {"__row": new_row, **{c: convert(fresh.get(c), t) for c, t in types.items()}}
            if sheet == "hiring" and fresh.get("S.No") is None:
                last = rows[-1].get("S.No") if rows else 0
                fresh["S.No"] = (last if isinstance(last, (int, float)) else len(rows)) + 1
            rows.append(fresh)
            by_row[new_row] = fresh
            inserted += 1
            changed.append(fresh)

    drop = set(body.get("delete") or [])
    for m in body.get("deleteMatch") or []:
        if isinstance(m, dict) and m:
            drop.update(r["__row"] for r in rows if _matches(r, m, types))
    if drop:
        before = len(rows)
        rows = [r for r in rows if r["__row"] not in drop]
        deleted = before - len(rows)

    if not (updated or inserted or deleted):
        return {**_sheet_out(sheet, d, rows=False), "updated": 0, "inserted": 0, "deleted": 0}
    d = await _save(db, org, d, sheet, {**d.data, "rows": rows}, actor)
    await webhooks.emit(
        db,
        org,
        "capacity.inputs.updated",
        {
            "sheet": sheet,
            "label": SHEETS[sheet]["label"],
            "version": d.version,
            "change": "edited",
            "rows": len(rows),
            "updatedBy": d.updated_by,
            "updated": updated,
            "inserted": inserted,
            "deleted": deleted,
            "changedRows": changed[:EVENT_ROWS],
            "deletedRows": sorted(drop)[:EVENT_ROWS],
        },
    )
    await record_audit(
        db,
        actor=actor,
        action="capacity.sheet.edit",
        entity_type="capacity_sheet",
        entity_id=sheet,
        after={"version": d.version, "updated": updated, "inserted": inserted, "deleted": deleted},
    )
    await _after_change(db, org)
    return {
        **_sheet_out(sheet, d, rows=False),
        "updated": updated,
        "inserted": inserted,
        "deleted": deleted,
    }


def validate_config(cfg: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(cfg, dict):
        raise ValidationError("config must be an object")
    unknown = [k for k in cfg if k not in DEFAULT_CONFIG]
    if unknown:
        raise ValidationError(
            f"Unknown switch(es): {', '.join(unknown)}", details={"allowed": list(DEFAULT_CONFIG)}
        )
    for k, choices in CONFIG_CHOICES.items():
        if k in cfg and cfg[k] not in choices:
            raise ValidationError(f"'{k}' must be one of {', '.join(map(str, choices))}")
    for k in (
        "snpPct",
        "hoursPerDay",
        "rampFlatUnitsPerDay",
        "samplingFlatPct",
        "thresholdLow",
        "thresholdHigh",
    ):
        if k in cfg and (
            not isinstance(cfg[k], (int, float))
            or isinstance(cfg[k], bool)
            or not math.isfinite(cfg[k])
            or cfg[k] < 0
        ):
            raise ValidationError(f"'{k}' must be a number ≥ 0")
    if "hoursPerDay" in cfg and cfg["hoursPerDay"] == 0:
        raise ValidationError("'hoursPerDay' must be more than 0")
    if (
        "glideActualPct" in cfg
        and cfg["glideActualPct"] is not None
        and (not isinstance(cfg["glideActualPct"], (int, float)) or cfg["glideActualPct"] < 0)
    ):
        raise ValidationError("'glideActualPct' must be null or a number ≥ 0")
    if "billTypeTreatment" in cfg:
        bt = cfg["billTypeTreatment"]
        if not isinstance(bt, dict) or any(v not in BILL_TREATMENTS for v in bt.values()):
            raise ValidationError(
                f"'billTypeTreatment' maps a BILL_TYPE to one of {', '.join(BILL_TREATMENTS)}"
            )
    return {**DEFAULT_CONFIG, **cfg}


async def put_config(
    db: AsyncSession,
    org: uuid.UUID,
    cfg: dict[str, Any],
    base_version: int | None,
    *,
    actor,
    partial: bool = False,
) -> tuple[dict[str, Any], int]:  # noqa: ANN001
    d = await _doc(db, org, CONFIG_DOC)
    _check_version(d, base_version, "The switches")
    current = merged_config(d.data if d else None)
    new = validate_config({**current, **cfg} if partial else cfg)
    if d is not None and new == current:
        return new, d.version
    d = await _save(db, org, d, CONFIG_DOC, new, actor)
    changed = {k: v for k, v in new.items() if current.get(k) != v}
    await webhooks.emit(
        db,
        org,
        "capacity.config.updated",
        {
            "version": d.version,
            "updatedBy": d.updated_by,
            "changed": changed,
            "config": new,
        },
    )
    await record_audit(
        db,
        actor=actor,
        action="capacity.config.update",
        entity_type="capacity_config",
        entity_id=CONFIG_DOC,
        after={"version": d.version, "changed": list(changed)},
    )
    await _after_change(db, org)
    return new, d.version


async def clear(db: AsyncSession, org: uuid.UUID, *, actor) -> int:  # noqa: ANN001
    """Remove every input sheet (the switches stay)."""
    docs = await _docs(db, org)
    gone = [sid for sid in SHEET_IDS if sid in docs]
    for sid in gone:
        await db.delete(docs[sid])
    if gone:
        await db.flush()
        await webhooks.emit(
            db,
            org,
            "capacity.inputs.updated",
            {"change": "cleared", "sheets": gone, "updatedBy": getattr(actor, "email", "")},
        )
        await record_audit(
            db,
            actor=actor,
            action="capacity.clear",
            entity_type="capacity_sheet",
            entity_id="*",
            after={"sheets": gone},
        )
        await _after_change(db, org)
    return len(gone)
