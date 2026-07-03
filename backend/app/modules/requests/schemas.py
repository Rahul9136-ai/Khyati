"""Change request DTOs."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.modules.requests.models import CATEGORIES

_CATEGORY_PATTERN = "^(" + "|".join(CATEGORIES) + ")$"


class RequestCreate(BaseModel):
    employee_id: uuid.UUID
    category: str = Field(pattern=_CATEGORY_PATTERN)
    reason: str = Field(min_length=3)
    payload: dict = {}
    attachments: list[dict] = []


class DecisionIn(BaseModel):
    approve: bool
    note: str = ""


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=2000)


class CommentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    author_user_id: uuid.UUID | None
    author_email: str
    body: str
    created_at: datetime


class RequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    employee_id: uuid.UUID
    requested_by: uuid.UUID | None
    category: str
    status: str
    reason: str
    payload: dict
    attachments: list
    sla_due_at: datetime | None
    manager_decided_by: uuid.UUID | None
    manager_decided_at: datetime | None
    wfm_decided_by: uuid.UUID | None
    wfm_decided_at: datetime | None
    decision_note: str | None
    created_at: datetime


class RequestDetailOut(RequestOut):
    comments: list[CommentOut]
