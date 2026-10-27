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
  and `Autonomous Agents` pages talk to this backend when it's running, and the **Scheduling
  timeline syncs to it** (see *Schedule sync* below) — while still working offline.

## What's built

### Forecasting & planning
- 7 forecasting models (Seasonal Naïve, Moving Average, Holt-Winters, SARIMA, Prophet-style,
  Linear Regression, k-NN) with rolling back-test + auto-selected best model by MAPE.
- Actuals import (Excel/CSV) that appends to history and retrains automatically.
- Daily/Weekly/Monthly granularity, custom date ranges, ramp-up/ramp-down planning, and a
  90-day horizon.
- **Events log (external factors)** — log one-off events (marketing campaigns, holidays,
  weather, outages, client wins/losses, product launches, seasonal peaks) with a date range
  (past or future), queue, and expected volume impact %; overlapping events compound
  multiplicatively. Shared between Forecasting (adjusts that queue's date-range forecast, with
  an honest baseline-vs-adjusted comparison) and Scenario Studio (below) — log an event once,
  see it in both. Excel import/template included.
- **Capacity Planning**, powered by the same Erlang C engine used throughout the app.
- **Scenario Studio** — the events log's volume & staffing-requirement impact, past and future,
  in one chart (baseline vs adjusted, by day); build a what-if scenario's volume % directly from
  one or more logged events (compounded), or type a volume %/AHT %/shrinkage override/headcount
  change by hand, run through the same Erlang C engine as the live plan, with side-by-side
  before/after and an FTE-gap verdict.

### Scheduling
- **Omni-channel continuous schedules** — a minute-precision timeline per agent aligned to
  Phone / Chat / Email, with breaks/lunch cut in, channel filter, grouping and sorting (name
  A→Z / Z→A, start time). Drag to move breaks, lunch and activities; drag any edge to resize a
  block, a channel boundary, OT, or the shift itself.
- **Overtime per channel** (drawn as grid lines in the channel colour) and an **activity
  overlay** (Meeting, Training, Coaching, LOA, Absence, Other) in the upper band that takes the
  agent off the channel for On duty / SL. Add in bulk by filters, staggered waves or Excel/CSV.
- **Bulk editing** — Ctrl/⌘+click, Shift+click or select-all; Ctrl+←/→ moves selected
  schedules; dragging in one selected row applies to all; right-click marks any AUX on all
  selected. Interval detail shows Forecast, AHT, Occupancy, SL %, Required/Actual HC and O/U.
- **Schedule sync** — the timeline is stored server-side as one *day plan* per agent per date
  (`/api/v1/scheduling/day-plans/{date}`, table `day_schedule_plans`). The backend enforces the
  same rules as the UI (`backend/app/modules/scheduling/dayplan.py` mirrors
  `frontend/src/lib/domain/channels.ts`) and offers the same operations for API callers: bulk
  save with optimistic versioning (409 on stale edits), move/resize (`/edit`, with followers for
  bulk drags), `/move`, `/resize-shift`, `/mark-aux` (incl. staggered waves), `/unmark`,
  `/overtime`, `/coverage` and `/export` (JSON or CSV, same five sheets as the UI). Every change
  is audited. The frontend loads the server copy on sign-in, saves changed agents as you edit,
  polls for other users' changes, keeps working offline and pushes offline edits when the
  backend is back; a badge in the timeline shows Synced / Saving / Offline / Updated from server.
- **Country labour law** — pick a country (India, US federal, US–California, UK, Germany,
  France, Spain, Philippines, Canada federal, Australia, Singapore, UAE, Brazil, Mexico, South
  Africa) and its scheduling rules apply automatically: daily/overtime limits, required breaks
  (total or one uninterrupted break), max work without a break and max spread of the day. Every
  schedule is checked live (⚖ markers, issue count, "only non-compliant" filter, compliance +
  rules sheets in exports); values can be adjusted for local agreements and reset to statute.
  The choice is one organisation-wide policy (`GET/PUT /api/v1/scheduling/labour-law`,
  presets at `/scheduling/labour-laws`, check at `/day-plans/{date}/compliance`). Presets are
  simplified statutory baselines, **not legal advice** — verify locally. Only daily rules are
  checked; weekly limits and rest between days are shown for reference.
- **3-month schedules & publishing** — a date bar walks the next 3 months (today − 14 days to
  today + 3 months) and a "Schedules — next 3 months" grid shows every agent's shift per day
  (published vs draft, activities, OT); click a day to edit it on the timeline. **Publish**
  (this day / week / 4 weeks / all 3 months / custom) creates any days nobody opened from
  shift patterns (`POST /scheduling/day-plans/fill`) and publishes them
  (`POST /scheduling/day-plans/publish`, needs `schedule:publish`). Until published, days are
  drafts that agents and team leaders can't see; agents see only their own days ("My schedule",
  `GET /scheduling/my-schedule`). Publishing and every later change to a published day notify the
  agent (via their employee record — roster id = employee code) and their team leaders (team
  leader / manager on the employee record, or a Team Leader login named as the roster's TL) with
  a pop-up on whatever page they're on; rapid edits update one unread notification instead of
  piling up. Dev logins for the demo roster: `ava.mendez@`, `liam.carter@`, `zara.khan@`,
  `leah.webb@` (agents) and `marcus.webb@`, `elena.faro@`, `sam.okoye@` (TLs) `flowforce.dev`,
  password `Demo@12345` (`python -m app.db.seed` adds them).
- **VTO / PTO / Overtime / Leave slots** — for the selected day and queue, "Open slots" works out
  each interval's heads over/under Required HC (net of meetings, VTO and leave already booked)
  and suggests time off (as VTO or PTO) where you're over, OT where you're short and full-day
  Leave where the whole day has room (slot length 30 min / 1 h / 2 h; room already on offer isn't
  offered twice). Opened slots go to the agents skilled for the queue with a pop-up; agents see
  each slot as "3 filled · 2 left" and take it first come, first served — it's written straight
  into their schedule (VTO / PTO / Leave activity, or an OT block) and their TL is notified like
  any change. Slots that don't fit an agent's published day are greyed out with the reason.
  Schedulers can change capacity, close/reopen, remove empty slots or cancel a claim (which
  takes it back out of the schedule). API: `GET/POST /scheduling/offers`,
  `PATCH/DELETE /offers/{id}`, `POST /offers/{id}/claim`, `POST /offers/claims/{id}/cancel`.
- **Auto-plan channels (future weeks)** — "Plan channels" re-aligns Phone / Chat / Email for next
  week, 2 weeks, 4 weeks or the rest of the 3 months: in every 30-min interval the free agents
  (not on a break, meeting or time off) go to **phone first** — enough for every queue's forecast
  before shrinkage — then the chat minimum, and everyone else to email; agents keep their channel
  wherever the need doesn't change, and OT isn't moved. The result is a **draft** only schedulers
  see (per-day agents moved and phone / chat shortfall in head-hours, before → after).
  **Publish changes** writes it into the schedules (skipping any day edited after planning),
  publishes those days and notifies agents and TLs ("Channels now Phone 09:30–18:00"); agents see
  their channels in My schedule. API: `GET/PUT /scheduling/channel-drafts`,
  `POST /channel-drafts/publish` (`schedule:publish`), `POST /channel-drafts/discard`, full rows
  via `GET /scheduling/day-plans/range`.
- **Work rules** (`/work-rules`) — reusable shift + break patterns (e.g. *8h · 30m lunch + 2×15m
  breaks*, *9h · 1h lunch + 2×15m breaks*, 10h × 4 days, part-time 6h / 4h; breaks are spread so
  the work splits into equal stretches) assigned to agents at a start time, each with their own
  **week off** — *Fixed* (same days every week, e.g. the "Fixed Sat–Sun" preset) or *Rotating*
  (the days move one day later each week) — set with presets or Mon–Sun toggles; bulk assign and
  "stagger days off" across a team. **Bulk import** takes an Excel / CSV file (or rows pasted
  from Excel): a *Work rules* sheet (Name · Shift Hours · Breaks e.g. "Break 15; Lunch 30;
  Break 15" · Week Off · Fixed/Rotating · Usual Start) and an *Agents* sheet (Work Rule · Start ·
  Week Off · Fixed/Rotating); the downloadable template is pre-filled with the current setup, and
  every row is checked in a preview before anything changes. Unopened dates
  follow the rules automatically (a full-shift *Week off* activity on days off). **Align schedules
  to work rules** (on Work Rules and Scheduling) sets any period you pick — for everyone on a rule,
  one team or the selected agents — to the rules: preview per day (schedules changing, week offs
  added / removed, shift and break moves), then align, optionally publishing the period. Offline
  it aligns the schedules kept in the browser. **Compliance rules** (break in every shift of 3h+,
  max 3h in a row without a break, lunch on long shifts, max days in a row, days off a week, weekly
  hours, rest between shifts) are checked on rule cards, in a per-agent report, and on the
  Scheduling timeline (⏱ badge, offending stretch outlined in red). Rules and assignments are kept
  in the browser like shift patterns; week offs written into schedules are saved on the server.
- Global, reusable **shift patterns** (start/end + break/lunch segments) that seed each
  agent's breaks on the timeline.
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

### Shared settings, API keys & webhooks (connect a CRM)
- **Saved for everyone** — work rules, compliance limits, shift patterns and each agent's rule /
  start / week off are stored per organisation (`GET/PUT /scheduling/settings/{key}`, versioned,
  409 on a stale save). Every browser loads them at sign-in, saves changes as they're made, picks
  up other people's changes every 20 s and uploads offline edits when back online; the Work Rules
  page shows "Saved for everyone".
- **API keys** (Settings → API & Webhooks) — named keys limited to chosen permissions (never more
  than their creator has), optional expiry, shown once, stored hashed, revocable. A tool sends
  `X-API-Key: wfm_…` (or `Authorization: Bearer wfm_…`) and uses the normal REST API.
- **Webhooks** — signed JSON events (`schedule.updated`, `schedule.published`, `slot.opened`,
  `slot.claimed`, `slot.released`, `settings.updated`) written to an outbox in the same transaction
  as the change and sent within seconds; `X-WFM-Signature: sha256=HMAC(secret, "{timestamp}.{body}")`.
  Failures retry after 30 s / 2 min / 10 min / 1 h / 6 h; a delivery log with payloads, redeliver,
  pause, rotate secret and "Send test".
- **Inbound** — `POST /connect/inbound/time-off` lets a CRM / HR tool mark (or remove, by
  `external_id`) leave, absence, week off or other activities for an agent over a date range.

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
