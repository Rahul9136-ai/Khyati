# Planning Module (AGS Health CP model)

Monthly headcount **capacity planning** for a contact centre, converted from the
`AGS Planning Frame Work` workbook into a scalable web module. It is **additive** —
it does not change the existing Erlang-based weekly capacity planner
(`app/modules/planning`), the Employee module, forecasting, or auth.

Backend module: `app/modules/hcplanning`. Frontend: `Planning` nav → `src/pages/Planning.tsx`.

---

## Data flow

```
Employee (+ AgentPlanningProfile)
        │  status, LOB, location, DOJ, inactive, DOP, experience, move in/out
        ▼
  per-agent monthly status  ── productive? tenure bucket, fresher/lateral
        │  (SUMPRODUCT: Σ productive × Status × LOB, per month)
        ▼
  Capacity engine  ──────────────────────────────────────────────┐
    Required HC · FTE · Ramp · Notice · OJT · Bench · Leave        │
    Production Agents · FTE+Ramp · Closing HC · Capacity %         │
    Excess/Deficit · OT/VTO · Utilisation · Buffer · Resource mix  │
        ▲                                                          │
        │ new-hire production (per month)                          ▼
  New Hire pipeline                                        Summary / Scenario
    Hiring → Training → Nesting → Production
```

Agents that plan a **move** (move-out / move-in / target LOB) shift which LOB they
count toward each month, so capacity for both LOBs reflects the movement.

---

## Calculation logic

All formulas live as labelled pure functions in `app/modules/hcplanning/engine/`
(no Excel cell references). Key relationships:

| Metric | Formula |
| --- | --- |
| **Required HC** | `Billable FTE / ((1 − OOO Shrinkage) × (1 − IO Shrinkage))` |
| **Production Agents** | `Σ(FTE, Ramp, Notice, OJT, Investment Bench, Ops Bench, Training, Long Leave, Maternity Leave)` |
| **FTE / Ramp (actual months)** | roster count: `Σ productive × (Status = category) × (LOB = selected)` |
| **FTE (projected months)** | `FTE[m−1] × (1 − attrition)` |
| **Ramp (projected months)** | `Ramp[m−1] × (1 − attrition) + new-hire production[m]` |
| **FTE + Ramp** | `FTE + Ramp` |
| **Closing HC** | `FTE + Ramp` (editable override per month) |
| **Capacity %** | `Closing HC / Required HC` |
| **Excess / Deficit** | `Closing HC − Required HC` |
| **OT / VTO Hours** | `Excess/Deficit × weekly hours (default 40)` |
| **Overall Utilisation %** | `Billable FTE / Production Agents` |
| **Productive Utilisation %** | `Billable FTE / (FTE + Ramp + Notice + Ops Bench)` |
| **Buffer %** | `Production Agents / Billable FTE − 1` |
| **New-hire production** | `ROUND(planned × hiring throughput × training throughput, 0)` at production month |

**Actuals vs projection.** Months up to `actuals_through` take FTE/Ramp straight
from the roster. Later months are projected (attrition decay; Ramp also receives
new-hire production). Other categories (Notice, OJT, Maternity, …) come from the
roster in all months.

## Agent monthly status

- **Productive** in a month when the month ≥ the agent's DOP month and (no inactive
  date or the month < the inactive month). Missing DOP ⇒ never productive.
- **Tenure bucket** from configurable bands (default A:0-6, B:7-12, C:13-24,
  D:25-36, E:37-48, F:49-60, G:61-72, H:73-84, I:>84 months).
- **Fresher (<1 yr) / Lateral (>1 yr)** by whole months since the DOP month.

## Planning assumptions (configurable, per org or per LOB)

OOO shrinkage (4%), IO shrinkage (4%), attrition (1.25%), weekly hours (40),
hiring throughput (90%), training throughput (95%), training/nesting durations
(21 / 9 days), tenure bands, `actuals_through`, per-month shrinkage/attrition
overrides, and per-month Closing HC overrides.

---

## API (`/api/v1/hc-planning`, permissions `planning:read` / `planning:write`)

| Method & path | Purpose |
| --- | --- |
| `GET  /config?lob_id=` | Effective config (LOB-specific over org default) |
| `PUT  /config` | Upsert assumptions |
| `GET  /demand?lob_id=` | Monthly Billable FTE |
| `PUT  /demand` | Bulk upsert demand |
| `PUT  /employees/{id}/profile` | Set DOP / status / experience / movement |
| `GET  /agents?lob_id=` | Agents + movement (Agent Movement view) |
| `GET  /new-hire-batches?lob_id=` · `POST` · `PUT/{id}` · `DELETE/{id}` | Hiring batches |
| `GET  /new-hire-pipeline?lob_id=` | Hiring → Training → Nesting → Production stages |
| `GET  /capacity?lob_id=&from=&to=` | The monthly capacity table |
| `POST /scenario` | Baseline vs what-if (never mutates the plan) |

## Database changes (additive)

New tables: `agent_planning_profiles`, `hc_planning_configs`, `hc_demand`,
`new_hire_batches`. No existing table is altered. SQLite dev/tests bootstrap via
`create_all`; Postgres uses the Alembic migration in `backend/alembic/versions`.

---

## Testing

- **`tests/test_hcplanning_engine.py`** — the mandatory Excel validation: the
  engine, driven by the agent population extracted from the workbook
  (`tests/fixtures/ags_health_cp.json`), reproduces **every AGS Health CP metric
  across all 14 months to 0.00**. Plus new-hire pipeline math and §34 edge cases.
- **`tests/test_hcplanning_api.py`** — config/demand/capacity flow, closing
  override, new-hire pipeline feeding Ramp, agent movement shifting capacity
  between LOBs, and scenario isolation from the baseline.

Run: `cd backend && pytest -k hcplanning`. Frontend: `cd frontend && npm run build`.
