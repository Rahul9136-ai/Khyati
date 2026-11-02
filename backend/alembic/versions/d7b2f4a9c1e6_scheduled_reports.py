"""scheduled email reports (schedules, distribution lists, run history)

Revision ID: d7b2f4a9c1e6
Revises: c6a1e8f3d295
Create Date: 2026-11-02 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d7b2f4a9c1e6"
down_revision: str | None = "c6a1e8f3d295"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NOW = sa.text("(CURRENT_TIMESTAMP)")


def _common() -> list:
    return [
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    ]


def _stamps() -> list:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "report_recipient_lists",
        *_common(),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("emails", sa.JSON(), nullable=False),
        *_stamps(),
    )
    op.create_index(
        op.f("ix_report_recipient_lists_organization_id"),
        "report_recipient_lists",
        ["organization_id"],
    )
    op.create_table(
        "report_subscriptions",
        *_common(),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("frequency", sa.String(length=16), nullable=False),
        sa.Column("weekdays", sa.JSON(), nullable=False),
        sa.Column("send_time", sa.String(length=5), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("lob", sa.String(length=128), nullable=False),
        sa.Column("to_recipients", sa.JSON(), nullable=False),
        sa.Column("cc_recipients", sa.JSON(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_status", sa.String(length=16), nullable=False),
        sa.Column("created_by_email", sa.String(length=255), nullable=False),
        *_stamps(),
    )
    op.create_index(
        op.f("ix_report_subscriptions_organization_id"), "report_subscriptions", ["organization_id"]
    )
    op.create_index(
        op.f("ix_report_subscriptions_next_run_at"), "report_subscriptions", ["next_run_at"]
    )
    op.create_table(
        "report_runs",
        *_common(),
        sa.Column("subscription_id", sa.Uuid(), nullable=False),
        sa.Column("trigger", sa.String(length=16), nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("to_recipients", sa.JSON(), nullable=False),
        sa.Column("cc_recipients", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("error", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.ForeignKeyConstraint(
            ["subscription_id"], ["report_subscriptions.id"], ondelete="CASCADE"
        ),
    )
    for col in ("organization_id", "subscription_id", "created_at"):
        op.create_index(op.f(f"ix_report_runs_{col}"), "report_runs", [col])


def downgrade() -> None:
    op.drop_table("report_runs")
    op.drop_table("report_subscriptions")
    op.drop_table("report_recipient_lists")
