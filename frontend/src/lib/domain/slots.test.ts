import { describe, expect, it } from "vitest"

import { netHeads, slotMisfit, suggestSlots } from "@/lib/domain/slots"
import type { PlanRow } from "@/lib/domain/types"

/** 8 half-hour intervals from 09:00 with these scheduled / required heads. */
function plan(scheduled: number[], required: number[]): PlanRow[] {
  return scheduled.map((s, i) => ({
    idx: i, label: "", volume: 0, intensity: 0, requiredNet: 0, requiredGross: required[i], scheduled: s,
    variance: s - required[i], targetSL: 0.8, projSL: 0.8, asa: 0, occupancy: 0,
  }))
}
const NINE = 9 * 60
const at = (h: number, m = 0) => h * 60 + m

describe("slot suggestions", () => {
  //           09:00 09:30 10:00 10:30 11:00 11:30 12:00 12:30
  const p = plan([10, 10, 9, 9, 6, 6, 5, 7], [7, 7, 7, 7, 7, 7, 7, 7])

  it("nets out heads already off on an activity", () => {
    expect(netHeads(p, [0, 1, 0, 0, 0, 0, 0, 0])).toEqual([3, 2, 2, 2, -1, -1, -2, 0])
  })

  it("offers time off where over and OT where short, per hour, joining equal neighbours", () => {
    const s = suggestSlots(p, [], NINE, { blockMinutes: 60, timeOff: "vto", ot: true, leave: false })
    expect(s).toEqual([
      { kind: "vto", start: at(9), end: at(10), capacity: 3, net: 3 },
      { kind: "vto", start: at(10), end: at(11), capacity: 2, net: 2 },
      { kind: "ot", start: at(11), end: at(12), capacity: 1, net: -1 },
      // 12:00 is 2 short, 12:30 exactly staffed: OT covers the worst interval.
      { kind: "ot", start: at(12), end: at(13), capacity: 2, net: -2 },
    ])
    const twoHours = suggestSlots(plan([9, 9, 9, 9], [7, 7, 7, 7]), [], NINE, { blockMinutes: 60, timeOff: "vto", ot: true, leave: false })
    expect(twoHours).toEqual([{ kind: "vto", start: at(9), end: at(11), capacity: 2, net: 2 }]) // equal neighbours joined
  })

  it("never offers time off that would take an interval under the requirement", () => {
    // 12:00–13:00 has one interval at −2 and one at 0: no VTO there, OT for the worst one.
    const s = suggestSlots(p, [], NINE, { blockMinutes: 60, timeOff: "pto", ot: false, leave: false })
    expect(s.map((x) => [x.kind, x.start, x.capacity])).toEqual([["pto", at(9), 3], ["pto", at(10), 2]])
    const halfHour = suggestSlots(p, [], NINE, { blockMinutes: 30, timeOff: "vto", ot: false, leave: false })
    expect(halfHour.map((x) => [x.start, x.end, x.capacity])).toEqual([[at(9), at(10), 3], [at(10), at(11), 2]])
  })

  it("doesn't offer again what's already open and untaken", () => {
    const open = [
      { kind: "vto" as const, start: at(9), end: at(10), left: 2 }, // 2 of the 3 spare at 9:00 already offered
      { kind: "ot" as const, start: at(11), end: at(12), left: 1 }, // the 11:00 shortfall already covered
      { kind: "vto" as const, start: at(10), end: at(11), left: 0 }, // full — taken places are in the schedule
    ]
    const s = suggestSlots(p, [], NINE, { blockMinutes: 60, timeOff: "vto", ot: true, leave: false }, open)
    expect(s.map((x) => [x.kind, x.start, x.capacity])).toEqual([
      ["vto", at(9), 1],
      ["vto", at(10), 2],
      ["ot", at(12), 2],
    ])
  })

  it("knows which slots fit an agent's day (same rules as the server)", () => {
    const shift: [number, number] = [at(7), at(15, 30)]
    expect(slotMisfit("vto", at(15), at(16), shift)).toBeNull() // overlaps the end of the shift
    expect(slotMisfit("pto", at(16), at(17), shift)).toBe("You're not working 16:00–17:00 that day")
    expect(slotMisfit("ot", at(15), at(16), shift)).toBeNull() // 15:30–16:00 is outside it
    expect(slotMisfit("ot", at(9), at(10), shift)).toBe("You're already working 09:00–10:00")
    expect(slotMisfit("leave", 0, 24 * 60, shift)).toBeNull()
  })

  it("full-day leave uses the tightest interval's room, and that room isn't offered again as VTO", () => {
    const roomy = plan([10, 10, 9, 9, 9, 9, 9, 9], [7, 7, 7, 7, 7, 7, 7, 7])
    const s = suggestSlots(roomy, [], NINE, { blockMinutes: 60, timeOff: "vto", ot: false, leave: true })
    expect(s).toEqual([
      { kind: "leave", start: 0, end: 24 * 60, capacity: 2, net: 2 },
      { kind: "vto", start: at(9), end: at(10), capacity: 1, net: 1 }, // 3 over − 2 for leave
    ])
    expect(suggestSlots(p, [], NINE, { blockMinutes: 60, timeOff: null, ot: false, leave: true })).toEqual([])
  })
})
