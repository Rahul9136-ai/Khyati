"""day-plan publishing + grouped/linked notifications

Revision ID: f4d2a7c81e93
Revises: e1b6c2a94f07
Create Date: 2026-10-24 15:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f4d2a7c81e93"
down_revision: str | None = "e1b6c2a94f07"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "day_schedule_plans",
        sa.Column("team_lead", sa.String(length=255), nullable=False, server_default=""),
    )
    op.add_column(
        "day_schedule_plans", sa.Column("published_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("day_schedule_plans", sa.Column("published_by", sa.Uuid(), nullable=True))
    op.add_column("notifications", sa.Column("ref", sa.String(length=128), nullable=True))
    op.add_column("notifications", sa.Column("link", sa.String(length=255), nullable=True))
    op.create_index(op.f("ix_notifications_ref"), "notifications", ["ref"])


def downgrade() -> None:
    op.drop_index(op.f("ix_notifications_ref"), table_name="notifications")
    with op.batch_alter_table("notifications") as batch:
        batch.drop_column("link")
        batch.drop_column("ref")
    with op.batch_alter_table("day_schedule_plans") as batch:
        batch.drop_column("published_by")
        batch.drop_column("published_at")
        batch.drop_column("team_lead")
