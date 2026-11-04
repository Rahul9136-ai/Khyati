// The real-time floor, tied to the schedule: what each agent should be doing
// right now (from their day on the Scheduling timeline — shift, breaks, lunch,
// meetings, training, week off …) and how long they've been in their current
// state (one timestamp per agent, so every page shows the same ticking timer).
import { DAY_START } from "@/lib/domain/adherence"
import type { AgentDay } from "@/lib/domain/channels"
import type { RtaEntry } from "@/lib/domain/types"

/** The AUX code an agent is scheduled to be in at `minute` (minutes after midnight). */
export function scheduledAux(day: AgentDay, minute: number): string {
  const covers = (s: { start: number; end: number }) => s.start <= minute && minute < s.end
  const onShift = day.shift[0] <= minute && minute < day.shift[1]
  const onOt = day.ot.some(covers)
  const activity = day.activities.find(covers)
  if (activity) {
    switch (activity.type) {
      case "meeting":
      case "other":
        return "AUX3"
      case "training":
        return "AUX4"
      case "coaching":
        return "AUX5"
      default: // off, leave, LOA, absence, PTO, VTO — not working
        return "OFFLINE"
    }
  }
  if (!onShift && !onOt) return "OFFLINE"
  const brk = day.breaks.find(covers)
  if (brk) return brk.type === "lunch" ? "AUX2" : "AUX1"
  return "AVAIL"
}

/** "Now" on the floor, in minutes after midnight: the Intraday clock's
 *  half-hour interval, plus how far into the current half hour the real clock is. */
export function liveMinute(nowIdx: number, at: Date = new Date()): number {
  return DAY_START + nowIdx * 30 + (at.getMinutes() % 30)
}

/** Seconds an agent has been in their current state. */
export function liveSecs(r: RtaEntry, now: number = Date.now()): number {
  return r.since ? Math.max(0, Math.floor((now - r.since) / 1000)) : r.secs
}
