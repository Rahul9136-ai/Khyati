// Align schedules with agents' work rules (shift + break pattern, week offs)
// for a chosen period.
//
// * Online: dates nobody has saved yet are created from the rules first
//   (ensureSaved); saved days are rewritten with PUT /scheduling/day-plans/
//   {date}. Published days change live, so agents and their team leaders get
//   the usual "your schedule changed" pop-up; the period can be published too.
// * Offline: the selected date and any dates kept in this browser are
//   rewritten locally (other dates already follow the rules).
import { api, type ApiError } from "@/lib/api"
import { agentDay, dayToPatch, type AgentDay } from "@/lib/domain/channels"
import { datesBetween } from "@/lib/domain/horizon"
import { workedMinutes } from "@/lib/domain/labourLaw"
import type { Agent } from "@/lib/domain/types"
import { applyWorkRuleToDay, checkWorkDay, checkWorkWeeks, isWeekOff, parseWorkRulePatternId, WEEK_OFF_ID, type WorkIssue } from "@/lib/domain/workRules"
import { ensureSaved, publishSchedules } from "@/lib/schedulePublish"
import { dayFromServer, pull, toServerPlan, type ServerDayPlan } from "@/lib/scheduleSync"
import { scheduleForDate, useWfm } from "@/store/wfm"

type RangeRow = ServerDayPlan & { plan_date: string; version: number }

export interface ApplyResult {
  changed: number
  days: number
  /** Days someone saved in the meantime — left as they were. */
  conflicts: number
  created: number
  /** Agent-days published afterwards (when asked). */
  published: number
}

/** One agent-day the rules would change. */
export interface AlignChange {
  date: string
  agent: Agent
  before: AgentDay
  after: AgentDay
  /** Server version it was based on (undefined = only in this browser). */
  version?: number
  weekOffAdded: boolean
  weekOffRemoved: boolean
  shiftChanged: boolean
  breaksChanged: boolean
}

export interface AlignPreview {
  changes: AlignChange[]
  /** Per date: agent-days changing, week offs added / removed, shift / break moves. */
  byDate: { date: string; agents: number; offAdded: number; offRemoved: number; shifts: number; breaks: number }[]
  /** Agent-days in the period with no saved schedule — they're created from the rules. */
  unsaved: number
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

/** What the rules would change, given each agent-day as it is now. */
export function alignmentChanges(days: { date: string; agent: Agent; day: AgentDay; version?: number }[]): AlignChange[] {
  const s = useWfm.getState()
  const out: AlignChange[] = []
  for (const { date, agent: a, day: before, version } of days) {
    if (!ruleTarget(a, before)) continue
    const pattern = parseWorkRulePatternId(a.shiftPatternId) ? (s.shiftPatterns.find((p) => p.id === a.shiftPatternId) ?? null) : null
    const after = applyWorkRuleToDay(before, pattern, a.weekOff ?? [], date, a.weekOffMode)
    if (fingerprint(a, after) === fingerprint(a, before)) continue
    out.push({
      date,
      agent: a,
      before,
      after,
      version,
      weekOffAdded: isWeekOff(after) && !isWeekOff(before),
      weekOffRemoved: !isWeekOff(after) && isWeekOff(before),
      shiftChanged: after.shift[0] !== before.shift[0] || after.shift[1] !== before.shift[1],
      breaksChanged: JSON.stringify(after.breaks.map((b) => [b.type, b.start, b.end])) !== JSON.stringify(before.breaks.map((b) => [b.type, b.start, b.end])),
    })
  }
  return out
}

function summarise(changes: AlignChange[], unsaved: number): AlignPreview {
  const byDate = new Map<string, AlignPreview["byDate"][number]>()
  for (const c of changes) {
    const d = byDate.get(c.date) ?? { date: c.date, agents: 0, offAdded: 0, offRemoved: 0, shifts: 0, breaks: 0 }
    d.agents++
    if (c.weekOffAdded) d.offAdded++
    if (c.weekOffRemoved) d.offRemoved++
    if (c.shiftChanged) d.shifts++
    if (c.breaksChanged) d.breaks++
    byDate.set(c.date, d)
  }
  return { changes, byDate: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)), unsaved }
}

const pickAgents = (agentIds: string[] | null) => {
  const s = useWfm.getState()
  return new Map(s.agents.filter((a) => !agentIds || agentIds.includes(a.id)).map((a) => [a.id, a]))
}

/** Days this browser holds for the period: the selected date and parked ones. */
function localDays(start: string, end: string, agentIds: string[] | null) {
  const s = useWfm.getState()
  const agents = pickAgents(agentIds)
  const out: { date: string; agent: Agent; day: AgentDay }[] = []
  for (const date of datesBetween(start, end)) {
    if (date !== s.scheduleDate && !s.dayStore[date]) continue // follows the rules already
    const d = scheduleForDate(s, date)
    for (const a of d.agents) {
      if (!agents.has(a.id)) continue
      out.push({ date, agent: agents.get(a.id)!, day: agentDay(a, s.shiftPatterns, d.breakOverrides, d.channelPlan, d.overtimePlan, d.activityPlan) })
    }
  }
  return out
}

/** Preview the alignment without changing anything. */
export async function previewAlignment(start: string, end: string, agentIds: string[] | null, online: boolean): Promise<AlignPreview> {
  if (!online) return summarise(alignmentChanges(localDays(start, end, agentIds)), 0)
  const rows = await fetchRangeRows(start, end)
  const agents = pickAgents(agentIds)
  const s = useWfm.getState()
  const saved = new Set(rows.map((r) => `${r.plan_date}|${r.agent_key}`))
  const days: { date: string; agent: Agent; day: AgentDay; version?: number }[] = rows
    .filter((r) => agents.has(r.agent_key))
    .map((r) => ({ date: r.plan_date, agent: agents.get(r.agent_key)!, day: dayFromServer(r), version: r.version }))
  // Not saved yet: created from this browser's copy (parked edits, or the rules).
  let unsaved = 0
  for (const date of datesBetween(start, end)) {
    const d = scheduleForDate(s, date)
    for (const a of d.agents) {
      if (!agents.has(a.id) || saved.has(`${date}|${a.id}`)) continue
      unsaved++
      days.push({ date, agent: agents.get(a.id)!, day: agentDay(a, s.shiftPatterns, d.breakOverrides, d.channelPlan, d.overtimePlan, d.activityPlan) })
    }
  }
  return summarise(alignmentChanges(days), unsaved)
}

export async function applyWorkRules(
  start: string,
  end: string,
  agentIds: string[] | null,
  step: (s: string) => void = () => {},
  opts: { online?: boolean; publish?: boolean } = {},
): Promise<ApplyResult> {
  const online = opts.online ?? true
  if (!online) {
    const changes = alignmentChanges(localDays(start, end, agentIds))
    const byDate = new Map<string, AlignChange[]>()
    for (const c of changes) byDate.set(c.date, [...(byDate.get(c.date) ?? []), c])
    for (const [date, list] of byDate) {
      useWfm.getState().applyDayPatches(date, list.map((c) => ({ agentId: c.agent.id, patch: dayToPatch(c.after) })), "Aligned with work rules (shift, breaks, week offs)")
    }
    return { changed: changes.length, days: byDate.size, conflicts: 0, created: 0, published: 0 }
  }

  const created = await ensureSaved(start, end, step)
  step("Loading schedules…")
  const rows = await fetchRangeRows(start, end)
  const agents = pickAgents(agentIds)
  const changes = alignmentChanges(rows.filter((r) => agents.has(r.agent_key)).map((r) => ({ date: r.plan_date, agent: agents.get(r.agent_key)!, day: dayFromServer(r), version: r.version })))
  const byDate = new Map<string, ServerDayPlan[]>()
  for (const c of changes) {
    byDate.set(c.date, [...(byDate.get(c.date) ?? []), { ...toServerPlan(c.agent, c.after), base_version: c.version } as ServerDayPlan])
  }

  let changed = 0
  let conflicts = 0
  let i = 0
  for (const [date, items] of byDate) {
    step(`Aligning schedules with work rules… ${++i}/${byDate.size} days`)
    try {
      await api.put(`/scheduling/day-plans/${date}`, { items, detail: "Aligned with work rules (shift, breaks, week offs)" })
      changed += items.length
    } catch (e) {
      if ((e as ApiError).status !== 409) throw e
      conflicts++
    }
  }
  let published = 0
  if (opts.publish) {
    const res = await publishSchedules(start, end, { note: "Aligned with work rules", onProgress: step })
    published = res.published
  } else {
    await pull() // the selected day may have just changed
  }
  return { changed, days: byDate.size - conflicts, conflicts, created, published }
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
