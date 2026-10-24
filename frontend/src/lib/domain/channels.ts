// Omni-channel continuous schedules. Every agent's shift is split into
// channel blocks (Phone / Chat / Email) at minute precision — not 30-min
// cells — with break/lunch segments cut out of them, plus optional overtime
// (OT) blocks outside the contracted shift, each on its own channel, and an
// overlay layer of off-phone activities (meetings, training, LOA, absence…).
import type { Sheet } from "@/lib/export"

import { effectiveSegments, type BreakOverrides } from "./breaks"
import { checkCompliance, fmtDuration, LABOUR_LAW_DISCLAIMER, workedMinutes, type LabourLaw } from "./labourLaw"
import { INTERVALS } from "./seed"
import type { BreakSegment, ShiftPattern } from "./shiftPatterns"
import type { Agent, Queue } from "./types"

export type Channel = "phone" | "chat" | "email"

export const CHANNELS: { id: Channel; label: string; short: string; color: string }[] = [
  { id: "phone", label: "Phone", short: "PH", color: "#2563eb" },
  { id: "chat", label: "Chat", short: "CH", color: "#7c3aed" },
  { id: "email", label: "Email", short: "EM", color: "#059669" },
]
export const CHANNEL_BY_ID = Object.fromEntries(CHANNELS.map((c) => [c.id, c])) as Record<Channel, (typeof CHANNELS)[number]>

/** A block of time on one channel; start/end are minutes from midnight. */
export interface ChannelSegment {
  id: string
  channel: Channel
  start: number
  end: number
}

/** Per-agent in-shift channel blocks that replace the default alignment once edited. */
export type ChannelPlan = Record<string, ChannelSegment[]>
/** Per-agent overtime blocks (outside the contracted shift). */
export type OvertimePlan = Record<string, ChannelSegment[]>

/** Off-phone activities layered over the base schedule (upper band of a row).
 *  While one runs the agent is unavailable for contacts. */
export type ActivityType = "meeting" | "training" | "coaching" | "loa" | "absence" | "other"

export const ACTIVITIES: { id: ActivityType; label: string; short: string; color: string; fullShift?: boolean }[] = [
  { id: "meeting", label: "Meeting", short: "MTG", color: "#0891b2" },
  { id: "training", label: "Training", short: "TRN", color: "#db2777" },
  { id: "coaching", label: "Coaching", short: "COA", color: "#65a30d" },
  { id: "loa", label: "LOA", short: "LOA", color: "#475569", fullShift: true },
  { id: "absence", label: "Absence", short: "ABS", color: "#dc2626", fullShift: true },
  { id: "other", label: "Other", short: "OTH", color: "#78716c" },
]
export const ACTIVITY_BY_ID = Object.fromEntries(ACTIVITIES.map((a) => [a.id, a])) as Record<ActivityType, (typeof ACTIVITIES)[number]>

export interface ActivitySegment {
  id: string
  type: ActivityType
  start: number
  end: number
  note?: string
}
/** Per-agent activities (meetings, LOA, absence, …). */
export type ActivityPlan = Record<string, ActivitySegment[]>

export type TimelineKind = "channel" | "break" | "lunch" | "unassigned" | "ot" | "activity"

export interface TimelineSegment {
  kind: TimelineKind
  channel?: Channel
  activity?: ActivityType
  start: number
  end: number
  label: string
  /** Id of the break, channel block, OT block or activity this piece belongs to — lets the UI move/resize it. */
  segId?: string
}

const DASH = "–"
export const toMins = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}
export const fmtHM = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`

export function shiftBounds(agent: Agent): [number, number] {
  const [s, e] = agent.shift.split(DASH)
  return [toMins(s), toMins(e)]
}

const hash = (id: string) => [...id].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7)

/** Deterministic starting alignment: most agents on Phone all day, some split
 *  Phone→Chat or Phone→Email at mid-shift, a few dedicated Chat/Email agents. */
export function defaultChannelSegments(agent: Agent): ChannelSegment[] {
  const [s, e] = shiftBounds(agent)
  const mid = s + Math.round((e - s) / 2 / 15) * 15
  const bucket = hash(agent.id) % 10
  if (bucket <= 4) return [{ id: "d1", channel: "phone", start: s, end: e }]
  if (bucket <= 6) return [{ id: "d1", channel: "phone", start: s, end: mid }, { id: "d2", channel: "chat", start: mid, end: e }]
  if (bucket === 7) return [{ id: "d1", channel: "phone", start: s, end: mid }, { id: "d2", channel: "email", start: mid, end: e }]
  if (bucket === 8) return [{ id: "d1", channel: "chat", start: s, end: e }]
  return [{ id: "d1", channel: "email", start: s, end: e }]
}

export function effectiveChannelSegments(agent: Agent, plan: ChannelPlan): ChannelSegment[] {
  return plan[agent.id] ?? defaultChannelSegments(agent)
}

/** Break/lunch segments as absolute minutes, honouring optimiser overrides. */
export function absoluteBreaks(agent: Agent, patterns: ShiftPattern[], overrides: BreakOverrides) {
  const [s] = shiftBounds(agent)
  return effectiveSegments(agent, patterns, overrides).map((b) => ({
    id: b.id,
    type: b.type,
    label: b.label,
    start: s + b.offsetMinutes,
    end: s + b.offsetMinutes + b.durationMinutes,
  }))
}

// ---- Direct manipulation: move / resize anything on an agent's day ----

/** Snap step (minutes) for mouse moves and resizes. */
export const AUX_SNAP = 5
/** Shortest a block may be resized down to. */
export const MIN_LEN = { aux: 5, channel: 15, ot: 15, shift: 60 } as const

export type Edge = "start" | "end"
export type EditOp =
  | { kind: "aux-move"; segId: string }
  | { kind: "aux-resize"; segId: string; edge: Edge }
  | { kind: "channel-resize"; segId: string; edge: Edge }
  | { kind: "ot-resize"; segId: string; edge: Edge }
  | { kind: "activity-move"; segId: string }
  | { kind: "activity-resize"; segId: string; edge: Edge }
  | { kind: "shift-resize"; edge: Edge }

interface AbsBreak {
  id: string
  type: BreakSegment["type"]
  label: string
  start: number
  end: number
}

/** One agent's day in absolute minutes — the unit every edit operates on. */
export interface AgentDay {
  shift: [number, number]
  breaks: AbsBreak[]
  channels: ChannelSegment[]
  ot: ChannelSegment[]
  activities: ActivitySegment[]
}

export function agentDay(
  agent: Agent,
  patterns: ShiftPattern[],
  overrides: BreakOverrides,
  channelPlan: ChannelPlan,
  otPlan: OvertimePlan,
  activityPlan: ActivityPlan = {},
): AgentDay {
  return {
    shift: shiftBounds(agent),
    breaks: absoluteBreaks(agent, patterns, overrides).sort((a, b) => a.start - b.start),
    channels: effectiveChannelSegments(agent, channelPlan).map((c) => ({ ...c })).sort((a, b) => a.start - b.start),
    ot: (otPlan[agent.id] ?? []).map((o) => ({ ...o })).sort((a, b) => a.start - b.start),
    activities: (activityPlan[agent.id] ?? []).map((x) => ({ ...x })).sort((a, b) => a.start - b.start),
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The list of blocks an op addresses by segId. */
function opList(day: AgentDay, op: Exclude<EditOp, { kind: "shift-resize" }>): { id: string; start: number; end: number }[] {
  if (op.kind === "channel-resize") return day.channels
  if (op.kind === "ot-resize") return day.ot
  if (op.kind === "activity-move" || op.kind === "activity-resize") return day.activities
  return day.breaks
}

/** The value an op drags: a block's start for a move, otherwise the edge's time. */
export function editValue(day: AgentDay, op: EditOp): number {
  if (op.kind === "shift-resize") return op.edge === "start" ? day.shift[0] : day.shift[1]
  const me = opList(day, op).find((x) => x.id === op.segId)
  if (!me) return 0
  return op.kind === "aux-move" || op.kind === "activity-move" || op.edge === "start" ? me.start : me.end
}

/** [lo, hi] the dragged value may take. Blocks stay inside their shift (OT
 *  outside it), never pass over a neighbour, and keep a minimum length. */
export function editBounds(day: AgentDay, op: EditOp): [number, number] {
  const [s, e] = day.shift
  const v = editValue(day, op)

  if (op.kind === "shift-resize") {
    // Breaks and activities must stay inside the shift; OT stays outside it.
    const inner = [...day.breaks, ...day.activities]
    if (op.edge === "start") {
      const otBefore = day.ot.filter((o) => o.end <= s).map((o) => o.end)
      const firstInner = Math.min(e, ...inner.map((b) => b.start))
      return [Math.max(0, ...otBefore), Math.min(firstInner, e - MIN_LEN.shift)]
    }
    const otAfter = day.ot.filter((o) => o.start >= e).map((o) => o.start)
    const lastInner = Math.max(s, ...inner.map((b) => b.end))
    return [Math.max(lastInner, s + MIN_LEN.shift), Math.min(24 * 60, ...otAfter)]
  }

  if (op.kind === "aux-move" || op.kind === "aux-resize" || op.kind === "activity-move" || op.kind === "activity-resize") {
    // Breaks can't pass other breaks; activities can't pass other activities
    // (an activity may sit over a break — it's a separate layer).
    const list = opList(day, op)
    const me = list.find((b) => b.id === op.segId)
    if (!me) return [v, v]
    const others = list.filter((b) => b.id !== op.segId)
    const prevEnd = Math.max(s, ...others.filter((b) => b.end <= me.start).map((b) => b.end))
    const nextStart = Math.min(e, ...others.filter((b) => b.start >= me.end).map((b) => b.start))
    if (op.kind === "aux-move" || op.kind === "activity-move") return [prevEnd, nextStart - (me.end - me.start)]
    return op.edge === "start" ? [prevEnd, me.end - MIN_LEN.aux] : [me.start + MIN_LEN.aux, nextStart]
  }

  if (op.kind === "channel-resize") {
    const me = day.channels.find((c) => c.id === op.segId)
    if (!me) return [v, v]
    const others = day.channels.filter((c) => c.id !== op.segId)
    if (op.edge === "start") {
      // A touching neighbour shares the boundary: it shrinks/grows in step.
      const adj = others.find((c) => c.end === me.start)
      const floor = adj ? adj.start + MIN_LEN.channel : Math.max(s, ...others.filter((c) => c.end <= me.start).map((c) => c.end))
      return [floor, me.end - MIN_LEN.channel]
    }
    const adj = others.find((c) => c.start === me.end)
    const ceil = adj ? adj.end - MIN_LEN.channel : Math.min(e, ...others.filter((c) => c.start >= me.end).map((c) => c.start))
    return [me.start + MIN_LEN.channel, ceil]
  }

  const me = day.ot.find((o) => o.id === op.segId)
  if (!me) return [v, v]
  const others = day.ot.filter((o) => o.id !== op.segId)
  const beforeShift = me.end <= s
  if (op.edge === "start") {
    const floor = Math.max(beforeShift ? 0 : e, ...others.filter((o) => o.end <= me.start).map((o) => o.end))
    return [floor, me.end - MIN_LEN.ot]
  }
  const ceil = Math.min(beforeShift ? s : 24 * 60, ...others.filter((o) => o.start >= me.end).map((o) => o.start))
  return [me.start + MIN_LEN.ot, ceil]
}

/** Apply one move/resize (value clamped to editBounds), returning the new day. */
export function applyEdit(day: AgentDay, op: EditOp, value: number): AgentDay {
  const [lo, hi] = editBounds(day, op)
  const v = clamp(value, lo, hi)
  const next: AgentDay = {
    shift: [...day.shift],
    breaks: day.breaks.map((b) => ({ ...b })),
    channels: day.channels.map((c) => ({ ...c })),
    ot: day.ot.map((o) => ({ ...o })),
    activities: day.activities.map((x) => ({ ...x })),
  }

  if (op.kind === "shift-resize") {
    const old = day.shift[op.edge === "start" ? 0 : 1]
    next.shift[op.edge === "start" ? 0 : 1] = v
    // Channel blocks on the moved edge follow it; everything is clipped to the new shift.
    next.channels = next.channels
      .map((c) => (op.edge === "start" && c.start === old ? { ...c, start: v } : op.edge === "end" && c.end === old ? { ...c, end: v } : c))
      .map((c) => ({ ...c, start: Math.max(c.start, next.shift[0]), end: Math.min(c.end, next.shift[1]) }))
      .filter((c) => c.end > c.start)
    return next
  }
  if (op.kind === "aux-move" || op.kind === "activity-move") {
    const b = opList(next, op).find((x) => x.id === op.segId)!
    b.end = v + (b.end - b.start)
    b.start = v
    return next
  }
  if (op.kind === "aux-resize" || op.kind === "ot-resize" || op.kind === "activity-resize") {
    const item = opList(next, op).find((x) => x.id === op.segId)!
    item[op.edge] = v
    return next
  }
  const me = next.channels.find((c) => c.id === op.segId)!
  if (op.edge === "start") {
    const adj = next.channels.find((c) => c.id !== me.id && c.end === me.start)
    if (adj) adj.end = v
    me.start = v
  } else {
    const adj = next.channels.find((c) => c.id !== me.id && c.start === me.end)
    if (adj) adj.start = v
    me.end = v
  }
  return next
}

/** Store-ready form of a day: shift string, breaks as offsets from shift start. */
export function dayToPatch(day: AgentDay) {
  const [s, e] = day.shift
  return {
    shift: `${fmtHM(s)}${DASH}${fmtHM(e)}`,
    breaks: day.breaks.map<BreakSegment>((b) => ({ id: b.id, type: b.type, label: b.label, offsetMinutes: b.start - s, durationMinutes: b.end - b.start })),
    channels: day.channels,
    overtime: day.ot,
    activities: day.activities,
  }
}

// ---- Bulk editing many selected schedules ----

/** Move an agent's whole day (shift, channels, breaks, activities, OT) by
 *  `delta` minutes, clamped so nothing leaves the calendar day. */
export function moveDay(day: AgentDay, delta: number): AgentDay {
  const first = Math.min(day.shift[0], ...day.ot.map((o) => o.start))
  const last = Math.max(day.shift[1], ...day.ot.map((o) => o.end))
  const d = clamp(delta, -first, 24 * 60 - last)
  const mv = <T extends { start: number; end: number }>(x: T): T => ({ ...x, start: x.start + d, end: x.end + d })
  return {
    shift: [day.shift[0] + d, day.shift[1] + d],
    breaks: day.breaks.map(mv),
    channels: day.channels.map(mv),
    ot: day.ot.map(mv),
    activities: day.activities.map(mv),
  }
}

/** The same edit on another agent's day, or null when they have no matching
 *  block: shift edges always match; breaks by pattern segment id (b1/b2/b3);
 *  activities by type + start time. Channel/OT blocks are per-agent only. */
export function equivalentOp(source: AgentDay, op: EditOp, target: AgentDay): EditOp | null {
  if (op.kind === "shift-resize") return op
  if (op.kind === "aux-move" || op.kind === "aux-resize") return target.breaks.some((b) => b.id === op.segId) ? op : null
  if (op.kind === "activity-move" || op.kind === "activity-resize") {
    const src = source.activities.find((x) => x.id === op.segId)
    const match = src && target.activities.find((x) => x.type === src.type && x.start === src.start)
    return match ? { ...op, segId: match.id } : null
  }
  return null
}

// ---- Row ordering ----

export type ScheduleSort = "roster" | "name-asc" | "name-desc" | "start-asc" | "start-desc"
export const SCHEDULE_SORTS: { id: ScheduleSort; label: string }[] = [
  { id: "roster", label: "Roster order" },
  { id: "name-asc", label: "Name A → Z" },
  { id: "name-desc", label: "Name Z → A" },
  { id: "start-asc", label: "Start time ↑ (earliest first)" },
  { id: "start-desc", label: "Start time ↓ (latest first)" },
]

/** Stable sort of schedule rows. Ties on start time fall back to name A→Z;
 *  ties on name fall back to earliest start; then roster order. */
export function sortSchedules<T>(items: T[], sort: ScheduleSort, key: (t: T) => { name: string; start: number }): T[] {
  if (sort === "roster") return items
  const byName = (a: T, b: T) => key(a).name.localeCompare(key(b).name, undefined, { sensitivity: "base" })
  const byStart = (a: T, b: T) => key(a).start - key(b).start
  const cmp: Record<Exclude<ScheduleSort, "roster">, (a: T, b: T) => number> = {
    "name-asc": (a, b) => byName(a, b) || byStart(a, b),
    "name-desc": (a, b) => byName(b, a) || byStart(a, b),
    "start-asc": (a, b) => byStart(a, b) || byName(a, b),
    "start-desc": (a, b) => byStart(b, a) || byName(a, b),
  }
  return items.map((t, i) => ({ t, i })).sort((x, y) => cmp[sort](x.t, y.t) || x.i - y.i).map((x) => x.t)
}

// ---- Marking any AUX on a day (right-click menu) ----

/** Every AUX that can be marked: the two break kinds plus all activities. */
export type AuxKind = "break" | "lunch" | ActivityType
export const AUX_KINDS: { id: AuxKind; label: string; color: string; fullShift?: boolean }[] = [
  { id: "break", label: "Break", color: "#d97706" },
  { id: "lunch", label: "Lunch", color: "#b45309" },
  ...ACTIVITIES.map((a) => ({ id: a.id as AuxKind, label: a.label, color: a.color, fullShift: a.fullShift })),
]
export const AUX_KIND_BY_ID = Object.fromEntries(AUX_KINDS.map((k) => [k.id, k])) as Record<AuxKind, (typeof AUX_KINDS)[number]>

export type MarkResult = { ok: true; day: AgentDay; start: number; end: number } | { ok: false; reason: string }

/** Mark an AUX on one agent's day. Breaks/lunch join the break layer (can't
 *  overlap another break); activities join the overlay (can't overlap another
 *  activity). Both must sit inside the shift. `fullShift` spans the shift. */
export function markAux(day: AgentDay, kind: AuxKind, start: number, length: number, fullShift: boolean, id: string, note?: string): MarkResult {
  const [s, e] = day.shift
  const from = fullShift ? s : start
  const to = fullShift ? e : start + length
  if (to - from < MIN_LEN.aux) return { ok: false, reason: `Must be at least ${MIN_LEN.aux} min` }
  if (from < s || to > e) return { ok: false, reason: `Outside shift ${fmtHM(s)}–${fmtHM(e)}` }
  const next: AgentDay = { ...day, breaks: [...day.breaks], activities: [...day.activities] }
  if (kind === "break" || kind === "lunch") {
    const clash = day.breaks.find((b) => from < b.end && to > b.start)
    if (clash) return { ok: false, reason: `Clashes with ${clash.label} ${fmtHM(clash.start)}–${fmtHM(clash.end)}` }
    next.breaks = [...day.breaks, { id, type: kind, label: kind === "lunch" ? "Lunch" : "Break", start: from, end: to }].sort((a, b) => a.start - b.start)
  } else {
    const clash = day.activities.find((x) => from < x.end && to > x.start)
    if (clash) return { ok: false, reason: `Clashes with ${ACTIVITY_BY_ID[clash.type].label} ${fmtHM(clash.start)}–${fmtHM(clash.end)}` }
    next.activities = [...day.activities, { id, type: kind, start: from, end: to, ...(note ? { note } : {}) }].sort((a, b) => a.start - b.start)
  }
  return { ok: true, day: next, start: from, end: to }
}

/** Remove whatever activities cover minute `at` (the overlay under the cursor). */
export function unmarkActivitiesAt(day: AgentDay, at: number): AgentDay {
  return { ...day, activities: day.activities.filter((x) => !(x.start <= at && x.end > at)) }
}

/** Human-readable summary of an edit, for the audit log and drag label. */
export function describeEdit(before: AgentDay, after: AgentDay, op: EditOp): string {
  const span = (x: { start: number; end: number }) => `${fmtHM(x.start)}–${fmtHM(x.end)}`
  if (op.kind === "shift-resize") return `Shift ${fmtHM(before.shift[0])}–${fmtHM(before.shift[1])} → ${fmtHM(after.shift[0])}–${fmtHM(after.shift[1])}`
  const pick = (d: AgentDay) => opList(d, op).find((x) => x.id === op.segId)!
  const a = pick(before)
  const b = pick(after)
  const name =
    op.kind === "channel-resize" ? CHANNEL_BY_ID[(b as ChannelSegment).channel].label
    : op.kind === "ot-resize" ? `OT ${CHANNEL_BY_ID[(b as ChannelSegment).channel].label}`
    : op.kind === "activity-move" || op.kind === "activity-resize" ? ACTIVITY_BY_ID[(b as ActivitySegment).type].label
    : (b as AbsBreak).label
  return `${name} ${span(a)} → ${span(b)}`
}

/** Subtract [cuts] from [start,end), returning the remaining pieces. */
function subtract(start: number, end: number, cuts: { start: number; end: number }[]): [number, number][] {
  let pieces: [number, number][] = [[start, end]]
  for (const c of cuts) {
    pieces = pieces.flatMap(([a, b]) => {
      if (c.end <= a || c.start >= b) return [[a, b] as [number, number]]
      const out: [number, number][] = []
      if (c.start > a) out.push([a, c.start])
      if (c.end < b) out.push([c.end, b])
      return out
    })
  }
  return pieces
}

/** One agent's full continuous day: channel work, breaks, gaps, and OT. */
export function agentTimeline(
  agent: Agent,
  patterns: ShiftPattern[],
  overrides: BreakOverrides,
  channelPlan: ChannelPlan,
  otPlan: OvertimePlan,
  activityPlan: ActivityPlan = {},
): TimelineSegment[] {
  return dayTimeline(agentDay(agent, patterns, overrides, channelPlan, otPlan, activityPlan))
}

/** Render a day as contiguous segments. Channel pieces carry their block's id
 *  (a block cut by a break yields several pieces with the same segId).
 *  Activities come back as their own "activity" segments, overlapping the
 *  base layer — they don't cut it (the UI draws them in an upper band). */
export function dayTimeline(day: AgentDay): TimelineSegment[] {
  const [s, e] = day.shift
  const breaks = day.breaks.filter((b) => b.end > s && b.start < e)
  const out: TimelineSegment[] = []

  for (const seg of day.channels) {
    for (const [a, b] of subtract(Math.max(s, seg.start), Math.min(e, seg.end), breaks)) {
      out.push({ kind: "channel", channel: seg.channel, start: a, end: b, label: CHANNEL_BY_ID[seg.channel].label, segId: seg.id })
    }
  }
  for (const [a, b] of subtract(s, e, [...breaks, ...day.channels])) {
    out.push({ kind: "unassigned", start: a, end: b, label: "Unassigned" })
  }
  for (const b of breaks) out.push({ kind: b.type, start: b.start, end: b.end, label: b.label, segId: b.id })
  for (const ot of day.ot) {
    out.push({ kind: "ot", channel: ot.channel, start: ot.start, end: ot.end, label: `OT · ${CHANNEL_BY_ID[ot.channel].label}`, segId: ot.id })
  }
  for (const act of day.activities) {
    const label = `${ACTIVITY_BY_ID[act.type].label}${act.note ? ` · ${act.note}` : ""}`
    out.push({ kind: "activity", activity: act.type, start: act.start, end: act.end, label, segId: act.id })
  }
  return out.sort((x, y) => x.start - y.start)
}

/** The channel an agent spends the most in-shift minutes on. */
export function primaryChannel(agent: Agent, plan: ChannelPlan): Channel {
  const mins: Record<Channel, number> = { phone: 0, chat: 0, email: 0 }
  for (const s of effectiveChannelSegments(agent, plan)) mins[s.channel] += s.end - s.start
  return CHANNELS.reduce((best, c) => (mins[c.id] > mins[best] ? c.id : best), "phone" as Channel)
}

export function channelsWorked(agent: Agent, channelPlan: ChannelPlan, otPlan: OvertimePlan): Set<Channel> {
  return new Set([...effectiveChannelSegments(agent, channelPlan), ...(otPlan[agent.id] ?? [])].map((s) => s.channel))
}

/** Validate an edited plan; returns human-readable problems (empty = OK). */
export function validateAgentPlan(agent: Agent, channels: ChannelSegment[], ot: ChannelSegment[]): string[] {
  const [s, e] = shiftBounds(agent)
  const errs: string[] = []
  const overlaps = (list: ChannelSegment[]) =>
    [...list].sort((a, b) => a.start - b.start).some((x, i, arr) => i > 0 && x.start < arr[i - 1].end)
  channels.forEach((c, i) => {
    if (c.end <= c.start) errs.push(`Channel block ${i + 1}: end must be after start.`)
    else if (c.start < s || c.end > e) errs.push(`Channel block ${i + 1} must sit inside the shift (${fmtHM(s)}–${fmtHM(e)}).`)
  })
  if (overlaps(channels)) errs.push("Channel blocks overlap each other.")
  ot.forEach((o, i) => {
    if (o.start < 0 || o.end > 24 * 60) errs.push(`OT block ${i + 1} must fall within the same calendar day.`)
    else if (o.end <= o.start) errs.push(`OT block ${i + 1}: end must be after start.`)
    else if (o.start < s ? o.end > s : o.start < e) errs.push(`OT block ${i + 1} overlaps the contracted shift — OT must be before or after it.`)
  })
  if (overlaps(ot)) errs.push("OT blocks overlap each other.")
  return errs
}

// ---- Adding OT for a channel ----

export type OtTiming = "after" | "before" | "custom"
export interface OtRequest {
  channel: Channel
  timing: OtTiming
  /** Minutes of OT (used for "after"/"before"). */
  duration: number
  /** Explicit window (used for "custom"). */
  start?: number
  end?: number
}
export type OtProposal = { ok: true; segment: Omit<ChannelSegment, "id"> } | { ok: false; reason: string }

/** Where a requested OT block would land for one agent, or why it can't.
 *  "After" chains onto the end of the shift (or of OT already worked after it);
 *  "before" leads into the shift (or into OT already worked before it). */
export function proposeOvertime(agent: Agent, existing: ChannelSegment[], req: OtRequest): OtProposal {
  const [s, e] = shiftBounds(agent)
  let start: number
  let end: number
  if (req.timing === "after") {
    start = Math.max(e, ...existing.filter((o) => o.start >= e).map((o) => o.end))
    end = start + req.duration
  } else if (req.timing === "before") {
    end = Math.min(s, ...existing.filter((o) => o.end <= s).map((o) => o.start))
    start = end - req.duration
  } else {
    start = req.start ?? 0
    end = req.end ?? 0
  }
  if (end - start < MIN_LEN.ot) return { ok: false, reason: `OT must be at least ${MIN_LEN.ot} min` }
  if (start < 0 || end > 24 * 60) return { ok: false, reason: "Would run past midnight" }
  if (start < e && end > s) return { ok: false, reason: `Overlaps shift ${fmtHM(s)}–${fmtHM(e)}` }
  const clash = existing.find((o) => start < o.end && end > o.start)
  if (clash) return { ok: false, reason: `Clashes with OT ${fmtHM(clash.start)}–${fmtHM(clash.end)}` }
  return { ok: true, segment: { channel: req.channel, start, end } }
}

/** Add an OT block, merging it with touching OT on the same channel. */
export function withOvertimeAdded(existing: ChannelSegment[], seg: ChannelSegment): ChannelSegment[] {
  let merged = { ...seg }
  const rest: ChannelSegment[] = []
  for (const o of existing) {
    if (o.channel === merged.channel && (o.end === merged.start || o.start === merged.end)) {
      merged = { ...merged, id: o.id, start: Math.min(o.start, merged.start), end: Math.max(o.end, merged.end) }
    } else rest.push(o)
  }
  return [...rest, merged].sort((a, b) => a.start - b.start)
}

/** OT blocks as pseudo-agents so the existing coverage/Erlang math counts them
 *  as extra heads (skilled the same as the agent working the OT). */
export function overtimeAgents(agents: Agent[], otPlan: OvertimePlan): Agent[] {
  return agents.flatMap((a) =>
    (otPlan[a.id] ?? []).map((o) => ({
      ...a,
      id: `${a.id}~ot~${o.id}`,
      shift: `${fmtHM(o.start)}${DASH}${fmtHM(o.end)}`,
      // OT blocks carry no break pattern of their own.
      shiftPatternId: undefined,
    })),
  )
}

/** Overall visible window: the operating day, widened to fit any OT. */
export function timelineWindow(agents: Agent[], otPlan: OvertimePlan): [number, number] {
  let lo = INTERVALS.length ? toMins(INTERVALS[0].label) : 420
  let hi = lo + INTERVALS.length * 30
  for (const a of agents) {
    const [s, e] = shiftBounds(a)
    lo = Math.min(lo, s)
    hi = Math.max(hi, e)
    for (const o of otPlan[a.id] ?? []) {
      lo = Math.min(lo, o.start)
      hi = Math.max(hi, o.end)
    }
  }
  return [Math.floor(lo / 60) * 60, Math.ceil(hi / 60) * 60]
}

/** Heads per channel in each 30-min slot of [lo, hi), minute-weighted (incl. OT). */
export function channelCoverage(
  agents: Agent[],
  patterns: ShiftPattern[],
  overrides: BreakOverrides,
  channelPlan: ChannelPlan,
  otPlan: OvertimePlan,
  window: [number, number],
  activityPlan: ActivityPlan = {},
) {
  return coverageFromTimelines(agents.map((a) => agentTimeline(a, patterns, overrides, channelPlan, otPlan, activityPlan)), window)
}

/** channelCoverage over already-built timelines (e.g. a live drag preview).
 *  Channel time under an activity doesn't count — that agent is off the
 *  channel; it's tallied as `activity` heads instead. */
export function coverageFromTimelines(timelines: TimelineSegment[][], [lo, hi]: [number, number]) {
  const slots = Array.from({ length: Math.ceil((hi - lo) / 30) }, (_, i) => ({
    start: lo + i * 30,
    phone: 0,
    chat: 0,
    email: 0,
    ot: 0,
    activity: 0,
  }))
  const add = (start: number, end: number, fn: (slot: (typeof slots)[number], heads: number) => void) => {
    for (const slot of slots) {
      const overlap = Math.min(end, slot.start + 30) - Math.max(start, slot.start)
      if (overlap > 0) fn(slot, overlap / 30)
    }
  }
  for (const tl of timelines) {
    const acts = tl.filter((s) => s.kind === "activity")
    for (const a of acts) add(a.start, a.end, (slot, h) => (slot.activity += h))
    for (const seg of tl) {
      if (!seg.channel) continue
      for (const [a, b] of subtract(seg.start, seg.end, acts)) {
        add(a, b, (slot, h) => {
          slot[seg.channel!] += h
          if (seg.kind === "ot") slot.ot += h
        })
      }
    }
  }
  return slots.map((s) => ({
    ...s,
    phone: +s.phone.toFixed(1),
    chat: +s.chat.toFixed(1),
    email: +s.email.toFixed(1),
    ot: +s.ot.toFixed(1),
    activity: +s.activity.toFixed(1),
  }))
}

/** Heads lost to activities per 30-min interval for a queue: skilled agents
 *  on shift and not already on break/lunch, but in a meeting / LOA / … —
 *  subtracted from break-aware "on duty" so SL reflects them. Same
 *  interval-start convention as breakAwareCoverage. */
export function activityCoverageLoss(
  queueId: string,
  agents: Agent[],
  patterns: ShiftPattern[],
  overrides: BreakOverrides,
  activityPlan: ActivityPlan,
): number[] {
  return INTERVALS.map(({ label }) => {
    const t = toMins(label)
    return agents.filter((a) => {
      const acts = activityPlan[a.id]
      if (!acts?.length || !a.skills.includes(queueId)) return false
      const [s, e] = shiftBounds(a)
      if (t < s || t >= e) return false
      if (absoluteBreaks(a, patterns, overrides).some((b) => t >= b.start && t < b.end)) return false
      return acts.some((x) => t >= x.start && t < x.end)
    }).length
  })
}

// ---- Adding activities ----

export interface ActivityRequest {
  type: ActivityType
  /** Whole contracted shift (LOA / absence) or an explicit window. */
  fullShift: boolean
  start?: number
  end?: number
  note?: string
}
export type ActivityProposal = { ok: true; segment: Omit<ActivitySegment, "id"> } | { ok: false; reason: string }

/** Where a requested activity lands for one agent, or why it can't: it must sit
 *  inside the shift and not clash with another activity (it may cover breaks). */
export function proposeActivity(agent: Agent, existing: ActivitySegment[], req: ActivityRequest): ActivityProposal {
  const [s, e] = shiftBounds(agent)
  const start = req.fullShift ? s : req.start ?? 0
  const end = req.fullShift ? e : req.end ?? 0
  if (end - start < MIN_LEN.aux) return { ok: false, reason: `Must be at least ${MIN_LEN.aux} min` }
  if (start < s || end > e) return { ok: false, reason: `Outside shift ${fmtHM(s)}–${fmtHM(e)}` }
  const clash = existing.find((x) => start < x.end && end > x.start)
  if (clash) return { ok: false, reason: `Clashes with ${ACTIVITY_BY_ID[clash.type].label} ${fmtHM(clash.start)}–${fmtHM(clash.end)}` }
  return { ok: true, segment: { type: req.type, start, end, ...(req.note ? { note: req.note } : {}) } }
}

/** Stagger a bulk activity: agent i (in selection order) joins wave
 *  floor(i / groupSize), each wave starting `every` minutes after the last. */
export function staggeredWindow(i: number, start: number, length: number, groupSize: number, every: number): [number, number] {
  const wave = Math.floor(i / Math.max(1, groupSize))
  const s = start + wave * every
  return [s, s + length]
}

const KIND_CODE: Partial<Record<TimelineKind, string>> = { break: "BRK", lunch: "LUN", unassigned: "—" }
const codeFor = (seg: TimelineSegment) =>
  seg.kind === "channel" ? CHANNEL_BY_ID[seg.channel!].short
  : seg.kind === "ot" ? `OT-${CHANNEL_BY_ID[seg.channel!].short}`
  : seg.kind === "activity" ? ACTIVITY_BY_ID[seg.activity!].short
  : KIND_CODE[seg.kind] ?? ""

/** Every schedule view as export sheets: segments, per-agent summary, a
 *  15-min agent × interval grid, and channel coverage by interval. */
export function scheduleExportSheets(
  agents: Agent[],
  queues: Queue[],
  patterns: ShiftPattern[],
  overrides: BreakOverrides,
  channelPlan: ChannelPlan,
  otPlan: OvertimePlan,
  activityPlan: ActivityPlan = {},
  law: LabourLaw | null = null,
): Sheet[] {
  const window = timelineWindow(agents, otPlan)
  const timelines = agents.map((a) => ({ a, segs: agentTimeline(a, patterns, overrides, channelPlan, otPlan, activityPlan) }))
  const skillNames = (a: Agent) => a.skills.map((s) => queues.find((q) => q.id === s)?.name ?? s).join(", ")

  const segments = timelines.flatMap(({ a, segs }) =>
    segs.map((s) => ({
      Agent: a.name,
      "Agent ID": a.id,
      Team: a.team,
      "Team Lead": a.tl,
      Skills: skillNames(a),
      Shift: a.shift,
      Activity:
        s.kind === "channel" || s.kind === "ot" ? CHANNEL_BY_ID[s.channel!].label
        : s.kind === "activity" ? ACTIVITY_BY_ID[s.activity!].label
        : s.label,
      Type:
        s.kind === "ot" ? "Overtime"
        : s.kind === "channel" ? "Channel work"
        : s.kind === "activity" ? "Activity (overlay)"
        : s.kind === "unassigned" ? "Unassigned"
        : s.kind === "lunch" ? "Lunch"
        : "Break",
      Code: codeFor(s),
      Note: s.kind === "activity" ? s.label.split(" · ").slice(1).join(" · ") : "",
      Start: fmtHM(s.start),
      End: fmtHM(s.end),
      "Duration (min)": s.end - s.start,
    })),
  )

  const summary = timelines.map(({ a, segs }) => {
    const mins = (pred: (s: TimelineSegment) => boolean) => segs.filter(pred).reduce((t, s) => t + s.end - s.start, 0)
    const hrs = (m: number) => +(m / 60).toFixed(2)
    return {
      Agent: a.name,
      "Agent ID": a.id,
      Team: a.team,
      "Team Lead": a.tl,
      Skills: skillNames(a),
      Shift: a.shift,
      "Primary channel": CHANNEL_BY_ID[primaryChannel(a, channelPlan)].label,
      "Phone hrs": hrs(mins((s) => s.kind === "channel" && s.channel === "phone")),
      "Chat hrs": hrs(mins((s) => s.kind === "channel" && s.channel === "chat")),
      "Email hrs": hrs(mins((s) => s.kind === "channel" && s.channel === "email")),
      "Break/lunch min": mins((s) => s.kind === "break" || s.kind === "lunch"),
      "Unassigned min": mins((s) => s.kind === "unassigned"),
      "OT hrs": hrs(mins((s) => s.kind === "ot")),
      "OT blocks": segs.filter((s) => s.kind === "ot").map((s) => `${CHANNEL_BY_ID[s.channel!].label} ${fmtHM(s.start)}–${fmtHM(s.end)}`).join("; "),
      ...Object.fromEntries(ACTIVITIES.map((t) => [`${t.label} min`, mins((s) => s.kind === "activity" && s.activity === t.id)])),
      Activities: segs.filter((s) => s.kind === "activity").map((s) => `${s.label} ${fmtHM(s.start)}–${fmtHM(s.end)}`).join("; "),
    }
  })

  const grid = timelines.map(({ a, segs }) => {
    const row: Record<string, string> = { Agent: a.name, Shift: a.shift }
    for (let t = window[0]; t < window[1]; t += 15) {
      // Activities (overlay) win, then breaks/lunch, then the channel block underneath.
      const hit = segs.filter((s) => s.start <= t && s.end > t)
      const seg = hit.find((s) => s.kind === "activity") ?? hit.find((s) => s.kind === "break" || s.kind === "lunch") ?? hit[0]
      row[fmtHM(t)] = seg ? codeFor(seg) : ""
    }
    return row
  })

  const coverage = channelCoverage(agents, patterns, overrides, channelPlan, otPlan, window, activityPlan).map((s) => ({
    Interval: `${fmtHM(s.start)}–${fmtHM(s.start + 30)}`,
    "Phone HC": s.phone,
    "Chat HC": s.chat,
    "Email HC": s.email,
    "Total HC": +(s.phone + s.chat + s.email).toFixed(1),
    "of which OT": s.ot,
    "In activities": s.activity,
  }))

  return [
    { name: "Schedule segments", rows: segments },
    { name: "Agent summary", rows: summary },
    { name: "Interval grid (15 min)", rows: grid },
    { name: "Channel coverage", rows: coverage },
    {
      name: "Legend",
      rows: [
        ...CHANNELS.map((c) => ({ Code: c.short, Meaning: `${c.label} (in shift)` })),
        ...CHANNELS.map((c) => ({ Code: `OT-${c.short}`, Meaning: `Overtime on ${c.label}` })),
        { Code: "BRK", Meaning: "Break" },
        { Code: "LUN", Meaning: "Lunch" },
        ...ACTIVITIES.map((t) => ({ Code: t.short, Meaning: `${t.label} — overlay activity, agent off the channel` })),
        { Code: "—", Meaning: "On shift, no channel assigned" },
      ],
    },
    ...(law ? labourLawSheets(agents, law, (a) => agentDay(a, patterns, overrides, channelPlan, otPlan, activityPlan)) : []),
  ]
}

/** "Labour-law compliance" (one row per agent) + "Labour-law rules" (what was applied). */
function labourLawSheets(agents: Agent[], law: LabourLaw, dayOf: (a: Agent) => AgentDay): Sheet[] {
  const hrs = (h: number | null) => (h == null ? "—" : fmtDuration(h * 60))
  return [
    {
      name: "Labour-law compliance",
      rows: agents.map((a) => {
        const day = dayOf(a)
        const issues = checkCompliance(day, law)
        return {
          Agent: a.name,
          "Agent ID": a.id,
          Team: a.team,
          Shift: `${fmtHM(day.shift[0])}–${fmtHM(day.shift[1])}`,
          Worked: fmtDuration(workedMinutes(day)),
          Status: issues.length ? "Issues" : "Compliant",
          Issues: issues.map((i) => i.message).join("; "),
        }
      }),
    },
    {
      name: "Labour-law rules",
      rows: [
        { Rule: "Country", Value: law.name },
        { Rule: "Source", Value: law.source },
        { Rule: "Standard hours / day (OT after)", Value: hrs(law.standardDailyHours) },
        { Rule: "Max hours / day incl. OT", Value: hrs(law.maxDailyHours) },
        { Rule: "Max OT / day", Value: hrs(law.maxDailyOtHours) },
        { Rule: "Max spread of the working day", Value: hrs(law.maxSpreadHours) },
        { Rule: "Max work without a break", Value: hrs(law.maxContinuousWorkHours) },
        { Rule: "Breaks shorter than this don't count", Value: law.minBreakBlockMinutes == null ? "—" : `${law.minBreakBlockMinutes} min` },
        ...law.breakRules.map((r) => ({
          Rule: `Break after ${hrs(r.afterHours)} worked`,
          Value: `${r.minBreakMinutes} min${r.continuous ? " (one uninterrupted break)" : " (total)"}`,
        })),
        { Rule: "Standard hours / week (reference)", Value: hrs(law.standardWeeklyHours) },
        { Rule: "Max hours / week (reference)", Value: hrs(law.maxWeeklyHours) },
        { Rule: "Min daily rest between shifts (reference)", Value: hrs(law.minDailyRestHours) },
        { Rule: "Notes", Value: law.notes },
        { Rule: "Disclaimer", Value: LABOUR_LAW_DISCLAIMER },
      ],
    },
  ]
}
