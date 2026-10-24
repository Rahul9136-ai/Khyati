"""add scheduling policies (country labour law)

Revision ID: e1b6c2a94f07
Revises: d7a3e91c5b40
Create Date: 2026-10-24 11:30:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e1b6c2a94f07"
down_revision: str | None = "d7a3e91c5b40"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "scheduling_policies",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("country_code", sa.String(length=8), nullable=True),
        sa.Column("overrides", sa.JSON(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("updated_by", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("organization_id"),
    )
    op.create_index(
        op.f("ix_scheduling_policies_organization_id"), "scheduling_policies", ["organization_id"]
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_scheduling_policies_organization_id"), table_name="scheduling_policies")
    op.drop_table("scheduling_policies")
