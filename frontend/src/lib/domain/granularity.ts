// Date-range forecasting over the day-level engine: one period (start → end),
// every target (volume, AHT, required hours / FTE, scheduled hours, over/under,
// service level, occupancy), with external events and forecast drivers applied.
// The row size follows the period's length: days up to a month, then weeks, then months.
import { dayIndex, dayOfYear, dowOf, enumerateDays, fmtDay, MAX_RANGE_DAYS, monthKey, monthLabel, weekKey, weekLabel, ymd } from "./dates"
import { driverMultipliers, type ForecastDriver } from "./drivers"
import { factorMultiplier, type ExternalFactor } from "./externalFactors"
import { METHODS, mape, methodById } from "./forecast"
import { type ActualRow, historyFor } from "./history"
import { buildPlan, summarisePlan } from "./planning"
import type { Agent, BucketRow, MethodResult, Queue } from "./types"

/** Paid hours one FTE covers per day (for Required FTE). */
export const HOURS_PER_FTE_DAY = 8

export type Bucket = "day" | "week" | "month"
/** Row size for a period: daily up to 31 days, weekly up to ~4 months, then monthly. */
export const bucketFor = (nDays: number): Bucket => (nDays <= 31 ? "day" : nDays <= 120 ? "week" : "month")

/** Back-test holdout: the last 7 days for a short period, else the last 14. */
export const backtestWindowFor = (nDays: number): 7 | 14 => (nDays <= 7 ? 7 : 14)

const DOW_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)

export interface BacktestG {
  perMethod: MethodResult[]
  best: MethodResult
  actual: number[]
  labels: string[]
  /** ISO date of each held-out day, aligned with `actual`. */
  dates: string[]
  unit: string
  window: number
}

/** The back-test as small steps (one model on one held-out day each), so it
 *  can run a step at a time without freezing the page (backtestGAsync). */
function* backtestSteps(queueId: string, window: number, overlay?: ActualRow[]): Generator<void, BacktestG> {
  const { days, dows, doys, dateKeys } = historyFor(queueId, overlay)
  const start = days.length - window
  const actual: number[] = []
  const labels: string[] = []
  const dates: string[] = []
  for (let d = start; d < days.length; d++) {
    actual.push(sum(days[d]))
    labels.push(`${DOW_NAME[dows[d]]} ${dateKeys[d].slice(8)}`)
    dates.push(dateKeys[d])
  }
  // Build each day's training slice once and share it across methods, so the
  // identity-keyed fit caches (LR, Prophet, ML and deep-learning fits) hit instead of refitting per method.
  const preds: number[][] = METHODS.map(() => [])
  for (let d = start; d < days.length; d++) {
    const train = days.slice(0, d), tDows = dows.slice(0, d), tDoys = doys.slice(0, d)
    for (let k = 0; k < METHODS.length; k++) {
      preds[k].push(sum(METHODS[k].fn(train, tDows, dows[d], d, tDoys, doys[d])))
      yield
    }
  }
  const perMethod = METHODS.map((m, k) => ({ id: m.id, name: m.name, kind: m.kind, mape: mape(preds[k], actual), pred: preds[k] }))
  const best = perMethod.reduce((a, b) => (b.mape < a.mape ? b : a))
  return { perMethod, best, actual, labels, dates, unit: "contacts / day", window }
}

// Finished back-tests by queue + window, per actuals overlay (a new import is a
// new array, so it gets fresh results).
const NO_OVERLAY: ActualRow[] = []
const backtests = new WeakMap<ActualRow[], Map<string, BacktestG>>()
const cacheFor = (overlay?: ActualRow[]) => {
  const k = overlay ?? NO_OVERLAY
  let m = backtests.get(k)
  if (!m) backtests.set(k, (m = new Map()))
  return m
}

/** A back-test already worked out, if there is one. */
export function cachedBacktest(queueId: string, window: number, overlay?: ActualRow[]): BacktestG | undefined {
  return cacheFor(overlay).get(`${queueId}|${window}`)
}

export function backtestG(queueId: string, window: number, overlay?: ActualRow[]): BacktestG {
  const hit = cachedBacktest(queueId, window, overlay)
  if (hit) return hit
  const steps = backtestSteps(queueId, window, overlay)
  let r = steps.next()
  while (!r.done) r = steps.next()
  cacheFor(overlay).set(`${queueId}|${window}`, r.value)
  return r.value
}

/** Same as backtestG, a step at a time between frames so the page stays responsive. */
export async function backtestGAsync(queueId: string, window: number, overlay?: ActualRow[], isCancelled: () => boolean = () => false): Promise<BacktestG | null> {
  const hit = cachedBacktest(queueId, window, overlay)
  if (hit) return hit
  const steps = backtestSteps(queueId, window, overlay)
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
  cacheFor(overlay).set(`${queueId}|${window}`, r.value)
  return r.value
}

/** Held-out predictions with the drivers/events recorded on those days applied,
 *  and the MAPE that gives — shows whether the drivers actually reduce error. */
export function adjustedBacktest(
  bt: BacktestG, method: MethodResult, queueId: string, factors?: ExternalFactor[], drivers?: ForecastDriver[],
): { pred: number[]; mape: number; changed: boolean } {
  let changed = false
  const pred = method.pred.map((p, i) => {
    const key = bt.dates[i]
    const m = (factors?.length ? factorMultiplier(factors, queueId, key) : 1) * driverMultipliers(drivers, queueId, key).volume
    if (m !== 1) changed = true
    return p * m
  })
  return { pred, mape: changed ? mape(pred, bt.actual) : method.mape, changed }
}

export function dayProfile(queueId: string, date: Date, methodId: string, overlay?: ActualRow[]): number[] {
  const { days, dows, doys, lastDate } = historyFor(queueId, overlay)
  const m = methodById[methodId] ?? METHODS[0]
  return m.fn(days, dows, dowOf(date), dayIndex(date, days.length, lastDate), doys, dayOfYear(date))
}

/** Every forecast target for one day (or a bucket of days). */
export interface TargetValues {
  volume: number
  aht: number // seconds, volume-weighted
  required: number // agent-hours incl. shrinkage
  fte: number // average FTE needed per day
  scheduled: number // agent-hours
  variance: number // scheduled − required (hours)
  projSL: number // 0..1, volume-weighted
  occupancy: number // 0..1, volume-weighted
}

export interface ForecastDay extends TargetValues {
  date: string
  /** Multipliers applied on this day: events × volume drivers, and AHT drivers. */
  eventMult: number
  volumeDriverMult: number
  ahtDriverMult: number
}

export interface ForecastRow extends BucketRow, TargetValues {
  days: number
}

export interface RangePlan {
  rows: ForecastRow[]
  days: ForecastDay[]
  totals: TargetValues
  unit: string
  bucket: Bucket
  nDays: number
  truncated: boolean
}

export interface RangePlanInput {
  queue: Queue
  start: Date
  end: Date
  methodId: string
  shrinkage: number
  agents: Agent[]
  overlay?: ActualRow[]
  factors?: ExternalFactor[]
  drivers?: ForecastDriver[]
}

function rollup(label: string, items: ForecastDay[]): ForecastRow {
  const volume = sum(items.map((p) => p.volume))
  const required = sum(items.map((p) => p.required))
  const scheduled = sum(items.map((p) => p.scheduled))
  const w = (k: "aht" | "projSL" | "occupancy") =>
    volume ? sum(items.map((p) => p[k] * p.volume)) / volume : items.length ? sum(items.map((p) => p[k])) / items.length : 0
  return {
    label,
    days: items.length,
    volume,
    aht: Math.round(w("aht")),
    required: Math.round(required),
    fte: Math.round((required / HOURS_PER_FTE_DAY / Math.max(1, items.length)) * 10) / 10,
    scheduled: Math.round(scheduled),
    variance: Math.round(scheduled - required),
    projSL: w("projSL"),
    occupancy: w("occupancy"),
  }
}

export function rangePlan(inp: RangePlanInput): RangePlan {
  const { queue, start, end, methodId, shrinkage, agents, overlay, factors, drivers } = inp
  const dates = enumerateDays(start, end)
  const { days, dows, doys, lastDate } = historyFor(queue.id, overlay)
  const m = methodById[methodId] ?? METHODS[0]

  const perDay: ForecastDay[] = dates.map((date) => {
    const key = ymd(date)
    const profile = m.fn(days, dows, dowOf(date), dayIndex(date, days.length, lastDate), doys, dayOfYear(date))
    const eventMult = factors?.length ? factorMultiplier(factors, queue.id, key) : 1
    const dm = driverMultipliers(drivers, queue.id, key)
    const mult = eventMult * dm.volume
    const adjusted = mult === 1 ? profile : profile.map((v) => v * mult)
    const aht = queue.aht * dm.aht
    const plan = buildPlan(adjusted, aht, queue, shrinkage, agents)
    const s = summarisePlan(plan)
    const occ = s.totalVol ? sum(plan.map((p) => p.occupancy * p.volume)) / s.totalVol : s.avgOcc
    return {
      date: key,
      volume: s.totalVol,
      aht: Math.round(aht),
      required: s.reqHours,
      fte: s.reqHours / HOURS_PER_FTE_DAY,
      scheduled: s.schedHours,
      variance: s.schedHours - s.reqHours,
      projSL: s.wSL,
      occupancy: occ,
      eventMult,
      volumeDriverMult: dm.volume,
      ahtDriverMult: dm.aht,
    }
  })

  const bucket = bucketFor(dates.length)
  const keyFn = bucket === "month" ? monthKey : bucket === "week" ? weekKey : ymd
  const labelFn = bucket === "month" ? monthLabel : bucket === "week" ? weekLabel : fmtDay
  const groups = new Map<string, { label: string; items: ForecastDay[] }>()
  perDay.forEach((p, i) => {
    const k = keyFn(dates[i])
    if (!groups.has(k)) groups.set(k, { label: labelFn(dates[i]), items: [] })
    groups.get(k)!.items.push(p)
  })
  const rows = [...groups.values()].map((g) => rollup(g.label, g.items))
  const t = rollup("Total", perDay)

  return { rows, days: perDay, totals: t, unit: "agent-hrs", bucket, nDays: dates.length, truncated: dates.length >= MAX_RANGE_DAYS }
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
