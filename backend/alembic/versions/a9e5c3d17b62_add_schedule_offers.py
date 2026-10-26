"""schedule offers (VTO / PTO / OT / Leave slots) and claims

Revision ID: a9e5c3d17b62
Revises: f4d2a7c81e93
Create Date: 2026-10-24 18:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a9e5c3d17b62"
down_revision: str | None = "f4d2a7c81e93"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
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
    ]


def upgrade() -> None:
    op.create_table(
        "schedule_offers",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("plan_date", sa.Date(), nullable=False),
        sa.Column("queue_key", sa.String(length=64), nullable=False),
        sa.Column("queue_name", sa.String(length=128), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("start_min", sa.Integer(), nullable=False),
        sa.Column("end_min", sa.Integer(), nullable=False),
        sa.Column("capacity", sa.Integer(), nullable=False),
        sa.Column("channel", sa.String(length=8), nullable=True),
        sa.Column("status", sa.String(length=8), nullable=False),
        sa.Column("eligible", sa.JSON(), nullable=True),
        sa.Column("note", sa.String(length=255), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        *_timestamps(),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "organization_id", "plan_date", "queue_key", "kind", "start_min", "end_min"
        ),
    )
    op.create_index(
        op.f("ix_schedule_offers_organization_id"), "schedule_offers", ["organization_id"]
    )
    op.create_index(op.f("ix_schedule_offers_plan_date"), "schedule_offers", ["plan_date"])
    op.create_table(
        "schedule_offer_claims",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("offer_id", sa.Uuid(), nullable=False),
        sa.Column("agent_key", sa.String(length=64), nullable=False),
        sa.Column("agent_name", sa.String(length=255), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("seg_id", sa.String(length=64), nullable=False),
        sa.Column("start_min", sa.Integer(), nullable=False),
        sa.Column("end_min", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=12), nullable=False),
        sa.Column("cancelled_by", sa.Uuid(), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.ForeignKeyConstraint(["offer_id"], ["schedule_offers.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_schedule_offer_claims_organization_id"),
        "schedule_offer_claims",
        ["organization_id"],
    )
    op.create_index(
        op.f("ix_schedule_offer_claims_offer_id"), "schedule_offer_claims", ["offer_id"]
    )
    op.create_index(
        op.f("ix_schedule_offer_claims_agent_key"), "schedule_offer_claims", ["agent_key"]
    )


def downgrade() -> None:
    op.drop_table("schedule_offer_claims")
    op.drop_table("schedule_offers")
