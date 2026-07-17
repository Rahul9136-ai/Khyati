# FlowForce WFM

A full-stack **Workforce Management** platform for contact centres — forecasting, capacity
planning, scheduling, real-time adherence, leave, reporting, and two layers of automation
(a client-side rules engine and a server-side autonomous-agent system). Original design
inspired by the *category* (IEX / Verint / NICE / Calabrio) — no proprietary code or assets
are copied.

The repo is a monorepo with two independently runnable halves:

- **`frontend/`** — a complete, navigable product (24 routes) with its own realistic
  simulated workforce (30+ agents, 3+ queues, a full day of forecast/schedule/RTA data),
  driven by a Zustand store. Every feature works with **zero backend** — clone, `npm install`,
  `npm run dev`.
- **`backend/`** — a real FastAPI service (JWT auth, RBAC, Postgres/SQLite) with its own
  domain modules and demo data, plus an autonomous-agents subsystem that observes the backend's
  own data and proposes/auto-applies actions. The frontend's `Login` / `Autonomous Agents`
  pages talk to this backend when it's running.

## What's built

### Forecasting & planning
- 7 forecasting models (Seasonal Naïve, Moving Average, Holt-Winters, SARIMA, Prophet-style,
  Linear Regression, k-NN) with rolling back-test + auto-selected best model by MAPE.
- Actuals import (Excel/CSV) that appends to history and retrains automatically.
- Daily/Weekly/Monthly granularity, custom date ranges, ramp-up/ramp-down planning, and a
  90-day horizon.
- **Capacity Planning** and a standalone **Erlang C Calculator**.
- **Scenario Studio** — what-if simulation (volume %, AHT %, shrinkage override, headcount ±)
  run through the same Erlang C engine as the live plan, with side-by-side before/after and an
  FTE-gap verdict.

### Scheduling
- Daily shift-plan grid with global, reusable **shift patterns** (start/end + break/lunch
  segments).
- Bulk schedule import from Excel with a downloadable template.
- **Break optimiser** — re-staggers every agent's breaks (not just uniform +2h/+4h offsets) to
  minimise volume-weighted SL shortfall across all queues, with a before/after report.
- **Auto-scheduler** — recommends the fewest new hires (by existing shift pattern) needed to
  close a queue's forecasted coverage gap, with a projected SL before/after; one click applies
  them to the roster.
- Interval-level volume + projected-SL panel under the roster grid.
- **Shift-Swap Marketplace** — agents propose swaps; an SL-neutrality check auto-approves
  harmless ones and writes the exchange to the roster immediately, escalating riskier swaps to
  a Team Leader.

### Real-time & adherence
- Verint-style AUX wallboard with live agent states, time-in-state, and an AI break-recovery
  panel that recommends (and one-click applies) recalling agents off deferrable breaks when SL
  is at risk.
- **Adherence & conformance engine** — minute-level scheduled-vs-actual timelines per agent,
  approved-exception handling, and a grace → flag → escalate ladder.
- Per-agent **actual adherence %** surfaced on every RTA card.
- Intraday reforecast: pacing vs. forecast, auto-triggered remaining-day reforecast past a
  configurable deviation threshold, and rule-gated VTO/overtime proposals.

### Automation (client-side rules engine)
- **Automation Center** — a configurable rules engine (auto-reforecast, forecast-variance
  alerts, shift-swap auto-approval, **leave auto-approval**, adherence escalation, break
  recovery, VTO/overtime proposals) with editable thresholds, all reflected live across the app.
- **PTO auto-approval** — a leave request auto-approves when the requester's skill group has
  enough coverage surplus to absorb the shift and isn't already over the concurrent-leave
  overlap cap; otherwise it waits for a human, with the reasoning logged.
- **Scheduled pipeline runner** — every pipeline stage (ingest → forecast → capacity →
  schedule → RTA) has a real "Run now" and a genuine "auto-run" toggle that keeps firing on a
  live interval, independent of which page is open.
- **Proactive alerts** — a background watcher recomputes SL risk, adherence escalations, and
  pending-approval queues on an interval and surfaces them in the topbar notification bell from
  any page, with deep links to the relevant module.

### Autonomous agents (real backend)
- A server-side `autonomy` module: specialist agents (intraday, forecast, planning,
  root-cause, …) that read live platform data and return confidence-scored proposals.
- A policy (`manual` / `assisted` / `autonomous` + auto-apply confidence threshold) governs
  whether a proposal auto-applies or waits for a human approve/reject.
- Full run history and a decision audit trail, exposed on the **Autonomous Agents** page.

### Workforce, access & reporting
- Employees, dynamic **Skills** (add a new skill/LOB and it gets its own forecast + Erlang
  staffing immediately), skill-priority ordering, PTO/leave.
- **Designation-level RBAC** — 12 roles × 15 modules, a live-editable permission matrix, an
  always-reachable role switcher, and `PermissionGate`/`RoleGuard` enforcement throughout.
- Full audit trail of every mutating action (who, when, what).
- Reports & KPI export (Excel) across every module; a natural-language AI Copilot over the
  live plan.

## RBAC designations

Super Admin · Business Admin · WFM Director · WFM Manager · Forecasting Manager · Planner ·
Scheduler · RTA · Team Leader · Operations Manager · Agent · Read-Only Viewer — each with a
per-module access level (`none` / `view` / `edit`), editable at runtime in Settings.

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | React 18 + TypeScript + Vite + Tailwind + shadcn/ui-style components |
| Frontend state | Zustand (`persist` to localStorage) for the simulated WFM data |
| Server state | TanStack Query (backend-backed pages: auth, notifications, autonomy) |
| Charts | Recharts |
| Backend | FastAPI (async), SQLAlchemy 2.0, Pydantic v2 |
| Database | PostgreSQL (default) or SQLite (`DB_BACKEND=sqlite`, zero-infra dev/tests) |
| Auth | JWT (access + refresh) + RBAC permission codes |
| Async jobs | Celery + Redis (broker/result backend) |
| Infra | Docker Compose (local) → Kubernetes (documented in `ARCHITECTURE.md`) |

## Repo layout

```
wfm-platform/
├── backend/
│   └── app/
│       ├── core/           # config, logging, security, exceptions
│       ├── db/             # SQLAlchemy base/session/mixins, seed script
│       ├── api/            # versioned router (v1) + shared deps
│       ├── modules/
│       │   ├── identity/      # users, roles/RBAC, auth, audit
│       │   ├── workforce/     # org, employees
│       │   ├── forecasting/   # models, backtest, approval
│       │   ├── planning/      # capacity plans, Erlang
│       │   ├── scheduling/    # rosters, templates, publishing
│       │   ├── intraday/      # pacing, reforecast, RTA
│       │   ├── attendance/    # adherence/shrinkage
│       │   ├── requests/      # change requests / leave workflow
│       │   ├── reporting/     # dashboards, KPIs
│       │   ├── notifications/ # in-app notification inbox
│       │   ├── ai/            # copilot / anomaly detection
│       │   └── autonomy/      # autonomous agents, policy, actions
│       ├── schemas/        # shared DTOs (envelope, pagination)
│       └── worker/         # Celery app
├── frontend/
│   └── src/
│       ├── pages/           # one file per route (24 routes)
│       ├── components/      # ui/ (shadcn-style) + layout/ + feature widgets
│       ├── lib/domain/      # pure domain logic: erlang, planning, forecast,
│       │                    #   breaks, autoschedule, swaps, ptoRules, heal,
│       │                    #   automation, alerts, adherence, roles, scenario
│       ├── store/           # wfm.ts (Zustand) + auth.ts (backend session)
│       └── providers/       # theme, query client
├── docs/                # API.md, DATABASE.md
├── ARCHITECTURE.md       # layering, tech rationale, module → package map
└── docker-compose.yml    # Postgres + Redis + backend + worker + nginx SPA
```

## Quick start

### Frontend only — no backend needed

Every feature above except login and the Autonomous Agents page works entirely off the
in-browser simulated data:

```bash
cd frontend
npm install
npm run dev
# → http://localhost:5180
```

### Backend — zero-infra (SQLite)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
DB_BACKEND=sqlite python -m app.db.seed             # creates tables + demo org + data
DB_BACKEND=sqlite uvicorn app.main:app --port 8000
# → http://localhost:8000/docs
```

Point the frontend at it with `frontend/.env.local`:

```
VITE_API_BASE_URL=http://localhost:8000/api/v1
```

Demo accounts (seeded): `admin@flowforce.dev` / `Admin@12345` (Super Admin), plus nine
role accounts at `Demo@12345` (see the demo-account chips on the login screen).

### Full stack — Docker Compose

```bash
docker compose up -d --build
docker compose exec backend python -m app.db.seed

# App      → http://localhost:8080   (admin@flowforce.dev / Admin@12345)
# Backend  → http://localhost:8000   (docs at /docs, health at /api/v1/health)
# Postgres → localhost:5433 · Redis → localhost:6380 (offset to avoid local clashes)
```

The container build serves the SPA with `VITE_API_BASE_URL=/api/v1` behind nginx, which
reverse-proxies `/api/` to the backend — same-origin, no CORS config needed.

## Testing

```bash
# Backend
cd backend && pytest

# Frontend
cd frontend && npm run typecheck && npm run lint && npm run build
```

## Docs

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — layering, tech rationale, module → package map.
- [`docs/API.md`](./docs/API.md) — API reference.
- [`docs/DATABASE.md`](./docs/DATABASE.md) — schema reference.
