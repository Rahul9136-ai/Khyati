// Auto-plan Phone / Chat / Email for future weeks and hold the result as
// server-side drafts (/api/v1/scheduling/channel-drafts) until a scheduler
// publishes them — only then do agents and team leaders see the changes.
import { api } from "@/lib/api"
import { describeLanes, planChannelDay, type ChannelPlanOptions } from "@/lib/domain/channelPlanner"
import { toMins, type ChannelSegment } from "@/lib/domain/channels"
import { buildPlan } from "@/lib/domain/planning"
import { INTERVALS } from "@/lib/domain/seed"
import { ensureSaved } from "@/lib/schedulePublish"
import { dayFromServer, pull, type ServerDayPlan } from "@/lib/scheduleSync"
import { useWfm } from "@/store/wfm"

export interface ChannelDraft {
  plan_date: string
  agent_key: string
  agent_name: string
  channels: ChannelSegment[]
  base_version: number
  summary: string
}

export interface DayPlanStats {
  date: string
  agents: number
  changed: number
  /** Head-hours short over the day, before → after (see ChannelDayPlan). */
  phoneGap: { before: number; after: number }
  chatGap: { before: number; after: number }
}

export interface ChannelPublishResult {
  applied: number
  stale: { agent_key: string; reason: string }[]
  published_days: number
  notified: number
}

export const DRAFTS_KEY = ["channel-drafts"] as const
export const FIRST_INTERVAL = INTERVALS.length ? toMins(INTERVALS[0].label) : 7 * 60

/** Heads needed on the phones per 30-min interval: every queue's Erlang
 *  requirement added up, *before* shrinkage — the planner only counts agents
 *  who are actually free (not on a break, meeting or time off), so adding the
 *  shrinkage allowance on top would count those absences twice. Forecast-driven,
 *  the same daily profile for each date. */
export function phoneRequirement(): number[] {
  const s = useWfm.getState()
  const need = INTERVALS.map(() => 0)
  for (const q of s.queues) {
    buildPlan(s.forecasts[q.id] ?? [], q.aht, q, s.shrinkage, s.agents).forEach((r, i) => {
      if (i < need.length) need[i] += r.requiredNet
    })
  }
  return need
}

export async function fetchDrafts(start: string, end: string): Promise<ChannelDraft[]> {
  return (await api.get("/scheduling/channel-drafts", { params: { start, end } })).data.data as ChannelDraft[]
}

/** Plan every day in [start, end] and save the agent-days that change as drafts
 *  (replacing earlier drafts in the range). Nothing is visible to agents yet. */
export async function planChannels(
  start: string,
  end: string,
  opts: ChannelPlanOptions,
  step: (s: string) => void = () => {},
): Promise<{ stats: DayPlanStats[]; drafts: number; created: number }> {
  const created = await ensureSaved(start, end, step)
  step("Loading schedules…")
  const rows = (await api.get("/scheduling/day-plans/range", { params: { start, end } })).data.data as (ServerDayPlan & { plan_date: string; version: number })[]
  const need = phoneRequirement()
  const byDate = new Map<string, typeof rows>()
  for (const r of rows) byDate.set(r.plan_date, [...(byDate.get(r.plan_date) ?? []), r])

  step("Planning Phone / Chat / Email…")
  const stats: DayPlanStats[] = []
  const items: ChannelDraft[] = []
  for (const [date, dayRows] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
    const plan = planChannelDay(dayRows.map((r) => ({ key: r.agent_key, day: dayFromServer(r) })), need, FIRST_INTERVAL, opts)
    const changed = plan.agents.filter((a) => a.changed)
    stats.push({ date, agents: dayRows.length, changed: changed.length, phoneGap: plan.phoneGap, chatGap: plan.chatGap })
    for (const a of changed) {
      const row = dayRows.find((r) => r.agent_key === a.key)!
      items.push({
        plan_date: date,
        agent_key: a.key,
        agent_name: row.agent_name,
        channels: a.after,
        base_version: row.version,
        summary: `${describeLanes(a.before)} → ${describeLanes(a.after)}`.slice(0, 500),
      })
    }
  }
  step(`Saving ${items.length} planned change${items.length === 1 ? "" : "s"} as a draft…`)
  await api.put("/scheduling/channel-drafts", { start, end, items })
  return { stats, drafts: items.length, created }
}

export async function publishChannelDrafts(start: string, end: string): Promise<ChannelPublishResult> {
  const res = (await api.post("/scheduling/channel-drafts/publish", { start, end })).data.data as ChannelPublishResult
  await pull() // the selected day may have just changed
  return res
}

export async function discardChannelDrafts(start: string, end: string): Promise<number> {
  return ((await api.post("/scheduling/channel-drafts/discard", { start, end })).data.data as { discarded: number }).discarded
}
