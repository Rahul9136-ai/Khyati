import { useEffect } from "react"

import { DEMO_RUN_INTERVAL_MS, PIPELINE } from "@/lib/domain/automation"
import { useWfm } from "@/store/wfm"

/**
 * Mounted once at the app root (regardless of route) so enabled pipeline
 * jobs keep firing on their demo-paced cadence even while the user is on a
 * completely different page — a genuinely running scheduler, not a page-local one.
 */
const ALERTS_POLL_MS = 15_000

export function AutomationRunner() {
  const pipelineAutoRun = useWfm((s) => s.pipelineAutoRun)
  const runPipelineJob = useWfm((s) => s.runPipelineJob)
  const recomputeAlerts = useWfm((s) => s.recomputeAlerts)

  useEffect(() => {
    const timers = PIPELINE.filter((job) => pipelineAutoRun[job.id]).map((job) =>
      window.setInterval(() => runPipelineJob(job.id, true), DEMO_RUN_INTERVAL_MS[job.id] ?? 60_000),
    )
    return () => timers.forEach((t) => window.clearInterval(t))
  }, [pipelineAutoRun, runPipelineJob])

  // Proactive alerts run independently of any pipeline toggle — always on.
  useEffect(() => {
    recomputeAlerts()
    const t = window.setInterval(recomputeAlerts, ALERTS_POLL_MS)
    return () => window.clearInterval(t)
  }, [recomputeAlerts])

  return null
}
