import { api } from "@/lib/api"

/** HC Planning (AGS Health CP) API client + types. */

export interface Lob {
  id: string
  name: string
}

export interface PlanningConfig {
  id?: string
  lob_id?: string | null
  ooo_shrinkage: number
  io_shrinkage: number
  attrition: number
  weekly_hours: number
  hiring_throughput: number
  training_throughput: number
  actuals_through: string | null
  tenure_bands: unknown[]
  monthly_overrides: Record<string, unknown>
  closing_overrides: Record<string, number>
}

export interface MonthResult {
  month: string
  billable_fte: number
  required_hc: number
  production_agents: number
  fte_ramp: number
  closing_hc: number
  closing_overridden: boolean
  capacity_pct: number | null
  excess_deficit: number
  ot_vto_hours: number
  fte: number
  ramp: number
  notice_period: number
  ojt: number
  investment_bench: number
  ops_bench: number
  training: number
  long_leave: number
  maternity_leave: number
  overall_utilization: number | null
  productive_utilization: number | null
  buffer_pct: number | null
  headcount_vs_billable: number
  req_hc_vs_actual: number
  fresher_lt_1yr: number
  lateral_gt_1yr: number
}

export interface CapacityTable {
  lob_id: string | null
  lob_name: string | null
  months: string[]
  results: MonthResult[]
  config: PlanningConfig
  agent_count: number
}

export interface DemandRow {
  month: string
  billable_fte: number
  locked: boolean
}

export async function listLobs(): Promise<Lob[]> {
  const res = await api.get("/org/lobs")
  const d = res.data.data
  return (Array.isArray(d) ? d : d.items) as Lob[]
}

export async function getCapacity(lobId: string, from?: string, to?: string) {
  const res = await api.get("/hc-planning/capacity", {
    params: { lob_id: lobId, from, to },
  })
  return res.data.data as CapacityTable
}

export async function getConfig(lobId?: string) {
  const res = await api.get("/hc-planning/config", { params: { lob_id: lobId } })
  return res.data.data as PlanningConfig
}

export async function updateConfig(patch: Partial<PlanningConfig> & { lob_id?: string | null }) {
  const res = await api.put("/hc-planning/config", patch)
  return res.data.data as PlanningConfig
}

export async function getDemand(lobId?: string) {
  const res = await api.get("/hc-planning/demand", { params: { lob_id: lobId } })
  return res.data.data as DemandRow[]
}

export async function updateDemand(lobId: string, items: { month: string; billable_fte: number }[]) {
  const res = await api.put("/hc-planning/demand", { lob_id: lobId, items })
  return res.data.data as DemandRow[]
}

/** Format a YYYY-MM month key as e.g. "Jan-26". */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number)
  const d = new Date(y, m - 1, 1)
  return d.toLocaleString(undefined, { month: "short", year: "2-digit" }).replace(" ", "-")
}

export const CATEGORY_ROWS: { field: keyof MonthResult; label: string; kind: "calc" | "edit" }[] = [
  { field: "billable_fte", label: "Billable FTE (Req)", kind: "edit" },
  { field: "required_hc", label: "Required HC", kind: "calc" },
  { field: "production_agents", label: "Production Agents", kind: "calc" },
  { field: "fte_ramp", label: "FTE + Ramp", kind: "calc" },
  { field: "closing_hc", label: "Closing HC", kind: "edit" },
  { field: "capacity_pct", label: "Capacity %", kind: "calc" },
  { field: "excess_deficit", label: "Excess / Deficit", kind: "calc" },
  { field: "ot_vto_hours", label: "OT / VTO Hours", kind: "calc" },
]

export const BREAKDOWN_ROWS: { field: keyof MonthResult; label: string }[] = [
  { field: "fte", label: "FTE" },
  { field: "ramp", label: "Ramp" },
  { field: "notice_period", label: "Notice Period" },
  { field: "ojt", label: "OJT" },
  { field: "maternity_leave", label: "Maternity Leave" },
]

/** Human-readable calculation notes for the "how is this calculated?" tooltips. */
export const FORMULA_NOTES: Partial<Record<keyof MonthResult, string>> = {
  required_hc: "Billable FTE / ((1 − OOO Shrinkage) × (1 − IO Shrinkage))",
  production_agents: "Sum of FTE, Ramp, Notice, OJT, Bench, Training, Leave",
  fte_ramp: "Actuals: roster FTE+Ramp. Projected: prev × (1 − attrition) + new-hire production",
  closing_hc: "= FTE + Ramp (editable — override to pin a value)",
  capacity_pct: "Closing HC / Required HC",
  excess_deficit: "Closing HC − Required HC",
  ot_vto_hours: "Excess/Deficit × weekly hours (40)",
}
