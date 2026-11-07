"""capacity sync requests (Idempotency-Key replay store for POST /capacity/sync)

Revision ID: f1a9c3d5e7b2
Revises: e8c4a1f6b203
Create Date: 2026-11-06 12:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f1a9c3d5e7b2"
down_revision: str | None = "e8c4a1f6b203"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NOW = sa.text("(CURRENT_TIMESTAMP)")


def upgrade() -> None:
    op.create_table(
        "capacity_sync_requests",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("key", sa.String(length=128), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("response", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("organization_id", "key"),
    )
    op.create_index(
        "ix_capacity_sync_requests_organization_id", "capacity_sync_requests", ["organization_id"]
    )
    op.create_index(
        "ix_capacity_sync_requests_created_at", "capacity_sync_requests", ["created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_capacity_sync_requests_created_at", table_name="capacity_sync_requests")
    op.drop_index("ix_capacity_sync_requests_organization_id", table_name="capacity_sync_requests")
    op.drop_table("capacity_sync_requests")
