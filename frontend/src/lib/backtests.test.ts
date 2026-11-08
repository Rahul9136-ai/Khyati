import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { backtest, backtestReady } from "@/lib/domain/forecast"
import { QUEUES } from "@/lib/domain/seed"

describe("backtest cache", () => {
  it("runs a queue's 12 models once; later calls reuse the result", () => {
    const t0 = performance.now()
    const first = backtest("support")
    const firstMs = performance.now() - t0
    const t1 = performance.now()
    const again = backtest("support")
    expect(again).toBe(first)
    expect(performance.now() - t1).toBeLessThan(Math.max(20, firstMs / 10))
    expect(backtestReady("support")).toBe(true)
    // different imported actuals are a different result
    expect(backtestReady("support", [{ date: "2026-11-01", volume: 50 }])).toBe(false)
  }, 60_000)
})

describe("background backtests", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it("pages wait (not freeze) until the worker has worked out every queue", async () => {
    const posted: { id: number; queueId: string }[] = []
    class FakeWorker {
      onmessage: ((e: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null
      postMessage(msg: { id: number; queueId: string }) {
        posted.push(msg)
        // answer later, like a real worker, with a plain backtest result
        setTimeout(() => this.onmessage?.({ data: { id: msg.id, result: { perMethod: [], best: { id: "snaive", name: "x", kind: "Statistical", mape: 1, pred: [] }, holdout: [], holdoutDow: 0 } } } as MessageEvent), 10)
      }
    }
    vi.stubGlobal("Worker", FakeWorker)
    const { useBacktestsReady } = await import("@/lib/backtests")
    const queues = QUEUES.map((q) => ({ ...q, id: `${q.id}-bg` }))
    const { result } = renderHook(() => useBacktestsReady(queues, {}))
    expect(result.current).toBe(false) // shows "Calculating…" instead of freezing
    await waitFor(() => expect(result.current).toBe(true))
    expect(posted.map((p) => p.queueId)).toEqual(queues.map((q) => q.id)) // each queue once
  })

  it("without worker support it calculates on the page, as before", async () => {
    vi.stubGlobal("Worker", undefined)
    const { useBacktestsReady } = await import("@/lib/backtests")
    const { result } = renderHook(() => useBacktestsReady(QUEUES, {}))
    expect(result.current).toBe(true)
  })
})
