// Leave auto-approval rule: a request auto-approves when (a) today's coverage
// for the requester's primary skill has enough surplus to absorb their shift
// length, and (b) approving it wouldn't push the share of that skill group
// already on approved leave over the overlap cap. Otherwise it stays Pending
// for a human. Mirrors the shift-swap SL-neutrality check in swaps.ts.
import { buildPlan, summarisePlan } from "./planning"
import type { Agent, Queue } from "./types"

export interface PtoLike {
  agentId: string
  from: string
  to: string
  status: string
}

export interface PtoAutoApproveResult {
  approve: boolean
  reason: string
  surplusHours: number
  agentDailyHours: number
  overlapPct: number
}

const DASH = "–"
const toMins = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

function overlaps(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom <= bTo && bFrom <= aTo
}

export function evaluatePtoRequest(
  request: { agentId: string; from: string; to: string },
  agents: Agent[],
  queues: Queue[],
  forecasts: Record<string, number[]>,
  shrinkage: number,
  existing: PtoLike[],
  overlapCapPct: number,
): PtoAutoApproveResult {
  const agent = agents.find((a) => a.id === request.agentId)
  const fallback = { approve: false, surplusHours: 0, agentDailyHours: 0, overlapPct: 0 }
  if (!agent) return { ...fallback, reason: "Employee not found on the roster." }

  const primarySkill = agent.skills[0]
  const queue = primarySkill ? queues.find((q) => q.id === primarySkill) : undefined
  if (!queue) return { ...fallback, reason: "No primary skill on file — routed to a human." }

  const plan = buildPlan(forecasts[queue.id] ?? [], queue.aht, queue, shrinkage, agents)
  const sum = summarisePlan(plan)
  const surplusHours = sum.schedHours - sum.reqHours

  const [start, end] = agent.shift.split(DASH)
  const agentDailyHours = (toMins(end) - toMins(start)) / 60

  const skilled = agents.filter((a) => a.skills.includes(primarySkill))
  const overlapping = existing.filter(
    (r) =>
      (r.status === "Approved" || r.status === "Auto-Approved") &&
      r.agentId !== request.agentId &&
      overlaps(request.from, request.to, r.from, r.to) &&
      agents.find((a) => a.id === r.agentId)?.skills.includes(primarySkill),
  )
  const overlapPct = skilled.length ? overlapping.length / skilled.length : 1

  const hasHeadroom = surplusHours - agentDailyHours >= 0
  const withinOverlapCap = overlapPct < overlapCapPct
  const approve = hasHeadroom && withinOverlapCap

  const reason = approve
    ? `${surplusHours.toFixed(1)}h coverage surplus on ${queue.name} covers the ${agentDailyHours.toFixed(1)}h shift; ${Math.round(overlapPct * 100)}% of ${queue.name} agents already on leave (cap ${Math.round(overlapCapPct * 100)}%).`
    : !hasHeadroom
      ? `Only ${surplusHours.toFixed(1)}h coverage surplus on ${queue.name} — not enough to absorb an ${agentDailyHours.toFixed(1)}h shift.`
      : `${Math.round(overlapPct * 100)}% of ${queue.name} agents already on approved leave for overlapping dates (cap ${Math.round(overlapCapPct * 100)}%).`

  return { approve, reason, surplusHours, agentDailyHours, overlapPct }
}
