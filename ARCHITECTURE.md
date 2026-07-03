# FlowForce WFM — Architecture (Module 1)

> Original, enterprise WFM SaaS inspired by the *category* (IEX / Verint / NICE / Calabrio).
> No proprietary code or designs are copied.

## 1. Architectural style

A **modular monolith** for the backend, organised by **bounded context** (one package per
business domain), behind a single FastAPI app. This gives strong module boundaries and SOLID
separation *now*, with a clean path to extract any domain into its own service later (the AI /
forecasting workers are already isolated behind Celery).

```
                         ┌──────────────────────────────────────────┐
                         │              Clients (SPA)                │
                         │   React + TS + Tailwind + shadcn/ui       │
                         └───────────────┬──────────────────────────┘
                                         │  HTTPS / JSON (OpenAPI)
                         ┌───────────────▼──────────────────────────┐
                         │            FastAPI gateway                │
                         │  middleware: auth(JWT/RBAC), request-id,  │
                         │  CORS, rate-limit, audit, error handler   │
                         └───────────────┬──────────────────────────┘
        ┌────────────────┬──────────────┼───────────────┬───────────────────┐
        ▼                ▼              ▼               ▼                   ▼
   identity/         workforce/      planning/       realtime/            ai/
   (users, RBAC,     (employees,     (forecast,      (RTA, adherence,    (copilot,
    org, auth)        skills, PTO)    capacity,        intraday, alerts)   RAG, recs)
                                      Erlang, sched)
        └────────────────┴──────────────┴───────────────┴───────────────────┘
                                         │  SQLAlchemy 2.0 (async)
                         ┌───────────────▼───────────────┐     ┌──────────────┐
                         │          PostgreSQL           │     │    Redis     │
                         └───────────────────────────────┘     │ cache/broker │
                                                               └──────┬───────┘
                                  ┌─────────────────────────────────┐ │
                                  │  Celery workers (Prophet/XGB/    │◄┘
                                  │  LightGBM training, exports)     │
                                  └─────────────────────────────────┘
```

## 2. Layered design (per module — SOLID)

Each domain package follows the same **layered** shape so responsibilities never leak:

| Layer | File | Responsibility | SOLID |
| --- | --- | --- | --- |
| **API** | `router.py` | HTTP only: routing, status codes, dependency wiring | SRP |
| **Schema** | `schemas.py` | Pydantic DTOs (request/response), validation | ISP |
| **Service** | `service.py` | Business rules, orchestration, transactions | SRP / DIP |
| **Repository** | `repository.py` | Data access via SQLAlchemy; the only layer touching the ORM | DIP |
| **Model** | `models.py` | SQLAlchemy ORM entities | — |
| **Deps** | `dependencies.py` | Injectables (current user, permission guards, repo/service factories) | DIP |

Services depend on **repository interfaces** (Protocols), not concrete ORM — so business logic is
unit-testable with in-memory fakes (Dependency Inversion). Routers depend on services via
`Depends`, keeping the framework at the edges (Open/Closed for new endpoints).

## 3. Tech stack & rationale

| Concern | Choice | Why |
| --- | --- | --- |
| API | **FastAPI** (async) | First-class OpenAPI, Pydantic v2, async I/O for high-concurrency RTA |
| ORM | **SQLAlchemy 2.0** + asyncpg | Typed, async, mature; Alembic migrations |
| DB | **PostgreSQL** | Relational integrity for org/role/schedule graphs; window funcs for analytics |
| Validation | **Pydantic v2** | Shared request/response contracts, settings management |
| Auth | **JWT (access+refresh) + OAuth2 + RBAC** | Stateless API auth; fine-grained permissions |
| Cache/Broker | **Redis** | Session/rate-limit cache + Celery broker/result backend |
| Async jobs | **Celery** | Long-running forecast training, bulk imports, exports |
| ML | **scikit-learn, statsmodels, Prophet, XGBoost, LightGBM** | Statistical + ML + ensemble forecasting |
| RAG | **LangChain + pgvector** | Copilot / NL analytics grounded in tenant data |
| Frontend | **React + TS + Vite + Tailwind + shadcn/ui** | Typed, fast HMR, accessible component primitives |
| Server state | **TanStack Query** | Caching, retries, optimistic updates |
| Client state | **Zustand** | Lightweight UI/theme state |
| Forms | **react-hook-form + zod** | Typed forms mirroring backend schemas |
| Charts | **Recharts** (ECharts for heavy dashboards) | Declarative, themeable |
| Infra | **Docker / Compose → K8s** | Local parity; cloud portability (Azure/GCP) |
| CI/CD | **GitHub Actions** | Lint, type-check, test, build, image push |

## 4. Cross-cutting concerns (built into the foundation)

- **Config** — `pydantic-settings`, 12-factor, `.env` per environment.
- **Logging** — structured JSON logs with a per-request `request_id`.
- **Errors** — typed `AppError` hierarchy → consistent JSON error envelope.
- **Pagination/Envelope** — generic `Page[T]` and `ApiResponse[T]` schemas.
- **Multi-tenancy** — every tenant-owned row carries `organization_id`; enforced in the
  repository layer + a query dependency (added in Module 3).
- **Audit** — middleware + `audit_logs` table (Module 22) records mutating actions.
- **Security** — password hashing (argon2), JWT, RBAC permission guards (Modules 1–3).

## 5. Module → package map

| Product module(s) | Backend package |
| --- | --- |
| 1 User Mgmt · 2 RBAC · 3 Org · 22 Audit · 23 API keys | `modules/identity` |
| 4 Employees · 5 Skills · 15 PTO/Leave · 16 Shift Bidding | `modules/workforce` |
| 6 Forecasting · 7 Capacity · 8 Budget · 9 Headcount · 10 Erlang · 11 Multi-skill · 12 Scheduling · 17 What-if | `modules/planning` |
| 13 Intraday · 14 RTA · 21 Alert Engine | `modules/realtime` |
| 18 Dashboards · 19 KPI Reporting · 24 Import/Export | `modules/analytics` |
| 20 AI Copilot · AI recs · RAG · NL/Voice | `modules/ai` |
| 25 Notification Center | `modules/notifications` |

## 6. Environments & deployment (summary)

- **Local**: `docker compose up` → Postgres, Redis, backend (uvicorn --reload), Celery worker,
  frontend (Vite). See root `README.md`.
- **CI**: lint (ruff) + type (mypy) + tests (pytest) for backend; eslint + tsc + vitest + build
  for frontend; Docker image build.
- **Prod**: container images → Kubernetes (manifests/Helm added in the deployment module);
  managed Postgres + Redis on Azure/GCP.
