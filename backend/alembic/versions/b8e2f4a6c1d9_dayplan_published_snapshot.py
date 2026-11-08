"""day plans keep the version last published (changes wait for the next publish)

Revision ID: b8e2f4a6c1d9
Revises: a7d3e9b1c4f6
Create Date: 2026-11-08 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b8e2f4a6c1d9"
down_revision: str | None = "a7d3e9b1c4f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_FIELDS = ("shift_start", "shift_end", "breaks", "channels", "overtime", "activities")


def upgrade() -> None:
    op.add_column("day_schedule_plans", sa.Column("published_snapshot", sa.JSON(), nullable=True))
    # Days already published: what they hold now is what agents were shown.
    plans = sa.table(
        "day_schedule_plans",
        sa.column("id", sa.Uuid()),
        sa.column("published_at", sa.DateTime(timezone=True)),
        sa.column("published_snapshot", sa.JSON()),
        *(sa.column(f, sa.Integer() if f.startswith("shift") else sa.JSON()) for f in _FIELDS),
    )
    bind = op.get_bind()
    rows = bind.execute(
        sa.select(plans.c.id, *(plans.c[f] for f in _FIELDS)).where(
            plans.c.published_at.is_not(None)
        )
    ).all()
    for r in rows:
        snap = {f: getattr(r, f) for f in _FIELDS}
        bind.execute(plans.update().where(plans.c.id == r.id).values(published_snapshot=snap))


def downgrade() -> None:
    op.drop_column("day_schedule_plans", "published_snapshot")
