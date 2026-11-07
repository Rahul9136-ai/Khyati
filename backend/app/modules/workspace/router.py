"""Workspace data API: the app saves what people add (employees, forecasts, PTO,
scenarios, messages ...) here, so it's kept until someone removes it and every
browser and device of the organisation sees the same.

GET /workspace/data lists every saved area (with `?values=false`, only versions:
cheap to poll). PUT /workspace/data/{key} saves one area; send the
`base_version` you read: if someone saved in between you get 409 with their copy.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import DbSession, get_current_user
from app.modules.workforce.service import org_scope
from app.modules.workspace import service
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/workspace", tags=["workspace data"])
#: Anyone signed in to the organisation (who may change what: service.KEYS).
Member = Annotated[Any, Depends(get_current_user)]


class DataIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: Any = Field(description="The area's data, as the app holds it")
    base_version: int | None = Field(
        None, description="The version you read (0 = never saved); a newer one -> 409"
    )


@router.get("/data", response_model=ApiResponse[dict])
async def list_data(
    db: DbSession,
    user: Member,
    values: bool = Query(True, description="false = versions only"),
):
    """Every saved area, and which areas you may change."""
    rows = await service.list_all(db, org_scope(user))
    return ApiResponse(
        data={
            "areas": [service.out(r, user, value=values) for r in rows],
            "keys": {k: service.can_write(user, k) for k in service.KEYS},
        }
    )


@router.get("/data/{key}", response_model=ApiResponse[dict])
async def get_data(key: str, db: DbSession, user: Member):
    return ApiResponse(data=service.out(await service.get(db, org_scope(user), key), user))


@router.put("/data/{key}", response_model=ApiResponse[dict])
async def put_data(key: str, body: DataIn, db: DbSession, actor: Member):
    """Save one area (the whole value). Removing something = saving the area without it."""
    row = await service.put(db, org_scope(actor), key, body.value, body.base_version, actor=actor)
    return ApiResponse(data=service.out(row, actor, value=False))
