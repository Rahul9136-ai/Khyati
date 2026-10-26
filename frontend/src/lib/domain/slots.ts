// VTO / PTO / OT / Leave slots worked out from the requirement vs the schedule.
//
// For each 30-min interval: net = scheduled heads − heads already off on an
// activity (meeting, VTO, leave…) − required heads. Where net > 0 the queue is
// over-staffed and can give time off; where net < 0 it's short and needs OT.
// Full-day Leave can go to as many agents as the *tightest* interval allows;
// that room is then no longer offered as VTO / PTO.
import { fmtHM } from "@/lib/domain/channels"
import type { PlanRow } from "@/lib/domain/types"

export type SlotKind = "vto" | "pto" | "ot" | "leave"

export const SLOT_KINDS: { id: SlotKind; label: string; long: string; color: string }[] = [
  { id: "vto", label: "VTO", long: "Voluntary time off (unpaid)", color: "#0f766e" },
  { id: "pto", label: "PTO", long: "Paid time off", color: "#4f46e5" },
  { id: "ot", label: "OT", long: "Overtime", color: "#d97706" },
  { id: "leave", label: "Leave", long: "Full-day leave", color: "#c026d3" },
]
export const SLOT_KIND_BY_ID = Object.fromEntries(SLOT_KINDS.map((k) => [k.id, k])) as Record<SlotKind, (typeof SLOT_KINDS)[number]>

export interface SlotSuggestion {
  kind: SlotKind
  /** Minutes from midnight (Leave: the whole day, 0–1440). */
  start: number
  end: number
  capacity: number
  /** Heads over (+) or under (−) the requirement behind it, for display. */
  net: number
}

export interface SlotOptions {
  /** Interval length of each slot: 30, 60 or 120 min. */
  blockMinutes: number
  /** Offer over-staffing as VTO, PTO, or not at all. */
  timeOff: "vto" | "pto" | null
  ot: boolean
  leave: boolean
}

/** Why a slot can't go into an agent's day (same rules the server applies when
 *  it's taken), or null if it fits: time off must overlap the shift, OT needs a
 *  part outside it. */
export function slotMisfit(kind: SlotKind, start: number, end: number, [s, e]: [number, number]): string | null {
  const span = `${fmtHM(start)}–${fmtHM(end)}`
  if (kind === "leave") return null
  if (kind === "vto" || kind === "pto") return Math.min(end, e) - Math.max(start, s) >= 5 ? null : `You're not working ${span} that day`
  return start < s || end > e ? null : `You're already working ${span}`
}

/** Heads over (+) / under (−) the requirement in each interval. */
export function netHeads(plan: PlanRow[], lost: number[]): number[] {
  return plan.map((p, i) => p.scheduled - (lost[i] ?? 0) - p.requiredGross)
}

/** A slot already open for the queue: its untaken places are already on offer.
 *  (Taken ones are in the schedule, so `lost` / `scheduled` count them.) */
export interface OpenSlot {
  kind: SlotKind
  start: number
  end: number
  left: number
}

export function suggestSlots(
  plan: PlanRow[],
  lost: number[],
  firstIntervalStart: number,
  opts: SlotOptions,
  open: OpenSlot[] = [],
): SlotSuggestion[] {
  // Room already on offer isn't offered twice: open time off / leave uses up
  // surplus, open OT already covers part of a shortfall.
  let net = netHeads(plan, lost).map((n, i) => {
    const t = firstIntervalStart + i * 30
    return open.reduce((acc, o) => {
      if (!o.left || (o.kind !== "leave" && (t < o.start || t >= o.end))) return acc
      return o.kind === "ot" ? acc + o.left : acc - o.left
    }, n)
  })
  if (!net.length) return []
  const out: SlotSuggestion[] = []
  if (opts.leave) {
    const room = Math.max(0, Math.floor(Math.min(...net)))
    if (room > 0) {
      out.push({ kind: "leave", start: 0, end: 24 * 60, capacity: room, net: room })
      net = net.map((n) => n - room)
    }
  }
  const per = Math.max(1, Math.round(opts.blockMinutes / 30))
  const blocks: SlotSuggestion[] = []
  for (let i = 0; i < net.length; i += per) {
    const chunk = net.slice(i, i + per)
    const start = firstIntervalStart + i * 30
    const end = start + chunk.length * 30
    const over = Math.floor(Math.min(...chunk))
    const under = Math.ceil(Math.max(...chunk.map((n) => -n)))
    if (opts.timeOff && over > 0) blocks.push({ kind: opts.timeOff, start, end, capacity: over, net: over })
    if (opts.ot && under > 0) blocks.push({ kind: "ot", start, end, capacity: under, net: -under })
  }
  // Join back-to-back blocks of the same kind and size into one longer slot.
  for (const b of blocks) {
    const prev = [...out].reverse().find((x) => x.kind === b.kind)
    if (prev && prev.end === b.start && prev.capacity === b.capacity) prev.end = b.end
    else out.push({ ...b })
  }
  return out.sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind))
}
