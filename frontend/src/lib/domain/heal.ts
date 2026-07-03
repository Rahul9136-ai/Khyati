// Self-healing intraday engine. Scans the live plan for queues missing their
// SL target *right now* and proposes concrete, executable recovery actions
// with an honest Erlang C before/after projection.
import { serviceLevel } from "./erlang"
import { buildPlan } from "./planning"
import { AUX_BY_CODE } from "./seed"
import type { Agent, Queue, RtaEntry } from "./types"

export type HealKind = "recall" | "notify"

export interface HealAction {
  id: string
  kind: HealKind
  queueId: string
  queueName: string
  queueColor: string
  title: string
  detail: string
  agentIds: string[]
  agentNames: string[]
  slBefore: number
  slAfter: number
  slTarget: number
}

export function recommendActions(
  queues: Queue[],
  forecasts: Record<string, number[]>,
  shrinkage: number,
  agents: Agent[],
  rta: RtaEntry[],
  nowIdx: number,
): HealAction[] {
  const actions: HealAction[] = []
  const rtaById: Record<string, RtaEntry> = Object.fromEntries(rta.map((r) => [r.id, r]))

  for (const q of queues) {
    const plan = buildPlan(forecasts[q.id] ?? [], q.aht, q, shrinkage, agents)
    const row = plan[Math.min(nowIdx, plan.length - 1)]
    if (!row) continue

    // Effective staffing right now = scheduled net + skilled agents already
    // recalled off break — otherwise every applied recall would immediately
    // re-trigger the same proposal for the next batch of agents.
    const recalledBoost = agents.filter((a) => a.skills.includes(q.id) && rtaById[a.id]?.recalled).length
    const schedNet = Math.round(row.scheduled * (1 - shrinkage)) + recalledBoost
    const slNow = serviceLevel(schedNet, row.intensity, q.aht, q.targetTime)
    if (slNow >= q.slTarget) continue

    // 1) Recall skilled agents currently on a deferrable AUX (break/meeting/coaching).
    const candidates = agents.filter((a) => {
      if (!a.skills.includes(q.id)) return false
      const r = rtaById[a.id]
      return !!r && !r.recalled && !!AUX_BY_CODE[r.actual]?.deferrable
    })
    if (candidates.length > 0) {
      const deficit = Math.max(1, -(row.variance + recalledBoost))
      const take = candidates.slice(0, Math.min(deficit, candidates.length, 5))
      const slAfter = serviceLevel(schedNet + take.length, row.intensity, q.aht, q.targetTime)
      actions.push({
        id: `recall-${q.id}`,
        kind: "recall",
        queueId: q.id,
        queueName: q.name,
        queueColor: q.color,
        title: `Recall ${take.length} agent${take.length > 1 ? "s" : ""} from deferrable AUX`,
        detail: take.map((a) => `${a.name} (${AUX_BY_CODE[rtaById[a.id].actual]?.label})`).join(", "),
        agentIds: take.map((a) => a.id),
        agentNames: take.map((a) => a.name),
        slBefore: slNow,
        slAfter,
        slTarget: q.slTarget,
      })
    }

    // 2) Flag out-of-adherence agents (offline while scheduled productive) to their TL.
    const offenders = agents.filter((a) => {
      if (a.skills[0] !== q.id) return false
      const r = rtaById[a.id]
      if (!r) return false
      return AUX_BY_CODE[r.scheduled]?.cat === "productive" && AUX_BY_CODE[r.actual]?.cat === "offline"
    })
    if (offenders.length > 0) {
      actions.push({
        id: `notify-${q.id}`,
        kind: "notify",
        queueId: q.id,
        queueName: q.name,
        queueColor: q.color,
        title: `Flag ${offenders.length} out-of-adherence agent${offenders.length > 1 ? "s" : ""} to their TL`,
        detail: offenders.map((a) => `${a.name} → ${a.tl}`).join(", "),
        agentIds: offenders.map((a) => a.id),
        agentNames: offenders.map((a) => a.name),
        slBefore: slNow,
        slAfter: slNow,
        slTarget: q.slTarget,
      })
    }
  }
  return actions
}
