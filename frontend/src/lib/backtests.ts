// Forecast backtests without freezing the page.
//
// Running all 12 forecasting models for one queue takes about a second, and
// Reports, Scenario Studio and the date-range plans need it for every queue. A
// background worker calculates them (soon after sign-in, and whenever queues or
// imported actuals change); results go into forecast.ts's cache, which every
// caller reads. Pages ask `useBacktestsReady` and show "Calculating…" until then.
// Without worker support (tests, very old browsers) everything is calculated
// directly, as before.
import { useEffect } from "react"
import { create } from "zustand"

import type { ActualRow } from "@/lib/domain/history"
import { backtestReady, primeBacktest, type Backtest } from "@/lib/domain/forecast"
import type { Queue } from "@/lib/domain/types"

export const useBacktestStore = create<{ version: number }>(() => ({ version: 0 }))

let worker: Worker | null | undefined
let nextId = 1
const pending = new Map<number, { queueId: string; overlay?: ActualRow[] }>()
const inFlight = new Set<string>()

const key = (queueId: string, overlay?: ActualRow[]) => `${queueId}|${overlay?.length ?? 0}|${overlay?.at(-1)?.date ?? ""}`

function getWorker(): Worker | null {
  if (worker !== undefined) return worker
  try {
    worker = typeof Worker === "undefined" ? null : new Worker(new URL("./backtest.worker.ts", import.meta.url), { type: "module" })
  } catch {
    worker = null
  }
  if (worker) {
    worker.onmessage = (e: MessageEvent<{ id: number; result?: Backtest; error?: string }>) => {
      const job = pending.get(e.data.id)
      pending.delete(e.data.id)
      if (!job) return
      inFlight.delete(key(job.queueId, job.overlay))
      if (e.data.result) primeBacktest(job.queueId, job.overlay, e.data.result)
      useBacktestStore.setState((s) => ({ version: s.version + 1 }))
    }
    worker.onerror = () => {
      // the worker can't run here: fall back to calculating on the page
      worker = null
      pending.clear()
      inFlight.clear()
      useBacktestStore.setState((s) => ({ version: s.version + 1 }))
    }
  }
  return worker
}

/** Start background backtests for any queue whose result isn't ready yet. */
export function warmBacktests(queues: Queue[], importedActuals: Record<string, ActualRow[]>) {
  const w = getWorker()
  if (!w) return
  for (const q of queues) {
    const overlay = importedActuals[q.id]
    const k = key(q.id, overlay)
    if (backtestReady(q.id, overlay) || inFlight.has(k)) continue
    inFlight.add(k)
    const id = nextId++
    pending.set(id, { queueId: q.id, overlay })
    w.postMessage({ id, queueId: q.id, overlay })
  }
}

/**
 * True once every queue's backtest is ready (so the page can use them without
 * freezing). Starts the background work if needed. Without a worker it's
 * always true: the page calculates directly.
 */
export function useBacktestsReady(queues: Queue[], importedActuals: Record<string, ActualRow[]>): boolean {
  useBacktestStore((s) => s.version) // re-render as results arrive
  const w = getWorker()
  useEffect(() => { warmBacktests(queues, importedActuals) }, [queues, importedActuals])
  if (!w) return true
  return queues.every((q) => backtestReady(q.id, importedActuals[q.id]))
}
