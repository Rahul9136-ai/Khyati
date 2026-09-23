// Additional ML forecasters: Random Forest, Gradient Boosting and Ridge regression.
//
// All three learn the day's *seasonal ratio* (daily total ÷ linear trend) from calendar
// features only (weekday, day-of-year), so they can forecast any horizon — the same
// contract as Prophet / Linear Regression / k-NN. The forecast total is
// ratio × extrapolated trend, spread across the day by the recent same-weekday shape.
import type { ForecastFn } from "./types"
import {
  fitTrend, gaussianSolve, lineageCache, mulberry32, profileShape, sum, toProfile, trendAt, type Trend,
} from "./modelUtils"

const REFIT_EVERY = 14 // days a fit may be reused for (see lineageCache)

// ---------- regression trees ----------
type Node = { v: number } | { f: number; t: number; l: Node; r: Node }

function fitTree(X: number[][], y: number[], idx: number[], depth: number, minLeaf: number): Node {
  const n = idx.length
  let s = 0
  for (const i of idx) s += y[i]
  const mean = s / n
  if (depth === 0 || n < 2 * minLeaf) return { v: mean }

  let bestGain = 1e-12, bf = -1, bt = 0
  for (let f = 0; f < X[0].length; f++) {
    const order = idx.slice().sort((a, b) => X[a][f] - X[b][f])
    let ls = 0
    for (let k = 0; k < n - 1; k++) {
      ls += y[order[k]]
      const lo = X[order[k]][f], hi = X[order[k + 1]][f]
      const nl = k + 1, nr = n - nl
      if (lo === hi || nl < minLeaf || nr < minLeaf) continue
      const rs = s - ls
      const gain = (ls * ls) / nl + (rs * rs) / nr - (s * s) / n // SSE reduction
      if (gain > bestGain) { bestGain = gain; bf = f; bt = (lo + hi) / 2 }
    }
  }
  if (bf < 0) return { v: mean }

  const li: number[] = [], ri: number[] = []
  for (const i of idx) (X[i][bf] <= bt ? li : ri).push(i)
  return { f: bf, t: bt, l: fitTree(X, y, li, depth - 1, minLeaf), r: fitTree(X, y, ri, depth - 1, minLeaf) }
}

function predictTree(node: Node, x: number[]): number {
  while ("f" in node) node = x[node.f] <= node.t ? node.l : node.r
  return node.v
}

// ---------- shared dataset ----------
interface Data {
  X: number[][]
  y: number[] // seasonal ratio
  trend: Trend
}

function buildData(days: number[][], dows: number[], doys?: number[]): Data {
  const totals = days.map(sum)
  const trend = fitTrend(totals)
  return {
    X: days.map((_, d) => [dows[d], doys?.[d] ?? d % 365]),
    y: totals.map((t, d) => t / trendAt(trend, d)),
    trend,
  }
}

// Wraps a "ratio predictor" into a ForecastFn: fit once (cached), predict the ratio,
// scale by the trend, distribute over the day.
function makeForecaster<F extends { trend: Trend }>(
  train: (data: Data) => F,
  predict: (fit: F, dow: number, doy: number) => number,
): ForecastFn {
  const cache = lineageCache<F>(REFIT_EVERY)
  return (days, dows, targetDow, targetDayIdx, doys, targetDoy) => {
    const fit = cache(days, () => train(buildData(days, dows, doys)))
    const ratio = predict(fit, targetDow, targetDoy ?? targetDayIdx % 365)
    return toProfile(Math.max(0, ratio) * trendAt(fit.trend, targetDayIdx), profileShape(days, dows, targetDow))
  }
}

// ---------- Random Forest ----------
// Bagged deep trees on bootstrap samples; the average smooths any one tree's noise.
export const randomForest: ForecastFn = makeForecaster(
  (data) => {
    const rnd = mulberry32(11)
    const n = data.y.length
    const trees: Node[] = []
    for (let t = 0; t < 40; t++) {
      const boot = Array.from({ length: n }, () => Math.floor(rnd() * n))
      trees.push(fitTree(data.X, data.y, boot, 9, 4))
    }
    return { trend: data.trend, trees }
  },
  (fit, dow, doy) => fit.trees.reduce((a, t) => a + predictTree(t, [dow, doy]), 0) / fit.trees.length,
)

// ---------- Gradient Boosting ----------
// Shallow trees added one at a time, each fitting the residual of the ensemble so far
// (stochastic boosting: every tree sees a random 80% of the days).
export const gradientBoosting: ForecastFn = makeForecaster(
  (data) => {
    const rnd = mulberry32(23)
    const n = data.y.length
    const lr = 0.1
    const base = data.y.reduce((a, b) => a + b, 0) / n
    const pred = new Array(n).fill(base)
    const trees: Node[] = []
    for (let m = 0; m < 120; m++) {
      const resid = data.y.map((v, i) => v - pred[i])
      const sample: number[] = []
      for (let i = 0; i < n; i++) if (rnd() < 0.8) sample.push(i)
      const tree = fitTree(data.X, resid, sample, 3, 8)
      trees.push(tree)
      for (let i = 0; i < n; i++) pred[i] += lr * predictTree(tree, data.X[i])
    }
    return { trend: data.trend, base, lr, trees }
  },
  (fit, dow, doy) => fit.trees.reduce((a, t) => a + fit.lr * predictTree(t, [dow, doy]), fit.base),
)

// ---------- Ridge regression ----------
// Weekday dummies + three annual harmonics, fit in closed form with an L2 penalty so
// the harmonics don't chase noise. Unlike the OLS "Linear Regression" model it works
// on the detrended daily ratio rather than raw interval volumes.
function ridgeFeatures(dow: number, doy: number): number[] {
  const f = new Array(7).fill(0)
  f[dow] = 1
  const y = (2 * Math.PI * doy) / 365.25
  for (let k = 1; k <= 3; k++) f.push(Math.sin(k * y), Math.cos(k * y))
  return f
}

export const ridgeRegression: ForecastFn = makeForecaster(
  (data) => {
    const P = 13
    const lambda = 1
    const XtX = Array.from({ length: P }, () => new Array(P).fill(0))
    const Xty = new Array(P).fill(0)
    data.X.forEach(([dow, doy], i) => {
      const f = ridgeFeatures(dow, doy)
      for (let a = 0; a < P; a++) {
        Xty[a] += f[a] * data.y[i]
        for (let b = 0; b < P; b++) XtX[a][b] += f[a] * f[b]
      }
    })
    for (let a = 0; a < P; a++) XtX[a][a] += lambda
    return { trend: data.trend, w: gaussianSolve(XtX, Xty) }
  },
  (fit, dow, doy) => ridgeFeatures(dow, doy).reduce((a, v, k) => a + v * fit.w[k], 0),
)
