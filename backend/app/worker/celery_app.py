"""Celery application — async jobs (forecast training, bulk import/export).

Task modules are registered with `autodiscover_tasks` as modules add them, e.g.
`app.modules.planning.tasks`.
"""
from __future__ import annotations

from celery import Celery

from app.core.config import settings

celery = Celery(
    "flowforce_wfm",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
)

celery.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_time_limit=60 * 30,  # hard cap for long ML training jobs
)

# Discover `tasks.py` inside each domain package as modules are built.
celery.autodiscover_tasks(["app.modules"])


@celery.task(name="system.ping")
def ping() -> str:
    """Smoke-test task to confirm the worker is wired up."""
    return "pong"
