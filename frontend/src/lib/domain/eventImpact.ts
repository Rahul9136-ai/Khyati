// Connects the events log (externalFactors.ts) to Forecasting and to the staffing
// requirement: for a date range (past, future, or straddling today) and a queue
// scope, this re-plans the same day-by-day pipeline Forecasting/Reports use twice —
// once with the logged events applied, once without — so a chart can show exactly
// where they raise or lower volume, and the agent-hours required to cover it.
import { fmtShort } from "./dates"
import type { ReportInputs } from "@/lib/report-granularity"
import { planRange } from "@/lib/report-granularity"

export interface ImpactPoint {
  date: string // ISO
  label: string
  baselineVolume: number
  adjustedVolume: number
  baselineReqHours: number
  adjustedReqHours: number
}

export interface ImpactSummary {
  points: ImpactPoint[]
  totalBaselineVolume: number
  totalAdjustedVolume: number
  totalBaselineReqHours: number
  totalAdjustedReqHours: number
}

function emptyPoint(date: string, label: string): ImpactPoint {
  return { date, label, baselineVolume: 0, adjustedVolume: 0, baselineReqHours: 0, adjustedReqHours: 0 }
}

/** Baseline (no events) vs adjusted (logged events applied), day by day, summed
 *  across every queue in scope. `queueId` is a real queue id or "all". */
export function eventImpactTimeline(inputs: ReportInputs, start: Date, end: Date, queueId: string): ImpactSummary {
  const scoped = queueId === "all" ? inputs.queues : inputs.queues.filter((q) => q.id === queueId)
  const scopedInputs = { ...inputs, queues: scoped }
  const adjusted = planRange(scopedInputs, start, end)
  const baseline = planRange({ ...scopedInputs, externalFactors: [] }, start, end)

  const byDate = new Map<string, ImpactPoint>()
  for (const item of baseline) {
    const p = byDate.get(item.key) ?? emptyPoint(item.key, fmtShort(item.date))
    p.baselineVolume += item.sum.totalVol
    p.baselineReqHours += item.sum.reqHours
    byDate.set(item.key, p)
  }
  for (const item of adjusted) {
    const p = byDate.get(item.key) ?? emptyPoint(item.key, fmtShort(item.date))
    p.adjustedVolume += item.sum.totalVol
    p.adjustedReqHours += item.sum.reqHours
    byDate.set(item.key, p)
  }

  const points = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const total = (k: "baselineVolume" | "adjustedVolume" | "baselineReqHours" | "adjustedReqHours") =>
    points.reduce((a, p) => a + p[k], 0)
  return {
    points,
    totalBaselineVolume: total("baselineVolume"),
    totalAdjustedVolume: total("adjustedVolume"),
    totalBaselineReqHours: total("baselineReqHours"),
    totalAdjustedReqHours: total("adjustedReqHours"),
  }
}
