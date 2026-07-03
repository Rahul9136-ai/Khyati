// What-If Scenario engine. A scenario perturbs the live plan's inputs —
// volume, AHT, shrinkage, headcount — and re-runs the same Erlang C planning
// math so baseline and scenario are always computed identically.
import { buildPlan, summarisePlan } from "./planning"
import type { Agent, PlanSummary, Queue } from "./types"

export interface Scenario {
  id: string
  name: string
  /** Queue id, or "all" to apply across every queue. */
  queueId: string
  /** Relative volume change, e.g. +20 = 20% more contacts. */
  volumePct: number
  /** Relative AHT change, e.g. +10 = handles take 10% longer. */
  ahtPct: number
  /** Absolute shrinkage override in %, or null to keep the live setting. */
  shrinkagePct: number | null
  /** Agents added (+) or lost (−) among those skilled for the scope. */
  agentDelta: number
  createdAt: number
}

export interface QueueComparison {
  queue: Queue
  base: PlanSummary
  mod: PlanSummary
}

export interface ScenarioResult {
  scenario: Scenario
  perQueue: QueueComparison[]
  /** Volume-weighted SL across affected queues, baseline vs scenario. */
  baseSL: number
  modSL: number
  baseReqHours: number
  modReqHours: number
  baseSchedHours: number
  modSchedHours: number
  /** Positive = extra FTE needed to close the scenario's deficit. */
  fteGap: number
}

/** Add cloned agents (round-robin over those skilled for the queue) or drop
 *  skilled agents from the end of the roster. */
export function adjustAgents(agents: Agent[], queueId: string, delta: number): Agent[] {
  if (delta === 0) return agents
  const skilled = (a: Agent) => queueId === "all" || a.skills.includes(queueId)
  if (delta > 0) {
    const pool = agents.filter(skilled)
    if (pool.length === 0) return agents
    const clones = Array.from({ length: delta }, (_, i) => {
      const src = pool[i % pool.length]
      return { ...src, id: `${src.id}-sim${i}`, name: `${src.name} (sim)` }
    })
    return [...agents, ...clones]
  }
  let toDrop = -delta
  const out: Agent[] = []
  for (let i = agents.length - 1; i >= 0; i--) {
    if (toDrop > 0 && skilled(agents[i])) {
      toDrop--
      continue
    }
    out.unshift(agents[i])
  }
  return out
}

export function runScenario(
  sc: Scenario,
  queues: Queue[],
  forecasts: Record<string, number[]>,
  shrinkage: number,
  agents: Agent[],
): ScenarioResult {
  const affected = sc.queueId === "all" ? queues : queues.filter((q) => q.id === sc.queueId)
  const modShrink = sc.shrinkagePct == null ? shrinkage : sc.shrinkagePct / 100
  const modAgents = adjustAgents(agents, sc.queueId, sc.agentDelta)

  const perQueue: QueueComparison[] = affected.map((q) => {
    const baseVol = forecasts[q.id] ?? []
    const modVol = baseVol.map((v) => Math.round(v * (1 + sc.volumePct / 100)))
    const modAht = Math.round(q.aht * (1 + sc.ahtPct / 100))
    const base = summarisePlan(buildPlan(baseVol, q.aht, q, shrinkage, agents))
    const mod = summarisePlan(buildPlan(modVol, modAht, q, modShrink, modAgents))
    return { queue: q, base, mod }
  })

  const wsl = (rows: QueueComparison[], pick: (c: QueueComparison) => PlanSummary) => {
    const vol = rows.reduce((a, c) => a + pick(c).totalVol, 0)
    return vol ? rows.reduce((a, c) => a + pick(c).wSL * pick(c).totalVol, 0) / vol : 0
  }
  const baseReqHours = perQueue.reduce((a, c) => a + c.base.reqHours, 0)
  const modReqHours = perQueue.reduce((a, c) => a + c.mod.reqHours, 0)
  const baseSchedHours = perQueue.reduce((a, c) => a + c.base.schedHours, 0)
  const modSchedHours = perQueue.reduce((a, c) => a + c.mod.schedHours, 0)
  const deficit = modReqHours - modSchedHours

  return {
    scenario: sc,
    perQueue,
    baseSL: wsl(perQueue, (c) => c.base),
    modSL: wsl(perQueue, (c) => c.mod),
    baseReqHours,
    modReqHours,
    baseSchedHours,
    modSchedHours,
    fteGap: deficit > 0 ? Math.ceil(deficit / 8) : 0,
  }
}
