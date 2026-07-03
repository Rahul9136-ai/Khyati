"""Liveness & readiness probes (used by Docker/K8s health checks)."""
from __future__ import annotations

import redis.asyncio as aioredis
from fastapi import APIRouter
from sqlalchemy import text

from app import __version__
from app.api.deps import DbSession
from app.core.config import settings
from app.schemas.common import HealthStatus, ReadinessStatus

router = APIRouter()


@router.get("/health", response_model=HealthStatus, summary="Liveness probe")
async def health() -> HealthStatus:
    """Cheap check — the process is up. Never touches dependencies."""
    return HealthStatus(status="ok", version=__version__, environment=settings.ENVIRONMENT)


@router.get("/ready", response_model=ReadinessStatus, summary="Readiness probe")
async def ready(db: DbSession) -> ReadinessStatus:
    """Verify the service can reach Postgres and Redis before taking traffic."""
    database = "ok"
    redis_status = "ok"

    try:
        await db.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001 - report, don't crash the probe
        database = "unavailable"

    try:
        client = aioredis.from_url(settings.REDIS_URL)
        await client.ping()
        await client.aclose()
    except Exception:  # noqa: BLE001
        redis_status = "unavailable"

    overall = "ok" if database == "ok" and redis_status == "ok" else "degraded"
    return ReadinessStatus(status=overall, database=database, redis=redis_status)
