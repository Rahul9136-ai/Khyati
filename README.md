# Purvi.AI — FlowForce WFM

A full-stack **Workforce Management** platform for contact centres — forecasting, capacity
planning, scheduling, real-time adherence, leave, messaging, reporting, and two layers of
automation (a client-side rules engine and a server-side autonomous-agent system). Branded as
**Purvi.AI, a product of Purvi Technology**; "FlowForce WFM" is the underlying engine/codebase
name still used internally. Original design inspired by the *category* (IEX / Verint / NICE /
Calabrio) — no proprietary code or assets are copied.

The repo is a monorepo with two independently runnable halves:

- **`frontend/`** — a complete, navigable product (22 pages) with its own realistic
  simulated workforce (36 agents, 3 queues, a full day of forecast/schedule/RTA data),
  driven by a Zustand store. Every feature below except real login and bulk employee onboarding
  works with **zero backend** — clone, `npm install`, `npm run dev`.
- **`backend/`** — a real FastAPI service (JWT auth, RBAC, Postgres/SQLite) with its own
  domain modules and demo data, plus an autonomous-agents subsystem that observes the backend's
  own data and proposes/auto-applies actions. The frontend's `Login`, `Settings → Bulk import`,
  and `Autonomous Agents` pages talk to this backend when it's running.

## What's built

### Forecasting & planning
- 7 forecasting models (Seasonal Naïve, Moving Average, Holt-Winters, SARIMA, Prophet-style,
  Linear Regression, k-NN) with rolling back-test + auto-selected best model by MAPE.
- Actuals import (Excel/CSV) that appends to history and retrains automatically.
- Daily/Weekly/Monthly granularity, custom date ranges, ramp-up/ramp-down planning, and a
  90-day horizon.
- **External factors overlay** — log one-off events (marketing campaigns, holidays, weather,
  outages) with a date range, queue, and expected volume impact %; overlapping factors compound
  multiplicatively and adjust the forecast for that window, with an honest baseline-vs-adjusted
  comparison and an Excel import/template.
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
- **Adherence & conformance engine** — minute-level scheduled-vs-actual timelines per agent and
  a grace → flag → escalate ladder.
- **Adherence & shrinkage request workflow** — a three-tier change-control chain instead of a
  single edit gate: **Agent/Team Leader raise** a request (an adherence exception credit, or a
  break/shrinkage schedule change) → **Operations Manager/Business Admin approve** it (a
  decision) → **RTA/Scheduler/Planner apply** it (the person who actually executes the change —
  only then does it credit adherence or move a break segment). Each stage is gated on the
  designations that would really hold that job, not a generic edit permission.
- **In-office vs out-of-office shrinkage overview** — a live breakdown of scheduled
  break/lunch/meeting/training/coaching minutes (in-office) alongside agents currently on
  approved/auto-approved leave (out-of-office).
- Per-agent **actual adherence %** surfaced on every RTA card.
- Intraday reforecast: pacing vs. forecast, auto-triggered remaining-day reforecast past a
  configurable deviation threshold, and rule-gated VTO/overtime proposals.

### Messaging
- **Broadcast messages** — Team Leaders and the WFM Manager can send a message to one agent, a
  whole team, or everyone, from a topbar composer available on every page.
- Messages **pop up on screen** for the recipient(s) as an interrupting modal (styled red for
  urgent) the moment they're on the app, rather than sitting passively in a notification bell —
  dismissing it acknowledges it only for that person; other targeted recipients still see it
  until they dismiss it too.

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

### Workforce, access & onboarding
- Employees, dynamic **Skills** (add a new skill/LOB and it gets its own forecast + Erlang
  staffing immediately), skill-priority ordering, PTO/leave.
- **Agent self-service workspace** — Agents get a dedicated dashboard (today's shift/breaks,
  their own adherence %, leave summary, skills) instead of the manager Operations Dashboard, and
  every page (Scheduling, PTO, Swaps, Adherence requests) scopes to only their own records —
  they can always raise/create their own requests without the edit-level access that would let
  them approve someone else's.
- **Bulk employee onboarding** — `Settings → Bulk import employees` uploads an Excel/CSV sheet
  and creates a **real backend account per row**: an `Employee` roster record plus a linked
  `User` login with a genuine Argon2-hashed temporary password (shown once, downloadable), all
  in one step. One bad row (unknown role, duplicate email) is reported and skipped, not fatal to
  the batch. Requires the backend API running and `admin:users` permission — this mints real
  credentials, not a client-side simulation.
- **Designation-level RBAC** — 12 roles × 20 modules, a live-editable permission matrix, an
  always-reachable role switcher (superuser only), and `PermissionGate`/`RoleGuard` enforcement
  throughout, plus capability-list gating (e.g. who can raise/approve/apply an adherence
  request, or send a broadcast message) layered on top of the view/edit matrix where a plain
  access level isn't precise enough.
- Full audit trail of every mutating action (who, when, what).
- Reports & KPI export (Excel) across every module; a natural-language AI Copilot over the
  live plan.

## RBAC designations

Super Admin · Business Admin · WFM Director · WFM Manager · Forecasting Manager · Planner ·
Scheduler · RTA · Team Leader · Operations Manager · Agent · Read-Only Viewer — each with a
per-module access level (`none` / `view` / `edit`), editable at runtime in Settings.

The **real backend** seeds a parallel, slightly different 11-role matrix (Super Admin, WFM
Director, Planning Manager, Forecasting Analyst, Scheduler, Real-Time Analyst, Operations
Manager, Team Leader, Employee, HR, Reporting Analyst) with `resource:action` permission codes
(`schedule:write`, `admin:users`, …) — `frontend/src/lib/auth.ts`'s `SERVER_ROLE_MAP` maps a
real logged-in user's backend role onto the closest frontend designation.

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | React 18 + TypeScript + Vite + Tailwind + shadcn/ui-style components |
| Frontend state | Zustand (`persist` to localStorage) for the simulated WFM data |
| Server state | TanStack Query (backend-backed pages: auth, notifications, autonomy) |
| Excel import/export | SheetJS (`xlsx`) — schedules, external factors, bulk employee import |
| Charts | Recharts |
| Backend | FastAPI (async), SQLAlchemy 2.0, Pydantic v2 |
| Database | PostgreSQL (default) or SQLite (`DB_BACKEND=sqlite`, zero-infra dev/tests) |
| Auth | JWT (access + refresh) + RBAC permission codes; Argon2id password hashing |
| Async jobs | Celery + Redis (broker/result backend) |
| Infra | Docker Compose (local) → Kubernetes (documented in `ARCHITECTURE.md`) |

## Repo layout

```
wfm-platform/
├── backend/
│   └── app/
│       ├── core/           # config, logging, security (hashing, JWT), exceptions
│       ├── db/             # SQLAlchemy base/session/mixins, seed script
│       ├── api/            # versioned router (v1) + shared deps
│       ├── modules/
│       │   ├── identity/      # users, roles/RBAC, auth, audit
│       │   ├── workforce/     # org structure, employees, bulk employee import
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
│       ├── pages/           # one file per route (22 pages)
│       ├── components/
│       │   ├── ui/             # shadcn-style primitives (button, dialog, table, …)
│       │   ├── layout/         # app-shell, notifications bell, send-message-button,
│       │   │                   #   message-popup, queue-picker
│       │   └── purvi-logo.tsx  # Purvi.AI brand mark
│       ├── lib/
│       │   ├── domain/       # pure domain logic: erlang, planning, forecast,
│       │   │                 #   breaks, autoschedule, swaps, ptoRules, heal,
│       │   │                 #   automation, alerts, adherence, roles, scenario,
│       │   │                 #   externalFactors
│       │   ├── schedule.ts   # Excel schedule import/template
│       │   ├── employeeImport.ts  # Excel bulk employee import/template
│       │   └── api.ts / auth.ts   # backend HTTP client, session/RBAC mapping
│       ├── store/           # wfm.ts (Zustand) + auth.ts (backend session)
│       └── providers/       # theme, query client
├── docs/                # API.md, DATABASE.md
├── ARCHITECTURE.md       # layering, tech rationale, module → package map
└── docker-compose.yml    # Postgres + Redis + backend + worker + nginx SPA
```

## Quick start

### Frontend only — no backend needed

Every feature above except real login and bulk employee onboarding works entirely off the
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
role accounts at `Demo@12345` (see the demo-account chips on the login screen). Once signed in
as a superuser, use `Settings → Invite user` (one at a time) or `Settings → Bulk import
employees` (Excel/CSV, many at once) to create additional real accounts.

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

> **Note:** this Docker/production path is documented but not the environment this project has
> been developed and verified in day to day — local development so far has run the frontend dev
> server and the SQLite backend directly. Treat first use of the full Compose stack as needing
> its own verification pass (build, seed, and a smoke-test login) before relying on it.

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
