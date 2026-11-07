"""Workspace data: everything people add in the app, saved for the organisation.

One row per organisation x area (`key`), e.g. "agents", "ptoRequests",
"scenarios". `value` is that area's data as the app holds it; `version` goes up
on every save and guards against overwriting someone else's change (409).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import TenantMixin, TimestampMixin, UUIDMixin


class WorkspaceData(UUIDMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "workspace_data"
    __table_args__ = (UniqueConstraint("organization_id", "key"),)

    key: Mapped[str] = mapped_column(String(64))
    value: Mapped[Any] = mapped_column(JSON)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_by: Mapped[str] = mapped_column(String(255), default="")
