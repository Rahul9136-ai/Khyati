// Country labour-law presets for scheduling + a day-level compliance check.
// Presets live in labourLaws.json (a byte-identical copy is in the backend at
// app/modules/scheduling/labour_laws.json, enforced by a backend test), and the
// check here mirrors backend app/modules/scheduling/labour_law.py.
//
// Only rules decidable from a single day are checked; weekly limits and rest
// between days are shown for reference.
import data from "./labourLaws.json"
import type { AgentDay } from "./channels"

export interface BreakRule {
  /** Applies when worked time exceeds this many hours. */
  afterHours: number
  /** Required break minutes (total, or one uninterrupted break if `continuous`). */
  minBreakMinutes: number
  continuous: boolean
}

export interface LabourLaw {
  code: string
  name: string
  source: string
  /** Hours after which daily work counts as overtime. */
  standardDailyHours: number | null
  /** Maximum worked hours in a day, including overtime. */
  maxDailyHours: number | null
  maxDailyOtHours: number | null
  /** Maximum from first start to last finish (incl. breaks). */
  maxSpreadHours: number | null
  /** Longest allowed stretch of work without a qualifying break. */
  maxContinuousWorkHours: number | null
  /** Breaks shorter than this don't count (null = any break counts). */
  minBreakBlockMinutes: number | null
  breakRules: BreakRule[]
  standardWeeklyHours: number | null
  maxWeeklyHours: number | null
  minDailyRestHours: number | null
  notes: string
}

export type LawOverrides = Partial<Omit<LabourLaw, "code" | "name" | "source" | "notes">>

export const LABOUR_LAW_DISCLAIMER: string = data.disclaimer
export const LABOUR_LAWS: LabourLaw[] = data.laws as LabourLaw[]
export const LABOUR_LAW_BY_CODE: Record<string, LabourLaw> = Object.fromEntries(LABOUR_LAWS.map((l) => [l.code, l]))

/** The preset for `code` with any local overrides applied (null = none selected). */
export function effectiveLaw(code: string | null, overrides: LawOverrides = {}): LabourLaw | null {
  const base = code ? LABOUR_LAW_BY_CODE[code] : undefined
  return base ? { ...base, ...overrides } : null
}

export type ComplianceRule =
  | "maxDailyHours"
  | "maxDailyOtHours"
  | "maxSpreadHours"
  | "breakRules"
  | "maxContinuousWorkHours"

export interface ComplianceIssue {
  rule: ComplianceRule
  message: string
}

/** "7h30" / "8h" — same format as the backend. */
export function fmtDuration(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`
}

type Span = { start: number; end: number }

function subtract(pieces: Span[], cuts: Span[]): Span[] {
  let out = pieces
  for (const c of cuts) {
    out = out.flatMap((p) => {
      if (c.end <= p.start || c.start >= p.end) return [p]
      const r: Span[] = []
      if (c.start > p.start) r.push({ start: p.start, end: c.start })
      if (c.end < p.end) r.push({ start: c.end, end: p.end })
      return r
    })
  }
  return out.sort((a, b) => a.start - b.start)
}

const NOT_WORKING = new Set(["loa", "absence", "vto", "pto", "leave", "off"])

/** Worked time: shift + OT, minus breaks/lunch and LOA/absence (meetings etc. are work). */
function workPieces(day: AgentDay): Span[] {
  const off: Span[] = [...day.breaks, ...day.activities.filter((a) => NOT_WORKING.has(a.type))]
  return subtract([{ start: day.shift[0], end: day.shift[1] }, ...day.ot], off)
}
export const workedMinutes = (day: AgentDay) => workPieces(day).reduce((t, w) => t + w.end - w.start, 0)

/** Check one agent's day against a law. Empty list = compliant (for daily rules). */
export function checkCompliance(day: AgentDay, law: LabourLaw): ComplianceIssue[] {
  const [s, e] = day.shift
  const work = workPieces(day)
  const worked = work.reduce((t, w) => t + w.end - w.start, 0)
  if (worked <= 0) return []

  const minBlock = law.minBreakBlockMinutes ?? 0
  const qualifying = day.breaks.filter((b) => b.end - b.start >= minBlock && b.start >= s && b.end <= e)
  const breakTotal = qualifying.reduce((t, b) => t + b.end - b.start, 0)
  const longestBreak = Math.max(0, ...qualifying.map((b) => b.end - b.start))
  const issues: ComplianceIssue[] = []

  if (law.maxDailyHours != null && worked > law.maxDailyHours * 60) {
    issues.push({ rule: "maxDailyHours", message: `Works ${fmtDuration(worked)} — max ${fmtDuration(law.maxDailyHours * 60)} a day` })
  }
  if (law.maxDailyOtHours != null) {
    const otBlocks = day.ot.reduce((t, o) => t + o.end - o.start, 0)
    const ot = Math.max(otBlocks, law.standardDailyHours != null ? worked - law.standardDailyHours * 60 : 0)
    if (ot > law.maxDailyOtHours * 60) {
      issues.push({ rule: "maxDailyOtHours", message: `${fmtDuration(ot)} overtime — max ${fmtDuration(law.maxDailyOtHours * 60)} a day` })
    }
  }
  if (law.maxSpreadHours != null) {
    const spread = work[work.length - 1].end - work[0].start
    if (spread > law.maxSpreadHours * 60) {
      issues.push({ rule: "maxSpreadHours", message: `Working day spans ${fmtDuration(spread)} — max ${fmtDuration(law.maxSpreadHours * 60)}` })
    }
  }
  // Strictest applicable rule of each kind (total vs one uninterrupted break).
  for (const continuous of [false, true]) {
    const applicable = law.breakRules
      .filter((r) => r.continuous === continuous && worked > r.afterHours * 60)
      .sort((a, b) => b.minBreakMinutes - a.minBreakMinutes)[0]
    if (!applicable) continue
    const have = continuous ? longestBreak : breakTotal
    if (have < applicable.minBreakMinutes) {
      issues.push({
        rule: "breakRules",
        message: continuous
          ? `Needs one break of ≥${applicable.minBreakMinutes} min after ${fmtDuration(applicable.afterHours * 60)} worked — longest is ${have} min`
          : `Needs ≥${applicable.minBreakMinutes} min of breaks after ${fmtDuration(applicable.afterHours * 60)} worked — has ${have} min`,
      })
    }
  }
  if (law.maxContinuousWorkHours != null) {
    // Wall-clock stretches between qualifying breaks / time off; short breaks don't reset it.
    const stretches = subtract(work.length ? [{ start: work[0].start, end: work[work.length - 1].end }] : [], [
      ...qualifying,
      ...day.activities.filter((a) => NOT_WORKING.has(a.type)),
      ...gaps(work).filter((g) => !day.breaks.some((b) => b.start < g.end && b.end > g.start)),
    ])
    const longest = Math.max(0, ...stretches.map((x) => x.end - x.start))
    if (longest > law.maxContinuousWorkHours * 60) {
      issues.push({
        rule: "maxContinuousWorkHours",
        message: `Works ${fmtDuration(longest)} without a qualifying break — max ${fmtDuration(law.maxContinuousWorkHours * 60)}`,
      })
    }
  }
  return issues
}

/** Gaps between work pieces that aren't breaks (e.g. between shift and OT) — they reset the clock too. */
function gaps(work: Span[]): Span[] {
  const out: Span[] = []
  for (let i = 1; i < work.length; i++) if (work[i].start > work[i - 1].end) out.push({ start: work[i - 1].end, end: work[i].start })
  return out
}
