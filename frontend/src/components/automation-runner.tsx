import { useEffect } from "react"

import { startCrossTabSync } from "@/lib/crossTabSync"
import { DEMO_RUN_INTERVAL_MS, PIPELINE } from "@/lib/domain/automation"
import { useWfm } from "@/store/wfm"

/**
 * Mounted once at the app root (regardless of route) so enabled pipeline
 * jobs keep firing on their demo-paced cadence even while the user is on a
 * completely different page — a genuinely running scheduler, not a page-local one.
 */
const ALERTS_POLL_MS = 15_000
/** How often employees past their last working day are taken off the roster. */
const EMPLOYMENT_POLL_MS = 60_000
/** How often the real-time board re-reads today's schedule (as the clock moves through breaks, lunch…). */
const REALTIME_POLL_MS = 10_000

export function AutomationRunner() {
  const pipelineAutoRun = useWfm((s) => s.pipelineAutoRun)
  const runPipelineJob = useWfm((s) => s.runPipelineJob)
  const recomputeAlerts = useWfm((s) => s.recomputeAlerts)
  const settleEmployment = useWfm((s) => s.settleEmployment)
  const syncRealTime = useWfm((s) => s.syncRealTime)

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

  // Leavers come off the roster, schedules and the real-time board the day
  // after their last working day — at load, and as midnight passes.
  useEffect(() => {
    settleEmployment()
    const t = window.setInterval(settleEmployment, EMPLOYMENT_POLL_MS)
    return () => window.clearInterval(t)
  }, [settleEmployment])

  // The real-time board follows the schedule: on a timer, and the moment a
  // schedule or the Intraday clock changes on any page.
  useEffect(() => {
    syncRealTime()
    const t = window.setInterval(syncRealTime, REALTIME_POLL_MS)
    let queued = false
    const unsubscribe = useWfm.subscribe((s, p) => {
      if (queued) return
      if (s.nowIdx === p.nowIdx && s.agents === p.agents && s.dayStore === p.dayStore && s.activityPlan === p.activityPlan &&
        s.breakOverrides === p.breakOverrides && s.overtimePlan === p.overtimePlan && s.shiftPatterns === p.shiftPatterns) return
      queued = true
      queueMicrotask(() => {
        queued = false
        syncRealTime()
      })
    })
    return () => {
      window.clearInterval(t)
      unsubscribe()
    }
  }, [syncRealTime])

  // Other open tabs of the app stay in step with this one.
  useEffect(() => startCrossTabSync(), [])

  // Every LOB and queue keeps a colour of its own (saved data from before, or
  // loaded from the server, may share one): fixed now and whenever they change.
  useEffect(() => {
    useWfm.getState().fixColours()
    return useWfm.subscribe((s, p) => {
      if (s.queues !== p.queues || s.lobs !== p.lobs) s.fixColours()
    })
  }, [])

  return null
}
