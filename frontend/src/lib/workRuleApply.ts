// Write agents' work rules (shift + break pattern, week offs) into the saved
// schedules for a date range. Dates nobody has opened yet are created from
// the rules first (ensureSaved); saved days are rewritten with PUT
// /scheduling/day-plans/{date}. Published days change live, so agents and
// their team leaders get the usual "your schedule changed" pop-up.
import { api, type ApiError } from "@/lib/api"
import { agentDay, type AgentDay } from "@/lib/domain/channels"
import { datesBetween } from "@/lib/domain/horizon"
import { workedMinutes } from "@/lib/domain/labourLaw"
import type { Agent } from "@/lib/domain/types"
import { applyWorkRuleToDay, checkWorkDay, checkWorkWeeks, parseWorkRulePatternId, WEEK_OFF_ID, type WorkIssue } from "@/lib/domain/workRules"
import { ensureSaved } from "@/lib/schedulePublish"
import { dayFromServer, pull, toServerPlan, type ServerDayPlan } from "@/lib/scheduleSync"
import { scheduleForDate, useWfm } from "@/store/wfm"

type RangeRow = ServerDayPlan & { plan_date: string; version: number }

export interface ApplyResult {
  changed: number
  days: number
  /** Days someone saved in the meantime — left as they were. */
  conflicts: number
  created: number
}

const fingerprint = (a: Agent, d: AgentDay) => JSON.stringify(toServerPlan(a, d))

/** Agents whose saved days the rules touch: on a rule, given week offs, or
 *  carrying a week off that may now be stale. */
function ruleTarget(a: Agent, day: AgentDay): boolean {
  return !!parseWorkRulePatternId(a.shiftPatternId) || a.weekOff !== undefined || day.activities.some((x) => x.id === WEEK_OFF_ID)
}

export async function fetchRangeRows(start: string, end: string): Promise<RangeRow[]> {
  return (await api.get("/scheduling/day-plans/range", { params: { start, end } })).data.data as RangeRow[]
}

export async function applyWorkRules(
  start: string,
  end: string,
  agentIds: string[] | null,
  step: (s: string) => void = () => {},
): Promise<ApplyResult> {
  const created = await ensureSaved(start, end, step)
  step("Loading schedules…")
  const rows = await fetchRangeRows(start, end)
  const s = useWfm.getState()
  const agents = new Map(s.agents.filter((a) => !agentIds || agentIds.includes(a.id)).map((a) => [a.id, a]))
  const byDate = new Map<string, ServerDayPlan[]>()
  for (const r of rows) {
    const a = agents.get(r.agent_key)
    if (!a) continue
    const before = dayFromServer(r)
    if (!ruleTarget(a, before)) continue
    const pattern = parseWorkRulePatternId(a.shiftPatternId) ? (s.shiftPatterns.find((p) => p.id === a.shiftPatternId) ?? null) : null
    const after = applyWorkRuleToDay(before, pattern, a.weekOff ?? [], r.plan_date, a.weekOffMode)
    if (fingerprint(a, after) === fingerprint(a, before)) continue
    byDate.set(r.plan_date, [...(byDate.get(r.plan_date) ?? []), { ...toServerPlan(a, after), base_version: r.version } as ServerDayPlan])
  }

  let changed = 0
  let conflicts = 0
  let i = 0
  for (const [date, items] of byDate) {
    step(`Writing work rules into schedules… ${++i}/${byDate.size} days`)
    try {
      await api.put(`/scheduling/day-plans/${date}`, { items, detail: "Work rule applied (shift, breaks, week offs)" })
      changed += items.length
    } catch (e) {
      if ((e as ApiError).status !== 409) throw e
      conflicts++
    }
  }
  await pull() // the selected day may have just changed
  return { changed, days: byDate.size - conflicts, conflicts, created }
}

export interface AgentCompliance {
  agent: Agent
  issues: WorkIssue[]
  /** Days off in the range. */
  daysOff: number
  workedMinutes: number
}

/** Every agent's days in the range against the daily and weekly work-rule
 *  checks — saved schedules where the server has them, else this browser's. */
export function rangeCompliance(start: string, end: string, saved: RangeRow[] = []): AgentCompliance[] {
  const s = useWfm.getState()
  const savedBy = new Map(saved.map((r) => [`${r.plan_date}|${r.agent_key}`, r]))
  const perAgent = new Map<string, { date: string; day: AgentDay }[]>(s.agents.map((a) => [a.id, []]))
  for (const date of datesBetween(start, end)) {
    const d = scheduleForDate(s, date)
    for (const a of d.agents) {
      const row = savedBy.get(`${date}|${a.id}`)
      const day = row ? dayFromServer(row) : agentDay(a, s.shiftPatterns, d.breakOverrides, d.channelPlan, d.overtimePlan, d.activityPlan)
      perAgent.get(a.id)!.push({ date, day })
    }
  }
  const c = s.workCompliance
  return s.agents.map((agent) => {
    const days = perAgent.get(agent.id)!
    const daily = days.flatMap(({ date, day }) => checkWorkDay(day, c).map((i) => ({ ...i, date })))
    const off = days.filter(({ day }) => day.activities.some((x) => x.type === "off"))
    return {
      agent,
      issues: [...daily, ...checkWorkWeeks(days, c)].sort((x, y) => (x.date ?? "").localeCompare(y.date ?? "")),
      daysOff: off.length,
      workedMinutes: days.reduce((t, { day }) => t + workedMinutes(day), 0), // a week off counts 0
    }
  })
}
