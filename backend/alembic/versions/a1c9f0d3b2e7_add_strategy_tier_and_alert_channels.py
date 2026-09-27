"""add strategy tier and alert channels

Revision ID: a1c9f0d3b2e7
Revises: e37e14f06f3c
Create Date: 2026-09-24 09:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = 'a1c9f0d3b2e7'
down_revision: str | None = 'e37e14f06f3c'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('agent_actions',
        sa.Column('tier', sa.String(length=16), nullable=False, server_default='tactical'))
    op.create_index('ix_agent_actions_tier', 'agent_actions', ['tier'])
    op.add_column('integration_configs',
        sa.Column('slack_strategic_channel', sa.String(length=128), nullable=False,
                   server_default=''))
    op.add_column('integration_configs',
        sa.Column('teams_strategic_webhook_url', sa.String(length=1024), nullable=False,
                   server_default=''))


def downgrade() -> None:
    op.drop_column('integration_configs', 'teams_strategic_webhook_url')
    op.drop_column('integration_configs', 'slack_strategic_channel')
    op.drop_index('ix_agent_actions_tier', table_name='agent_actions')
    op.drop_column('agent_actions', 'tier')
