"""add day schedule plans (omni-channel timeline)

Revision ID: d7a3e91c5b40
Revises: c4f8b6a2e915
Create Date: 2026-10-24 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d7a3e91c5b40"
down_revision: str | None = "c4f8b6a2e915"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "day_schedule_plans",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("plan_date", sa.Date(), nullable=False),
        sa.Column("agent_key", sa.String(length=64), nullable=False),
        sa.Column("employee_id", sa.Uuid(), nullable=True),
        sa.Column("agent_name", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("team", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("shift_start", sa.Integer(), nullable=False),
        sa.Column("shift_end", sa.Integer(), nullable=False),
        sa.Column("breaks", sa.JSON(), nullable=False),
        sa.Column("channels", sa.JSON(), nullable=False),
        sa.Column("overtime", sa.JSON(), nullable=False),
        sa.Column("activities", sa.JSON(), nullable=False),
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
        sa.ForeignKeyConstraint(["employee_id"], ["employees.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("organization_id", "plan_date", "agent_key"),
    )
    op.create_index(
        op.f("ix_day_schedule_plans_organization_id"), "day_schedule_plans", ["organization_id"]
    )
    op.create_index(op.f("ix_day_schedule_plans_plan_date"), "day_schedule_plans", ["plan_date"])
    op.create_index(op.f("ix_day_schedule_plans_agent_key"), "day_schedule_plans", ["agent_key"])
    op.create_index(
        op.f("ix_day_schedule_plans_employee_id"), "day_schedule_plans", ["employee_id"]
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_day_schedule_plans_employee_id"), table_name="day_schedule_plans")
    op.drop_index(op.f("ix_day_schedule_plans_agent_key"), table_name="day_schedule_plans")
    op.drop_index(op.f("ix_day_schedule_plans_plan_date"), table_name="day_schedule_plans")
    op.drop_index(op.f("ix_day_schedule_plans_organization_id"), table_name="day_schedule_plans")
    op.drop_table("day_schedule_plans")
