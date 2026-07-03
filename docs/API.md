# API Reference

Base URL: `/api/v1`. Interactive docs: `/docs` (Swagger) — use **Authorize** with
`admin@flowforce.dev / Admin@12345` after seeding (`python -m app.db.seed`).

Every success response is wrapped: `{"success": true, "data": …}`.
Errors: `{"success": false, "error": {"code", "message", "details"}}` with proper HTTP status.
Auth: `Authorization: Bearer <access_token>`; permissions listed per endpoint
(superusers bypass; see `app/modules/identity/rbac.py` for the 11-role matrix).

## Auth
| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/auth/login` | — | JSON email+password → access + refresh tokens |
| POST | `/auth/token` | — | OAuth2 form flow (Swagger button) |
| POST | `/auth/refresh` | — | Rotating one-time-use refresh token |
| POST | `/auth/logout` | — | Revokes the refresh token |
| GET | `/auth/me` | any | Current user + roles + permission codes |
| POST | `/auth/change-password` | any | |

## Users / Roles / Audit
| Method | Path | Permission |
|---|---|---|
| GET/POST | `/users` | `admin:users` |
| PATCH | `/users/{id}` | `admin:users` |
| GET | `/roles`, `/roles/permissions` | `admin:roles` or `admin:users` |
| POST/PATCH | `/roles`, `/roles/{id}` | `admin:roles` |
| GET | `/audit?entity_type=&action=` | `audit:read` |

## Organization & Employees
| Method | Path | Permission |
|---|---|---|
| GET | `/org` | any |
| GET/POST/PATCH/DELETE | `/org/{countries,business-units,lobs,teams,skills,queues}` | read: any · write: `admin:org` |
| GET/POST | `/org/holiday-calendars` | read: any · write: `admin:org` |
| GET/POST | `/employees` (`?team_id&lob_id&status&search&page&size`) | `employee:read` / `employee:write` |
| GET/PATCH | `/employees/{id}` | `employee:read` / `employee:write` |
| PUT | `/employees/{id}/skills` | `employee:write` |

## Forecasting
| Method | Path | Permission |
|---|---|---|
| POST | `/forecasting/series` (JSON) · `/forecasting/series/upload-csv` (multipart) | `forecast:write` |
| GET | `/forecasting/series`, `/forecasting/series/{id}/points` | `forecast:read` |
| POST | `/forecasting/forecasts` (`model: auto\|seasonal_naive\|moving_average\|exp_smoothing\|holt_winters\|regression`) | `forecast:write` |
| GET | `/forecasting/forecasts`, `/forecasting/forecasts/{id}` | `forecast:read` |
| POST | `/forecasting/forecasts/{id}/{submit,approve,reject}` | submit: `forecast:write` · decide: `forecast:approve` |
| GET | `/forecasting/forecasts/{id}/export` (CSV) | `forecast:read` |
| GET | `/forecasting/forecasts/{id}/intervals?day&interval_minutes` | `forecast:read` |

## Planning & Erlang
| Method | Path | Permission |
|---|---|---|
| GET/POST | `/planning/plans` | `plan:read` / `plan:write` |
| GET/PATCH | `/planning/plans/{id}` | `plan:read` / `plan:write` |
| POST | `/planning/plans/{id}/what-if` | `plan:read` (non-persisting) |
| POST | `/planning/erlang/{requirements,service-level,staffing-curve}` | `plan:read` |

## Scheduling
| Method | Path | Permission |
|---|---|---|
| GET/POST/PATCH/DELETE | `/scheduling/templates` | `schedule:read` / `schedule:write` |
| POST | `/scheduling/schedules/generate` | `schedule:write` |
| GET | `/scheduling/schedules`, `/scheduling/schedules/{id}`, `…/validate` | `schedule:read` |
| POST | `/scheduling/schedules/{id}/publish` | `schedule:publish` (blocked on conflicts; notifies employees) |
| POST/PATCH/DELETE | `/scheduling/schedules/{id}/shifts`, `/scheduling/shifts/{id}` | `schedule:write` (drafts only) |

## Change Requests
| Method | Path | Permission |
|---|---|---|
| POST | `/requests` (11 categories) | `request:create` |
| GET | `/requests?status&category&employee_id&overdue_only` | `request:read` |
| GET | `/requests/{id}` | `request:read` |
| POST | `/requests/{id}/manager-decision` | `request:approve_manager` |
| POST | `/requests/{id}/wfm-decision` | `request:approve_wfm` |
| POST | `/requests/{id}/cancel`, `/requests/{id}/comments` | `request:create` / `request:read` |

## Attendance
| Method | Path | Permission |
|---|---|---|
| GET/POST/PATCH/DELETE | `/attendance/codes` | read: `attendance:read` · write: `admin:settings` |
| GET/POST/PATCH | `/attendance/records`, `/attendance/records/bulk` | `attendance:read` / `attendance:write` |
| GET | `/attendance/summary?start&end` | `attendance:read` |

## Intraday
| Method | Path | Permission |
|---|---|---|
| POST | `/intraday/actuals` (bulk upsert) | `intraday:write` |
| GET | `/intraday/actuals?queue_id&day` | `intraday:read` |
| GET | `/intraday/status?queue_id&day` | `intraday:read` — forecast vs actual per interval, reforecast, RTA recommendations |

## Reports (`?format=csv` on row-based reports)
| Path | Permission |
|---|---|
| `/reports/dashboard` | `report:read` |
| `/reports/forecast-accuracy?forecast_id` (MAPE/WAPE/bias) | `report:read` |
| `/reports/adherence?start&end&team_id` | `report:read` |
| `/reports/shrinkage?start&end` | `report:read` |
| `/reports/sla?queue_id&start&end` | `report:read` |
| `/reports/agent-performance?start&end` | `report:read` |

## Notifications & AI
| Method | Path | Permission |
|---|---|---|
| GET | `/notifications?unread_only` · POST `/notifications/{id}/read` | any |
| GET | `/ai/staffing-recommendation?forecast_id&day` | `ai:use` |
| GET | `/ai/anomalies?queue_id&start&end` | `ai:use` |
| GET | `/ai/explain-forecast?forecast_id` | `ai:use` |
| POST | `/ai/chat` | `ai:use` — grounded NL answers; uses Claude when `ANTHROPIC_API_KEY` set |
