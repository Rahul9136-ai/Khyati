// Shift-swap SL-neutrality check. Simulates exchanging two agents' shifts and
// measures the volume-weighted service-level delta across every queue either
// agent is skilled for — the basis for auto-approving harmless swaps.
import { buildPlan, summarisePlan } from "./planning"
import type { Agent, Queue } from "./types"

/** Swaps whose SL drop is smaller than this (in absolute SL, 0.005 = 0.5pp)
 *  auto-approve; anything worse escalates to a Team Leader. */
export const AUTO_APPROVE_THRESHOLD = -0.005

export interface SwapImpact {
  /** modSL − baseSL across affected queues; negative = service level drops. */
  impact: number
  before: number
  after: number
  neutral: boolean
}

export function swapImpact(
  aId: string,
  bId: string,
  agents: Agent[],
  queues: Queue[],
  forecasts: Record<string, number[]>,
  shrinkage: number,
): SwapImpact {
  const a = agents.find((x) => x.id === aId)
  const b = agents.find((x) => x.id === bId)
  if (!a || !b || aId === bId) return { impact: 0, before: 0, after: 0, neutral: true }
  if (a.shift === b.shift) return { impact: 0, before: 0, after: 0, neutral: true }

  const affected = queues.filter((q) => a.skills.includes(q.id) || b.skills.includes(q.id))
  const swapped = agents.map((x) =>
    x.id === aId
      ? { ...x, shift: b.shift, shiftPatternId: b.shiftPatternId }
      : x.id === bId
        ? { ...x, shift: a.shift, shiftPatternId: a.shiftPatternId }
        : x,
  )

  const weightedSL = (roster: Agent[]) => {
    const per = affected.map((q) => summarisePlan(buildPlan(forecasts[q.id] ?? [], q.aht, q, shrinkage, roster)))
    const vol = per.reduce((acc, s) => acc + s.totalVol, 0)
    return vol ? per.reduce((acc, s) => acc + s.wSL * s.totalVol, 0) / vol : 0
  }

  const before = weightedSL(agents)
  const after = weightedSL(swapped)
  const impact = after - before
  return { impact, before, after, neutral: impact >= AUTO_APPROVE_THRESHOLD }
}
