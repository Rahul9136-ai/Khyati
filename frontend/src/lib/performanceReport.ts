// Performance reports, by LOB or for one person, from what the tool really knows:
//   * schedules — hours, breaks, overtime, time off, work-rule compliance;
//   * attendance records — lates, early logouts, absences (matched by employee code);
//   * queue actuals — offered, handled, AHT, SL, occupancy (matched by queue name);
//   * the forecast plan — volume, required hours, projected SL, always labelled as such.
// Adherence stays out: its "actual" timeline is simulated until an ACD feed is
// connected (lib/domain/adherence.ts), and there is no per-agent contact data.
import { api } from "@/lib/api"
import { ACTIVITY_BY_ID, type AgentDay } from "@/lib/domain/channels"
import { workedMinutes } from "@/lib/domain/labourLaw"
import type { Agent, Queue } from "@/lib/domain/types"
import { checkWorkDay, checkWorkWeeks, WORK_CHECK_LABEL, type WorkCompliance } from "@/lib/domain/workRules"
import type { Row, Sheet } from "@/lib/export"
import type { QueueDay } from "@/lib/report-granularity"
import type { RangeDay } from "@/lib/workRuleApply"

export interface AttendanceRow {
  employee_code: string
  employee_name: string
  team: string
  lob: string
  date: string
  code: string
  category: string
  minutes_late: number
  minutes_early_logout: number
}

export interface QueueActualRow {
  lob: string
  queue: string
  channel: string
  date: string
  offered: number
  handled: number
  aht_seconds: number | null
  service_level_pct: number | null
  sl_target_pct: number
  occupancy_pct: number | null
}

export interface PerformanceActuals {
  attendance: AttendanceRow[]
  queues: QueueActualRow[]
}

export async function fetchPerformanceActuals(start: string, end: string): Promise<PerformanceActuals> {
  return (await api.get("/reports/performance-actuals", { params: { start, end } })).data.data as PerformanceActuals
}

export type DayStatus = "Working" | "Week off" | "Leave" | "Absence" | "LOA"
const WHOLE_DAY: Record<string, DayStatus> = { absence: "Absence", leave: "Leave", loa: "LOA", off: "Week off" }
const ABSENT = new Set(["absent", "sick"])
const hrs = (mins: number) => Math.round((mins / 60) * 100) / 100
const pct1 = (x: number) => Math.round(x * 1000) / 10

/** A day's status: a whole-shift absence / leave / LOA / week off, else working. */
export function dayStatus(day: AgentDay): DayStatus {
  for (const type of ["absence", "leave", "loa", "off"]) {
    if (day.activities.some((a) => a.type === type && a.start <= day.shift[0] && a.end >= day.shift[1])) return WHOLE_DAY[type]
  }
  return "Working"
}

const span = (items: { start: number; end: number }[]) => items.reduce((t, x) => t + x.end - x.start, 0)
const lobOf = (a: Agent, queues: Queue[]) => queues.find((q) => q.id === a.skills[0])?.name ?? "No LOB"

function dayMetrics(day: AgentDay) {
  const status = dayStatus(day)
  const working = status === "Working"
  const activity = (types: string[]) => (working ? span(day.activities.filter((a) => types.includes(a.type))) : 0)
  return {
    status,
    scheduled: working ? day.shift[1] - day.shift[0] : 0,
    worked: workedMinutes(day),
    breaks: working ? span(day.breaks) : 0,
    ot: span(day.ot),
    offPhone: activity(["meeting", "training", "coaching", "other"]),
    partOff: activity(["vto", "pto", "absence", "loa", "leave"]),
  }
}

export interface PersonSummary {
  agent: Agent
  lob: string
  days: number
  /** Days that are only the plan: no schedule was ever saved for them. */
  notSaved: number
  working: number
  weekOff: number
  leave: number
  absence: number
  scheduledMins: number
  workedMins: number
  breakMins: number
  otMins: number
  offPhoneMins: number
  partOffMins: number
  issues: number
  /** null = no attendance records for this person in the period. */
  attendance: { records: number; absent: number; late: number; lateMins: number; earlyMins: number } | null
}

const attendanceOf = (agent: Agent, rows: AttendanceRow[]) => rows.filter((r) => r.employee_code.toLowerCase() === agent.id.toLowerCase())

export function summarisePerson(agent: Agent, days: RangeDay[], queues: Queue[], attendance: AttendanceRow[], c: WorkCompliance): PersonSummary {
  const m = days.map((d) => dayMetrics(d.day))
  const sum = (f: (x: (typeof m)[number]) => number) => m.reduce((t, x) => t + f(x), 0)
  const count = (s: DayStatus) => m.filter((x) => x.status === s).length
  const mine = attendanceOf(agent, attendance)
  return {
    agent,
    lob: lobOf(agent, queues),
    days: days.length,
    notSaved: days.filter((d) => d.source === "planned").length,
    working: count("Working"),
    weekOff: count("Week off"),
    leave: count("Leave") + count("LOA"),
    absence: count("Absence"),
    scheduledMins: sum((x) => x.scheduled),
    workedMins: sum((x) => x.worked),
    breakMins: sum((x) => x.breaks),
    otMins: sum((x) => x.ot),
    offPhoneMins: sum((x) => x.offPhone),
    partOffMins: sum((x) => x.partOff),
    issues: days.reduce((t, d) => t + checkWorkDay(d.day, c).length, 0) + checkWorkWeeks(days, c).length,
    attendance: mine.length
      ? {
          records: mine.length,
          absent: mine.filter((r) => ABSENT.has(r.category)).length,
          late: mine.filter((r) => r.minutes_late > 0).length,
          lateMins: mine.reduce((t, r) => t + r.minutes_late, 0),
          earlyMins: mine.reduce((t, r) => t + r.minutes_early_logout, 0),
        }
      : null,
  }
}

const personRow = (p: PersonSummary): Row => ({
  "Agent ID": p.agent.id,
  Agent: p.agent.name,
  Team: p.agent.team,
  "Team leader": p.agent.tl,
  LOB: p.lob,
  "Days in period": p.days,
  "Days not saved (plan only)": p.notSaved,
  "Working days": p.working,
  "Week offs": p.weekOff,
  "Leave days": p.leave,
  "Absence days": p.absence,
  "Scheduled hours": hrs(p.scheduledMins),
  "Planned work hours": hrs(p.workedMins),
  "Break hours": hrs(p.breakMins),
  "Overtime hours": hrs(p.otMins),
  "Meetings & training hours": hrs(p.offPhoneMins),
  "Part-day time off hours": hrs(p.partOffMins),
  "Compliance issues": p.issues,
  "Attendance records": p.attendance?.records ?? "No records",
  "Absences recorded": p.attendance?.absent ?? "No records",
  "Late days": p.attendance?.late ?? "No records",
  "Minutes late": p.attendance?.lateMins ?? "No records",
  "Minutes early logout": p.attendance?.earlyMins ?? "No records",
})

function aboutSheet(title: string, scope: string, start: string, end: string, notes: string[]): Sheet {
  return {
    name: "About this report",
    rows: [
      { Item: "Report", Detail: title },
      { Item: "Scope", Detail: scope },
      { Item: "Period", Detail: `${start} to ${end}` },
      { Item: "Created", Detail: new Date().toLocaleString() },
      ...notes.map((Detail) => ({ Item: "Note", Detail })),
    ],
  }
}

const COMMON_NOTES = [
  "Hours come from schedules: what was planned, not time actually worked or logged by a phone system.",
  "Adherence and per-agent calls / AHT aren't included: they need a phone-system (ACD) feed. The tool's adherence scores are simulated until one is connected.",
]

export interface ReportInput {
  start: string
  end: string
  agents: Agent[]
  queues: Queue[]
  days: Map<string, RangeDay[]>
  compliance: WorkCompliance
  actuals: PerformanceActuals | null
}

function statusNote(input: ReportInput): string[] {
  const out: string[] = []
  if (!input.actuals) out.push("Attendance and queue actuals couldn't be loaded, so they're left out.")
  const planned = input.agents.some((a) => (input.days.get(a.id) ?? []).some((d) => d.source === "planned"))
  if (planned) out.push("Rows with source 'Planned' aren't saved schedules yet: they come from each agent's work rule or shift pattern.")
  return out
}

/** Everything about one person: summary, each day, compliance issues, attendance. */
export function personReport(input: ReportInput, agent: Agent): { summary: PersonSummary; sheets: Sheet[] } {
  const days = input.days.get(agent.id) ?? []
  const attendance = input.actuals?.attendance ?? []
  const summary = summarisePerson(agent, days, input.queues, attendance, input.compliance)
  const daily: Row[] = days.map(({ date, day, source }) => {
    const m = dayMetrics(day)
    const whole = m.status !== "Working"
    return {
      Date: date,
      Status: m.status,
      "Shift start": whole ? "" : minsLabel(day.shift[0]),
      "Shift end": whole ? "" : minsLabel(day.shift[1]),
      "Scheduled hours": hrs(m.scheduled),
      "Planned work hours": hrs(m.worked),
      "Break hours": hrs(m.breaks),
      "Overtime hours": hrs(m.ot),
      Activities: day.activities.map((a) => ACTIVITY_BY_ID[a.type]?.label ?? a.type).join(", "),
      Issues: checkWorkDay(day, input.compliance).map((i) => i.message).join("; "),
      Source: source[0].toUpperCase() + source.slice(1),
    }
  })
  const issues: Row[] = [
    ...days.flatMap(({ date, day }) => checkWorkDay(day, input.compliance).map((i) => ({ Date: date, Rule: WORK_CHECK_LABEL[i.rule], Detail: i.message }))),
    ...checkWorkWeeks(days, input.compliance).map((i) => ({ Date: i.date ?? "", Rule: WORK_CHECK_LABEL[i.rule], Detail: i.message })),
  ].sort((a, b) => String(a.Date).localeCompare(String(b.Date)))
  const att: Row[] = attendanceOf(agent, attendance).map((r) => ({
    Date: r.date, Code: r.code, Category: r.category, "Minutes late": r.minutes_late, "Minutes early logout": r.minutes_early_logout,
  }))
  return {
    summary,
    sheets: [
      aboutSheet("Performance report: person", `${agent.name} (${agent.id})`, input.start, input.end, [...COMMON_NOTES, ...statusNote(input)]),
      { name: "Summary", rows: [personRow(summary)] },
      { name: "Daily detail", rows: daily },
      { name: "Compliance issues", rows: issues },
      { name: "Attendance", rows: att },
    ],
  }
}

export interface LobSummary {
  lob: string
  agents: number
  scheduledMins: number
  workedMins: number
  otMins: number
  leave: number
  absence: number
  weekOff: number
  issues: number
  lateMins: number
  /** Forecast plan for the period. */
  volume: number
  requiredHours: number
  projectedSl: number
  projectedOcc: number
}

/** One or all LOBs: totals, a row per day, everyone in it, and queue actuals. */
export function lobReport(input: ReportInput, planned: QueueDay[], lobId: string | null): { rows: LobSummary[]; people: PersonSummary[]; sheets: Sheet[]; actualRows: number } {
  const queues = lobId ? input.queues.filter((q) => q.id === lobId) : input.queues
  const attendance = input.actuals?.attendance ?? []
  const peopleIn = (q: Queue) => input.agents.filter((a) => a.skills[0] === q.id)
  const summaries = new Map(input.agents.map((a) => [a.id, summarisePerson(a, input.days.get(a.id) ?? [], input.queues, attendance, input.compliance)]))

  const rows: LobSummary[] = queues.map((q) => {
    const people = peopleIn(q).map((a) => summaries.get(a.id)!)
    const plan = planned.filter((p) => p.queue.id === q.id)
    const volume = plan.reduce((t, p) => t + p.sum.totalVol, 0)
    const add = (f: (p: PersonSummary) => number) => people.reduce((t, p) => t + f(p), 0)
    return {
      lob: q.name,
      agents: people.length,
      scheduledMins: add((p) => p.scheduledMins),
      workedMins: add((p) => p.workedMins),
      otMins: add((p) => p.otMins),
      leave: add((p) => p.leave),
      absence: add((p) => p.absence),
      weekOff: add((p) => p.weekOff),
      issues: add((p) => p.issues),
      lateMins: add((p) => p.attendance?.lateMins ?? 0),
      volume,
      requiredHours: plan.reduce((t, p) => t + p.sum.reqHours, 0),
      projectedSl: volume ? plan.reduce((t, p) => t + p.sum.wSL * p.sum.totalVol, 0) / volume : 0,
      projectedOcc: plan.length ? plan.reduce((t, p) => t + p.sum.avgOcc, 0) / plan.length : 0,
    }
  })

  const summaryRows: Row[] = rows.map((r) => ({
    LOB: r.lob,
    Agents: r.agents,
    "Scheduled hours": hrs(r.scheduledMins),
    "Planned work hours": hrs(r.workedMins),
    "Overtime hours": hrs(r.otMins),
    "Week off days": r.weekOff,
    "Leave days": r.leave,
    "Absence days": r.absence,
    "Compliance issues": r.issues,
    "Minutes late (recorded)": r.lateMins,
    "Forecast volume": Math.round(r.volume),
    "Required hours (forecast)": Math.round(r.requiredHours * 10) / 10,
    "Projected SL %": pct1(r.projectedSl),
    "Projected occupancy %": pct1(r.projectedOcc),
  }))

  const dailyRows: Row[] = []
  for (const q of queues) {
    const people = peopleIn(q)
    for (const p of planned.filter((x) => x.queue.id === q.id)) {
      const today = people.flatMap((a) => (input.days.get(a.id) ?? []).filter((d) => d.date === p.key))
      const m = today.map((d) => dayMetrics(d.day))
      dailyRows.push({
        Date: p.key,
        LOB: q.name,
        "Agents working": m.filter((x) => x.status === "Working").length,
        "Week off": m.filter((x) => x.status === "Week off").length,
        "On leave": m.filter((x) => x.status === "Leave" || x.status === "LOA").length,
        Absent: m.filter((x) => x.status === "Absence").length,
        "Planned work hours": hrs(m.reduce((t, x) => t + x.worked, 0)),
        "Overtime hours": hrs(m.reduce((t, x) => t + x.ot, 0)),
        "Forecast volume": Math.round(p.sum.totalVol),
        "Required hours (forecast)": Math.round(p.sum.reqHours * 10) / 10,
        "Projected SL %": pct1(p.sum.wSL),
      })
    }
  }

  const names = new Set(queues.map((q) => q.name.toLowerCase()))
  const actualRows = (input.actuals?.queues ?? []).filter((r) => !lobId || names.has(r.queue.toLowerCase()) || names.has(r.lob.toLowerCase()))
  const actualSheet: Row[] = actualRows.map((r) => ({
    Date: r.date,
    LOB: r.lob,
    Queue: r.queue,
    Channel: r.channel,
    Offered: r.offered,
    Handled: r.handled,
    "Not handled": Math.round((r.offered - r.handled) * 10) / 10,
    "AHT (sec)": r.aht_seconds,
    "SL %": r.service_level_pct,
    "SL target %": r.sl_target_pct,
    "Occupancy %": r.occupancy_pct,
  }))

  const people = queues.flatMap((q) => peopleIn(q)).map((a) => summaries.get(a.id)!)
  const scope = lobId ? (queues[0]?.name ?? "LOB") : "All LOBs"
  return {
    rows,
    people,
    actualRows: actualRows.length,
    sheets: [
      aboutSheet("Performance report: LOB", scope, input.start, input.end, [
        ...COMMON_NOTES,
        "Each agent counts under their primary skill's LOB, so multi-skilled agents' hours appear once.",
        "Forecast volume, required hours and projected SL / occupancy are forecasts from the current roster, not results. Recorded results are on the 'Queue actuals' sheet.",
        ...statusNote(input),
      ]),
      { name: "LOB summary", rows: summaryRows },
      { name: "LOB daily", rows: dailyRows },
      { name: "Agents", rows: people.map(personRow) },
      { name: "Queue actuals", rows: actualSheet },
    ],
  }
}

function minsLabel(m: number) {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
}
