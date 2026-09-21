"""HC planning endpoints: /hc-planning."""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.api.deps import DbSession, require_permission
from app.modules.hcplanning import service
from app.modules.hcplanning.schemas import (
    CapacityTableOut,
    ConfigIn,
    ConfigOut,
    DemandBulkIn,
    DemandOut,
    MonthResultOut,
    ProfileIn,
    ProfileOut,
)
from app.modules.identity.models import User
from app.modules.workforce.service import org_scope
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/hc-planning", tags=["hc planning"])

Reader = Annotated[User, Depends(require_permission("planning:read", "plan:read"))]
Writer = Annotated[User, Depends(require_permission("planning:write", "plan:write"))]


def _config_out(row) -> ConfigOut:
    return ConfigOut.model_validate(row)


@router.get("/config", response_model=ApiResponse[ConfigOut])
async def get_config(
    db: DbSession, user: Reader, lob_id: uuid.UUID | None = None
):
    row = await service.get_config_row(db, org_scope(user), lob_id)
    return ApiResponse(data=_config_out(row))


@router.put("/config", response_model=ApiResponse[ConfigOut])
async def put_config(body: ConfigIn, db: DbSession, actor: Writer):
    row = await service.upsert_config(db, org_scope(actor), body)
    return ApiResponse(data=_config_out(row))


@router.get("/demand", response_model=ApiResponse[list[DemandOut]])
async def get_demand(db: DbSession, user: Reader, lob_id: uuid.UUID | None = None):
    rows = await service.list_demand(db, org_scope(user), lob_id)
    return ApiResponse(data=[DemandOut.model_validate(r) for r in rows])


@router.put("/demand", response_model=ApiResponse[list[DemandOut]])
async def put_demand(body: DemandBulkIn, db: DbSession, actor: Writer):
    rows = await service.upsert_demand(db, org_scope(actor), body.lob_id, body.items)
    return ApiResponse(data=[DemandOut.model_validate(r) for r in rows])


@router.put("/employees/{employee_id}/profile", response_model=ApiResponse[ProfileOut])
async def put_profile(
    employee_id: uuid.UUID, body: ProfileIn, db: DbSession, actor: Writer
):
    row = await service.upsert_profile(db, org_scope(actor), employee_id, body)
    return ApiResponse(data=ProfileOut.model_validate(row))


@router.get("/capacity", response_model=ApiResponse[CapacityTableOut])
async def get_capacity(
    db: DbSession,
    user: Reader,
    lob_id: uuid.UUID,
    from_month: Annotated[str | None, Query(alias="from", pattern=r"^\d{4}-\d{2}$")] = None,
    to_month: Annotated[str | None, Query(alias="to", pattern=r"^\d{4}-\d{2}$")] = None,
):
    out = await service.compute_capacity(
        db, org_scope(user), lob_id, from_month=from_month, to_month=to_month
    )
    lob = out["lob"]
    cfg_row = out["config_row"]
    return ApiResponse(data=CapacityTableOut(
        lob_id=lob_id,
        lob_name=lob.name if lob else None,
        months=out["months"],
        results=[MonthResultOut(**r.as_dict()) for r in out["results"]],
        config=_config_out(cfg_row) if cfg_row else ConfigOut(
            ooo_shrinkage=0.04, io_shrinkage=0.04, attrition=0.0125, weekly_hours=40,
            hiring_throughput=0.9, training_throughput=0.95, actuals_through=None,
            tenure_bands=[], monthly_overrides={}, closing_overrides={},
        ),
        agent_count=out["agents"],
    ))
