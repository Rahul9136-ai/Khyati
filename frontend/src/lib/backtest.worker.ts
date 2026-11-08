// Runs forecast backtests (all 12 models, ~1 s per queue) off the main thread,
// so pages that need them don't freeze. See lib/backtests.ts.
import type { ActualRow } from "@/lib/domain/history"
import { computeBacktest } from "@/lib/domain/forecast"

self.onmessage = (e: MessageEvent<{ id: number; queueId: string; overlay?: ActualRow[] }>) => {
  const { id, queueId, overlay } = e.data
  try {
    const result = computeBacktest(queueId, overlay)
    // functions can't cross to the main thread; results are plain data
    self.postMessage({ id, result })
  } catch (err) {
    self.postMessage({ id, error: String(err) })
  }
}
