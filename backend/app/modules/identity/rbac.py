"""Canonical permission catalogue and the role→permission matrix.

Permissions are `resource:action` strings checked by `require_permission`.
Roles are seeded from ROLE_MATRIX and remain editable at runtime (admins can
create custom roles); the 11 system roles here match the product spec.
"""
from __future__ import annotations

PERMISSIONS: dict[str, str] = {
    # forecasting
    "forecast:read": "View forecasts and historical data",
    "forecast:write": "Upload history, run and edit forecasts",
    "forecast:approve": "Approve or reject forecast versions",
    # capacity planning
    "plan:read": "View capacity plans and Erlang calculators",
    "plan:write": "Create and edit capacity plans / scenarios",
    # scheduling
    "schedule:read": "View schedules",
    "schedule:write": "Create and edit schedules and shift templates",
    "schedule:publish": "Publish schedules to employees",
    # intraday / real-time
    "intraday:read": "View intraday dashboards",
    "intraday:write": "Post actuals, reforecast, apply intraday actions",
    # change requests
    "request:read": "View change requests",
    "request:create": "Submit change requests",
    "request:approve_manager": "Approve requests as operations manager",
    "request:approve_wfm": "Approve requests as WFM",
    # attendance
    "attendance:read": "View attendance and shrinkage",
    "attendance:write": "Code attendance, manual/bulk adjustments",
    # workforce
    "employee:read": "View employee profiles",
    "employee:write": "Create and edit employees, teams, skills",
    # reporting & analytics
    "report:read": "View reports and analytics",
    "report:export": "Export reports (CSV/Excel)",
    # administration
    "admin:users": "Manage user accounts",
    "admin:roles": "Manage roles and permissions",
    "admin:org": "Manage org structure (countries, BUs, LOBs, queues)",
    "admin:settings": "Manage platform settings and templates",
    # misc
    "audit:read": "View audit logs",
    "ai:use": "Use AI assistant features",
    "notification:read": "View notifications",
}

_ALL = sorted(PERMISSIONS)

ROLE_MATRIX: dict[str, list[str]] = {
    "Super Admin": _ALL,
    "WFM Director": [p for p in _ALL if not p.startswith("admin:users")],
    "Planning Manager": [
        "forecast:read", "forecast:write", "forecast:approve",
        "plan:read", "plan:write",
        "schedule:read", "intraday:read",
        "request:read", "request:approve_wfm",
        "attendance:read", "employee:read",
        "report:read", "report:export",
        "ai:use", "notification:read",
    ],
    "Forecasting Analyst": [
        "forecast:read", "forecast:write",
        "plan:read", "intraday:read", "employee:read",
        "report:read", "report:export",
        "ai:use", "notification:read",
    ],
    "Scheduler": [
        "schedule:read", "schedule:write", "schedule:publish",
        "plan:read", "forecast:read",
        "request:read", "request:approve_wfm",
        "attendance:read", "employee:read",
        "report:read", "ai:use", "notification:read",
    ],
    "Real-Time Analyst": [
        "intraday:read", "intraday:write",
        "schedule:read", "forecast:read",
        "attendance:read", "attendance:write",
        "request:read", "employee:read",
        "report:read", "ai:use", "notification:read",
    ],
    "Operations Manager": [
        "request:read", "request:create", "request:approve_manager",
        "schedule:read", "intraday:read",
        "attendance:read", "employee:read",
        "report:read", "report:export",
        "ai:use", "notification:read",
    ],
    "Team Leader": [
        "request:read", "request:create", "request:approve_manager",
        "schedule:read", "intraday:read",
        "attendance:read", "attendance:write",
        "employee:read", "report:read",
        "ai:use", "notification:read",
    ],
    "Employee": [
        "schedule:read", "request:read", "request:create",
        "attendance:read", "notification:read",
    ],
    "HR": [
        "employee:read", "employee:write",
        "attendance:read", "report:read", "report:export",
        "audit:read", "notification:read",
    ],
    "Reporting Analyst": [
        "report:read", "report:export",
        "forecast:read", "plan:read", "schedule:read",
        "intraday:read", "attendance:read", "employee:read",
        "ai:use", "notification:read",
    ],
}
