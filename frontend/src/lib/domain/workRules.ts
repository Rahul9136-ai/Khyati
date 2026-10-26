// Work rules: what an agent's working week looks like — shift length, the
// break pattern inside it (e.g. 8h with one 30-min lunch and two 15-min
// breaks) and the weekly days off — plus the organisation's compliance rules
// (a break in every shift of 3h+, never more than 3h in a row without one,
// a lunch on long shifts, days off, weekly hours, rest between shifts).
//
// A rule assigned to an agent at a start time becomes a generated shift
// pattern (`workRulePattern`), so every screen that reads shift patterns picks
// it up; week offs become a full-shift "Week off" activity on those dates.
import { fmtDuration, workedMinutes } from "./labourLaw"
import { fmtHM, toMins, type AgentDay, type ChannelSegment } from "./channels"
import type { BreakSegment, BreakType, ShiftPattern } from "./shiftPatterns"

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const
/** 0 = Monday … 6 = Sunday, for a local ISO date. */
export const weekdayOf = (iso: string) => (new Date(`${iso}T00:00:00`).getDay() + 6) % 7

/** fixed: the same days off every week (e.g. Sat–Sun). rotating: the days
 *  move one day later each week (Sat–Sun, then Sun–Mon, then Mon–Tue…). */
export type WeekOffMode = "fixed" | "rotating"
/** Weeks of a rotation are counted from this Monday. */
export const ROTATION_ANCHOR = "2026-01-05"

export const WEEK_OFF_PRESETS: { id: string; label: string; mode: WeekOffMode; days: number[] }[] = [
  { id: "fixed-sat-sun", label: "Fixed Sat–Sun", mode: "fixed", days: [5, 6] },
  { id: "fixed-sun", label: "Fixed Sunday only", mode: "fixed", days: [6] },
  { id: "fixed-fri-sat", label: "Fixed Fri–Sat", mode: "fixed", days: [4, 5] },
  { id: "fixed-sun-mon", label: "Fixed Sun–Mon", mode: "fixed", days: [0, 6] },
  { id: "fixed-fri-sun", label: "Fixed Fri–Sun (3 days)", mode: "fixed", days: [4, 5, 6] },
  { id: "rotating-2", label: "Rotating 2 days (moves 1 day each week)", mode: "rotating", days: [5, 6] },
  { id: "rotating-1", label: "Rotating 1 day (moves 1 day each week)", mode: "rotating", days: [6] },
]

/** The days off in the week containing `date`. */
export function offDaysOn(days: number[], mode: WeekOffMode | undefined, date: string): number[] {
  if (mode !== "rotating") return days
  const shift = ((Math.floor(dayDiff(ROTATION_ANCHOR, date) / 7) % 7) + 7) % 7
  return days.map((d) => (d + shift) % 7).sort()
}
export const isOffOn = (days: number[] | undefined, mode: WeekOffMode | undefined, date: string) =>
  !!days?.length && offDaysOn(days, mode, date).includes(weekdayOf(date))

/** "Fixed · Sat, Sun" / "Rotating · from Sat, Sun" / "none". */
export function describeWeekOff(days: number[] | undefined, mode: WeekOffMode | undefined): string {
  if (!days?.length) return "none"
  const list = [...days].sort().map((d) => WEEKDAYS[d]).join(", ")
  return mode === "rotating" ? `Rotating · from ${list}` : `Fixed · ${list}`
}

export interface BreakStep {
  type: BreakType
  minutes: number
}

export interface WorkRule {
  id: string
  name: string
  /** Shift length from start to end, breaks included. */
  shiftMinutes: number
  /** Breaks in the order they're taken; placed evenly through the shift. */
  breaks: BreakStep[]
  /** Default days off for agents given this rule (0 = Mon … 6 = Sun). */
  weekOff: number[]
  /** Fixed days every week, or rotating one day later each week (absent = fixed). */
  weekOffMode?: WeekOffMode
  /** Usual start time, offered first when assigning. */
  defaultStart: string
}

/** Organisation-wide compliance rules. null switches a rule off. */
export interface WorkCompliance {
  /** Shifts at least this long must have a break or lunch. */
  breakRequiredAfterHours: number | null
  /** Longest stretch of work allowed without a break, lunch or time off. */
  maxContinuousWorkHours: number | null
  /** Shifts longer than this need a lunch of `minLunchMinutes`. */
  lunchRequiredAfterHours: number | null
  minLunchMinutes: number
  maxConsecutiveWorkDays: number | null
  minDaysOffPerWeek: number | null
  maxWeeklyHours: number | null
  minRestBetweenShiftsHours: number | null
}

export const DEFAULT_WORK_COMPLIANCE: WorkCompliance = {
  breakRequiredAfterHours: 3,
  maxContinuousWorkHours: 3,
  lunchRequiredAfterHours: 6,
  minLunchMinutes: 30,
  maxConsecutiveWorkDays: 6,
  minDaysOffPerWeek: 1,
  maxWeeklyHours: 48,
  minRestBetweenShiftsHours: 11,
}

const WEEKEND = [5, 6]
const brk = (minutes: number): BreakStep => ({ type: "break", minutes })
const lunch = (minutes: number): BreakStep => ({ type: "lunch", minutes })

export const DEFAULT_WORK_RULES: WorkRule[] = [
  { id: "wr-8h", name: "8h · 30m lunch + 2×15m breaks", shiftMinutes: 480, breaks: [brk(15), lunch(30), brk(15)], weekOff: WEEKEND, weekOffMode: "fixed", defaultStart: "09:00" },
  { id: "wr-9h", name: "9h · 1h lunch + 2×15m breaks", shiftMinutes: 540, breaks: [brk(15), lunch(60), brk(15)], weekOff: WEEKEND, weekOffMode: "fixed", defaultStart: "09:00" },
  { id: "wr-8h30", name: "8.5h · 30m lunch + 2×15m breaks", shiftMinutes: 510, breaks: [brk(15), lunch(30), brk(15)], weekOff: WEEKEND, weekOffMode: "fixed", defaultStart: "08:00" },
  { id: "wr-10h", name: "10h × 4 days · 1h lunch + 2×15m breaks", shiftMinutes: 600, breaks: [brk(15), lunch(60), brk(15)], weekOff: [4, 5, 6], weekOffMode: "fixed", defaultStart: "08:00" },
  { id: "wr-6h", name: "6h part-time · 2×15m breaks", shiftMinutes: 360, breaks: [brk(15), brk(15)], weekOff: WEEKEND, weekOffMode: "fixed", defaultStart: "10:00" },
  { id: "wr-4h", name: "4h part-time · 1×15m break", shiftMinutes: 240, breaks: [brk(15)], weekOff: WEEKEND, weekOffMode: "fixed", defaultStart: "12:00" },
]

export const breakLabel = (b: BreakStep) => (b.type === "lunch" ? "Lunch" : "Break")

/** "30m lunch + 2×15m breaks" style summary of a break pattern. */
export function describeBreaks(breaks: BreakStep[]): string {
  if (!breaks.length) return "no breaks"
  const groups = new Map<string, number>()
  for (const b of breaks) groups.set(`${b.type}|${b.minutes}`, (groups.get(`${b.type}|${b.minutes}`) ?? 0) + 1)
  return [...groups]
    .sort(([a], [b]) => (a.startsWith("lunch") ? -1 : b.startsWith("lunch") ? 1 : 0))
    .map(([k, n]) => {
      const [type, mins] = k.split("|")
      const what = `${fmtMins(+mins)} ${type}${n > 1 ? (type === "lunch" ? "es" : "s") : ""}`
      return n > 1 ? `${n}×${what}` : what
    })
    .join(" + ")
}
const fmtMins = (m: number) => (m % 60 ? `${m}m` : `${m / 60}h`)

/** Break offsets (from shift start) that split the work into equal stretches,
 *  on a 5-minute grid; the last stretch takes the rounding. */
export function placeBreaks(rule: Pick<WorkRule, "shiftMinutes" | "breaks">): BreakSegment[] {
  const total = rule.breaks.reduce((t, b) => t + b.minutes, 0)
  const work = rule.shiftMinutes - total
  if (!rule.breaks.length || work <= 0) return []
  const chunk = Math.floor(work / (rule.breaks.length + 1) / 5) * 5
  let at = 0
  let nBreak = 0
  return rule.breaks.map((b, i) => {
    at += chunk
    const seg: BreakSegment = {
      id: `wr${i + 1}`,
      type: b.type,
      label: b.type === "lunch" ? "Lunch" : `Break ${++nBreak}`,
      offsetMinutes: at,
      durationMinutes: b.minutes,
    }
    at += b.minutes
    return seg
  })
}

export const WORK_RULE_PATTERN_PREFIX = "wr:"
export const workRulePatternId = (ruleId: string, start: string) => `${WORK_RULE_PATTERN_PREFIX}${ruleId}@${start}`
/** The rule a generated pattern id came from (null for an ordinary pattern). */
export function parseWorkRulePatternId(id: string | undefined): { ruleId: string; start: string } | null {
  if (!id?.startsWith(WORK_RULE_PATTERN_PREFIX)) return null
  const [ruleId, start] = id.slice(WORK_RULE_PATTERN_PREFIX.length).split("@")
  return ruleId && start ? { ruleId, start } : null
}

/** The shift pattern an agent on `rule` starting at `start` works. */
export function workRulePattern(rule: WorkRule, start: string): ShiftPattern & { workRuleId: string } {
  const s = toMins(start)
  return {
    id: workRulePatternId(rule.id, start),
    name: `${rule.name} · ${start}`,
    start,
    end: fmtHM(Math.min(24 * 60, s + rule.shiftMinutes)),
    breaks: placeBreaks(rule),
    workRuleId: rule.id,
  }
}

// ---- Compliance ----

export type WorkCheck =
  | "breakRequired"
  | "maxContinuousWork"
  | "lunchRequired"
  | "otOnWeekOff"
  | "maxConsecutiveWorkDays"
  | "minDaysOffPerWeek"
  | "maxWeeklyHours"
  | "minRestBetweenShifts"

export const WORK_CHECK_LABEL: Record<WorkCheck, string> = {
  breakRequired: "Break in every shift",
  maxContinuousWork: "Max hours in a row",
  lunchRequired: "Lunch on long shifts",
  otOnWeekOff: "Overtime on a week off",
  maxConsecutiveWorkDays: "Days worked in a row",
  minDaysOffPerWeek: "Days off a week",
  maxWeeklyHours: "Weekly hours",
  minRestBetweenShifts: "Rest between shifts",
}

export interface WorkIssue {
  rule: WorkCheck
  message: string
  /** The stretch of the day at fault, to highlight on the timeline. */
  span?: { start: number; end: number }
  /** For weekly checks: the date it shows up on. */
  date?: string
}

type Span = { start: number; end: number }
const NOT_WORKING = new Set(["loa", "absence", "vto", "pto", "leave", "off"])
export const isWeekOff = (day: AgentDay) => day.activities.some((a) => a.type === "off")

/** Stretches of continuous work — shift and OT minus breaks and time off,
 *  touching pieces joined (a shift running straight into OT is one stretch). */
export function workStretches(day: AgentDay): Span[] {
  const off: Span[] = [...day.breaks, ...day.activities.filter((a) => NOT_WORKING.has(a.type))]
  let pieces: Span[] = [{ start: day.shift[0], end: day.shift[1] }, ...day.ot.map((o) => ({ start: o.start, end: o.end }))]
  for (const c of off) {
    pieces = pieces.flatMap((p) => {
      if (c.end <= p.start || c.start >= p.end) return [p]
      return [
        ...(c.start > p.start ? [{ start: p.start, end: c.start }] : []),
        ...(c.end < p.end ? [{ start: c.end, end: p.end }] : []),
      ]
    })
  }
  const out: Span[] = []
  for (const p of pieces.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start)) {
    const last = out.at(-1)
    if (last && p.start <= last.end) last.end = Math.max(last.end, p.end)
    else out.push({ ...p })
  }
  return out
}

/** One agent's day against the daily rules. Empty = compliant. */
export function checkWorkDay(day: AgentDay, c: WorkCompliance): WorkIssue[] {
  const issues: WorkIssue[] = []
  if (isWeekOff(day)) {
    for (const o of day.ot) issues.push({ rule: "otOnWeekOff", message: `Overtime ${fmtHM(o.start)}–${fmtHM(o.end)} on a week off`, span: { start: o.start, end: o.end } })
    return issues
  }
  const stretches = workStretches(day)
  if (!stretches.length) return issues
  const [s, e] = day.shift
  const inShift = day.breaks.filter((b) => b.start < e && b.end > s)
  const length = stretches.at(-1)!.end - stretches[0].start

  if (c.breakRequiredAfterHours != null && length >= c.breakRequiredAfterHours * 60 && !inShift.length) {
    issues.push({ rule: "breakRequired", message: `${fmtDuration(length)} shift with no break — shifts of ${fmtDuration(c.breakRequiredAfterHours * 60)} or more need one` })
  }
  if (c.maxContinuousWorkHours != null) {
    for (const x of stretches) {
      if (x.end - x.start > c.maxContinuousWorkHours * 60) {
        issues.push({
          rule: "maxContinuousWork",
          message: `Works ${fmtHM(x.start)}–${fmtHM(x.end)} (${fmtDuration(x.end - x.start)}) without a break — max ${fmtDuration(c.maxContinuousWorkHours * 60)} in a row`,
          span: x,
        })
      }
    }
  }
  if (c.lunchRequiredAfterHours != null && workedMinutes(day) > c.lunchRequiredAfterHours * 60 && !inShift.some((b) => b.type === "lunch" && b.end - b.start >= c.minLunchMinutes)) {
    issues.push({ rule: "lunchRequired", message: `Works over ${fmtDuration(c.lunchRequiredAfterHours * 60)} with no lunch of ${c.minLunchMinutes} min or more` })
  }
  return issues
}

/** A rule template against the daily rules (as a sample day). */
export function checkWorkRule(rule: Pick<WorkRule, "shiftMinutes" | "breaks">, c: WorkCompliance): WorkIssue[] {
  if (rule.breaks.reduce((t, b) => t + b.minutes, 0) >= rule.shiftMinutes) {
    return [{ rule: "breakRequired", message: "Breaks take up the whole shift" }]
  }
  const start = 9 * 60
  const day: AgentDay = {
    shift: [start, start + rule.shiftMinutes],
    breaks: placeBreaks(rule).map((b) => ({ id: b.id, type: b.type, label: b.label, start: start + b.offsetMinutes, end: start + b.offsetMinutes + b.durationMinutes })),
    channels: [],
    ot: [],
    activities: [],
  }
  // Report stretches by length, not clock time — the rule has no fixed start.
  return checkWorkDay(day, c).map((i) =>
    i.span ? { ...i, message: `${fmtDuration(i.span.end - i.span.start)} of work without a break — max ${fmtDuration(c.maxContinuousWorkHours! * 60)} in a row` } : i,
  )
}

/** One agent's run of dates (any order, gaps allowed) against the weekly rules.
 *  A week only counts towards "days off a week" when the whole week is in range. */
export function checkWorkWeeks(days: { date: string; day: AgentDay }[], c: WorkCompliance): WorkIssue[] {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date))
  const worked = (d: AgentDay) => (isWeekOff(d) ? 0 : workedMinutes(d))
  const issues: WorkIssue[] = []

  if (c.maxConsecutiveWorkDays != null) {
    let run = 0
    let prev: string | null = null
    for (const { date, day } of sorted) {
      run = worked(day) > 0 ? (prev && dayDiff(prev, date) === 1 ? run + 1 : 1) : 0
      prev = date
      if (run === c.maxConsecutiveWorkDays + 1) {
        issues.push({ rule: "maxConsecutiveWorkDays", date, message: `${run} days worked in a row by ${date} — max ${c.maxConsecutiveWorkDays}` })
      }
    }
  }

  const weeks = new Map<string, { date: string; day: AgentDay }[]>()
  for (const d of sorted) {
    const monday = addDaysIso(d.date, -weekdayOf(d.date))
    weeks.set(monday, [...(weeks.get(monday) ?? []), d])
  }
  for (const [monday, list] of weeks) {
    if (c.minDaysOffPerWeek != null && list.length === 7) {
      const off = list.filter((d) => worked(d.day) === 0).length
      if (off < c.minDaysOffPerWeek) {
        issues.push({ rule: "minDaysOffPerWeek", date: monday, message: `${off} day${off === 1 ? "" : "s"} off in the week of ${monday} — needs ${c.minDaysOffPerWeek}` })
      }
    }
    if (c.maxWeeklyHours != null) {
      const mins = list.reduce((t, d) => t + worked(d.day), 0)
      if (mins > c.maxWeeklyHours * 60) {
        issues.push({ rule: "maxWeeklyHours", date: monday, message: `${fmtDuration(mins)} worked in the week of ${monday} — max ${c.maxWeeklyHours}h` })
      }
    }
  }

  if (c.minRestBetweenShiftsHours != null) {
    for (let i = 1; i < sorted.length; i++) {
      const [a, b] = [sorted[i - 1], sorted[i]]
      if (dayDiff(a.date, b.date) !== 1) continue
      const [ea, sb] = [workStretches(a.day).at(-1)?.end, workStretches(b.day)[0]?.start]
      if (ea == null || sb == null || worked(a.day) === 0 || worked(b.day) === 0) continue
      const rest = 24 * 60 - ea + sb
      if (rest < c.minRestBetweenShiftsHours * 60) {
        issues.push({ rule: "minRestBetweenShifts", date: b.date, message: `Only ${fmtDuration(rest)} rest before ${b.date} (finished ${fmtHM(ea)}, starts ${fmtHM(sb)}) — needs ${c.minRestBetweenShiftsHours}h` })
      }
    }
  }
  return issues
}

const dayMs = 86_400_000
const isoMs = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
const dayDiff = (a: string, b: string) => Math.round((isoMs(b) - isoMs(a)) / dayMs)
const addDaysIso = (iso: string, n: number) => new Date(isoMs(iso) + n * dayMs).toISOString().slice(0, 10)

// ---- Writing a rule into a saved day ----

export const WEEK_OFF_ID = "week-off"

/** Channel blocks stretched / trimmed to a new shift: blocks are cut to it and
 *  the first and last reach its edges, so nothing in the shift is unassigned. */
export function fitChannels(channels: ChannelSegment[], [s, e]: [number, number]): ChannelSegment[] {
  const sorted = [...channels].sort((a, b) => a.start - b.start)
  const fallback = sorted[0]?.channel ?? "phone"
  const kept = sorted.map((c) => ({ ...c, start: Math.max(s, c.start), end: Math.min(e, c.end) })).filter((c) => c.end > c.start)
  if (!kept.length) return [{ id: "d1", channel: fallback, start: s, end: e }]
  kept[0].start = s
  kept[kept.length - 1].end = e
  for (let i = 1; i < kept.length; i++) kept[i].start = kept[i - 1].end
  return kept
}

/** An agent's day for `date` with their work rule applied: shift and breaks
 *  from the rule's pattern (kept as they are without one), and on a week off
 *  a full-shift "Week off". OT that would now overlap the shift is dropped;
 *  activities are kept inside it. */
export function applyWorkRuleToDay(day: AgentDay, pattern: ShiftPattern | null, weekOff: number[], date: string, mode: WeekOffMode = "fixed"): AgentDay {
  const [s, e] = pattern ? [toMins(pattern.start), toMins(pattern.end)] : day.shift
  const activities = day.activities
    .filter((a) => a.id !== WEEK_OFF_ID)
    .map((a) => ({ ...a, start: Math.max(s, a.start), end: Math.min(e, a.end) }))
    .filter((a) => a.end > a.start)
  if (isOffOn(weekOff, mode, date)) activities.push({ id: WEEK_OFF_ID, type: "off", start: s, end: e, note: "Week off" })
  return {
    shift: [s, e],
    breaks: pattern
      ? pattern.breaks.map((b) => ({ id: b.id, type: b.type, label: b.label, start: s + b.offsetMinutes, end: s + b.offsetMinutes + b.durationMinutes }))
      : day.breaks,
    channels: day.shift[0] === s && day.shift[1] === e ? day.channels : fitChannels(day.channels, [s, e]),
    ot: day.ot.filter((o) => o.end <= s || o.start >= e),
    activities: activities.sort((a, b) => a.start - b.start),
  }
}
