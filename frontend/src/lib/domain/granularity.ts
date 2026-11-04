// Granularity + date-range rollups over the day-level engine.
import { dayIndex, dayOfYear, dowOf, enumerateDays, fmtDay, MAX_RANGE_DAYS, monthKey, monthLabel, weekKey, weekLabel, ymd } from "./dates"
import { factorMultiplier, type ExternalFactor } from "./externalFactors"
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

/** The back-test as small steps (one model on one held-out day each), so it
 *  can run a step at a time without freezing the page (backtestGAsync). */
function* backtestSteps(queueId: string, gran: GranId, overlay?: ActualRow[]): Generator<void, BacktestG> {
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
  // Build each day's training slice once and share it across methods, so the
  // identity-keyed fit caches (LR, Prophet, ML and deep-learning fits) hit instead of refitting per method.
  const preds: number[][] = METHODS.map(() => [])
  for (let d = start; d < days.length; d++) {
    const train = days.slice(0, d), tDows = dows.slice(0, d), tDoys = doys.slice(0, d)
    for (let k = 0; k < METHODS.length; k++) {
      preds[k].push(dayTotal(METHODS[k], train, tDows, dows[d], d, tDoys, doys[d]))
      yield
    }
  }
  const perMethod = METHODS.map((m, k) => ({ id: m.id, name: m.name, kind: m.kind, mape: mape(preds[k], actual), pred: preds[k] }))
  const best = perMethod.reduce((a, b) => (b.mape < a.mape ? b : a))
  return { perMethod, best, actual, labels, unit: "contacts / day" }
}

// Finished back-tests by queue + granularity, per actuals overlay (a new
// import is a new array, so it gets fresh results).
const NO_OVERLAY: ActualRow[] = []
const backtests = new WeakMap<ActualRow[], Map<string, BacktestG>>()
const cacheFor = (overlay?: ActualRow[]) => {
  const k = overlay ?? NO_OVERLAY
  let m = backtests.get(k)
  if (!m) backtests.set(k, (m = new Map()))
  return m
}

/** A back-test already worked out, if there is one. */
export function cachedBacktest(queueId: string, gran: GranId, overlay?: ActualRow[]): BacktestG | undefined {
  return cacheFor(overlay).get(`${queueId}|${gran}`)
}

export function backtestG(queueId: string, gran: GranId, overlay?: ActualRow[]): BacktestG {
  const hit = cachedBacktest(queueId, gran, overlay)
  if (hit) return hit
  const steps = backtestSteps(queueId, gran, overlay)
  let r = steps.next()
  while (!r.done) r = steps.next()
  cacheFor(overlay).set(`${queueId}|${gran}`, r.value)
  return r.value
}

/** Same as backtestG, a step at a time between frames so the page stays
 *  responsive — the monthly back-test refits every model 14 times. */
export async function backtestGAsync(queueId: string, gran: GranId, overlay?: ActualRow[], isCancelled: () => boolean = () => false): Promise<BacktestG | null> {
  const hit = cachedBacktest(queueId, gran, overlay)
  if (hit) return hit
  const steps = backtestSteps(queueId, gran, overlay)
  let r = steps.next()
  let sliceStart = performance.now()
  while (!r.done) {
    if (performance.now() - sliceStart > 12) { // ~one frame of work, then let the page paint and handle input
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (isCancelled()) return null
      sliceStart = performance.now()
    }
    r = steps.next()
  }
  cacheFor(overlay).set(`${queueId}|${gran}`, r.value)
  return r.value
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
  factors?: ExternalFactor[],
): RangePlan {
  const dates = enumerateDays(start, end)
  const { days, dows, doys, lastDate } = historyFor(queueId, overlay)
  const m = methodById[methodId] ?? METHODS[0]

  const perDay = dates.map((date) => {
    const profile = m.fn(days, dows, dowOf(date), dayIndex(date, days.length, lastDate), doys, dayOfYear(date))
    const mult = factors?.length ? factorMultiplier(factors, queueId, ymd(date)) : 1
    const adjusted = mult === 1 ? profile : profile.map((v) => v * mult)
    const s = summarisePlan(buildPlan(adjusted, aht, queue, shrinkage, agents))
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
