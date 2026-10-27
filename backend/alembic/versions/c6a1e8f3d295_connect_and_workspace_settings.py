"""connect (API keys, webhooks) + shared workspace settings

Revision ID: c6a1e8f3d295
Revises: b3f7d9e24a18
Create Date: 2026-10-27 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c6a1e8f3d295"
down_revision: str | None = "b3f7d9e24a18"
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


def _org() -> list:
    return [
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
    ]


def upgrade() -> None:
    op.create_table(
        "workspace_settings",
        sa.Column("id", sa.Uuid(), nullable=False),
        *_org(),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("updated_by", sa.String(length=255), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("organization_id", "key"),
    )
    op.create_index(
        op.f("ix_workspace_settings_organization_id"), "workspace_settings", ["organization_id"]
    )

    op.create_table(
        "api_keys",
        sa.Column("id", sa.Uuid(), nullable=False),
        *_org(),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("prefix", sa.String(length=16), nullable=False),
        sa.Column("key_hash", sa.String(length=64), nullable=False),
        sa.Column("scopes", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("created_by_email", sa.String(length=255), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_api_keys_organization_id"), "api_keys", ["organization_id"])
    op.create_index(op.f("ix_api_keys_key_hash"), "api_keys", ["key_hash"], unique=True)
    op.create_index(op.f("ix_api_keys_created_by"), "api_keys", ["created_by"])

    op.create_table(
        "webhook_subscriptions",
        sa.Column("id", sa.Uuid(), nullable=False),
        *_org(),
        sa.Column("url", sa.String(length=1024), nullable=False),
        sa.Column("description", sa.String(length=255), nullable=False),
        sa.Column("events", sa.JSON(), nullable=False),
        sa.Column("secret", sa.String(length=128), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_by_email", sa.String(length=255), nullable=False),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_failure_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("consecutive_failures", sa.Integer(), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_webhook_subscriptions_organization_id"),
        "webhook_subscriptions",
        ["organization_id"],
    )

    op.create_table(
        "webhook_deliveries",
        sa.Column("id", sa.Uuid(), nullable=False),
        *_org(),
        sa.Column("subscription_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.String(length=64), nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("response_status", sa.Integer(), nullable=True),
        sa.Column("response_body", sa.Text(), nullable=False),
        sa.Column("error", sa.String(length=500), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["subscription_id"], ["webhook_subscriptions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    for col in (
        "organization_id",
        "subscription_id",
        "event_id",
        "event_type",
        "status",
        "next_attempt_at",
        "created_at",
    ):
        op.create_index(op.f(f"ix_webhook_deliveries_{col}"), "webhook_deliveries", [col])


def downgrade() -> None:
    op.drop_table("webhook_deliveries")
    op.drop_table("webhook_subscriptions")
    op.drop_table("api_keys")
    op.drop_table("workspace_settings")
