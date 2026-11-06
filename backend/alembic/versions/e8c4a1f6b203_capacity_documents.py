"""capacity planning documents (input sheets + switches, shared per organisation)

Revision ID: e8c4a1f6b203
Revises: d7b2f4a9c1e6
Create Date: 2026-11-06 01:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e8c4a1f6b203"
down_revision: str | None = "d7b2f4a9c1e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NOW = sa.text("(CURRENT_TIMESTAMP)")


def upgrade() -> None:
    op.create_table(
        "capacity_documents",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("doc", sa.String(length=32), nullable=False),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("updated_by", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("organization_id", "doc"),
    )
    op.create_index(
        "ix_capacity_documents_organization_id", "capacity_documents", ["organization_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_capacity_documents_organization_id", table_name="capacity_documents")
    op.drop_table("capacity_documents")
