"""add inbound automation config

Revision ID: e37e14f06f3c
Revises: 3b046bef4f12
Create Date: 2026-09-22 09:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = 'e37e14f06f3c'
down_revision: str | None = '3b046bef4f12'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('integration_configs',
        sa.Column('automation_enabled', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column('integration_configs',
        sa.Column('auto_apply_min_confidence', sa.String(length=8), nullable=False,
                   server_default='High'))
    op.add_column('integration_configs',
        sa.Column('slack_command_channel', sa.String(length=128), nullable=False,
                   server_default=''))
    op.add_column('integration_configs',
        sa.Column('teams_command_channel', sa.String(length=256), nullable=False,
                   server_default=''))
    op.add_column('integration_configs',
        sa.Column('teams_app_id', sa.String(length=128), nullable=False, server_default=''))
    op.add_column('integration_configs',
        sa.Column('teams_app_password', sa.String(length=256), nullable=False, server_default=''))


def downgrade() -> None:
    op.drop_column('integration_configs', 'teams_app_password')
    op.drop_column('integration_configs', 'teams_app_id')
    op.drop_column('integration_configs', 'teams_command_channel')
    op.drop_column('integration_configs', 'slack_command_channel')
    op.drop_column('integration_configs', 'auto_apply_min_confidence')
    op.drop_column('integration_configs', 'automation_enabled')
