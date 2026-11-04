// Interval outcomes on the coverage actually there — contacts handled,
// abandoned, ASA and SL:
//   * intervals before "now": the actual volume on the scheduled heads,
//   * the current interval: the actual volume on the agents who are on queue
//     right now (Available / ACW on the Real-Time Monitor), so recalling
//     someone from break moves the numbers at once,
//   * the rest of the day: forecast volume on the schedule.
// Abandonment and waits come from Erlang A; SL from Erlang C as elsewhere.
import { erlangA, serviceLevel, trafficIntensity } from "@/lib/domain/erlang"
import { AUX_BY_CODE } from "@/lib/domain/seed"
import type { Agent, Queue, RtaEntry } from "@/lib/domain/types"

/** Mean time a caller waits before hanging up (Erlang A patience), seconds. */
export const PATIENCE_SECS = 120

export type IntervalPhase = "actual" | "live" | "projected"

export interface IntervalOutcome {
  phase: IntervalPhase
  /** Contacts offered: actual so far, forecast from now on. */
  offered: number
  /** Heads answering: net on-duty heads, or live on-queue agents for "live". */
  heads: number
  handled: number
  abandoned: number
  abandonRate: number
  /** Mean seconds in queue per offered contact. */
  asa: number
  sl: number
}

/** Agents skilled for the queue, each with their live state from the Real-Time Monitor. */
export function liveAgentStates(rta: RtaEntry[], agents: Agent[], queueId: string) {
  const byId = new Map(rta.map((r) => [r.id, r]))
  return agents
    .filter((a) => a.skills.includes(queueId))
    .map((a) => {
      const r = byId.get(a.id)
      const aux = r ? AUX_BY_CODE[r.actual] : undefined
      return { agent: a, aux, onQueue: aux?.cat === "productive" }
    })
}

export function intervalOutcomes(opts: {
  queue: Queue
  forecast: number[]
  /** Actual volume per interval (null = not happened yet). */
  actuals: (number | null)[]
  /** Scheduled heads on duty per interval (after breaks / activities). */
  onDuty: number[]
  shrinkage: number
  /** The current interval, or null when the day isn't today (all projected). */
  nowIdx: number | null
  /** Agents on queue right now — used for the current interval. */
  liveHeads: number
  patience?: number
}): IntervalOutcome[] {
  const { queue, forecast, actuals, onDuty, shrinkage, nowIdx, liveHeads, patience = PATIENCE_SECS } = opts
  return forecast.map((fc, i) => {
    const phase: IntervalPhase = nowIdx === null || i > nowIdx ? "projected" : i === nowIdx ? "live" : "actual"
    const offered = phase === "projected" ? fc : actuals[i] ?? fc
    const heads = phase === "live" ? liveHeads : Math.round((onDuty[i] ?? 0) * (1 - shrinkage))
    const { abandon, wait } = erlangA(heads, offered, queue.aht, patience)
    const abandoned = Math.round(offered * abandon)
    return {
      phase,
      offered,
      heads,
      handled: offered - abandoned,
      abandoned,
      abandonRate: offered ? abandoned / offered : 0,
      asa: wait,
      sl: serviceLevel(heads, trafficIntensity(offered, queue.aht, 1800), queue.aht, queue.targetTime),
    }
  })
}

/** Totals over the intervals so far (actual + live): handled, abandoned and offered-weighted ASA. */
export function soFar(rows: IntervalOutcome[]) {
  const done = rows.filter((r) => r.phase !== "projected")
  const offered = done.reduce((t, r) => t + r.offered, 0)
  const handled = done.reduce((t, r) => t + r.handled, 0)
  const abandoned = done.reduce((t, r) => t + r.abandoned, 0)
  const asa = offered ? done.reduce((t, r) => t + r.asa * r.offered, 0) / offered : 0
  return { offered, handled, abandoned, abandonRate: offered ? abandoned / offered : 0, asa }
}
