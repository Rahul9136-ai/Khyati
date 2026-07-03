// Forecasting engine — statistical + ML methods, back-tested with MAPE.
// Trains on ~3 years of history (see history.ts). The ML models use intraday,
// weekly AND annual (day-of-year) seasonality features so the long history pays off.
import { addDays, dayOfYear, dowOf } from "./dates"
import { type ActualRow, historyFor } from "./history"
import type { ForecastMethod, MethodResult } from "./types"

const M = 24
const TWO_PI = Math.PI * 2

function intervalFeatures(i: number): number[] {
  return [
    Math.sin((TWO_PI * i) / M), Math.cos((TWO_PI * i) / M),
    Math.sin((2 * TWO_PI * i) / M), Math.cos((2 * TWO_PI * i) / M),
  ]
}
function dowFeatures(dow: number): number[] {
  // weighted a little heavier so weekday similarity dominates
  return [1.4 * Math.sin((TWO_PI * dow) / 7), 1.4 * Math.cos((TWO_PI * dow) / 7)]
}
function doyFeatures(doy: number): number[] {
  return [
    Math.sin((TWO_PI * doy) / 365), Math.cos((TWO_PI * doy) / 365),
    Math.sin((2 * TWO_PI * doy) / 365), Math.cos((2 * TWO_PI * doy) / 365),
  ]
}

// ---- statistical ----
function seasonalNaive(days: number[][], dows: number[], targetDow: number): number[] {
  for (let d = days.length - 1; d >= 0; d--) if (dows[d] === targetDow) return days[d].slice()
  return days[days.length - 1].slice()
}

function movingAverage(days: number[][], dows: number[], targetDow: number): number[] {
  const K = 6 // last 6 matching-weekday days → reflects the current annual phase
  const sameDow = days.filter((_, d) => dows[d] === targetDow)
  const pool = (sameDow.length >= 2 ? sameDow : days).slice(-K)
  return Array.from({ length: M }, (_, i) => Math.round(pool.reduce((a, day) => a + day[i], 0) / pool.length))
}

function holtWinters(days: number[][], dows: number[], targetDow: number): number[] {
  const alpha = 0.4, beta = 0.04, gamma = 0.3
  // train on the last ~26 weeks only — keeps it responsive to the current level/season
  const recent = days.slice(-182)
  const Y = recent.flat()
  const n = Y.length
  if (n < 2 * M) return movingAverage(days, dows, targetDow)
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length
  let level = mean(Y.slice(0, M))
  let trend = (mean(Y.slice(M, 2 * M)) - mean(Y.slice(0, M))) / M
  const seasonal = Y.slice(0, M).map((y) => y - level)
  for (let t = M; t < n; t++) {
    const s = seasonal[t % M]
    const newLevel = alpha * (Y[t] - s) + (1 - alpha) * (level + trend)
    trend = beta * (newLevel - level) + (1 - beta) * trend
    seasonal[t % M] = gamma * (Y[t] - newLevel) + (1 - gamma) * s
    level = newLevel
  }
  return Array.from({ length: M }, (_, h) => Math.max(0, Math.round(level + (h + 1) * trend + seasonal[h % M])))
}

// ---- ML: linear regression (OLS) ----
function gaussianSolve(A: number[][], b: number[]): number[] {
  const n = b.length
  const m = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r
    ;[m[col], m[piv]] = [m[piv], m[col]]
    const d = m[col][col] || 1e-9
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = m[r][col] / d
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c]
    }
  }
  return m.map((row, i) => row[n] / (m[i][i] || 1e-9))
}

// Precompute the intraday feature rows once (shared across every fit).
const IF: number[][] = Array.from({ length: M }, (_, i) => intervalFeatures(i))
const P = 12 // [1, 4 interval, 2 dow, 4 doy, 1 trend]

// Cache the fitted weights by training-array identity. historyFor returns stable
// references, so range/forward forecasts (same full history) fit once and reuse.
const lrCache = new WeakMap<number[][], number[]>()

function linearRegression(
  days: number[][], dows: number[], targetDow: number, targetDayIdx: number,
  doys?: number[], targetDoy?: number,
): number[] {
  const dy = doys ?? days.map((_, d) => d)
  const tDoy = targetDoy ?? 0
  let w = lrCache.get(days)
  if (!w) {
    // day-level feature segment (dow + doy + trend) — allocate per day, not per row
    const DP = days.map((_, d) => [...dowFeatures(dows[d]), ...doyFeatures(dy[d]), d / days.length])
    const XtX = Array.from({ length: P }, () => new Array(P).fill(0))
    const Xty = new Array(P).fill(0)
    const row = new Array(P)
    for (let d = 0; d < days.length; d++) {
      const dp = DP[d]
      const day = days[d]
      for (let i = 0; i < M; i++) {
        const f = IF[i]
        row[0] = 1
        row[1] = f[0]; row[2] = f[1]; row[3] = f[2]; row[4] = f[3]
        row[5] = dp[0]; row[6] = dp[1]; row[7] = dp[2]; row[8] = dp[3]; row[9] = dp[4]; row[10] = dp[5]; row[11] = dp[6]
        const yv = day[i]
        for (let a = 0; a < P; a++) {
          Xty[a] += row[a] * yv
          for (let b = a; b < P; b++) XtX[a][b] += row[a] * row[b]
        }
      }
    }
    for (let a = 0; a < P; a++) {
      for (let b = 0; b < a; b++) XtX[a][b] = XtX[b][a]
      XtX[a][a] += 1e-3
    }
    w = gaussianSolve(XtX, Xty)
    lrCache.set(days, w)
  }
  const dn = targetDayIdx / days.length
  const td = dowFeatures(targetDow)
  const ty = doyFeatures(tDoy)
  return Array.from({ length: M }, (_, i) => {
    const f = IF[i]
    const r = [1, f[0], f[1], f[2], f[3], td[0], td[1], ty[0], ty[1], ty[2], ty[3], dn]
    let s = 0
    for (let k = 0; k < P; k++) s += r[k] * w![k]
    return Math.max(0, Math.round(s))
  })
}

// ---- ML: k-NN — average the K nearest same-weekday days by time-of-year + trend ----
function knn(
  days: number[][], dows: number[], targetDow: number, targetDayIdx: number,
  doys?: number[], targetDoy?: number,
): number[] {
  const K = 8
  const dy = doys ?? days.map((_, d) => d)
  const tDoy = targetDoy ?? 0
  // hard-filter to the same weekday (fall back to all if too few)
  let cand: number[] = []
  for (let d = 0; d < days.length; d++) if (dows[d] === targetDow) cand.push(d)
  if (cand.length < K) cand = days.map((_, d) => d)

  const q = doyFeatures(tDoy)
  const qt = targetDayIdx / days.length
  const best: { d: number; dist: number }[] = []
  let worst = Infinity
  for (const d of cand) {
    const f = doyFeatures(dy[d])
    let dist = (d / days.length - qt) ** 2 * 0.6
    for (let k = 0; k < 4; k++) dist += (f[k] - q[k]) ** 2
    if (best.length < K) {
      best.push({ d, dist })
      if (best.length === K) worst = Math.max(...best.map((b) => b.dist))
    } else if (dist < worst) {
      let mi = 0
      for (let j = 1; j < K; j++) if (best[j].dist > best[mi].dist) mi = j
      best[mi] = { d, dist }
      worst = Math.max(...best.map((b) => b.dist))
    }
  }
  return Array.from({ length: M }, (_, i) => Math.round(best.reduce((a, b) => a + days[b.d][i], 0) / best.length))
}

// ---------- SARIMA (approx) ----------
// Seasonal ARIMA on the weekly-seasonal sub-series: for each interval we take the
// same-weekday history and fit ARIMA(1,1,0) — first difference + AR(1) — so trend
// and short-term autocorrelation carry into the forecast. (Weekly seasonality is
// handled by the same-weekday subsetting; a TS stand-in for statsmodels SARIMAX.)
function sarima(days: number[][], dows: number[], targetDow: number): number[] {
  const idx: number[] = []
  for (let d = 0; d < days.length; d++) if (dows[d] === targetDow) idx.push(d)
  const src = idx.length >= 4 ? idx : days.map((_, d) => d)
  return Array.from({ length: M }, (_, i) => {
    const v = src.map((d) => days[d][i])
    const k = v.length
    if (k < 3) return v[k - 1] ?? 0
    const diff: number[] = []
    for (let t = 1; t < k; t++) diff.push(v[t] - v[t - 1])
    const mean = diff.reduce((a, b) => a + b, 0) / diff.length
    let num = 0, den = 0
    for (let t = 1; t < diff.length; t++) {
      num += (diff[t] - mean) * (diff[t - 1] - mean)
      den += (diff[t - 1] - mean) ** 2
    }
    const phi = den ? Math.max(-0.9, Math.min(0.9, num / den)) : 0
    const dHat = mean + phi * (diff[diff.length - 1] - mean)
    return Math.max(0, Math.round(v[k - 1] + dHat))
  })
}

// ---------- Prophet (approx) ----------
// Additive/decomposition model like Prophet: piecewise level + linear trend on
// daily totals × weekly factor × yearly (day-of-year bucket) factor, distributed
// across the day by the average intraday shape. Cached per training set.
interface ProphetFit {
  intercept: number
  slope: number
  weekly: number[] // by weekday
  yearly: number[] // by ~monthly doy bucket (12)
  shape: number[] // normalised intraday profile (sums to 1)
}
const prophetCache = new WeakMap<number[][], ProphetFit>()
const doyBucket = (doy: number) => Math.min(11, Math.floor((doy - 1) / 30.5))

function prophet(
  days: number[][], dows: number[], targetDow: number, targetDayIdx: number,
  doys?: number[], targetDoy?: number,
): number[] {
  const dy = doys ?? days.map(() => 1)
  let fit = prophetCache.get(days)
  if (!fit) {
    const totals = days.map((day) => day.reduce((a, b) => a + b, 0))
    const overall = totals.reduce((a, b) => a + b, 0) / totals.length || 1
    // OLS linear trend on day index
    let sx = 0, sy = 0, sxx = 0, sxy = 0
    totals.forEach((y, x) => { sx += x; sy += y; sxx += x * x; sxy += x * y })
    const n = totals.length
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1)
    const intercept = (sy - slope * sx) / n
    // weekly + yearly multiplicative factors (ratio to overall mean)
    const wSum = new Array(7).fill(0), wCnt = new Array(7).fill(0)
    const ySum = new Array(12).fill(0), yCnt = new Array(12).fill(0)
    const shapeAcc = new Array(M).fill(0)
    let shapeDays = 0
    totals.forEach((tot, d) => {
      wSum[dows[d]] += tot; wCnt[dows[d]]++
      const b = doyBucket(dy[d]); ySum[b] += tot; yCnt[b]++
      if (tot > 0) { for (let i = 0; i < M; i++) shapeAcc[i] += days[d][i] / tot; shapeDays++ }
    })
    const weekly = wSum.map((s, k) => (wCnt[k] ? s / wCnt[k] / overall : 1))
    const yearly = ySum.map((s, k) => (yCnt[k] ? s / yCnt[k] / overall : 1))
    const shape = shapeAcc.map((s) => (shapeDays ? s / shapeDays : 1 / M))
    fit = { intercept, slope, weekly, yearly, shape }
    prophetCache.set(days, fit)
  }
  const baseTrend = fit.intercept + fit.slope * (targetDayIdx ?? days.length)
  const dayTotal = Math.max(0, baseTrend) * (fit.weekly[targetDow] ?? 1) * (fit.yearly[doyBucket(targetDoy ?? 1)] ?? 1)
  return fit.shape.map((s) => Math.max(0, Math.round(dayTotal * s)))
}

export const METHODS: ForecastMethod[] = [
  { id: "snaive", name: "Seasonal Naïve", kind: "Statistical", fn: seasonalNaive },
  { id: "movavg", name: "Moving Average", kind: "Statistical", fn: movingAverage },
  { id: "holt", name: "Holt-Winters", kind: "Statistical", fn: holtWinters },
  { id: "sarima", name: "SARIMA", kind: "Statistical", fn: sarima },
  { id: "prophet", name: "Prophet", kind: "ML", fn: prophet },
  { id: "linreg", name: "Linear Regression", kind: "ML", fn: linearRegression },
  { id: "knn", name: "k-NN Regression", kind: "ML", fn: knn },
]
export const methodById: Record<string, ForecastMethod> = Object.fromEntries(METHODS.map((m) => [m.id, m]))

export function mape(pred: number[], actual: number[]): number {
  let s = 0, c = 0
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] > 0) {
      s += Math.abs(pred[i] - actual[i]) / actual[i]
      c++
    }
  }
  return c ? s / c : 0
}

export interface Backtest {
  perMethod: MethodResult[]
  best: MethodResult
  holdout: number[]
  holdoutDow: number
}

export function backtest(queueId: string, overlay?: ActualRow[]): Backtest {
  const { days, dows, doys } = historyFor(queueId, overlay)
  const L = days.length - 1
  const train = days.slice(0, L)
  const trainDows = dows.slice(0, L)
  const trainDoys = doys.slice(0, L)
  const holdout = days[L]
  const perMethod: MethodResult[] = METHODS.map((m) => {
    const forecast = m.fn(train, trainDows, dows[L], L, trainDoys, doys[L])
    return { id: m.id, name: m.name, kind: m.kind, mape: mape(forecast, holdout), pred: forecast }
  })
  const best = perMethod.reduce((a, b) => (b.mape < a.mape ? b : a))
  return { perMethod, best, holdout, holdoutDow: dows[L] }
}

// Forecasts the day after the training series' last known date — normally
// TODAY (base history ends TODAY-1), but shifts forward once imported actuals
// extend the series past that.
export function generate(queueId: string, methodId: string, overlay?: ActualRow[]): number[] {
  const { days, dows, doys, lastDate } = historyFor(queueId, overlay)
  const m = methodById[methodId] ?? METHODS[0]
  const targetDate = addDays(lastDate, 1)
  return m.fn(days, dows, dowOf(targetDate), days.length, doys, dayOfYear(targetDate))
}
