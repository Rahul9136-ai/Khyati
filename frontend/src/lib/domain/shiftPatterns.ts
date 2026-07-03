// Global shift + break patterns — reusable templates that define a shift's
// start/end time and the break/lunch segments within it (offset + duration in
// minutes from shift start). Agents reference a pattern by id; Scheduling and
// the coverage/Erlang math read the derived "HH:MM–HH:MM" shift string, while
// the break/lunch markers shown in the roster grid come from the pattern.
import type { Agent } from "./types"

export type BreakType = "break" | "lunch"

export interface BreakSegment {
  id: string
  type: BreakType
  label: string
  offsetMinutes: number // minutes after shift start when this segment begins
  durationMinutes: number
}

export interface ShiftPattern {
  id: string
  name: string
  start: string // "HH:MM"
  end: string // "HH:MM"
  breaks: BreakSegment[]
}

const DASH = "–" // en-dash — matches planning.ts's shift string parser

export const DEFAULT_SHIFT_PATTERNS: ShiftPattern[] = [
  {
    id: "sp-early",
    name: "Early",
    start: "07:00",
    end: "15:30",
    breaks: [
      { id: "b1", type: "break", label: "Morning Break", offsetMinutes: 120, durationMinutes: 15 },
      { id: "b2", type: "lunch", label: "Lunch", offsetMinutes: 240, durationMinutes: 30 },
      { id: "b3", type: "break", label: "Afternoon Break", offsetMinutes: 360, durationMinutes: 15 },
    ],
  },
  {
    id: "sp-midam",
    name: "Mid-Morning",
    start: "08:00",
    end: "16:30",
    breaks: [
      { id: "b1", type: "break", label: "Morning Break", offsetMinutes: 120, durationMinutes: 15 },
      { id: "b2", type: "lunch", label: "Lunch", offsetMinutes: 240, durationMinutes: 30 },
      { id: "b3", type: "break", label: "Afternoon Break", offsetMinutes: 360, durationMinutes: 15 },
    ],
  },
  {
    id: "sp-midday",
    name: "Midday",
    start: "09:30",
    end: "18:00",
    breaks: [
      { id: "b1", type: "break", label: "Morning Break", offsetMinutes: 120, durationMinutes: 15 },
      { id: "b2", type: "lunch", label: "Lunch", offsetMinutes: 240, durationMinutes: 30 },
      { id: "b3", type: "break", label: "Afternoon Break", offsetMinutes: 360, durationMinutes: 15 },
    ],
  },
  {
    id: "sp-late",
    name: "Late",
    start: "10:30",
    end: "19:00",
    breaks: [
      { id: "b1", type: "break", label: "Morning Break", offsetMinutes: 120, durationMinutes: 15 },
      { id: "b2", type: "lunch", label: "Lunch", offsetMinutes: 240, durationMinutes: 30 },
      { id: "b3", type: "break", label: "Afternoon Break", offsetMinutes: 360, durationMinutes: 15 },
    ],
  },
]

const toMins = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

// 30-min interval indices (0..23, matching seed.ts's INTERVALS = 07:00..18:30)
// that a break segment overlaps, independent of seed.ts to avoid a circular import.
export function segmentIntervalIndices(pattern: ShiftPattern, seg: BreakSegment): number[] {
  const start = toMins(pattern.start) + seg.offsetMinutes
  const end = start + seg.durationMinutes
  const out: number[] = []
  for (let i = 0; i < 24; i++) {
    const mins = 7 * 60 + i * 30
    if (mins >= start && mins < end) out.push(i)
  }
  return out
}

// Map of interval index → break type, for every segment in a pattern.
export function patternMarkers(pattern: ShiftPattern): Map<number, BreakType> {
  const map = new Map<number, BreakType>()
  pattern.breaks.forEach((seg) => segmentIntervalIndices(pattern, seg).forEach((idx) => map.set(idx, seg.type)))
  return map
}

// Resolve the pattern an agent's shift/breaks should render with: explicit
// link first, then a match on the raw shift string, then a synthesised
// fallback (for imported rosters that don't carry a pattern id).
export function resolvePatternForAgent(agent: Agent, patterns: ShiftPattern[]): ShiftPattern {
  if (agent.shiftPatternId) {
    const byId = patterns.find((p) => p.id === agent.shiftPatternId)
    if (byId) return byId
  }
  const [start, end] = agent.shift.split(DASH)
  const byTime = patterns.find((p) => p.start === start && p.end === end)
  if (byTime) return byTime

  const durMin = toMins(end) - toMins(start)
  const breaks: BreakSegment[] = []
  if (durMin > 120) breaks.push({ id: "auto-b1", type: "break", label: "Break", offsetMinutes: 120, durationMinutes: 15 })
  if (durMin > 240) breaks.push({ id: "auto-lunch", type: "lunch", label: "Lunch", offsetMinutes: 240, durationMinutes: 30 })
  if (durMin > 360) breaks.push({ id: "auto-b2", type: "break", label: "Break", offsetMinutes: 360, durationMinutes: 15 })
  return { id: "auto", name: "Custom", start, end, breaks }
}

export function shiftStringFor(pattern: ShiftPattern): string {
  return `${pattern.start}${DASH}${pattern.end}`
}
