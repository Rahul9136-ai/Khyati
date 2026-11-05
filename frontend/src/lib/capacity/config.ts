// Open decisions (build prompt §7) as switches. Every default reproduces the
// workbook's current behaviour; anything beyond §7 that we had to decide is
// listed in ADDITIONAL_DECISIONS so it's visible, not silent.

export type BillTreatment = "transaction" | "fte" | "hourly" | "exclude"

export interface CapacityConfig {
  /** P13 / Q6 — SNP %. */
  snpPct: number
  /** Q1 — how each BILL_TYPE turns into Base FTE. Unknown types use classifyBillType(). */
  billTypeTreatment: Record<string, BillTreatment>
  /** Q1 — hours per working day for `Hourly FTE` (Units ÷ (W.days × hours)). */
  hoursPerDay: number
  /** Q2 — Glide Path "A" value. null = no actual source, use Budgeted Glide % only. */
  glideActualPct: number | null
  /** Q3 — QCA Attrition HC = Actual QA × SNP (sheet) or × Attrition %. */
  qcaAttritionMode: "snp" | "attrition"
  /** Q4 — ramp production from Peak × Ramp Grid % (live) or a flat units/day (sheet: 15). */
  rampMode: "grid" | "flat"
  rampFlatUnitsPerDay: number
  /** Q5 — sampling from the Sampling Grid (live) or a flat % (sheet: 18%). */
  samplingMode: "grid" | "flat"
  samplingFlatPct: number
  /** Q6 — Volume Based shrinkage: 1 − P5 (MIN of B, A), or B / A only. */
  volumeShrinkageSource: "min" | "budget" | "actual"
  /** Q7 — months with no budget row carry the last budget month forward (flagged). */
  carryForwardBudget: boolean
  /** A1 — a key whose transaction task has no peak target: blank the key (strict) or drop just that task. */
  missingPeakMode: "blank-key" | "exclude-task"
  /** A2 — Volume Based forecast: P1 units as-is (spec V1 = P1) or FTE-billed tasks converted to equivalent volume. */
  volumeForecastBasis: "units" | "equivalent"
  /** §4.4 — Capacity % colour thresholds. */
  thresholdLow: number
  thresholdHigh: number
}

export function classifyBillType(billType: string): BillTreatment {
  const k = billType.trim().toUpperCase()
  if (k.includes("ADDITIONAL BILLING")) return "exclude"
  if (k === "HOURLY FTE") return "hourly"
  if (k === "FLAT FTE" || k === "FTE SLAB BASED" || (k.includes("FTE") && !k.includes("TRANSACTION"))) return "fte"
  return "transaction"
}

export const DEFAULT_CONFIG: CapacityConfig = {
  snpPct: 0.2,
  billTypeTreatment: {
    "Transaction based - Hourly TAT": "transaction",
    "Transaction based - Days TAT": "transaction",
    "Transaction Slab based": "transaction",
    "Flat FTE": "fte",
    "FTE Slab Based": "fte",
    "Hourly FTE": "hourly",
    "Additional Billing - Flat Rate": "exclude",
  },
  hoursPerDay: 8,
  glideActualPct: null,
  qcaAttritionMode: "snp",
  rampMode: "grid",
  rampFlatUnitsPerDay: 15,
  samplingMode: "grid",
  samplingFlatPct: 0.18,
  volumeShrinkageSource: "min",
  carryForwardBudget: true,
  missingPeakMode: "blank-key",
  volumeForecastBasis: "units",
  thresholdLow: 0.95,
  thresholdHigh: 1.05,
}

export function treatmentFor(cfg: CapacityConfig, billType: string): BillTreatment {
  const exact = cfg.billTypeTreatment[billType]
  if (exact) return exact
  const ci = Object.entries(cfg.billTypeTreatment).find(([k]) => k.trim().toUpperCase() === billType.trim().toUpperCase())
  return ci ? ci[1] : classifyBillType(billType)
}

export interface SwitchDoc {
  id: string
  key: keyof CapacityConfig
  question: string
  defaultText: string
  status: "open" | "assumed"
}

export const SWITCH_DOCS: SwitchDoc[] = [
  { id: "Q1", key: "billTypeTreatment", status: "open",
    question: "How is Base FTE computed per BILL_TYPE?",
    defaultText: "Transaction types: Volume ÷ W.days ÷ Peak. Flat FTE / FTE Slab Based: Units = Base FTE. Hourly FTE: Units ÷ (W.days × 8). Additional Billing - Flat Rate: excluded." },
  { id: "Q2", key: "glideActualPct", status: "open",
    question: "There is no Actual Glide Path sheet — where does Glide A come from?",
    defaultText: "No actual source: Glide % = Budgeted Glide Buffer % only. A manual A value can be entered." },
  { id: "Q3", key: "qcaAttritionMode", status: "open",
    question: "QCA Attrition HC uses SNP (=I10*I12) while Production uses Attrition % (=C16*C17). Intended?",
    defaultText: "Replicate the sheet: Actual QA × SNP %. Switch to Actual QA × Attrition %." },
  { id: "Q4", key: "rampMode", status: "open",
    question: "Ramp productivity is hard-coded at 15 units/day in the sheet.",
    defaultText: "Live data: Peak Target × Ramp Grid Week-n %. Golden test / flat mode: 15 units/day." },
  { id: "Q5", key: "samplingMode", status: "open",
    question: "Sampling % is hard-coded at 18%, while the Sampling Grid BAU is 15%.",
    defaultText: "Live data: Sampling Grid (week column for ramp users, BAU otherwise). Golden test / flat mode: 18%." },
  { id: "Q6", key: "volumeShrinkageSource", status: "open",
    question: "Volume Based shrinkage: the sheet uses 94% = 1 − 6% (the MIN shrinkage).",
    defaultText: "1 − P5 (lower of Budgeted and Actual)." },
  { id: "Q7", key: "carryForwardBudget", status: "open",
    question: "Months with no budget (Jan'27–Aug'27).",
    defaultText: "Carry the last budget month (Dec'26) forward, and flag those rows." },
  { id: "A1", key: "missingPeakMode", status: "assumed",
    question: "A transaction task with no peak target (TaskNo not in Target Details, or Peak = 0).",
    defaultText: "Strict: Base FTE for that Customer × SL × Location × Month is blank (not 0, not ∞) and flagged. Alternative: drop only that task." },
  { id: "A2", key: "volumeForecastBasis", status: "assumed",
    question: "Volume Based uses V1 = P1, which adds FTE-billed units (e.g. 6 FTE) to transaction volumes.",
    defaultText: "As written (V1 = P1). Alternative: convert FTE-billed tasks to equivalent volume (Base FTE × Peak × W.days)." },
]

/** Decisions the spec doesn't cover. Fixed behaviour, documented in the UI and the final report. */
export const ADDITIONAL_DECISIONS: string[] = [
  "Peak Target at Customer × SL × Location level (for BAU / ramp production and VA HC) = volume-weighted: Σ Volume ÷ Σ (Volume ÷ Peak) over transaction tasks, so it reproduces summed Base FTE. With no volume in the month, the simple average of the key's task peaks is used.",
  "Peak Target QCA and Ramp Grid % at key level = volume-weighted average of the key's tasks (simple average when the month has no volume).",
  "Ramp week of a user in a month = floor((1st of month − Date of Production) ÷ 7) + 1. Users whose production starts later in (or after) the month count as week 1. Weeks 1–16 are ramp; later weeks are BAU.",
  "Ramp user type comes from Designation Type (Job Name → User Type). Only Trainee and Lateral users are ramp users (V3/V4); users with no Date of Production, or a Job Name not in Designation Type, are treated as BAU and flagged.",
  "Sampling Grid lookup: (User Type, Customer, Service Line, Specialty). Users that aren't Trainee use the Lateral grid. Week-1…12 for ramp weeks 1–12, BAU for later weeks. A key-level Sampling % is the production-weighted average of its users. No grid match → flat % (18%) and flagged.",
  "Missing Budgeted / Actual values in MIN(B, A) / MAX(B, A): the value that exists is used; when neither exists the component is 0 and the key is flagged in Data Exceptions.",
  "Budgeted Attrition has no Prod/QCA split, so the same budgeted % is used as B for both Production (P12) and QCA (Q5).",
  "Hiring additions are counted only in their Due to delivery month (not cumulative), exactly as P15/P16 read. Due months outside the Working Days horizon are flagged and not added.",
  "Actual HC / Actual QA are today's roster counts and are the same in every month.",
  "Rows are created for every Customer × SL × Location found in Forecast, User Mapping or Hiring, so roster and hiring totals reconcile even where there is no forecast (Req = 0 → Capacity blank).",
]
