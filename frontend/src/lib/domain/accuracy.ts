// Forecast-accuracy tracking: MAPE / WAPE / bias per day and week, plus
// interval-level variance alerts against a configurable threshold.
//
// The historical "forecast" for each past day is reconstructed the way a
// production system would have produced it — a weighted average of the four
// prior same-weekday totals — so the error series is honest (the synthetic
// history contains noise/seasonality the simple model cannot fully explain).
import { historyFor, type ActualRow } from "./history"

export interface AccuracyPoint {
  date: string // ISO yyyy-mm-dd
  label: string // "Jul 14"
  dow: number
  actual: number
  forecast: number
  err: number // forecast - actual (signed)
  ape: number // |err| / actual
}

export interface AccuracySummary {
  mape: number // mean of daily APEs
  wape: number // Σ|err| / Σactual (volume-weighted)
  bias: number // Σ(forecast-actual) / Σactual — positive = over-forecasting
  n: number
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const WEIGHTS = [0.4, 0.3, 0.2, 0.1] // most-recent same-DOW week weighted highest

function shortLabel(iso: string): string {
  const [, m, d] = iso.split("-").map(Number)
  return `${MONTHS[m - 1]} ${d}`
}

/** Reconstructed forecast-vs-actual series for the trailing `nDays` days. */
export function dailyAccuracy(queueId: string, nDays = 28, overlay?: ActualRow[]): AccuracyPoint[] {
  const h = historyFor(queueId, overlay)
  const totals = h.days.map((day) => day.reduce((a, b) => a + b, 0))
  const out: AccuracyPoint[] = []
  const from = Math.max(28, h.days.length - nDays)
  for (let i = from; i < h.days.length; i++) {
    let acc = 0
    let wsum = 0
    WEIGHTS.forEach((w, k) => {
      const j = i - 7 * (k + 1)
      if (j >= 0) {
        acc += w * totals[j]
        wsum += w
      }
    })
    const forecast = wsum ? Math.round(acc / wsum) : totals[i]
    const actual = totals[i]
    const err = forecast - actual
    out.push({
      date: h.dateKeys[i],
      label: shortLabel(h.dateKeys[i]),
      dow: h.dows[i],
      actual,
      forecast,
      err,
      ape: actual ? Math.abs(err) / actual : 0,
    })
  }
  return out
}

export function accuracySummary(points: AccuracyPoint[]): AccuracySummary {
  if (!points.length) return { mape: 0, wape: 0, bias: 0, n: 0 }
  const sumActual = points.reduce((a, p) => a + p.actual, 0)
  const sumAbsErr = points.reduce((a, p) => a + Math.abs(p.err), 0)
  const sumErr = points.reduce((a, p) => a + p.err, 0)
  return {
    mape: points.reduce((a, p) => a + p.ape, 0) / points.length,
    wape: sumActual ? sumAbsErr / sumActual : 0,
    bias: sumActual ? sumErr / sumActual : 0,
    n: points.length,
  }
}

export interface WeeklyAccuracyRow extends AccuracySummary {
  label: string // "w/e Jul 14"
  actual: number
  forecast: number
}

/** Roll the daily series into trailing 7-day weeks (most recent week last). */
export function weeklyAccuracy(points: AccuracyPoint[]): WeeklyAccuracyRow[] {
  const out: WeeklyAccuracyRow[] = []
  for (let end = points.length; end > 0; end -= 7) {
    const chunk = points.slice(Math.max(0, end - 7), end)
    const s = accuracySummary(chunk)
    out.unshift({
      ...s,
      label: `w/e ${chunk[chunk.length - 1].label}`,
      actual: chunk.reduce((a, p) => a + p.actual, 0),
      forecast: chunk.reduce((a, p) => a + p.forecast, 0),
    })
  }
  return out
}

export interface VarianceAlert {
  idx: number
  label: string
  forecast: number
  actual: number
  deltaPct: number // (actual - forecast) / forecast, signed
  severity: "warn" | "critical" // critical at 2× the configured threshold
}

/** Intervals so far today where actuals deviate beyond the alert threshold. */
export function intervalVarianceAlerts(
  forecast: number[],
  actuals: (number | null)[],
  nowIdx: number,
  threshold: number,
  labels: string[],
): VarianceAlert[] {
  const out: VarianceAlert[] = []
  for (let i = 0; i <= nowIdx && i < forecast.length; i++) {
    const a = actuals[i]
    const f = forecast[i]
    if (a == null || !f) continue
    const deltaPct = (a - f) / f
    if (Math.abs(deltaPct) >= threshold) {
      out.push({
        idx: i,
        label: labels[i],
        forecast: f,
        actual: a,
        deltaPct,
        severity: Math.abs(deltaPct) >= threshold * 2 ? "critical" : "warn",
      })
    }
  }
  return out.sort((x, y) => Math.abs(y.deltaPct) - Math.abs(x.deltaPct))
}
