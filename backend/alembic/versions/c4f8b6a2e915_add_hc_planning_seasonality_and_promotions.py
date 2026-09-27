"""add hc planning seasonality and promotions

Revision ID: c4f8b6a2e915
Revises: a1c9f0d3b2e7
Create Date: 2026-09-27 09:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = 'c4f8b6a2e915'
down_revision: str | None = 'a1c9f0d3b2e7'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('hc_planning_configs',
        sa.Column('historical_assumptions', sa.JSON(), nullable=False, server_default='{}'))
    op.add_column('hc_planning_configs',
        sa.Column('yoy_growth_pct', sa.Float(), nullable=False, server_default='0'))

    op.create_table(
        'hc_promotions',
        sa.Column('lob_id', sa.Uuid(), nullable=True),
        sa.Column('name', sa.String(length=128), nullable=False),
        sa.Column('month_from', sa.String(length=7), nullable=False),
        sa.Column('month_to', sa.String(length=7), nullable=False),
        sa.Column('demand_impact_pct', sa.Float(), nullable=False),
        sa.Column('recurring', sa.Boolean(), nullable=False),
        sa.Column('note', sa.String(length=255), nullable=False),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('organization_id', sa.Uuid(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['lob_id'], ['lobs.id'], name=op.f('fk_hc_promotions_lob_id_lobs'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], name=op.f('fk_hc_promotions_organization_id_organizations'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_hc_promotions')),
    )
    op.create_index(op.f('ix_hc_promotions_lob_id'), 'hc_promotions', ['lob_id'], unique=False)
    op.create_index(op.f('ix_hc_promotions_organization_id'), 'hc_promotions', ['organization_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_hc_promotions_organization_id'), table_name='hc_promotions')
    op.drop_index(op.f('ix_hc_promotions_lob_id'), table_name='hc_promotions')
    op.drop_table('hc_promotions')
    op.drop_column('hc_planning_configs', 'yoy_growth_pct')
    op.drop_column('hc_planning_configs', 'historical_assumptions')
