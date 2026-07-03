# FlowForce WFM Platform

Production-grade, multi-tenant **Workforce Management** SaaS (forecasting, capacity planning,
scheduling, real-time adherence, analytics, AI copilot). Enterprise architecture — see
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

**Status: full stack implemented.** The frontend is a complete navigable product (18 routes,
real Erlang C + statistical forecasting in TS, port 5180). The backend implements every
domain module — identity/RBAC (11 roles), org & employees, forecasting (5 models + MAPE
backtest + approval workflow), capacity planning + Erlang C/A, scheduling (templates,
auto-generation, conflict validation, publishing), change requests (2-stage approval + SLA),
attendance & shrinkage, intraday (reforecast + RTA recommendations), reports, notifications,
and an AI assistant — with a 38-test integration suite (`pytest`), ruff + mypy clean.
See [`docs/DATABASE.md`](./docs/DATABASE.md) and [`docs/API.md`](./docs/API.md).

```bash
# fastest possible backend demo (zero infra: SQLite)
cd backend && pip install -e ".[dev]"
DB_BACKEND=sqlite python -m app.db.seed        # tables + demo org + data
DB_BACKEND=sqlite uvicorn app.main:app --port 8000
# → http://localhost:8000/docs  (admin@flowforce.dev / Admin@12345)
```

## Monorepo layout

```
wfm-platform/
├── backend/              # FastAPI modular monolith (Python 3.12)
│   └── app/
│       ├── core/         # config, logging, security, exceptions
│       ├── db/           # SQLAlchemy base, session, mixins
│       ├── api/          # versioned API router (v1) + shared deps
│       ├── modules/      # one package per bounded context (added per module)
│       ├── schemas/      # shared DTOs (envelope, pagination)
│       └── worker/       # Celery app
├── frontend/             # React + TS + Vite + Tailwind + shadcn/ui
│   └── src/
│       ├── components/   # ui/ (shadcn) + layout/
│       ├── providers/    # theme, query client
│       ├── lib/          # api client, utils
│       └── features/     # one folder per domain (added per module)
├── infra/                # k8s/helm (added in deployment module)
├── .github/workflows/    # CI
└── docker-compose.yml    # local dev stack
```

## Quick start (local)

```bash
# 1. Bring up Postgres + Redis + backend + worker + frontend
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
docker compose up --build

# Backend  → http://localhost:8000  (docs at /docs, health at /api/v1/health)
# Frontend → http://localhost:5173
```

### Backend only (no Docker)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
uvicorn app.main:app --reload
pytest
```

### Frontend only

```bash
cd frontend
npm install
npm run dev
```

## Conventions

- **Backend layering** per module: `router → service → repository → models`, DTOs in `schemas`.
- **Commits/PRs**: one product module per PR; CI must be green (lint + types + tests).
- **Migrations**: `alembic revision --autogenerate -m "..."` then `alembic upgrade head`.

## Roadmap (build order)

1. ✅ **Architecture & Foundation** ← *this module*
2. User Management · 3. RBAC · 4. Org Setup · 5. Employees · 6. Skills …

See `ARCHITECTURE.md` for the full module → package map.
