"""Capacity Planning storage: one row per organisation × document.

Documents are the 14 input sheets (`doc` = sheet id, `data` = {columns, rows,
monthColumns, fileName, sheetName}) and the switches (`doc` = "config",
`data` = the config object). `version` goes up on every change and guards
against overwriting someone else's edit (409).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import TenantMixin, TimestampMixin, UUIDMixin


class CapacityDocument(UUIDMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "capacity_documents"
    __table_args__ = (UniqueConstraint("organization_id", "doc"),)

    doc: Mapped[str] = mapped_column(String(32))
    data: Mapped[dict] = mapped_column(JSON)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_by: Mapped[str] = mapped_column(String(255), default="")


class CapacitySyncRequest(UUIDMixin, TenantMixin, Base):
    """A batch a connected tool pushed to POST /capacity/sync with an `Idempotency-Key`.

    Sending the same key again returns the stored response instead of applying the
    changes twice (a CRM retrying after a timeout is safe).
    """

    __tablename__ = "capacity_sync_requests"
    __table_args__ = (UniqueConstraint("organization_id", "key"),)

    key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    response: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
