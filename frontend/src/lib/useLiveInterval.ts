// The current interval on the floor, worked out one way for every page
// (Dashboard, Intraday, Scheduling → Coverage & SL): today's schedule, the
// actual volume so far and the agents on queue right now on the Real-Time
// Monitor. One calculation, so the pages can't disagree.
import { useMemo } from "react"

import { breakAwareCoverage } from "@/lib/domain/breaks"
import { activityCoverageLoss, overtimeAgents } from "@/lib/domain/channels"
import { employedOn } from "@/lib/domain/employeeProfile"
import { localISODate } from "@/lib/domain/horizon"
import { intervalOutcomes, liveAgentStates, soFar } from "@/lib/domain/liveCoverage"
import { buildPlan } from "@/lib/domain/planning"
import { actualsFor, inAdherence } from "@/lib/domain/seed"
import type { Queue } from "@/lib/domain/types"
import { scheduleForDate, useWfm } from "@/store/wfm"

export function useLiveInterval(queue: Queue) {
  const s = useWfm()
  const today = localISODate()
  const { rta, nowIdx, forecasts, shrinkage, shiftPatterns, employeeProfiles } = s
  const day = scheduleForDate(s, today)

  const agents = useMemo(
    () => day.agents.filter((a) => !employeeProfiles[a.id] || employedOn(employeeProfiles[a.id], today)),
    [day.agents, employeeProfiles, today],
  )
  return useMemo(() => {
    const staffed = [...agents, ...overtimeAgents(agents, day.overtimePlan)]
    const lost = activityCoverageLoss(queue.id, agents, shiftPatterns, day.breakOverrides, day.activityPlan)
    const onDuty = breakAwareCoverage(queue.id, staffed, shiftPatterns, day.breakOverrides).map((c, i) => Math.max(0, c - lost[i]))
    const liveStates = liveAgentStates(rta, agents, queue.id)
    const liveHeads = liveStates.filter((x) => x.onQueue).length
    const forecast = forecasts[queue.id] ?? []
    const outcomes = intervalOutcomes({ queue, forecast, actuals: actualsFor(queue.id, nowIdx), onDuty, shrinkage, nowIdx, liveHeads })
    const plan = buildPlan(forecast, queue.aht, queue, shrinkage, staffed)
    const board = rta.filter((r) => agents.some((a) => a.id === r.id))
    const onPlan = board.filter((r) => inAdherence(r.actual, r.scheduled)).length
    return {
      row: outcomes[nowIdx],
      totals: soFar(outcomes),
      liveStates,
      liveHeads,
      /** Heads needed on the phones this interval (net of shrinkage). */
      requiredNet: plan[nowIdx]?.requiredNet ?? 0,
      /** Scheduled heads on duty this interval, net of shrinkage. */
      plannedNet: Math.round((onDuty[nowIdx] ?? 0) * (1 - shrinkage)),
      adherence: board.length ? onPlan / board.length : 0,
      onPlan,
      boardSize: board.length,
    }
  }, [agents, day.overtimePlan, day.breakOverrides, day.activityPlan, queue, shiftPatterns, rta, forecasts, nowIdx, shrinkage])
}
