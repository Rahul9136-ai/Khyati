"""Capacity Planning API — for the app and for connected tools (CRMs, HR systems).

Authenticate with a login token or an API key (`X-API-Key: wfm_…`, created in
Settings → API & Webhooks). Reading needs `planning:read`; changing needs
`planning:write`. Subscribe to `capacity.inputs.updated`,
`capacity.config.updated` and `capacity.results.updated` webhooks to hear
about changes made anywhere.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import DbSession, require_permission
from app.core.exceptions import ValidationError
from app.modules.capacity import service
from app.modules.capacity.calc import DEFAULT_CONFIG
from app.modules.capacity.schema import describe
from app.modules.workforce.service import org_scope
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/capacity", tags=["capacity planning"])
Reader = Annotated[Any, Depends(require_permission("planning:read", "planning:write"))]
Writer = Annotated[Any, Depends(require_permission("planning:write"))]


class SheetIn(BaseModel):
    """A whole sheet. Row objects use the column names from GET /capacity/schema."""

    model_config = ConfigDict(extra="forbid")
    rows: list[dict[str, Any]] = Field(
        description="Row objects; `__row` (optional) is the row number"
    )
    monthColumns: list[str] | None = Field(
        None, description='Forecast only: e.g. ["Units _ Sep\'26", …]'
    )
    fileName: str | None = None
    sheetName: str | None = None
    base_version: int | None = Field(None, description="The version you read; a newer one → 409")


class WorkbookIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sheets: dict[str, SheetIn] = Field(
        description='Sheet id → sheet, e.g. {"userMapping": {…}, "forecast": {…}}'
    )


class UpsertOp(BaseModel):
    model_config = ConfigDict(extra="forbid")
    row: int | None = Field(None, description="Row number (`__row`) to update")
    match: dict[str, Any] | None = Field(
        None,
        description='Find the row by business key, e.g. {"Emp Id": "1001"}; '
        "no match → the row is added",
    )
    values: dict[str, Any] = Field(description="Columns to set")


class RowsPatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    upsert: list[UpsertOp] = []
    delete: list[int] = Field([], description="Row numbers to delete")
    deleteMatch: list[dict[str, Any]] = Field(
        [], description="Delete every row matching each object"
    )
    base_version: int | None = None


class ConfigIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    config: dict[str, Any] = Field(
        description="Switches (see GET /capacity/config); PATCH sends only the changes"
    )
    base_version: int | None = None


@router.get("/schema", response_model=ApiResponse[dict])
async def get_schema(user: Reader):
    """The 14 input sheets: columns and types, plus suggested match keys for row updates."""
    return ApiResponse(
        data={
            "sheets": describe(),
            "defaultConfig": DEFAULT_CONFIG,
            "events": [
                "capacity.inputs.updated",
                "capacity.config.updated",
                "capacity.results.updated",
            ],
        }
    )


@router.get("/state", response_model=ApiResponse[dict])
async def get_state(db: DbSession, user: Reader):
    """Version of every sheet and the switches, and a `resultsVersion` that changes whenever
    the results do.
    Cheap to poll."""
    return ApiResponse(data=await service.state(db, org_scope(user)))


@router.get("/sheets", response_model=ApiResponse[list[dict]])
async def list_sheets(db: DbSession, user: Reader, include_rows: bool = False):
    """Loaded sheets (rows only with `include_rows=true`)."""
    return ApiResponse(data=await service.list_sheets(db, org_scope(user), include_rows))


@router.get("/sheets/{sheet}", response_model=ApiResponse[dict])
async def get_sheet(sheet: str, db: DbSession, user: Reader):
    return ApiResponse(data=await service.get_sheet(db, org_scope(user), sheet))


@router.put("/sheets/{sheet}", response_model=ApiResponse[dict])
async def put_sheet(sheet: str, body: SheetIn, db: DbSession, actor: Writer):
    """Replace a whole sheet. Values are stored as the Excel import would: numbers,
    percentages as decimals
    (or "12%"), dates YYYY-MM-DD, months Mon'YY."""
    return ApiResponse(
        data=await service.put_sheet(db, org_scope(actor), sheet, body.model_dump(), actor=actor)
    )


@router.patch("/sheets/{sheet}/rows", response_model=ApiResponse[dict])
async def patch_rows(sheet: str, body: RowsPatchIn, db: DbSession, actor: Writer):
    """Update, add or delete rows — e.g. a CRM changing one employee:
    `{"upsert": [{"match": {"Emp Id": "1001"}, "values": {"City": "Chennai"}}]}`."""
    return ApiResponse(
        data=await service.patch_rows(db, org_scope(actor), sheet, body.model_dump(), actor=actor)
    )


@router.put("/workbook", response_model=ApiResponse[list[dict]])
async def put_workbook(body: WorkbookIn, db: DbSession, actor: Writer):
    """Replace several sheets at once (a whole workbook import)."""
    sheets = {sid: s.model_dump() for sid, s in body.sheets.items()}
    return ApiResponse(data=await service.put_workbook(db, org_scope(actor), sheets, actor=actor))


@router.delete("/sheets", response_model=ApiResponse[dict])
async def clear_sheets(db: DbSession, actor: Writer):
    """Remove every input sheet (the switches stay)."""
    return ApiResponse(data={"removed": await service.clear(db, org_scope(actor), actor=actor)})


@router.get("/config", response_model=ApiResponse[dict])
async def get_config(db: DbSession, user: Reader):
    cfg, version = await service.get_config(db, org_scope(user))
    return ApiResponse(data={"config": cfg, "version": version})


@router.put("/config", response_model=ApiResponse[dict])
async def put_config(body: ConfigIn, db: DbSession, actor: Writer):
    """Set all switches (missing ones go back to the workbook default)."""
    cfg, version = await service.put_config(
        db, org_scope(actor), body.config, body.base_version, actor=actor
    )
    return ApiResponse(data={"config": cfg, "version": version})


@router.patch("/config", response_model=ApiResponse[dict])
async def patch_config(body: ConfigIn, db: DbSession, actor: Writer):
    """Change only the switches you send."""
    cfg, version = await service.put_config(
        db, org_scope(actor), body.config, body.base_version, actor=actor, partial=True
    )
    return ApiResponse(data={"config": cfg, "version": version})


@router.get("/results", response_model=ApiResponse[dict])
async def get_results(
    db: DbSession,
    user: Reader,
    view: Literal["summary", "full"] = Query(
        "summary",
        description="summary = the Summary tab's columns; "
        "full = every P/Q/V field, nested as prod / qca / vol",
    ),
    customer: str | None = None,
    service_line: str | None = None,
    location: str | None = None,
    month: str | None = Query(None, description="Sep'26 or 2026-09"),
    offset: int = Query(0, ge=0),
    limit: int = Query(1000, ge=1, le=10000),
):
    """Calculated results per Customer × Service Line × Location × Month, plus monthly totals."""
    if month and not service.parse_month(month):
        raise ValidationError("month must look like Sep'26 or 2026-09")
    res, rv = await service.results(db, org_scope(user))
    rows = [r for r in res["rows"] if service.passes(r, customer, service_line, location, month)]
    page = rows[offset : offset + limit]
    data = [service.summary_row(r) for r in page] if view == "summary" else page
    return ApiResponse(
        data={
            "resultsVersion": rv,
            "months": res["months"],
            "total": len(rows),
            "offset": offset,
            "limit": limit,
            "rows": data,
            "monthlyTotals": service.monthly_totals({**res, "rows": rows}),
            "exceptions": service.exception_counts(res),
        }
    )


@router.get("/exceptions", response_model=ApiResponse[dict])
async def get_exceptions(
    db: DbSession,
    user: Reader,
    severity: Literal["error", "warning", "info"] | None = None,
    code: str | None = None,
    customer: str | None = None,
    service_line: str | None = None,
    location: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(1000, ge=1, le=10000),
):
    """Data Exceptions: join failures and dirty data, with the action taken."""
    res, rv = await service.results(db, org_scope(user))
    ex = [
        e
        for e in res["exceptions"]
        if (not severity or e["severity"] == severity)
        and (not code or e["code"] == code)
        and service.passes(
            {
                "customer": e.get("customer"),
                "serviceLine": e.get("serviceLine"),
                "location": e.get("location"),
            },
            customer,
            service_line,
            location,
            None,
        )
    ]
    return ApiResponse(
        data={
            "resultsVersion": rv,
            "total": len(ex),
            "counts": service.exception_counts(res),
            "rows": ex[offset : offset + limit],
        }
    )
