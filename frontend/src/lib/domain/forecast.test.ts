import { describe, expect, it } from "vitest"

import { backtest, generate, METHODS, methodById } from "./forecast"
import { backtestG } from "./granularity"
import { historyFor } from "./history"
import { QUEUES } from "./seed"

const NEW_IDS = ["rf", "gbm", "ridge", "mlp", "gru"]
const qid = QUEUES[0].id

// Same history, but with fresh row objects so the per-history fit caches start empty.
function freshHistory() {
  const h = historyFor(qid)
  return { days: h.days.map((r) => r.slice()), dows: h.dows, doys: h.doys }
}

describe("ML and deep-learning forecasting methods", () => {
  it("registers the new models with the right kinds and no ensembles", () => {
    expect(METHODS.map((m) => m.id)).toEqual(["snaive", "movavg", "holt", "sarima", "prophet", "linreg", "knn", ...NEW_IDS])
    expect(["rf", "gbm", "ridge"].every((id) => methodById[id].kind === "ML")).toBe(true)
    expect(["mlp", "gru"].every((id) => methodById[id].kind === "DL")).toBe(true)
    expect(METHODS.some((m) => m.name.toLowerCase().includes("ensemble"))).toBe(false)
  })

  it("returns 24 finite, non-negative whole-number intervals", () => {
    const { days, dows, doys } = freshHistory()
    const L = days.length - 1
    for (const id of NEW_IDS) {
      const out = methodById[id].fn(days.slice(0, L), dows.slice(0, L), dows[L], L, doys.slice(0, L), doys[L])
      expect(out).toHaveLength(24)
      out.forEach((v) => {
        expect(Number.isFinite(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(Number.isInteger(v)).toBe(true)
      })
    }
  })

  it("is deterministic — the same history gives the same forecast", () => {
    const a = freshHistory(), b = freshHistory()
    const L = a.days.length - 1
    for (const id of NEW_IDS) {
      const f = (h: typeof a) => methodById[id].fn(h.days.slice(0, L), h.dows.slice(0, L), h.dows[L], L, h.doys.slice(0, L), h.doys[L])
      expect(f(a)).toEqual(f(b))
    }
  })

  it("never reuses a fit trained on days after the training window (no hold-out leakage)", () => {
    const L = 900
    const long = freshHistory()
    const alone = freshHistory()
    const at = (h: typeof long, n: number) => (id: string) =>
      methodById[id].fn(h.days.slice(0, n), h.dows.slice(0, n), h.dows[n], n, h.doys.slice(0, n), h.doys[n])
    for (const id of NEW_IDS) {
      at(long, L + 40)(id) // populate the cache with a longer fit first
      expect(at(long, L)(id)).toEqual(at(alone, L)(id)) // a shorter slice must still fit fresh
    }
  })

  it("forecasts multi-day horizons and matches forecasts of the same day made in one pass", () => {
    const { days, dows, doys } = freshHistory()
    const N = days.length
    for (const id of ["mlp", "gru"]) {
      const fn = methodById[id].fn
      const day = (k: number) => fn(days, dows, (dows[N - 1] + 1 + k) % 7, N + k, doys, ((doys[N - 1] + k) % 365) + 1)
      const far = day(30)
      expect(far).toHaveLength(24)
      expect(far.reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
      expect(day(30)).toEqual(far) // cached rollout gives the same answer
    }
  })

  it("is included in backtests and can be generated", () => {
    const bt = backtest(qid)
    expect(bt.perMethod).toHaveLength(METHODS.length)
    for (const id of NEW_IDS) {
      const m = bt.perMethod.find((p) => p.id === id)!
      expect(Number.isFinite(m.mape)).toBe(true)
      expect(m.mape).toBeLessThan(0.35) // sane, not garbage
      expect(generate(qid, id)).toHaveLength(24)
    }
  })

  it("keeps back-tests fast enough for the UI", () => {
    for (const g of ["daily", "weekly", "monthly"] as const) {
      const t0 = performance.now()
      backtestG(qid, g)
      const ms = performance.now() - t0
      console.log(`backtestG ${g}: ${ms.toFixed(0)} ms`)
      expect(ms).toBeLessThan(8000)
    }
  })
})
