"""Notification endpoints: /notifications."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from app.api.deps import DbSession, get_current_user
from app.core.exceptions import NotFoundError
from app.modules.identity.models import User
from app.modules.notifications import service
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    kind: str
    title: str
    body: str
    channel: str
    read_at: datetime | None
    created_at: datetime


@router.get("", response_model=ApiResponse[list[NotificationOut]])
async def list_notifications(
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
    unread_only: bool = False,
):
    rows = await service.list_for_user(db, user.id, unread_only=unread_only)
    return ApiResponse(data=[NotificationOut.model_validate(n) for n in rows])


@router.post("/{notification_id}/read", response_model=ApiResponse[dict])
async def mark_read(
    notification_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
):
    if not await service.mark_read(db, user.id, notification_id):
        raise NotFoundError("Notification not found")
    return ApiResponse(data={"detail": "Marked read"})
