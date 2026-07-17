// Automation & intelligence layer: the scheduled-job pipeline that chains
// data ingest → forecast → capacity → schedule → RTA monitoring, plus the
// rules engine that governs auto-approvals, alerts and intraday actions.
// Job history is deterministic (seeded off the job id + run index) so the
// control centre renders a stable, realistic operational record.

export interface Thresholds {
  /** Intraday deviation (|actual−forecast|/forecast, to-date) that triggers auto-reforecast. */
  reforecastPct: number
  /** Interval-level forecast variance that raises an accuracy alert. */
  varianceAlertPct: number
  /** Target adherence — agents/teams below this are flagged on scorecards. */
  adherenceTarget: number
  /** Minutes out-of-adherence tolerated before an agent is flagged. */
  graceMins: number
  /** Minutes out-of-adherence before the alert escalates to the team lead. */
  escalateMins: number
  /** Max planned occupancy — capacity plans above this are flagged burnout-risk. */
  occupancyCap: number
  /** Max service-level drop (percentage points) a shift swap may cause and still auto-approve. */
  autoApproveSwapSlPp: number
  /** Max share of same-skill headcount simultaneously on approved leave before PTO auto-approval defers to a human. */
  ptoOverlapCapPct: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  reforecastPct: 0.1,
  varianceAlertPct: 0.15,
  adherenceTarget: 0.9,
  graceMins: 3,
  escalateMins: 10,
  occupancyCap: 0.85,
  autoApproveSwapSlPp: 0.5,
  ptoOverlapCapPct: 0.25,
}

export const THRESHOLD_META: {
  key: keyof Thresholds
  label: string
  help: string
  kind: "pct" | "mins" | "pp"
  min: number
  max: number
  step: number
}[] = [
  { key: "reforecastPct", label: "Intraday auto-reforecast trigger", help: "Deviation of actuals vs forecast (to-date) beyond which the day is automatically reforecast.", kind: "pct", min: 0.02, max: 0.3, step: 0.01 },
  { key: "varianceAlertPct", label: "Interval variance alert", help: "Interval-level forecast miss that raises an accuracy alert (2× = critical).", kind: "pct", min: 0.05, max: 0.5, step: 0.01 },
  { key: "adherenceTarget", label: "Adherence target", help: "Agents and teams below this adherence are flagged on scorecards.", kind: "pct", min: 0.7, max: 0.99, step: 0.01 },
  { key: "graceMins", label: "Adherence grace period", help: "Minutes out-of-adherence tolerated before an agent is flagged.", kind: "mins", min: 0, max: 15, step: 1 },
  { key: "escalateMins", label: "Escalate to team lead after", help: "Minutes out-of-adherence before the alert escalates to the agent's TL.", kind: "mins", min: 2, max: 45, step: 1 },
  { key: "occupancyCap", label: "Occupancy cap", help: "Planned occupancy above this is flagged as burnout risk in capacity plans.", kind: "pct", min: 0.6, max: 0.95, step: 0.01 },
  { key: "autoApproveSwapSlPp", label: "Swap auto-approval SL tolerance", help: "Largest service-level drop (percentage points) a shift swap can cause and still auto-approve.", kind: "pp", min: 0, max: 3, step: 0.1 },
  { key: "ptoOverlapCapPct", label: "Leave auto-approval overlap cap", help: "Max share of the requester's skill group already on approved leave for overlapping dates before auto-approval defers to a human.", kind: "pct", min: 0.05, max: 0.6, step: 0.05 },
]

// ---- scheduled-job pipeline ----

export interface PipelineJob {
  id: string
  name: string
  stage: number // 1..5, the chain order
  schedule: string // human-readable cadence
  description: string
}

export const PIPELINE: PipelineJob[] = [
  { id: "ingest", name: "Data Ingest", stage: 1, schedule: "hourly :05", description: "Pulls contact volume, AHT and shrinkage actuals from the ACD export / API sync." },
  { id: "forecast", name: "Forecast Refresh", stage: 2, schedule: "daily 02:00", description: "Re-trains every model on the augmented history, backtests, auto-selects the lowest-MAPE model per queue." },
  { id: "capacity", name: "Capacity Rebuild", stage: 3, schedule: "daily 02:30", description: "Converts the fresh forecast into interval FTE requirements via Erlang C with shrinkage and occupancy caps." },
  { id: "schedule", name: "Schedule Optimiser", stage: 4, schedule: "Mon 03:00 + intraday", description: "Regenerates optimal break/lunch placement against interval requirements; proposes VTO/OT on deviation." },
  { id: "rta", name: "RTA Monitor", stage: 5, schedule: "every 30 s", description: "Compares live agent states to schedule, applies grace periods, escalates to team leads." },
]

export type RunStatus = "success" | "warning" | "failed"

export interface JobRun {
  jobId: string
  at: number // epoch ms
  durationSec: number
  status: RunStatus
  note: string
}

const RUN_NOTES: Record<string, string[]> = {
  ingest: ["3 queues · 4,812 rows merged", "3 queues · 4,633 rows merged", "3 queues · 4,921 rows merged, 2 rows quarantined"],
  forecast: ["Best models: Holt-Winters ×2, GBM ×1", "Retrained 15 models · avg MAPE 6.8%", "Retrained 15 models · avg MAPE 7.1%"],
  capacity: ["Requirements rebuilt · 3 queues × 24 intervals", "2 intervals over occupancy cap flagged", "Requirements rebuilt · no violations"],
  schedule: ["Breaks re-staggered for 12 agents · SL +1.4pp", "No reoptimisation needed", "Proposed 2h VTO on Billing (surplus)"],
  rta: ["30 agents polled · 3 exceptions applied", "30 agents polled · 1 escalation raised", "30 agents polled · all clear"],
}

function seededPick(seed: number, n: number): number {
  return (Math.imul(seed + 0x9e3779b9, 48271) >>> 8) % n
}

const CADENCE_MS: Record<string, number> = {
  ingest: 3600_000,
  forecast: 86_400_000,
  capacity: 86_400_000,
  schedule: 86_400_000,
  rta: 30_000,
}

// Real cadence compressed to something observable in a live browser tab —
// used only by the "auto-run" toggle in the Automation Center, never by the
// display-only "next run" countdown above (which shows the real-world schedule).
export const DEMO_RUN_INTERVAL_MS: Record<string, number> = {
  ingest: 60_000,
  forecast: 90_000,
  capacity: 45_000,
  schedule: 120_000,
  rta: 20_000,
}

/** Deterministic recent run history for one job (most recent first). */
export function runsFor(jobId: string, count = 6, now = Date.now()): JobRun[] {
  const cadence = CADENCE_MS[jobId] ?? 3600_000
  const notes = RUN_NOTES[jobId] ?? ["OK"]
  const out: JobRun[] = []
  for (let i = 0; i < count; i++) {
    const seed = jobId.length * 1000 + i * 97
    // one warning per ~5 runs, a single failed ingest deep in history
    const status: RunStatus = jobId === "ingest" && i === 4 ? "failed" : seededPick(seed, 5) === 3 ? "warning" : "success"
    out.push({
      jobId,
      at: now - (i + 1) * cadence - (seededPick(seed, 300) - 150) * 1000,
      durationSec: 4 + seededPick(seed + 1, 90),
      status,
      note: status === "failed" ? "ACD export timed out — retried on next run" : notes[seededPick(seed + 2, notes.length)],
    })
  }
  return out
}

export function nextRunMs(jobId: string, now = Date.now()): number {
  const cadence = CADENCE_MS[jobId] ?? 3600_000
  return now + cadence - (now % cadence)
}

export const fmtAgo = (ms: number, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export const fmtIn = (ms: number, now = Date.now()): string => {
  const s = Math.max(0, Math.round((ms - now) / 1000))
  if (s < 90) return `in ${s}s`
  if (s < 5400) return `in ${Math.round(s / 60)}m`
  return `in ${Math.round(s / 3600)}h`
}

// ---- rules engine ----

export interface AutomationRule {
  id: string
  name: string
  trigger: string
  action: string
  /** Threshold this rule reads, if configurable. */
  thresholdKey?: keyof Thresholds
  /** false = fully automated; true = proposes and waits for a human. */
  requiresApproval: boolean
  defaultEnabled: boolean
}

export const RULES: AutomationRule[] = [
  {
    id: "auto-reforecast",
    name: "Intraday auto-reforecast",
    trigger: "Actual volume deviates from forecast beyond the trigger threshold",
    action: "Regenerate the remaining-day forecast from to-date pacing and restaff",
    thresholdKey: "reforecastPct",
    requiresApproval: false,
    defaultEnabled: true,
  },
  {
    id: "variance-alert",
    name: "Forecast variance alerts",
    trigger: "An interval's actuals miss forecast beyond the variance threshold",
    action: "Raise an accuracy alert (critical at 2× threshold) and notify the forecaster",
    thresholdKey: "varianceAlertPct",
    requiresApproval: false,
    defaultEnabled: true,
  },
  {
    id: "swap-auto-approve",
    name: "Shift-swap auto-approval",
    trigger: "An agent proposes a swap whose SL impact is within tolerance",
    action: "Approve and write the exchange to the roster immediately",
    thresholdKey: "autoApproveSwapSlPp",
    requiresApproval: false,
    defaultEnabled: true,
  },
  {
    id: "pto-auto-approve",
    name: "Leave auto-approval",
    trigger: "A leave request lands on days with coverage surplus and the requester's skill group isn't already over the overlap cap",
    action: "Approve without routing to the manager queue",
    thresholdKey: "ptoOverlapCapPct",
    requiresApproval: false,
    defaultEnabled: true,
  },
  {
    id: "adherence-escalation",
    name: "Adherence escalation",
    trigger: "An agent stays out-of-adherence past the grace period",
    action: "Flag on the wallboard; escalate to the team lead after the escalation window",
    thresholdKey: "escalateMins",
    requiresApproval: false,
    defaultEnabled: true,
  },
  {
    id: "break-recovery",
    name: "AI break recovery",
    trigger: "Projected SL falls below target while deferrable breaks are running",
    action: "Recommend break recalls ranked by skill match — one-click apply",
    requiresApproval: true,
    defaultEnabled: true,
  },
  {
    id: "vto-offer",
    name: "VTO / overtime proposals",
    trigger: "Intraday net staffing shows a sustained surplus or deficit",
    action: "Propose voluntary time off (surplus) or overtime blocks (deficit) to the intraday desk",
    requiresApproval: true,
    defaultEnabled: true,
  },
]

export type RuleState = Record<string, boolean>

export const DEFAULT_RULE_STATE: RuleState = Object.fromEntries(RULES.map((r) => [r.id, r.defaultEnabled]))
