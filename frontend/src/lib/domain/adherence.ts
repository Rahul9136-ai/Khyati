// Adherence & conformance engine.
//
// Builds minute-level scheduled vs actual state timelines for every agent's
// day (07:00–19:00), derived from their real shift + break pattern, with
// deterministic seeded deviations standing in for an ACD feed. On top of the
// timelines it computes the two industry metrics:
//
//   Adherence %   = minutes in the scheduled state (or an applied exception)
//                   ÷ scheduled minutes — time-of-day sensitive.
//   Conformance % = productive minutes worked ÷ productive minutes scheduled —
//                   ignores *when* the work happened.
//
// Requests go through three stages, each restricted to a different tier of
// designation (see CAN_RAISE/APPROVE/APPLY_ADHERENCE_REQUEST in roles.ts):
//   Pending  → raised by the agent or their Team Leader
//   Approved → decided by Operations Manager / Business Admin (not yet live)
//   Applied  → executed by RTA / Scheduler / Planner — only *this* stage
//              actually credits adherence or changes the break placement.
// Denied ends the chain. This mirrors a real WFM change-control process:
// approval is a decision, applying is the person who actually makes the change.
import { AUX_BY_CODE } from "./seed"
import type { BreakType, ShiftPattern } from "./shiftPatterns"
import type { BreakOverrides } from "./breaks"
import { effectiveSegments } from "./breaks"
import type { Agent } from "./types"

export const DAY_START = 7 * 60 // 07:00
export const DAY_END = 19 * 60 // 19:00
export const DAY_MINS = DAY_END - DAY_START

export interface TimelineSeg {
  startMin: number // minutes from midnight
  endMin: number
  code: string // AUX code from seed.ts
}

export interface AgentDay {
  agentId: string
  shiftStart: number
  shiftEnd: number
  scheduled: TimelineSeg[]
  actual: TimelineSeg[]
}

export type ExceptionStatus = "Pending" | "Approved" | "Applied" | "Denied"
export type RequestKind = "exception" | "breakChange"

export interface AdherenceException {
  id: string
  agentId: string
  kind: RequestKind
  /** kind: "exception" — the justified activity (AUX3 meeting / AUX5 coaching / AUX4 training). */
  code: string
  startMin: number
  endMin: number
  /** kind: "breakChange" — the break/lunch segment being moved (existing id, or "new" to add one). */
  segId?: string
  segType?: BreakType
  reason: string
  requestedBy: string
  status: ExceptionStatus
}

const DASH = "–"
const toMins = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

export const fmtMin = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`

function hashOf(id: string): number {
  const h = [...id].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7)
  return Math.imul(h, 2654435761) >>> 0
}

/** Insert `seg` into a sorted, non-overlapping timeline, clipping what it covers. */
function overlay(segs: TimelineSeg[], seg: TimelineSeg): TimelineSeg[] {
  const out: TimelineSeg[] = []
  for (const s of segs) {
    if (s.endMin <= seg.startMin || s.startMin >= seg.endMin) {
      out.push(s)
      continue
    }
    if (s.startMin < seg.startMin) out.push({ ...s, endMin: seg.startMin })
    if (s.endMin > seg.endMin) out.push({ ...s, startMin: seg.endMin })
  }
  out.push(seg)
  return out.sort((a, b) => a.startMin - b.startMin)
}

/** Scheduled timeline: shift window filled with AVAIL, breaks/lunch punched in. */
function scheduledTimeline(agent: Agent, patterns: ShiftPattern[], overrides: BreakOverrides): TimelineSeg[] {
  const [startS, endS] = agent.shift.split(DASH)
  const start = toMins(startS)
  const end = toMins(endS)
  let segs: TimelineSeg[] = [{ startMin: start, endMin: end, code: "AVAIL" }]
  for (const b of effectiveSegments(agent, patterns, overrides)) {
    const s = start + b.offsetMinutes
    const e = Math.min(end, s + b.durationMinutes)
    if (e > s) segs = overlay(segs, { startMin: s, endMin: e, code: b.type === "lunch" ? "AUX2" : "AUX1" })
  }
  return segs
}

/**
 * Actual timeline: the schedule perturbed by seeded, per-agent deviations —
 * a stand-in for the ACD/CCaaS state feed. Deterministic so scores are stable.
 */
export function buildAgentDay(agent: Agent, patterns: ShiftPattern[], overrides: BreakOverrides): AgentDay {
  const scheduled = scheduledTimeline(agent, patterns, overrides)
  const [startS, endS] = agent.shift.split(DASH)
  const shiftStart = toMins(startS)
  const shiftEnd = toMins(endS)
  const h = hashOf(agent.id)

  let actual = scheduled.map((s) => ({ ...s }))
  // Everyone gets some ACW blocks — productive, so still adherent.
  const acwAt = shiftStart + 60 + (h % 45)
  actual = overlay(actual, { startMin: acwAt, endMin: acwAt + 20, code: "ACW" })

  switch (h % 10) {
    case 0: // late log-in
      actual = overlay(actual, { startMin: shiftStart, endMin: shiftStart + 6 + (h % 8), code: "OFFLINE" })
      break
    case 1: { // first break overruns
      const firstBreak = scheduled.find((s) => s.code === "AUX1")
      if (firstBreak) actual = overlay(actual, { startMin: firstBreak.startMin, endMin: firstBreak.endMin + 8 + (h % 8), code: "AUX1" })
      break
    }
    case 2: { // unscheduled coaching block mid-shift
      const s = shiftStart + 290 + (h % 30)
      actual = overlay(actual, { startMin: s, endMin: s + 25, code: "AUX5" })
      break
    }
    case 3: // leaves early
      actual = overlay(actual, { startMin: shiftEnd - 12 - (h % 10), endMin: shiftEnd, code: "OFFLINE" })
      break
    case 4: { // pulled into an unscheduled team meeting
      const s = shiftStart + 160 + (h % 20)
      actual = overlay(actual, { startMin: s, endMin: s + 20, code: "AUX3" })
      break
    }
    case 5: { // lunch taken 20 min late
      const lunch = scheduled.find((s) => s.code === "AUX2")
      if (lunch) {
        actual = overlay(actual, { startMin: lunch.startMin, endMin: lunch.endMin, code: "AVAIL" })
        actual = overlay(actual, { startMin: lunch.startMin + 20, endMin: lunch.endMin + 20, code: "AUX2" })
      }
      break
    }
    default:
      break // on-plan day
  }

  return { agentId: agent.id, shiftStart, shiftEnd, scheduled, actual }
}

/** Seed requests matching the unscheduled coaching/meeting deviations above —
 *  spread across all three pipeline stages so the demo shows the full chain. */
export function seedExceptions(agents: Agent[]): AdherenceException[] {
  const out: AdherenceException[] = []
  const stageFor = (h: number): ExceptionStatus => (h % 20 === 2 ? "Pending" : h % 20 === 6 ? "Approved" : "Applied")
  for (const a of agents) {
    const h = hashOf(a.id)
    const [startS] = a.shift.split(DASH)
    const shiftStart = toMins(startS)
    if (h % 10 === 2) {
      const s = shiftStart + 290 + (h % 30)
      out.push({
        id: "ex-" + a.id,
        agentId: a.id,
        kind: "exception",
        code: "AUX5",
        startMin: s,
        endMin: s + 25,
        reason: "QA coaching session",
        requestedBy: a.tl,
        status: stageFor(h),
      })
    } else if (h % 10 === 4) {
      const s = shiftStart + 160 + (h % 20)
      out.push({
        id: "ex-" + a.id,
        agentId: a.id,
        kind: "exception",
        code: "AUX3",
        startMin: s,
        endMin: s + 20,
        reason: "Ad-hoc team huddle",
        requestedBy: a.tl,
        status: stageFor(h),
      })
    }
  }
  return out
}

function codeAt(segs: TimelineSeg[], m: number): string | null {
  for (const s of segs) if (m >= s.startMin && m < s.endMin) return s.code
  return null
}

const isProductive = (code: string | null) => !!code && AUX_BY_CODE[code]?.cat === "productive"

/** Minute-level adherence: same code, or both states productive (AVAIL↔ACW). */
function minuteAdheres(actual: string | null, sched: string | null): boolean {
  if (actual === sched) return true
  return isProductive(actual) && isProductive(sched)
}

export interface DayScore {
  agentId: string
  schedMins: number
  adherentMins: number
  exceptionMins: number // adherent only thanks to an approved exception
  offPlanMins: number
  workedMins: number // productive minutes actually delivered
  schedWorkMins: number // productive minutes on the schedule
  adherence: number
  conformance: number
}

/** Score one agent-day, crediting only *applied* exceptions — approval alone
 *  is a decision, not yet a change to the record. `upToMin` scores a partial day. */
export function scoreAgentDay(day: AgentDay, exceptions: AdherenceException[], upToMin = DAY_END): DayScore {
  const mine = exceptions.filter((e) => e.agentId === day.agentId && e.kind === "exception" && e.status === "Applied")
  let schedMins = 0
  let adherentMins = 0
  let exceptionMins = 0
  let workedMins = 0
  let schedWorkMins = 0

  const end = Math.min(day.shiftEnd, upToMin)
  for (let m = day.shiftStart; m < end; m++) {
    const sched = codeAt(day.scheduled, m)
    const actual = codeAt(day.actual, m)
    if (sched == null) continue
    schedMins++
    if (isProductive(sched)) schedWorkMins++
    if (isProductive(actual)) workedMins++
    if (minuteAdheres(actual, sched)) {
      adherentMins++
    } else if (mine.some((e) => m >= e.startMin && m < e.endMin && e.code === actual)) {
      adherentMins++
      exceptionMins++
    }
  }

  return {
    agentId: day.agentId,
    schedMins,
    adherentMins,
    exceptionMins,
    offPlanMins: schedMins - adherentMins,
    workedMins,
    schedWorkMins,
    adherence: schedMins ? adherentMins / schedMins : 1,
    conformance: schedWorkMins ? workedMins / schedWorkMins : 1,
  }
}

// ---- shrinkage breakdown ----

/** In-office shrinkage: *scheduled* break/lunch/meeting/training/coaching
 *  minutes by AUX code — shrinkage that happens while at work, as opposed to
 *  PTO/leave (out-of-office, computed from ptoRequests at the page level). */
export function inOfficeShrinkageByCode(days: AgentDay[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const day of days) {
    for (const seg of day.scheduled) {
      const cat = AUX_BY_CODE[seg.code]?.cat
      if (cat !== "break" && cat !== "shrink") continue
      totals[seg.code] = (totals[seg.code] ?? 0) + (seg.endMin - seg.startMin)
    }
  }
  return totals
}

// ---- real-time escalation ladder ----

export type EscalationLevel = "in" | "grace" | "flagged" | "escalated"

/** Where an out-of-adherence timer sits on the grace → flag → escalate ladder. */
export function escalationFor(offPlan: boolean, secsOffPlan: number, graceMins: number, escalateMins: number): EscalationLevel {
  if (!offPlan) return "in"
  if (secsOffPlan < graceMins * 60) return "grace"
  if (secsOffPlan < escalateMins * 60) return "flagged"
  return "escalated"
}
