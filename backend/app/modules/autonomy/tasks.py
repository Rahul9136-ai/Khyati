"""The "fully automated" entrypoint: celery beat fires this on a schedule
(see AUTONOMY_RUN_INTERVAL_SECONDS / worker/celery_app.py's beat_schedule) so
the autonomy layer senses live signals and acts on its own — no one has to
open the Autonomous Agents page and click "Run now".

There is no HTTP request here, so there is no human actor: every action a
scheduled run applies is attributed to "system" (record_audit's existing
actor=None convention — see autonomy/service.py and forecasting/service.py).
One organization's failure is logged and skipped rather than sinking the
whole run; each org gets its own transaction so one org can never roll back
another's.
"""
from __future__ import annotations

import asyncio
import uuid

import structlog
from sqlalchemy import select

from app.db.session import AsyncSessionLocal
from app.modules.autonomy.service import run_orchestrator
from app.modules.workforce.models import Organization
from app.worker.celery_app import celery

log = structlog.get_logger(__name__)


@celery.task(name="autonomy.run_all_orgs")
def run_all_orgs() -> dict:
    """Sync Celery entrypoint — bridges into the async orchestrator."""
    return asyncio.run(_run_all_orgs())


async def _run_all_orgs() -> dict:
    summary = {"orgs_run": 0, "proposed": 0, "auto_applied": 0, "pending_review": 0,
               "errors": []}
    org_ids: list[uuid.UUID] = []
    async with AsyncSessionLocal() as db:
        org_ids = [row[0] for row in (await db.execute(select(Organization.id))).all()]

    for org_id in org_ids:
        async with AsyncSessionLocal() as db:
            try:
                result = await run_orchestrator(db, org_id, actor=None)
                await db.commit()
                summary["orgs_run"] += 1
                summary["proposed"] += result["proposed"]
                summary["auto_applied"] += result["auto_applied"]
                summary["pending_review"] += result["pending_review"]
            except Exception as exc:  # one org's failure must not sink the others
                await db.rollback()
                log.error("autonomy_scheduled_run_failed", org_id=str(org_id), error=str(exc))
                summary["errors"].append(str(org_id))

    log.info("autonomy_scheduled_run_complete", **summary)
    return summary
