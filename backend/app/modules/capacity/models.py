"""Capacity Planning storage: one row per organisation × document.

Documents are the 14 input sheets (`doc` = sheet id, `data` = {columns, rows,
monthColumns, fileName, sheetName}) and the switches (`doc` = "config",
`data` = the config object). `version` goes up on every change and guards
against overwriting someone else's edit (409).
"""

from __future__ import annotations

from sqlalchemy import JSON, Integer, String, UniqueConstraint
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
