// Granularity + date-range rollups over the day-level engine.
import { dayIndex, dayOfYear, dowOf, enumerateDays, fmtDay, MAX_RANGE_DAYS, monthKey, monthLabel, weekKey, weekLabel } from "./dates"
import { METHODS, mape, methodById } from "./forecast"
import { type ActualRow, historyFor } from "./history"
import { buildPlan, summarisePlan } from "./planning"
import { INTERVALS } from "./seed"
import type { Agent, BucketRow, MethodResult, Queue } from "./types"

export const GRANULARITIES = [
  { id: "daily", name: "Daily", sub: "one day · 30-min intervals" },
  { id: "weekly", name: "Weekly", sub: "per-day buckets" },
  { id: "monthly", name: "Monthly", sub: "per-week / month buckets" },
] as const
export type GranId = (typeof GRANULARITIES)[number]["id"]

const DOW_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
const dayTotal = (
  m: (typeof METHODS)[number], days: number[][], dows: number[], dow: number, idx: number,
  doys: number[], doy: number,
) => sum(m.fn(days, dows, dow, idx, doys, doy))

export interface BacktestG {
  perMethod: MethodResult[]
  best: MethodResult
  actual: number[]
  labels: string[]
  unit: string
  holdoutDow?: number
}

export function backtestG(queueId: string, gran: GranId, overlay?: ActualRow[]): BacktestG {
  const { days, dows, doys } = historyFor(queueId, overlay)

  if (gran === "daily") {
    const L = days.length - 1
    const train = days.slice(0, L)
    const tdows = dows.slice(0, L)
    const tdoys = doys.slice(0, L)
    const actual = days[L]
    const perMethod = METHODS.map((m) => {
      const pred = m.fn(train, tdows, dows[L], L, tdoys, doys[L])
      return { id: m.id, name: m.name, kind: m.kind, mape: mape(pred, actual), pred }
    })
    const best = perMethod.reduce((a, b) => (b.mape < a.mape ? b : a))
    return { perMethod, best, actual, labels: INTERVALS.map((i) => i.label), unit: "contacts / interval", holdoutDow: dows[L] }
  }

  const window = gran === "weekly" ? 7 : 14
  const start = days.length - window
  const actual: number[] = []
  const labels: string[] = []
  for (let d = start; d < days.length; d++) {
    actual.push(sum(days[d]))
    labels.push(DOW_NAME[dows[d]])
  }
  const perMethod = METHODS.map((m) => {
    const pred: number[] = []
    for (let d = start; d < days.length; d++) {
      pred.push(dayTotal(m, days.slice(0, d), dows.slice(0, d), dows[d], d, doys.slice(0, d), doys[d]))
    }
    return { id: m.id, name: m.name, kind: m.kind, mape: mape(pred, actual), pred }
  })
  const best = perMethod.reduce((a, b) => (b.mape < a.mape ? b : a))
  return { perMethod, best, actual, labels, unit: "contacts / day" }
}

export function dayProfile(queueId: string, date: Date, methodId: string, overlay?: ActualRow[]): number[] {
  const { days, dows, doys, lastDate } = historyFor(queueId, overlay)
  const m = methodById[methodId] ?? METHODS[0]
  return m.fn(days, dows, dowOf(date), dayIndex(date, days.length, lastDate), doys, dayOfYear(date))
}

export interface RangePlan {
  rows: BucketRow[]
  unit: string
  bucket: "day" | "week" | "month"
  nDays: number
  truncated: boolean
}

export function rangePlan(
  queueId: string,
  start: Date,
  end: Date,
  gran: GranId,
  methodId: string,
  aht: number,
  queue: Queue,
  shrinkage: number,
  agents: Agent[],
  overlay?: ActualRow[],
): RangePlan {
  const dates = enumerateDays(start, end)
  const { days, dows, doys, lastDate } = historyFor(queueId, overlay)
  const m = methodById[methodId] ?? METHODS[0]

  const perDay = dates.map((date) => {
    const profile = m.fn(days, dows, dowOf(date), dayIndex(date, days.length, lastDate), doys, dayOfYear(date))
    const s = summarisePlan(buildPlan(profile, aht, queue, shrinkage, agents))
    return { date, volume: s.totalVol, reqH: s.reqHours, schedH: s.schedHours, wSL: s.wSL }
  })

  const keyFn = gran === "monthly" ? monthKey : gran === "weekly" ? weekKey : (d: Date) => String(d.getTime())
  const labelFn = gran === "monthly" ? monthLabel : gran === "weekly" ? weekLabel : fmtDay
  const groups = new Map<string, { label: string; volume: number; reqH: number; schedH: number; slw: number }>()
  perDay.forEach((p) => {
    const k = keyFn(p.date)
    if (!groups.has(k)) groups.set(k, { label: labelFn(p.date), volume: 0, reqH: 0, schedH: 0, slw: 0 })
    const g = groups.get(k)!
    g.volume += p.volume
    g.reqH += p.reqH
    g.schedH += p.schedH
    g.slw += p.wSL * p.volume
  })

  const rows: BucketRow[] = [...groups.values()].map((g) => ({
    label: g.label,
    volume: g.volume,
    required: Math.round(g.reqH),
    scheduled: Math.round(g.schedH),
    variance: Math.round(g.schedH - g.reqH),
    projSL: g.volume ? g.slw / g.volume : 0,
  }))

  const bucket = gran === "monthly" ? "month" : gran === "weekly" ? "week" : "day"
  return { rows, unit: "agent-hrs", bucket, nDays: dates.length, truncated: dates.length >= MAX_RANGE_DAYS }
}

export interface BucketSummary {
  totalVol: number
  wSL: number
  under: number
  over: number
  peakLabel?: string
  worst: BucketRow | null
}

export function summariseBuckets(rows: BucketRow[]): BucketSummary {
  const totalVol = sum(rows.map((r) => r.volume))
  const wSL = totalVol ? sum(rows.map((r) => r.projSL * r.volume)) / totalVol : 0
  const under = rows.filter((r) => r.variance < 0)
  const over = rows.filter((r) => r.variance > 0)
  const peak = rows.reduce((a, r, i) => (r.volume > rows[a].volume ? i : a), 0)
  const worst = under.reduce<BucketRow | null>((a, r) => (!a || r.variance < a.variance ? r : a), null)
  return { totalVol, wSL, under: under.length, over: over.length, peakLabel: rows[peak]?.label, worst }
}
