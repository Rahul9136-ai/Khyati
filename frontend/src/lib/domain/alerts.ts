// Proactive alerts engine. Recomputed on an interval by AutomationRunner
// (mounted once at the app root) so SL risk, adherence escalations, and
// pending-approval queues surface in the topbar bell from any page — not
// only when someone happens to have the Copilot or RTA page open.
import { escalationFor } from "./adherence"
import { recommendActions } from "./heal"
import { inAdherence } from "./seed"
import type { Agent, Queue, RtaEntry } from "./types"
import type { Thresholds } from "./automation"

export type AlertSeverity = "info" | "warning" | "critical"

export interface WfmAlert {
  id: string
  ts: number
  severity: AlertSeverity
  title: string
  detail: string
  to: string
}

export interface AlertInputs {
  queues: Queue[]
  forecasts: Record<string, number[]>
  shrinkage: number
  agents: Agent[]
  rta: RtaEntry[]
  nowIdx: number
  thresholds: Thresholds
  ptoPending: number
  swapsPending: number
  skillChangePending: number
}

export function computeAlerts(inp: AlertInputs): WfmAlert[] {
  const now = Date.now()
  const out: WfmAlert[] = []

  const actions = recommendActions(inp.queues, inp.forecasts, inp.shrinkage, inp.agents, inp.rta, inp.nowIdx)
  for (const a of actions) {
    out.push({
      id: `heal-${a.id}`,
      ts: now,
      severity: a.kind === "recall" ? "critical" : "warning",
      title: a.title,
      detail: `${a.queueName} · ${a.detail}`,
      to: "/copilot",
    })
  }

  const escalated = inp.rta.filter(
    (r) => escalationFor(!inAdherence(r.actual, r.scheduled), r.secs, inp.thresholds.graceMins, inp.thresholds.escalateMins) === "escalated",
  )
  if (escalated.length > 0) {
    out.push({
      id: "adherence-escalated",
      ts: now,
      severity: "warning",
      title: `${escalated.length} agent(s) escalated for adherence`,
      detail: `Out of adherence past ${inp.thresholds.escalateMins} min — review on the real-time wallboard.`,
      to: "/rta",
    })
  }

  if (inp.ptoPending > 0) {
    out.push({
      id: "pto-pending",
      ts: now,
      severity: "info",
      title: `${inp.ptoPending} leave request(s) awaiting approval`,
      detail: "Auto-approval passed these to a human — coverage surplus or the overlap cap wasn't met.",
      to: "/pto",
    })
  }

  if (inp.swapsPending > 0) {
    out.push({
      id: "swaps-pending",
      ts: now,
      severity: "info",
      title: `${inp.swapsPending} shift swap(s) awaiting approval`,
      detail: "Projected SL impact exceeded the auto-approve tolerance.",
      to: "/swaps",
    })
  }

  if (inp.skillChangePending > 0) {
    out.push({
      id: "skill-change-pending",
      ts: now,
      severity: "warning",
      title: `${inp.skillChangePending} skill re-balance recommendation(s)`,
      detail: "SL dropping or volume spiking on a queue — AI found agents who could flex over. Needs WFM + Ops approval.",
      to: "/rta",
    })
  }

  return out
}
