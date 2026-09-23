// Deep-learning forecasters, trained in the browser with hand-written backprop + Adam
// (no ML runtime dependency): a feed-forward network (MLP) and a recurrent network (GRU).
//
// Like the ML models in mlmodels.ts they predict volume ÷ linear trend, so the trend is
// extrapolated separately. Unlike them they output all 24 intervals directly, so they
// learn the intraday shape as well as the level. Weights are seeded — every run of a
// back-test is identical.
import type { ForecastFn } from "./types"
import {
  Adam, CAL_FEATURES, calFeatures, fitTrend, lineageCache, M, mulberry32, shuffle, sum, trendAt, type Trend,
} from "./modelUtils"

const REFIT_EVERY = 14

function uniform(rnd: () => number, limit: number) {
  return (rnd() * 2 - 1) * limit
}

// Target for day d: each interval's volume relative to the trend, scaled so it's O(1).
function targetVec(day: number[], trend: Trend, d: number): Float64Array {
  const scale = M / trendAt(trend, d)
  return Float64Array.from(day, (v) => v * scale)
}

// Turn a network output (24 normalised intervals) back into contacts per interval.
function toContacts(out: ArrayLike<number>, trend: Trend, idx: number): number[] {
  const scale = trendAt(trend, idx) / M
  return Array.from({ length: M }, (_, i) => Math.max(0, Math.round(out[i] * scale)))
}

// =========================================================================
// MLP — calendar features → two tanh hidden layers → 24 interval volumes
// =========================================================================
const MI = CAL_FEATURES
const MH = 20
const O_W1 = 0
const O_B1 = O_W1 + MH * MI
const O_W2 = O_B1 + MH
const O_B2 = O_W2 + MH * MH
const O_W3 = O_B2 + MH
const O_B3 = O_W3 + M * MH
const MLP_SIZE = O_B3 + M

interface MlpFit { P: Float64Array; trend: Trend }

function mlpForward(P: Float64Array, x: ArrayLike<number>, a1: Float64Array, a2: Float64Array, o: Float64Array) {
  for (let h = 0; h < MH; h++) {
    let s = P[O_B1 + h]
    for (let i = 0; i < MI; i++) s += P[O_W1 + h * MI + i] * x[i]
    a1[h] = Math.tanh(s)
  }
  for (let h = 0; h < MH; h++) {
    let s = P[O_B2 + h]
    for (let k = 0; k < MH; k++) s += P[O_W2 + h * MH + k] * a1[k]
    a2[h] = Math.tanh(s)
  }
  for (let j = 0; j < M; j++) {
    let s = P[O_B3 + j]
    for (let k = 0; k < MH; k++) s += P[O_W3 + j * MH + k] * a2[k]
    o[j] = s
  }
}

function trainMlp(days: number[][], dows: number[], doys?: number[]): MlpFit {
  const n = days.length
  const trend = fitTrend(days.map(sum))
  const rnd = mulberry32(101)
  const P = new Float64Array(MLP_SIZE)
  for (let i = 0; i < O_B1; i++) P[i] = uniform(rnd, Math.sqrt(6 / (MI + MH)))
  for (let i = O_W2; i < O_B2; i++) P[i] = uniform(rnd, Math.sqrt(6 / (2 * MH)))
  for (let i = O_W3; i < O_B3; i++) P[i] = uniform(rnd, Math.sqrt(6 / (MH + M)))

  const start = Math.max(0, n - 730)
  const rows: { x: number[]; y: Float64Array }[] = []
  for (let d = start; d < n; d++) rows.push({ x: calFeatures(dows[d], doys?.[d] ?? d % 365), y: targetVec(days[d], trend, d) })
  for (let j = 0; j < M; j++) P[O_B3 + j] = rows.reduce((a, r) => a + r.y[j], 0) / rows.length // start from the mean shape

  const G = new Float64Array(MLP_SIZE)
  const adam = new Adam(MLP_SIZE)
  const a1 = new Float64Array(MH), a2 = new Float64Array(MH), o = new Float64Array(M)
  const d2 = new Float64Array(MH), d1 = new Float64Array(MH)
  const order = rows.map((_, i) => i)
  const BATCH = 32, EPOCHS = 35
  let lr = 0.01

  for (let ep = 0; ep < EPOCHS; ep++) {
    shuffle(order, rnd)
    for (let b = 0; b < order.length; b += BATCH) {
      const end = Math.min(order.length, b + BATCH)
      G.fill(0)
      for (let s = b; s < end; s++) {
        const { x, y } = rows[order[s]]
        mlpForward(P, x, a1, a2, o)
        d2.fill(0)
        for (let j = 0; j < M; j++) {
          const dO = o[j] - y[j]
          G[O_B3 + j] += dO
          for (let k = 0; k < MH; k++) {
            G[O_W3 + j * MH + k] += dO * a2[k]
            d2[k] += P[O_W3 + j * MH + k] * dO
          }
        }
        d1.fill(0)
        for (let h = 0; h < MH; h++) {
          const dz = d2[h] * (1 - a2[h] * a2[h])
          G[O_B2 + h] += dz
          for (let k = 0; k < MH; k++) {
            G[O_W2 + h * MH + k] += dz * a1[k]
            d1[k] += P[O_W2 + h * MH + k] * dz
          }
        }
        for (let h = 0; h < MH; h++) {
          const dz = d1[h] * (1 - a1[h] * a1[h])
          G[O_B1 + h] += dz
          for (let i = 0; i < MI; i++) G[O_W1 + h * MI + i] += dz * x[i]
        }
      }
      adam.step(P, G, lr, 1 / (end - b))
    }
    lr *= 0.95
  }
  return { P, trend }
}

const mlpCache = lineageCache<MlpFit>(REFIT_EVERY)
export const neuralNetwork: ForecastFn = (days, dows, targetDow, targetDayIdx, doys, targetDoy) => {
  const fit = mlpCache(days, () => trainMlp(days, dows, doys))
  const a1 = new Float64Array(MH), a2 = new Float64Array(MH), o = new Float64Array(M)
  mlpForward(fit.P, calFeatures(targetDow, targetDoy ?? targetDayIdx % 365), a1, a2, o)
  return toContacts(o, fit.trend, targetDayIdx)
}

// =========================================================================
// GRU — reads the last 14 days' level, then a dense head adds the target day's
// calendar features → 24 interval volumes. Multi-day horizons roll forward, feeding
// each predicted day back in as the next step's input.
// =========================================================================
export const W = 14 // days of history the recurrent layer reads
export const GI = 3 // per-step input: [level vs trend, sin(weekday), cos(weekday)]
const GH = 8 // GRU hidden size
const HD = 16 // dense-head hidden size
const HQ = GH + CAL_FEATURES

const G_WZ = 0
const G_WR = G_WZ + GH * GI
const G_WN = G_WR + GH * GI
const G_UZ = G_WN + GH * GI
const G_UR = G_UZ + GH * GH
const G_UN = G_UR + GH * GH
const G_BZ = G_UN + GH * GH
const G_BR = G_BZ + GH
const G_BN = G_BR + GH
const G_V1 = G_BN + GH
const G_C1 = G_V1 + HD * HQ
const G_V2 = G_C1 + HD
const G_C2 = G_V2 + M * HD
export const GRU_SIZE = G_C2 + M
const LEVEL_SCALE = 3 // brings the ±30% seasonal swing to roughly ±1

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v))

interface GruFit { P: Float64Array; trend: Trend }

export interface Work {
  h: Float64Array // (W+1) × GH hidden states, h[0] = 0
  z: Float64Array; r: Float64Array; n: Float64Array; a: Float64Array // W × GH gate caches
  q: Float64Array // head input [h_W, calendar]
  u: Float64Array // head hidden
  o: Float64Array // head output
}
export const newWork = (): Work => ({
  h: new Float64Array((W + 1) * GH),
  z: new Float64Array(W * GH), r: new Float64Array(W * GH), n: new Float64Array(W * GH), a: new Float64Array(W * GH),
  q: new Float64Array(HQ), u: new Float64Array(HD), o: new Float64Array(M),
})

// xs: W × GI inputs, flattened. Fills ws with every intermediate needed for backprop.
export function gruForward(P: Float64Array, xs: Float64Array, cal: ArrayLike<number>, ws: Work) {
  ws.h.fill(0, 0, GH)
  for (let t = 0; t < W; t++) {
    const hp = t * GH, hn = (t + 1) * GH
    for (let j = 0; j < GH; j++) {
      let z = P[G_BZ + j], r = P[G_BR + j], nx = P[G_BN + j], a = 0
      for (let i = 0; i < GI; i++) {
        const xi = xs[t * GI + i]
        z += P[G_WZ + j * GI + i] * xi
        r += P[G_WR + j * GI + i] * xi
        nx += P[G_WN + j * GI + i] * xi
      }
      for (let k = 0; k < GH; k++) {
        const hk = ws.h[hp + k]
        z += P[G_UZ + j * GH + k] * hk
        r += P[G_UR + j * GH + k] * hk
        a += P[G_UN + j * GH + k] * hk
      }
      z = sigmoid(z); r = sigmoid(r)
      const n = Math.tanh(nx + r * a)
      const o = t * GH + j
      ws.z[o] = z; ws.r[o] = r; ws.n[o] = n; ws.a[o] = a
      ws.h[hn + j] = (1 - z) * n + z * ws.h[hp + j]
    }
  }
  for (let k = 0; k < GH; k++) ws.q[k] = ws.h[W * GH + k]
  for (let k = 0; k < CAL_FEATURES; k++) ws.q[GH + k] = cal[k]
  for (let j = 0; j < HD; j++) {
    let s = P[G_C1 + j]
    for (let k = 0; k < HQ; k++) s += P[G_V1 + j * HQ + k] * ws.q[k]
    ws.u[j] = Math.tanh(s)
  }
  for (let j = 0; j < M; j++) {
    let s = P[G_C2 + j]
    for (let k = 0; k < HD; k++) s += P[G_V2 + j * HD + k] * ws.u[k]
    ws.o[j] = s
  }
}

// Backprop through the head and then through time (BPTT). dO = o - y.
export function gruBackward(P: Float64Array, G: Float64Array, xs: Float64Array, ws: Work, y: Float64Array) {
  const du = new Float64Array(HD)
  for (let j = 0; j < M; j++) {
    const dO = ws.o[j] - y[j]
    G[G_C2 + j] += dO
    for (let k = 0; k < HD; k++) {
      G[G_V2 + j * HD + k] += dO * ws.u[k]
      du[k] += P[G_V2 + j * HD + k] * dO
    }
  }
  let dh = new Float64Array(GH)
  for (let j = 0; j < HD; j++) {
    const dz = du[j] * (1 - ws.u[j] * ws.u[j])
    G[G_C1 + j] += dz
    for (let k = 0; k < HQ; k++) {
      G[G_V1 + j * HQ + k] += dz * ws.q[k]
      if (k < GH) dh[k] += P[G_V1 + j * HQ + k] * dz
    }
  }
  for (let t = W - 1; t >= 0; t--) {
    const hp = t * GH
    const dPrev = new Float64Array(GH)
    for (let j = 0; j < GH; j++) {
      const o = t * GH + j
      const z = ws.z[o], r = ws.r[o], n = ws.n[o], a = ws.a[o]
      const dhn = dh[j]
      const dnp = dhn * (1 - z) * (1 - n * n)
      const dzp = dhn * (ws.h[hp + j] - n) * z * (1 - z)
      const drp = dnp * a * r * (1 - r)
      const da = dnp * r
      dPrev[j] += dhn * z
      G[G_BN + j] += dnp; G[G_BZ + j] += dzp; G[G_BR + j] += drp
      for (let i = 0; i < GI; i++) {
        const xi = xs[t * GI + i]
        G[G_WN + j * GI + i] += dnp * xi
        G[G_WZ + j * GI + i] += dzp * xi
        G[G_WR + j * GI + i] += drp * xi
      }
      for (let k = 0; k < GH; k++) {
        const hk = ws.h[hp + k]
        G[G_UN + j * GH + k] += da * hk
        G[G_UZ + j * GH + k] += dzp * hk
        G[G_UR + j * GH + k] += drp * hk
        dPrev[k] += P[G_UN + j * GH + k] * da + P[G_UZ + j * GH + k] * dzp + P[G_UR + j * GH + k] * drp
      }
    }
    dh = dPrev
  }
}

function stepInput(level: number, dow: number, out: Float64Array, at: number) {
  const w = (2 * Math.PI * dow) / 7
  out[at] = level * LEVEL_SCALE
  out[at + 1] = Math.sin(w)
  out[at + 2] = Math.cos(w)
}

function trainGru(days: number[][], dows: number[], doys?: number[]): GruFit {
  const n = days.length
  const totals = days.map(sum)
  const trend = fitTrend(totals)
  const rnd = mulberry32(202)

  const P = new Float64Array(GRU_SIZE)
  const wLim = Math.sqrt(1 / GI), uLim = Math.sqrt(1 / GH)
  for (let i = G_WZ; i < G_UZ; i++) P[i] = uniform(rnd, wLim)
  for (let i = G_UZ; i < G_BZ; i++) P[i] = uniform(rnd, uLim)
  for (let i = G_V1; i < G_C1; i++) P[i] = uniform(rnd, Math.sqrt(6 / (HQ + HD)))
  for (let i = G_V2; i < G_C2; i++) P[i] = uniform(rnd, Math.sqrt(6 / (HD + M)))

  // per-day step input: how far above/below trend the day was, plus its weekday
  const steps = new Float64Array(n * GI)
  for (let d = 0; d < n; d++) stepInput(totals[d] / trendAt(trend, d) - 1, dows[d], steps, d * GI)

  const first = Math.max(W, n - 360)
  const samples: number[] = []
  for (let d = first; d < n; d++) samples.push(d)
  const ys = new Map<number, Float64Array>(samples.map((d) => [d, targetVec(days[d], trend, d)]))
  for (let j = 0; j < M; j++) P[G_C2 + j] = samples.reduce((a, d) => a + ys.get(d)![j], 0) / samples.length

  const G = new Float64Array(GRU_SIZE)
  const adam = new Adam(GRU_SIZE)
  const ws = newWork()
  const xs = new Float64Array(W * GI)
  const BATCH = 16, EPOCHS = 22
  let lr = 0.01

  for (let ep = 0; ep < EPOCHS; ep++) {
    shuffle(samples, rnd)
    for (let b = 0; b < samples.length; b += BATCH) {
      const end = Math.min(samples.length, b + BATCH)
      G.fill(0)
      for (let s = b; s < end; s++) {
        const d = samples[s]
        for (let t = 0; t < W; t++) for (let i = 0; i < GI; i++) xs[t * GI + i] = steps[(d - W + t) * GI + i]
        gruForward(P, xs, calFeatures(dows[d], doys?.[d] ?? d % 365), ws)
        gruBackward(P, G, xs, ws, ys.get(d)!)
      }
      adam.step(P, G, lr, 1 / (end - b))
    }
    lr *= 0.95
  }
  return { P, trend }
}

// Rolled-forward input windows, cached per training array so a 90-day range forecast
// walks the recurrence once instead of once per date.
interface Roll { fit: GruFit; windows: Float64Array[] }
const gruCache = lineageCache<GruFit>(REFIT_EVERY)
const rollCache = new WeakMap<number[][], Roll>()

export const gruNetwork: ForecastFn = (days, dows, targetDow, targetDayIdx, doys, targetDoy) => {
  const N = days.length
  const fit = gruCache(days, () => trainGru(days, dows, doys))
  const ws = newWork()

  let roll = rollCache.get(days)
  if (!roll || roll.fit !== fit) {
    const totals = days.map(sum)
    const w0 = new Float64Array(W * GI)
    for (let t = 0; t < W; t++) {
      const d = Math.max(0, N - W + t)
      stepInput(totals[d] / trendAt(fit.trend, d) - 1, dows[d], w0, t * GI)
    }
    roll = { fit, windows: [w0] }
    rollCache.set(days, roll)
  }

  // advance the window one day at a time, feeding each predicted day back in
  const k = Math.max(0, targetDayIdx - N)
  const lastDow = dows[N - 1], lastDoy = doys?.[N - 1] ?? (N - 1) % 365
  while (roll.windows.length <= k) {
    const j = roll.windows.length - 1 // predicting day N + j from window j
    const dow = (lastDow + 1 + j) % 7, doy = ((lastDoy + j) % 365) + 1
    gruForward(fit.P, roll.windows[j], calFeatures(dow, doy), ws)
    let ratio = 0
    for (let i = 0; i < M; i++) ratio += ws.o[i]
    const next = new Float64Array(W * GI)
    next.set(roll.windows[j].subarray(GI))
    stepInput(ratio / M - 1, dow, next, (W - 1) * GI)
    roll.windows.push(next)
  }

  gruForward(fit.P, roll.windows[k], calFeatures(targetDow, targetDoy ?? targetDayIdx % 365), ws)
  return toContacts(ws.o, fit.trend, targetDayIdx)
}
