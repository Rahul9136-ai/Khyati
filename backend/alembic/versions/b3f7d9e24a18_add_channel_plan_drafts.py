"""channel plan drafts (auto-planned Phone/Chat/Email, unpublished)

Revision ID: b3f7d9e24a18
Revises: a9e5c3d17b62
Create Date: 2026-10-26 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b3f7d9e24a18"
down_revision: str | None = "a9e5c3d17b62"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "channel_plan_drafts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("plan_date", sa.Date(), nullable=False),
        sa.Column("agent_key", sa.String(length=64), nullable=False),
        sa.Column("agent_name", sa.String(length=255), nullable=False),
        sa.Column("channels", sa.JSON(), nullable=False),
        sa.Column("base_version", sa.Integer(), nullable=False),
        sa.Column("summary", sa.String(length=500), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
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
        sa.UniqueConstraint("organization_id", "plan_date", "agent_key"),
    )
    op.create_index(
        op.f("ix_channel_plan_drafts_organization_id"), "channel_plan_drafts", ["organization_id"]
    )
    op.create_index(op.f("ix_channel_plan_drafts_plan_date"), "channel_plan_drafts", ["plan_date"])


def downgrade() -> None:
    op.drop_table("channel_plan_drafts")
