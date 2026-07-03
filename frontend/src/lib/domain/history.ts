// Synthetic historical interval data the forecasting models train on, with
// support for real imported actuals layered on top.
//
// ~3 years (1,110 days) per queue so the models have real long-range structure to
// learn: multi-year trend + annual (day-of-year) seasonality + weekly seasonality
// + intraday shape + a holiday dip + noise. Deterministic (seeded) and memoised so
// the large series is generated only once per queue.
//
// Imported actuals (see lib/actuals.ts) are daily-total rows keyed by ISO date.
// They are merged on top of the synthetic base: a date that already exists is
// overwritten with the real number (ground truth beats the synthetic estimate);
// a date beyond the current last entry is appended, extending the training
// window — and the "last known day" (the anchor forward forecasts start from)
// moves forward to match.
import { addDays, dayOfYear, daysBetween, dowOf, TODAY, ymd } from "./dates"
import { PEAKS, SHAPE } from "./seed"

function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Mon-heavy, weekend-light weekly multipliers (index by weekday, 0=Sun … 6=Sat).
const DOW_FACTOR = [0.62, 1.06, 1.0, 0.99, 1.03, 0.94, 0.7]

const ANNUAL_GROWTH = 0.09 // ~9% organic growth per year
const ANNUAL_AMP = 0.13 // seasonal swing amplitude
const ANNUAL_PEAK_DOY = 320 // peak demand mid-November (pre-holiday)
const TWO_PI = Math.PI * 2

export const HISTORY_DAYS = 1110 // ~3 years + a margin (synthetic base length)
const SUM_SHAPE = SHAPE.reduce((a, b) => a + b, 0)

// Annual seasonality multiplier for a given day-of-year (peaks in Q4, dips ~July).
function annualFactor(doy: number): number {
  return 1 + ANNUAL_AMP * Math.cos((TWO_PI * (doy - ANNUAL_PEAK_DOY)) / 365)
}

// Holiday effect: sharp dip over the year-end break, small new-year recovery.
function holidayFactor(doy: number): number {
  if (doy >= 358 || doy <= 1) return 0.6 // 24 Dec – 1 Jan shutdown
  if (doy >= 350 && doy < 358) return 0.85 // wind-down week
  return 1
}

// One imported actual: a real daily-total contact volume for a calendar date.
export interface ActualRow {
  date: string // ISO yyyy-mm-dd
  volume: number
}

export interface History {
  days: number[][] // [day][interval] contact volume, chronological
  dows: number[] // weekday per day
  doys: number[] // day-of-year per day
  dateKeys: string[] // ISO date per day, aligned with days/dows/doys
  lastDate: Date // calendar date of the final entry — the forward-forecast anchor
}

// Spread a real daily total across the day using the standard intraday shape.
export function distributeDaily(volume: number): number[] {
  return SHAPE.map((s) => Math.max(0, Math.round((volume * s) / SUM_SHAPE)))
}

const baseCache = new Map<string, History>()

function baseHistoryFor(queueId: string): History {
  const hit = baseCache.get(queueId)
  if (hit) return hit

  const peak = PEAKS[queueId] ?? 40
  const rnd = mulberry32(queueId.split("").reduce((a, c) => a + c.charCodeAt(0), 7))
  const days: number[][] = []
  const dows: number[] = []
  const doys: number[] = []
  const dateKeys: string[] = []

  for (let d = 0; d < HISTORY_DAYS; d++) {
    // day d's calendar date — the last entry (d = HISTORY_DAYS-1) is TODAY-1.
    const date = addDays(TODAY, -(HISTORY_DAYS - d))
    const dow = dowOf(date)
    const doy = dayOfYear(date)
    const trend = 1 + (d / 365) * ANNUAL_GROWTH
    const seasonal = DOW_FACTOR[dow] * annualFactor(doy) * holidayFactor(doy)
    const day = SHAPE.map((s) => {
      const noise = 1 + (rnd() - 0.5) * 0.14 // ±7% interval noise
      return Math.max(0, Math.round(peak * s * seasonal * trend * noise))
    })
    days.push(day)
    dows.push(dow)
    doys.push(doy)
    dateKeys.push(ymd(date))
  }

  const result: History = { days, dows, doys, dateKeys, lastDate: addDays(TODAY, -1) }
  baseCache.set(queueId, result)
  return result
}

// Merge cache keyed by queueId → last overlay array *reference* seen. Zustand
// keeps the persisted overlay array stable until it actually changes, so a
// simple reference check avoids re-merging (and re-fitting downstream models)
// on every render.
const mergedCache = new Map<string, { overlayRef: ActualRow[]; result: History }>()

export function historyFor(queueId: string, overlay?: ActualRow[]): History {
  const base = baseHistoryFor(queueId)
  if (!overlay || overlay.length === 0) return base

  const hit = mergedCache.get(queueId)
  if (hit && hit.overlayRef === overlay) return hit.result

  const map = new Map<string, number[]>()
  base.dateKeys.forEach((k, i) => map.set(k, base.days[i]))
  for (const row of overlay) map.set(row.date, distributeDaily(row.volume))

  const dateKeys = [...map.keys()].sort() // ISO strings sort chronologically
  const days = dateKeys.map((k) => map.get(k)!)
  const dows: number[] = []
  const doys: number[] = []
  let lastDate = base.lastDate
  dateKeys.forEach((k) => {
    const [y, m, d] = k.split("-").map(Number)
    const date = new Date(y, m - 1, d)
    dows.push(dowOf(date))
    doys.push(dayOfYear(date))
    if (date > lastDate) lastDate = date
  })

  const result: History = { days, dows, doys, dateKeys, lastDate }
  mergedCache.set(queueId, { overlayRef: overlay, result })
  return result
}

// How many *new* calendar days an overlay adds beyond the synthetic base's
// last day (TODAY-1) — i.e. how far the training window has been extended.
export function daysAppendedBeyondBase(queueId: string, overlay?: ActualRow[]): number {
  if (!overlay || overlay.length === 0) return 0
  const base = baseHistoryFor(queueId)
  return Math.max(0, daysBetween(base.lastDate, historyFor(queueId, overlay).lastDate))
}
