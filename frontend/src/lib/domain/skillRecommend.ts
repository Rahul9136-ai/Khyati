// RTA skill re-balancing — scans current per-queue staffing variance (same
// Erlang C math the rest of the app uses) and proposes moving an agent's
// skill from a queue running a surplus to one running short right now.
// Proposing is free; the actual roster switch only happens once both a WFM
// Manager and an Operations Manager have signed off (see CAN_APPROVE_SKILL_
// CHANGE_WFM/_OPS in roles.ts and approveSkillChange in store/wfm.ts).
import { buildPlan } from "./planning"
import type { Agent, Queue } from "./types"

export interface SkillChangeCandidate {
  agentId: string
  agentName: string
  fromQueueId: string
  fromQueueName: string
  toQueueId: string
  toQueueName: string
  reason: string
}

const MIN_IMBALANCE = 0.5 // heads — ignore noise-level variance

export function recommendSkillChanges(
  queues: Queue[],
  forecasts: Record<string, number[]>,
  shrinkage: number,
  agents: Agent[],
  nowIdx: number,
): SkillChangeCandidate[] {
  const variance: Record<string, number> = {}
  for (const q of queues) {
    const plan = buildPlan(forecasts[q.id] ?? [], q.aht, q, shrinkage, agents)
    variance[q.id] = plan[Math.min(nowIdx, plan.length - 1)]?.variance ?? 0
  }

  const deficits = queues.filter((q) => variance[q.id] < -MIN_IMBALANCE).sort((a, b) => variance[a.id] - variance[b.id])
  const surpluses = queues.filter((q) => variance[q.id] > MIN_IMBALANCE).sort((a, b) => variance[b.id] - variance[a.id])
  if (!deficits.length || !surpluses.length) return []

  const out: SkillChangeCandidate[] = []
  const used = new Set<string>()
  for (const short of deficits) {
    let need = Math.ceil(-variance[short.id])
    for (const spare of surpluses) {
      if (need <= 0) break
      const candidates = agents.filter(
        (a) => !used.has(a.id) && a.skills[0] === spare.id && !a.skills.includes(short.id),
      )
      for (const a of candidates) {
        if (need <= 0) break
        out.push({
          agentId: a.id,
          agentName: a.name,
          fromQueueId: spare.id,
          fromQueueName: spare.name,
          toQueueId: short.id,
          toQueueName: short.name,
          reason: `${short.name} short ${Math.abs(variance[short.id]).toFixed(1)} heads right now; ${spare.name} is running a ${variance[spare.id].toFixed(1)}-head surplus.`,
        })
        used.add(a.id)
        need--
      }
    }
  }
  return out.slice(0, 8)
}
