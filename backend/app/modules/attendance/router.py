"""Attendance endpoints: /attendance/codes, /attendance/records, /attendance/summary."""
from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.api.deps import DbSession, require_permission
from app.modules.attendance import service
from app.modules.attendance.models import AttendanceCode
from app.modules.attendance.schemas import (
    AttendanceSummary,
    BulkRecordsIn,
    CodeIn,
    CodeOut,
    RecordIn,
    RecordOut,
    RecordUpdate,
)
from app.modules.identity.models import User
from app.modules.workforce.service import (
    create_entity,
    delete_entity,
    list_entities,
    org_scope,
    update_entity,
)
from app.schemas.common import ApiResponse, Page

router = APIRouter(prefix="/attendance", tags=["attendance"])

Reader = Annotated[User, Depends(require_permission("attendance:read"))]
Writer = Annotated[User, Depends(require_permission("attendance:write"))]
Admin = Annotated[User, Depends(require_permission("admin:settings"))]


# -------------------------------------------------------------------- codes

@router.get("/codes", response_model=ApiResponse[list[CodeOut]])
async def list_codes(db: DbSession, user: Reader):
    rows = await list_entities(db, AttendanceCode, org_scope(user))
    return ApiResponse(data=[CodeOut.model_validate(c) for c in rows])


@router.post("/codes", response_model=ApiResponse[CodeOut], status_code=201)
async def create_code(body: CodeIn, db: DbSession, actor: Admin):
    code = await create_entity(
        db, AttendanceCode, org_scope(actor), body.model_dump(),
        actor=actor, entity_name="attendance_code",
    )
    return ApiResponse(data=CodeOut.model_validate(code))


@router.patch("/codes/{code_id}", response_model=ApiResponse[CodeOut])
async def update_code(code_id: uuid.UUID, body: CodeIn, db: DbSession, actor: Admin):
    code = await update_entity(
        db, AttendanceCode, code_id, body.model_dump(), actor=actor,
        entity_name="attendance_code",
    )
    return ApiResponse(data=CodeOut.model_validate(code))


@router.delete("/codes/{code_id}", response_model=ApiResponse[dict])
async def delete_code(code_id: uuid.UUID, db: DbSession, actor: Admin):
    await delete_entity(db, AttendanceCode, code_id, actor=actor,
                        entity_name="attendance_code")
    return ApiResponse(data={"detail": "Code deleted"})


# ------------------------------------------------------------------ records

@router.get("/records", response_model=ApiResponse[Page[RecordOut]])
async def list_records(
    db: DbSession,
    user: Reader,
    employee_id: uuid.UUID | None = None,
    start: date | None = None,
    end: date | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(100, ge=1, le=500),
):
    rows, total = await service.list_records(
        db, org_scope(user), employee_id=employee_id, start=start, end=end,
        offset=(page - 1) * size, limit=size,
    )
    return ApiResponse(
        data=Page(items=[RecordOut.model_validate(r) for r in rows],
                  total=total, page=page, size=size)
    )


@router.post("/records", response_model=ApiResponse[RecordOut], status_code=201)
async def create_record(body: RecordIn, db: DbSession, actor: Writer):
    record = await service.create_record(db, org_scope(actor), body, actor=actor)
    return ApiResponse(data=RecordOut.model_validate(record))


@router.post("/records/bulk", response_model=ApiResponse[list[RecordOut]], status_code=201)
async def bulk_create(body: BulkRecordsIn, db: DbSession, actor: Writer):
    rows = await service.bulk_create(db, org_scope(actor), body.records, actor=actor)
    return ApiResponse(data=[RecordOut.model_validate(r) for r in rows])


@router.patch("/records/{record_id}", response_model=ApiResponse[RecordOut])
async def update_record(
    record_id: uuid.UUID, body: RecordUpdate, db: DbSession, actor: Writer
):
    record = await service.update_record(db, record_id, body, actor=actor)
    return ApiResponse(data=RecordOut.model_validate(record))


@router.get("/summary", response_model=ApiResponse[AttendanceSummary])
async def summary(
    db: DbSession, user: Reader, start: date = Query(...), end: date = Query(...)
):
    return ApiResponse(data=await service.summarize(db, org_scope(user), start, end))
