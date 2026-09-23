// Shared helpers for the ML and deep-learning forecasting models (mlmodels.ts,
// dlmodels.ts): seeded randomness, trend/shape decomposition and a fit cache.
export const M = 24
const TWO_PI = Math.PI * 2

export const sum = (a: ArrayLike<number>) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return s
}

// Deterministic PRNG so every fit — and therefore every back-test — is reproducible.
export function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function gaussianSolve(A: number[][], b: number[]): number[] {
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

// ---- trend ----
// The ML / DL models learn the *seasonal ratio* (volume ÷ trend) so they only have to
// model calendar structure; the linear trend is extrapolated separately. Trees and
// networks can't extrapolate a growth trend on their own.
export interface Trend {
  a: number
  b: number
  floor: number
}

export function fitTrend(totals: number[]): Trend {
  const n = totals.length
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  totals.forEach((y, x) => { sx += x; sy += y; sxx += x * x; sxy += x * y })
  const denom = n * sxx - sx * sx
  const b = denom ? (n * sxy - sx * sy) / denom : 0
  const a = (sy - b * sx) / (n || 1)
  return { a, b, floor: 0.1 * (sy / (n || 1)) }
}

export const trendAt = (t: Trend, idx: number) => Math.max(t.floor, t.a + t.b * idx)

// ---- intraday shape ----
// Share of the day's volume in each interval, from the last few same-weekday days
// (falls back to all days when the weekday is rare). Sums to 1.
export function profileShape(days: number[][], dows: number[], targetDow: number): number[] {
  const K = 8
  const pool: number[][] = []
  for (let d = days.length - 1; d >= 0 && pool.length < K; d--) if (dows[d] === targetDow) pool.push(days[d])
  const src = pool.length ? pool : days.slice(-K)
  const acc = new Array(M).fill(0)
  let used = 0
  for (const day of src) {
    const tot = sum(day)
    if (tot <= 0) continue
    for (let i = 0; i < M; i++) acc[i] += day[i] / tot
    used++
  }
  return used ? acc.map((v) => v / used) : new Array(M).fill(1 / M)
}

export const toProfile = (total: number, shape: number[]) =>
  shape.map((s) => Math.max(0, Math.round(total * s)))

// ---- calendar features for the neural networks ----
export const CAL_FEATURES = 10
export function calFeatures(dow: number, doy: number): number[] {
  const w = (TWO_PI * dow) / 7
  const y = (TWO_PI * doy) / 365.25
  return [
    Math.sin(w), Math.cos(w), Math.sin(2 * w), Math.cos(2 * w),
    Math.sin(y), Math.cos(y), Math.sin(2 * y), Math.cos(2 * y), Math.sin(3 * y), Math.cos(3 * y),
  ]
}

// ---- fit cache ----
// Backtests and range forecasts call a model many times with training arrays that are
// prefixes of one history, each a day or two longer. Refitting a network or forest per
// call would freeze the UI, so a fit is reused for training sets up to `maxAge` days
// longer than the one it was trained on — the same as retraining on a schedule.
// A fit is only ever used for days *after* its own training window, so nothing leaks
// from the hold-out. The prefix check makes edits to history (imported actuals that
// overwrite a day) trigger a refit instead of reusing a stale one.
export function lineageCache<F>(maxAge: number, maxEntries = 4) {
  const store = new WeakMap<number[], { rows: number[][]; fit: F }[]>()
  return (days: number[][], train: () => F): F => {
    const key = days[0]
    if (!key) return train()
    const list = store.get(key) ?? []
    let best: { rows: number[][]; fit: F } | undefined
    for (const e of list) {
      const n = e.rows.length
      if (n > days.length || days.length - n > maxAge) continue
      if (best && n <= best.rows.length) continue
      let same = true
      for (let i = 0; i < n; i++) if (days[i] !== e.rows[i]) { same = false; break }
      if (same) best = e
    }
    if (best) return best.fit
    const fit = train()
    list.push({ rows: days.slice(), fit })
    if (list.length > maxEntries) list.shift()
    store.set(key, list)
    return fit
  }
}

// ---- Adam optimiser over a flat parameter vector ----
export class Adam {
  private m: Float64Array
  private v: Float64Array
  private t = 0
  constructor(size: number) {
    this.m = new Float64Array(size)
    this.v = new Float64Array(size)
  }
  step(p: Float64Array, g: Float64Array, lr: number, invBatch: number, clip = 5) {
    let norm = 0
    for (let i = 0; i < g.length; i++) norm += g[i] * g[i]
    norm = Math.sqrt(norm) * invBatch
    const scale = norm > clip ? clip / norm : 1
    this.t++
    const b1 = 0.9, b2 = 0.999
    const c1 = 1 - Math.pow(b1, this.t), c2 = 1 - Math.pow(b2, this.t)
    for (let i = 0; i < p.length; i++) {
      const gi = g[i] * invBatch * scale
      this.m[i] = b1 * this.m[i] + (1 - b1) * gi
      this.v[i] = b2 * this.v[i] + (1 - b2) * gi * gi
      p[i] -= (lr * (this.m[i] / c1)) / (Math.sqrt(this.v[i] / c2) + 1e-8)
    }
  }
}

export function shuffle<T>(arr: T[], rnd: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}
