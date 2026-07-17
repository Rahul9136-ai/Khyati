"""Top-level API router. Each module registers its sub-router here."""
from __future__ import annotations

from fastapi import APIRouter

from app.api.v1 import health
from app.modules.ai.router import router as ai_router
from app.modules.attendance.router import router as attendance_router
from app.modules.autonomy.router import router as autonomy_router
from app.modules.forecasting.router import router as forecasting_router
from app.modules.identity.router import (
    audit_router,
    auth_router,
    roles_router,
    users_router,
)
from app.modules.intraday.router import router as intraday_router
from app.modules.notifications.router import router as notifications_router
from app.modules.planning.router import router as planning_router
from app.modules.reporting.router import router as reports_router
from app.modules.requests.router import router as requests_router
from app.modules.scheduling.router import router as scheduling_router
from app.modules.workforce.router import employees_router, org_router

api_router = APIRouter()

# --- v1 routes ---
api_router.include_router(health.router, tags=["system"])
api_router.include_router(auth_router)
api_router.include_router(users_router)
api_router.include_router(roles_router)
api_router.include_router(audit_router)
api_router.include_router(org_router)
api_router.include_router(employees_router)
api_router.include_router(forecasting_router)
api_router.include_router(planning_router)
api_router.include_router(scheduling_router)
api_router.include_router(intraday_router)
api_router.include_router(requests_router)
api_router.include_router(attendance_router)
api_router.include_router(reports_router)
api_router.include_router(notifications_router)
api_router.include_router(ai_router)
api_router.include_router(autonomy_router)
