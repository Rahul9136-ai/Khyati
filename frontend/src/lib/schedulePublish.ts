// Generating schedules for future weeks (as drafts) and publishing a date range
// of them to agents (POST /scheduling/day-plans/publish).
//
// The backend only publishes days it has. Dates nobody has opened yet exist
// only as shift-pattern defaults in the browser, so those are created first
// (POST /scheduling/day-plans/fill — never overwrites a saved day).
//
// How far ahead schedules have been generated is one organisation-wide setting
// (`schedule_horizon`), so everyone's scheduling window — the date bar, the
// overview and agents' My schedule — reaches the generated weeks.
import { useQuery } from "@tanstack/react-query"

import { api, type ApiError } from "@/lib/api"
import { agentDay } from "@/lib/domain/channels"
import { datesBetween, isISODate, localISODate, scheduleHorizon } from "@/lib/domain/horizon"
import { flush, pull, toServerPlan, useScheduleSync, type ServerDayPlan } from "@/lib/scheduleSync"
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

export interface GenerateResult {
  start: string
  end: string
  /** Agent-days created as drafts (days that already had a schedule are kept). */
  created: number
}

const FILL_CHUNK = 2000
const HORIZON_URL = "/scheduling/settings/schedule_horizon"

/** The last day schedules have been generated through, or null (never / not past 3 months). */
export async function fetchGeneratedThrough(): Promise<string | null> {
  try {
    const through = ((await api.get(HORIZON_URL)).data?.data?.value as { through?: string } | undefined)?.through
    return isISODate(through) ? through : null
  } catch (e) {
    if ((e as ApiError).status === 404) return null // never saved
    throw e
  }
}

/** The scheduling window, extended to the generated weeks when online. */
export function useScheduleHorizon(): { start: string; end: string } {
  const status = useScheduleSync((s) => s.status)
  const online = status !== "idle" && status !== "offline"
  const { data } = useQuery({ queryKey: ["schedule-horizon"], queryFn: fetchGeneratedThrough, enabled: online, staleTime: 60_000 })
  return scheduleHorizon(localISODate(), online ? data : null)
}

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

/** Save pending edits, then create every day in the range the server doesn't
 *  have yet from shift patterns (or this browser's parked edits). Returns how many. */
export async function ensureSaved(start: string, end: string, step: (s: string) => void = () => {}): Promise<number> {
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
  return created
}

/** Create draft schedules for every agent and day from `start` through `end`
 *  (from shift patterns / work rules, week offs included) and extend everyone's
 *  scheduling window to `end`. Nobody but schedulers sees them until published. */
export async function generateSchedules(
  start: string,
  end: string,
  opts: { onProgress?: (step: string) => void } = {},
): Promise<GenerateResult> {
  const step = opts.onProgress ?? (() => {})
  const created = await ensureSaved(start, end, step)
  const through = await fetchGeneratedThrough()
  if (!through || end > through) await api.put(HORIZON_URL, { value: { through: end } })
  return { start, end, created }
}

export async function publishSchedules(
  start: string,
  end: string,
  opts: { note?: string; onProgress?: (step: string) => void } = {},
): Promise<PublishResult> {
  const step = opts.onProgress ?? (() => {})
  const created = await ensureSaved(start, end, step)
  step("Publishing…")
  const res = await api.post("/scheduling/day-plans/publish", { start, end, note: opts.note ?? "" })
  await pull() // refresh the selected day's published flags
  return { ...(res.data.data as Omit<PublishResult, "created">), created }
}
