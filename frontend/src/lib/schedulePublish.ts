// Publishing a date range of schedules to agents (POST /scheduling/day-plans/publish).
//
// The backend only publishes days it has. Dates nobody has opened yet exist
// only as shift-pattern defaults in the browser, so those are created first
// (POST /scheduling/day-plans/fill — never overwrites a saved day).
import { api } from "@/lib/api"
import { agentDay } from "@/lib/domain/channels"
import { datesBetween } from "@/lib/domain/horizon"
import { flush, pull, toServerPlan, type ServerDayPlan } from "@/lib/scheduleSync"
import { scheduleForDate, useWfm } from "@/store/wfm"

/** One agent-day in the multi-week overview (GET /scheduling/day-plans). */
export interface DaySummary {
  plan_date: string
  agent_key: string
  agent_name: string
  team: string
  shift_start: number
  shift_end: number
  ot_minutes: number
  activities: string[]
  version: number
  published: boolean
}

export interface PublishResult {
  start: string
  end: string
  days: number
  agents: number
  published: number
  unchanged: number
  notified: number
  /** Days created from shift-pattern defaults before publishing. */
  created: number
}

const FILL_CHUNK = 2000

export async function fetchRange(start: string, end: string): Promise<DaySummary[]> {
  const res = await api.get("/scheduling/day-plans", { params: { start, end } })
  return res.data.data as DaySummary[]
}

/** Every agent's day for every date in the range that the server doesn't have yet. */
export function missingDays(start: string, end: string, saved: Set<string>): (ServerDayPlan & { plan_date: string })[] {
  const s = useWfm.getState()
  const out: (ServerDayPlan & { plan_date: string })[] = []
  for (const date of datesBetween(start, end)) {
    const d = scheduleForDate(s, date)
    for (const a of d.agents) {
      if (saved.has(`${date}|${a.id}`)) continue
      const day = agentDay(a, s.shiftPatterns, d.breakOverrides, d.channelPlan, d.overtimePlan, d.activityPlan)
      out.push({ ...toServerPlan(a, day), plan_date: date })
    }
  }
  return out
}

export async function publishSchedules(
  start: string,
  end: string,
  opts: { note?: string; onProgress?: (step: string) => void } = {},
): Promise<PublishResult> {
  const step = opts.onProgress ?? (() => {})
  step("Saving pending changes…")
  await flush()
  const saved = new Set((await fetchRange(start, end)).map((r) => `${r.plan_date}|${r.agent_key}`))
  const todo = missingDays(start, end, saved)
  let created = 0
  for (let i = 0; i < todo.length; i += FILL_CHUNK) {
    step(`Creating schedules from shift patterns… ${Math.min(i + FILL_CHUNK, todo.length)}/${todo.length}`)
    const res = await api.post("/scheduling/day-plans/fill", { items: todo.slice(i, i + FILL_CHUNK) })
    created += (res.data.data as { created: number }).created
  }
  step("Publishing…")
  const res = await api.post("/scheduling/day-plans/publish", { start, end, note: opts.note ?? "" })
  await pull() // refresh the selected day's published flags
  return { ...(res.data.data as Omit<PublishResult, "created">), created }
}
