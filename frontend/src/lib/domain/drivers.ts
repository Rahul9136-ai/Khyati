// Forecast drivers — the dependent features a contact-centre forecast moves with:
// marketing spend, active customers, orders, website traffic, billing runs, price
// changes, app releases … anything with a number per date.
//
// Each driver has a *reference level* (the level the model's history already
// reflects) and an *elasticity* (% change in the target per 1% change in the
// driver). On a date the driver's value is v, so the target is multiplied by
//
//     (v / reference) ^ elasticity
//
// and several drivers compound multiplicatively (like the events log). The target
// is either volume or AHT. Elasticity is typed in, or learned from history: the
// day-by-day deviation of volume from its usual level for that weekday is
// regressed (log–log OLS) on the driver's deviation from its reference.
import * as XLSX from "xlsx"

import { addDays, parseYMD, ymd } from "./dates"
import type { History } from "./history"
import type { Queue } from "./types"

export const DRIVER_KINDS = [
  "Marketing spend", "Active customers", "Orders / transactions", "Website traffic", "Billing cycle",
  "Price change", "App / product release", "Weather index", "Economic index", "Custom",
] as const
export type DriverKind = (typeof DRIVER_KINDS)[number]

export type DriverTarget = "volume" | "aht"
export const DRIVER_TARGETS: { id: DriverTarget; name: string }[] = [
  { id: "volume", name: "Volume" },
  { id: "aht", name: "AHT" },
]

/** A driver's value over a date range (a single day when from === to). */
export interface DriverValue {
  from: string // YYYY-MM-DD
  to: string
  value: number
}

export interface LearnedElasticity {
  elasticity: number
  r2: number
  n: number // days used
  at: number
}

export interface ForecastDriver {
  id: string
  name: string
  kind: DriverKind
  unit: string
  /** A real queue id, or "all". */
  queueId: string
  target: DriverTarget
  /** The "normal" level: the value at which the driver changes nothing. */
  reference: number
  /** % change in the target per 1% change in the driver (0.5 = +10% driver → ≈ +4.9% target). */
  elasticity: number
  elasticitySource: "manual" | "learned"
  learned?: LearnedElasticity
  /** Recorded (past) and planned (future) values; a later entry wins where ranges overlap. */
  values: DriverValue[]
  enabled: boolean
  createdAt: number
}

export type NewDriver = Omit<ForecastDriver, "id" | "createdAt">

const MIN_MULT = 0.2
const MAX_MULT = 5
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

// value lookup by date, built once per values array (the store keeps arrays stable)
const lookupCache = new WeakMap<DriverValue[], Map<string, number>>()
function lookup(values: DriverValue[]): Map<string, number> {
  let m = lookupCache.get(values)
  if (m) return m
  m = new Map()
  for (const v of values) {
    if (!Number.isFinite(v.value)) continue
    let d = parseYMD(v.from)
    const last = parseYMD(v.to < v.from ? v.from : v.to)
    for (let i = 0; d <= last && i < 1500; i++, d = addDays(d, 1)) m.set(ymd(d), v.value)
  }
  lookupCache.set(values, m)
  return m
}

/** The driver's value on a date, or undefined where none is recorded or planned. */
export function driverValueOn(d: ForecastDriver, date: string): number | undefined {
  return lookup(d.values).get(date)
}

export const appliesTo = (d: ForecastDriver, queueId: string) => d.enabled && (d.queueId === "all" || d.queueId === queueId)

/** One driver's multiplier on its target for a date (1 where it has no value). */
export function driverMultiplier(d: ForecastDriver, date: string): number {
  const v = driverValueOn(d, date)
  if (v === undefined || !(d.reference > 0) || !(v > 0) || !d.elasticity) return 1
  return clamp(Math.pow(v / d.reference, d.elasticity), MIN_MULT, MAX_MULT)
}

export interface DriverMultipliers {
  volume: number
  aht: number
}

/** Combined multipliers for one queue on one date, compounding every enabled driver. */
export function driverMultipliers(drivers: ForecastDriver[] | undefined, queueId: string, date: string): DriverMultipliers {
  let volume = 1
  let aht = 1
  if (drivers?.length) {
    for (const d of drivers) {
      if (!appliesTo(d, queueId)) continue
      const m = driverMultiplier(d, date)
      if (d.target === "aht") aht *= m
      else volume *= m
    }
  }
  return { volume: clamp(volume, MIN_MULT, MAX_MULT), aht: clamp(aht, MIN_MULT, MAX_MULT) }
}

/** Dates (within [from, to]) that have a value. */
export function datesWithValues(d: ForecastDriver, from: string, to: string): string[] {
  return [...lookup(d.values).keys()].filter((k) => k >= from && k <= to).sort()
}

/** Mean of the values recorded over the last `days` days up to `lastHistoryDate`. */
export function recentLevel(d: ForecastDriver, lastHistoryDate: string, days = 28): number | undefined {
  const from = ymd(addDays(parseYMD(lastHistoryDate), -(days - 1)))
  const vals = datesWithValues(d, from, lastHistoryDate).map((k) => lookup(d.values).get(k)!)
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined
}

/**
 * Learns the driver's elasticity on daily volume from history. For each past day
 * with a driver value: y = ln(volume / usual volume for that weekday over the
 * previous 4 weeks), x = ln(value / reference). OLS slope = elasticity.
 * Needs 14+ days with a value and a driver that actually moves.
 */
export function learnElasticity(d: ForecastDriver, history: History): LearnedElasticity | { error: string } {
  if (d.target !== "volume") return { error: "Only volume drivers can be learned — there's no AHT history to learn from." }
  if (!(d.reference > 0)) return { error: "Set a reference level above 0 first." }
  const totals = history.days.map((day) => day.reduce((a, b) => a + b, 0))
  const xs: number[] = []
  const ys: number[] = []
  history.dateKeys.forEach((key, i) => {
    const v = driverValueOn(d, key)
    if (v === undefined || !(v > 0) || !(totals[i] > 0)) return
    const prior: number[] = []
    for (let k = 1; k <= 4; k++) if (i - 7 * k >= 0) prior.push(totals[i - 7 * k])
    if (prior.length < 2) return
    const usual = prior.reduce((a, b) => a + b, 0) / prior.length
    if (!(usual > 0)) return
    xs.push(Math.log(v / d.reference))
    ys.push(Math.log(totals[i] / usual))
  })
  const n = xs.length
  if (n < 14) return { error: `Needs at least 14 past days with a value (found ${n}). Import the driver's history first.` }
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxx = 0, sxy = 0, syy = 0
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2
    sxy += (xs[i] - mx) * (ys[i] - my)
    syy += (ys[i] - my) ** 2
  }
  if (sxx < 1e-6) return { error: "The driver barely moves in history, so its effect can't be measured — type an elasticity instead." }
  const elasticity = clamp(sxy / sxx, -3, 3)
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0
  return { elasticity: Math.round(elasticity * 1000) / 1000, r2, n, at: Date.now() }
}

/** Every date (ascending) in [from, to] as YYYY-MM-DD, capped. */
function rangeKeys(from: string, to: string, cap = 1500): string[] {
  const out: string[] = []
  for (let d = parseYMD(from), last = parseYMD(to); d <= last && out.length < cap; d = addDays(d, 1)) out.push(ymd(d))
  return out
}

/** Plans a value over a range, with an optional growth from `value` to `endValue` (linear). */
export function planValues(from: string, to: string, value: number, endValue?: number): DriverValue[] {
  if (endValue === undefined || endValue === value || from === to) return [{ from, to, value }]
  const keys = rangeKeys(from, to)
  return keys.map((k, i) => ({ from: k, to: k, value: value + ((endValue - value) * i) / Math.max(1, keys.length - 1) }))
}

// ---- import / template ----

function toISODate(v: unknown): string | null {
  if (v == null || v === "") return null
  if (v instanceof Date) return ymd(v)
  if (typeof v === "number") {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86_400_000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
  }
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const p = new Date(s)
  return isNaN(p.getTime()) ? null : ymd(p)
}

const norm = (k: string) => k.toLowerCase().replace(/[^a-z]/g, "")
const RESERVED = new Set(["date", "day", "queue", "lob", "skill"])

export interface ParsedDriverSeries {
  name: string
  queueId: string
  values: DriverValue[]
}

export interface ParseDriversResult {
  series: ParsedDriverSeries[]
  errors: string[]
}

/**
 * Reads a wide sheet: a Date column, an optional Queue column, then one numeric
 * column per driver (any header becomes the driver's name). Past rows are the
 * driver's recorded history (used to learn its effect); future rows are the plan.
 */
export async function parseDriversFile(file: File, queues: Queue[]): Promise<ParseDriversResult> {
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" })
  const errors: string[] = []
  if (!raw.length) return { series: [], errors: ["The sheet is empty."] }

  const headers = Object.keys(raw[0])
  const dateKey = headers.find((h) => ["date", "day"].includes(norm(h)))
  if (!dateKey) return { series: [], errors: ['No "Date" column found.'] }
  const queueKey = headers.find((h) => ["queue", "lob", "skill"].includes(norm(h)))
  const driverKeys = headers.filter((h) => !RESERVED.has(norm(h)) && h.trim() && !h.startsWith("__EMPTY"))
  if (!driverKeys.length) return { series: [], errors: ["No driver columns found — add one numeric column per driver next to Date."] }

  const byKey = new Map<string, ParsedDriverSeries>()
  raw.forEach((row, i) => {
    const date = toISODate(row[dateKey])
    if (!date) return void errors.push(`Row ${i + 2}: invalid date`)
    let queueId = "all"
    if (queueKey) {
      const cell = String(row[queueKey] ?? "").trim().toLowerCase()
      if (cell && cell !== "all") {
        const q = queues.find((x) => x.id === cell || x.name.toLowerCase() === cell)
        if (!q) return void errors.push(`Row ${i + 2}: unknown queue "${cell}"`)
        queueId = q.id
      }
    }
    for (const h of driverKeys) {
      const cell = row[h]
      if (cell === "" || cell == null) continue
      const value = Number(String(cell).replace(/[,%\s]/g, ""))
      if (!Number.isFinite(value)) {
        errors.push(`Row ${i + 2}: "${h}" is not a number`)
        continue
      }
      const k = `${h.trim()}|${queueId}`
      let s = byKey.get(k)
      if (!s) byKey.set(k, (s = { name: h.trim(), queueId, values: [] }))
      s.values.push({ from: date, to: date, value })
    }
  })
  for (const s of byKey.values()) s.values.sort((a, b) => (a.from < b.from ? -1 : 1))
  return { series: [...byKey.values()], errors }
}

export function downloadDriversTemplate(lastHistoryDate: Date) {
  const rows: Record<string, unknown>[] = []
  for (let k = -27; k <= 14; k++) {
    const d = addDays(lastHistoryDate, k)
    const dow = d.getDay()
    rows.push({
      Date: ymd(d),
      Queue: "all",
      "Marketing spend": Math.round(12000 + (k > 0 ? 3000 : 0) + (dow === 1 ? 1500 : 0)),
      "Active customers": Math.round(250000 + k * 180),
      "Website traffic": Math.round(42000 * (dow === 0 || dow === 6 ? 0.7 : 1)),
    })
  }
  const ws = XLSX.utils.json_to_sheet(rows)
  ws["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 16 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "Forecast Drivers")
  XLSX.writeFile(wb, "wfm-forecast-drivers-template.xlsx")
}
