// Reports at four granularities — interval, day, week, month — over a date range.
//
// Every day in the range is planned per queue once (`planRange`), using the same
// pipeline as the Forecasting page: the queue's applied forecast model, external
// factors, the current roster and shrinkage. The interval view is that plan as-is;
// day / week / month roll it up.
import {
  dowOf, enumerateDays, fmtDay, monthKey, monthLabel, TODAY, weekKey, weekLabel, ymd,
} from "@/lib/domain/dates"
import { factorMultiplier, type ExternalFactor } from "@/lib/domain/externalFactors"
import { backtest, methodById } from "@/lib/domain/forecast"
import { dayProfile } from "@/lib/domain/granularity"
import type { ActualRow } from "@/lib/domain/history"
import { buildPlan, summarisePlan } from "@/lib/domain/planning"
import { INTERVALS } from "@/lib/domain/seed"
import type { Agent, PlanRow, PlanSummary, Queue } from "@/lib/domain/types"
import type { Row } from "@/lib/export"

export const REPORT_GRANULARITIES = [
  { id: "interval", name: "Interval", sub: "every 30-min interval" },
  { id: "day", name: "Day", sub: "one row per day" },
  { id: "week", name: "Week", sub: "Mon–Sun buckets" },
  { id: "month", name: "Month", sub: "calendar months" },
] as const
export type ReportGran = (typeof REPORT_GRANULARITIES)[number]["id"]
export const ALL_GRANULARITIES: ReportGran[] = REPORT_GRANULARITIES.map((g) => g.id)

export const GRAN_SHEET: Record<ReportGran, string> = {
  interval: "Interval Requirement",
  day: "Daily Summary",
  week: "Weekly Summary",
  month: "Monthly Summary",
}

export interface ReportInputs {
  forecasts: Record<string, number[]>
  forecastMethod: Record<string, string>
  importedActuals: Record<string, ActualRow[]>
  externalFactors: ExternalFactor[]
  shrinkage: number
  agents: Agent[]
  queues: Queue[]
}

/** One queue's full interval plan for one day. */
export interface QueueDay {
  date: Date
  key: string // ISO date
  queue: Queue
  plan: PlanRow[]
  sum: PlanSummary
}

const DOW3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const ALL_QUEUES = "All queues"
const pct = (x: number) => Math.round(x * 1000) / 10 // 0.8734 → 87.3
const r1 = (x: number) => Math.round(x * 10) / 10

export function planRange(inp: ReportInputs, start: Date, end: Date): QueueDay[] {
  const dates = enumerateDays(start, end)
  const todayKey = ymd(TODAY)

  // the model each queue's forecast is on; queues on a manual/baseline forecast use the best back-tested model
  const methodOf: Record<string, string> = {}
  for (const q of inp.queues) {
    const applied = inp.forecastMethod[q.id]
    methodOf[q.id] = methodById[applied] ? applied : backtest(q.id, inp.importedActuals[q.id]).best.id
  }

  const out: QueueDay[] = []
  for (const date of dates) {
    const key = ymd(date)
    for (const q of inp.queues) {
      // today = the applied (possibly hand-edited / reforecast) plan; later days = the model's forecast
      const base = key === todayKey && inp.forecasts[q.id]
        ? inp.forecasts[q.id]
        : dayProfile(q.id, date, methodOf[q.id], inp.importedActuals[q.id])
      const mult = inp.externalFactors.length ? factorMultiplier(inp.externalFactors, q.id, key) : 1
      const volume = mult === 1 ? base : base.map((v) => Math.round(v * mult))
      const plan = buildPlan(volume, q.aht, q, inp.shrinkage, inp.agents)
      out.push({ date, key, queue: q, plan, sum: summarisePlan(plan) })
    }
  }
  return out
}

// ---------- aggregation ----------
interface Agg {
  volume: number
  reqHrs: number
  schedHrs: number
  slw: number // Σ SL × volume
  under: number
  occSum: number
  occN: number
  days: Set<string>
  from: string
  to: string
}

function aggregate(items: QueueDay[]): Agg {
  const a: Agg = { volume: 0, reqHrs: 0, schedHrs: 0, slw: 0, under: 0, occSum: 0, occN: 0, days: new Set(), from: "", to: "" }
  for (const { key, sum } of items) {
    a.volume += sum.totalVol
    a.reqHrs += sum.reqHours
    a.schedHrs += sum.schedHours
    a.slw += sum.wSL * sum.totalVol
    a.under += sum.underIntervals
    a.occSum += sum.avgOcc
    a.occN++
    a.days.add(key)
    if (!a.from || key < a.from) a.from = key
    if (!a.to || key > a.to) a.to = key
  }
  return a
}

const aggSL = (a: Agg) => (a.volume ? a.slw / a.volume : 0)
const aggOcc = (a: Agg) => (a.occN ? a.occSum / a.occN : 0)

/** Centre-wide totals over a range (used by the KPI cards and the Centre KPIs sheet). */
export function centreTotals(items: QueueDay[]) {
  const a = aggregate(items)
  return { volume: a.volume, sl: aggSL(a), reqHrs: a.reqHrs, schedHrs: a.schedHrs, days: a.days.size }
}

/** Per-queue totals over a range, in queue order. */
export function queueTotals(items: QueueDay[], queues: Queue[]) {
  return queues.map((q) => {
    const a = aggregate(items.filter((i) => i.queue.id === q.id))
    return { queue: q, volume: a.volume, sl: aggSL(a), reqHrs: a.reqHrs, schedHrs: a.schedHrs, under: a.under, occ: aggOcc(a) }
  })
}

// ---------- interval ----------
export function intervalRows(items: QueueDay[]): Row[] {
  const rows: Row[] = []
  for (const group of groupBy(items, (i) => i.key)) {
    const { date, key } = group[0]
    const day = DOW3[dowOf(date)]
    for (const { queue, plan } of group) {
      for (const p of plan) {
        rows.push({
          Date: key, Day: day, Queue: queue.name, Interval: p.label,
          Volume: p.volume,
          "Required (net)": p.requiredNet, "Required (gross)": p.requiredGross,
          Scheduled: p.scheduled, Variance: p.variance,
          "Proj. SL %": pct(p.projSL),
          "ASA (s)": Number.isFinite(p.asa) ? Math.round(p.asa) : "",
          "Occupancy %": pct(p.occupancy),
        })
      }
    }
    // centre-wide rows: headcount and volume add up across queues
    INTERVALS.forEach((_, i) => {
      const cells = group.map((g) => g.plan[i])
      const vol = cells.reduce((a, c) => a + c.volume, 0)
      rows.push({
        Date: key, Day: day, Queue: ALL_QUEUES, Interval: cells[0].label,
        Volume: vol,
        "Required (net)": cells.reduce((a, c) => a + c.requiredNet, 0),
        "Required (gross)": cells.reduce((a, c) => a + c.requiredGross, 0),
        Scheduled: cells.reduce((a, c) => a + c.scheduled, 0),
        Variance: cells.reduce((a, c) => a + c.variance, 0),
        "Proj. SL %": pct(vol ? cells.reduce((a, c) => a + c.projSL * c.volume, 0) / vol : 0),
        "ASA (s)": "",
        "Occupancy %": pct(cells.reduce((a, c) => a + c.occupancy, 0) / cells.length),
      })
    })
  }
  return rows
}

// ---------- day / week / month ----------
const bucketKey = (gran: "day" | "week" | "month", d: Date, key: string) =>
  gran === "day" ? key : gran === "week" ? weekKey(d) : monthKey(d)
const bucketLabel = (gran: "day" | "week" | "month", d: Date, key: string) =>
  gran === "day" ? key : gran === "week" ? weekLabel(d) : monthLabel(d)

function summaryRow(gran: "day" | "week" | "month", first: QueueDay, a: Agg, queue: string, slTarget: number | null, peak: string): Row {
  const period: Row =
    gran === "day"
      ? { Date: first.key, Day: DOW3[dowOf(first.date)] }
      : { Period: bucketLabel(gran, first.date, first.key), From: a.from, To: a.to, Days: a.days.size }
  return {
    ...period,
    Queue: queue,
    Volume: a.volume,
    ...(gran === "day" ? {} : { "Avg daily volume": Math.round(a.volume / Math.max(1, a.days.size)) }),
    "Service Level %": pct(aggSL(a)),
    "SL Target %": slTarget === null ? "" : pct(slTarget),
    "Required hrs": r1(a.reqHrs),
    "Scheduled hrs": r1(a.schedHrs),
    "Variance hrs": r1(a.schedHrs - a.reqHrs),
    "Schedule efficiency %": pct(a.reqHrs / Math.max(1e-9, a.schedHrs)),
    "Under-staffed intervals": a.under,
    "Avg occupancy %": pct(aggOcc(a)),
    ...(gran === "day" ? { "Peak interval": peak } : {}),
  }
}

export function summaryRows(items: QueueDay[], queues: Queue[], gran: "day" | "week" | "month"): Row[] {
  const rows: Row[] = []
  for (const bucket of groupBy(items, (i) => bucketKey(gran, i.date, i.key))) {
    for (const q of queues) {
      const mine = bucket.filter((i) => i.queue.id === q.id)
      if (!mine.length) continue
      rows.push(summaryRow(gran, mine[0], aggregate(mine), q.name, q.slTarget, INTERVALS[mine[0].sum.peakIdx]?.label ?? ""))
    }
    // busiest interval of the summed-across-queues day (only meaningful for the day view)
    const total = INTERVALS.map((_, i) => bucket.reduce((s, b) => s + b.plan[i].volume, 0))
    const peak = INTERVALS[total.indexOf(Math.max(...total))]?.label ?? ""
    rows.push(summaryRow(gran, bucket[0], aggregate(bucket), ALL_QUEUES, null, peak))
  }
  return rows
}

export function granularRows(items: QueueDay[], queues: Queue[], gran: ReportGran): Row[] {
  return gran === "interval" ? intervalRows(items) : summaryRows(items, queues, gran)
}

// ---------- chart ----------
export interface CoverageChart {
  data: { label: string; Required: number; Scheduled: number }[]
  title: string
  unit: string
}

export function coverageChart(items: QueueDay[], gran: ReportGran): CoverageChart {
  if (gran === "interval") {
    const nDays = Math.max(1, new Set(items.map((i) => i.key)).size)
    return {
      title: "Centre coverage by interval — required vs scheduled",
      unit: nDays > 1 ? `agents (avg of ${nDays} days)` : "agents",
      data: INTERVALS.map((iv, i) => ({
        label: iv.label,
        Required: r1(items.reduce((a, x) => a + x.plan[i].requiredGross, 0) / nDays),
        Scheduled: r1(items.reduce((a, x) => a + x.plan[i].scheduled, 0) / nDays),
      })),
    }
  }
  return {
    title: `Centre coverage by ${gran} — required vs scheduled`,
    unit: "agent-hours",
    data: groupBy(items, (i) => bucketKey(gran, i.date, i.key)).map((g) => {
      const a = aggregate(g)
      return {
        label: gran === "day" ? fmtDay(g[0].date) : bucketLabel(gran, g[0].date, g[0].key),
        Required: r1(a.reqHrs),
        Scheduled: r1(a.schedHrs),
      }
    }),
  }
}

// Group preserving first-seen order.
function groupBy<T>(items: T[], key: (t: T) => string): T[][] {
  const m = new Map<string, T[]>()
  for (const it of items) {
    const k = key(it)
    const g = m.get(k)
    if (g) g.push(it)
    else m.set(k, [it])
  }
  return [...m.values()]
}
