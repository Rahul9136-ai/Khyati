// Interval-by-interval capacity plan tying forecast + Erlang + roster coverage.
import { applyShrinkage, intervalStaffing, serviceLevel, trafficIntensity } from "./erlang"
import { AGENTS, INTERVALS } from "./seed"
import type { Agent, PlanRow, PlanSummary, Queue } from "./types"

function shiftToIdx(shift: string): number[] {
  const [start, end] = shift.split("–").map((t) => {
    const [h, m] = t.split(":").map(Number)
    return h * 60 + m
  })
  const out: number[] = []
  INTERVALS.forEach(({ idx, label }) => {
    const [h, m] = label.split(":").map(Number)
    const mins = h * 60 + m
    if (mins >= start && mins < end) out.push(idx)
  })
  return out
}

export function scheduledCoverage(queueId: string, agents: Agent[] = AGENTS): number[] {
  const cover = INTERVALS.map(() => 0)
  agents.forEach((a) => {
    if (!a.skills.includes(queueId)) return
    shiftToIdx(a.shift).forEach((idx) => {
      cover[idx] += 1
    })
  })
  return cover
}

export function buildPlan(
  volume: number[],
  aht: number,
  queue: Queue,
  shrinkage: number,
  agents: Agent[] = AGENTS,
): PlanRow[] {
  const opts = { interval: 1800, slTarget: queue.slTarget, targetTime: queue.targetTime }
  const scheduled = scheduledCoverage(queue.id, agents)

  return INTERVALS.map((iv, i) => {
    const v = volume[i]
    const s = intervalStaffing(v, aht, opts)
    const requiredNet = s.required
    const requiredGross = applyShrinkage(requiredNet, shrinkage)
    const sched = scheduled[i]
    const intensity = trafficIntensity(v, aht, 1800)
    const schedNet = Math.round(sched * (1 - shrinkage))
    const projSL = serviceLevel(schedNet, intensity, aht, queue.targetTime)
    return {
      idx: i,
      label: iv.label,
      volume: v,
      intensity,
      requiredNet,
      requiredGross,
      scheduled: sched,
      variance: sched - requiredGross,
      targetSL: s.serviceLevel,
      projSL,
      asa: s.asa,
      occupancy: s.occupancy,
    }
  })
}

export function summarisePlan(plan: PlanRow[]): PlanSummary {
  const totalVol = plan.reduce((a, p) => a + p.volume, 0)
  const wSL = totalVol ? plan.reduce((a, p) => a + p.projSL * p.volume, 0) / totalVol : 0
  const reqHours = plan.reduce((a, p) => a + p.requiredGross, 0) * 0.5
  const schedHours = plan.reduce((a, p) => a + p.scheduled, 0) * 0.5
  const underIntervals = plan.filter((p) => p.variance < 0).length
  const avgOcc = plan.length ? plan.reduce((a, p) => a + p.occupancy, 0) / plan.length : 0
  const peakIdx = plan.reduce((best, p, i) => (p.volume > plan[best].volume ? i : best), 0)
  return { totalVol, wSL, reqHours, schedHours, underIntervals, avgOcc, peakIdx }
}

export const fmtPct = (x: number) => `${(x * 100).toFixed(1)}%`
export const fmtSec = (x: number) => (x === Infinity || isNaN(x) ? "—" : `${Math.round(x)}s`)
