import { describe, expect, it } from "vitest"

import { matchActivityType, resolveActivityRows } from "./activityImport"
import { toMins } from "./domain/channels"
import { AGENTS } from "./domain/seed"

const [a1, a2] = AGENTS // both 07:00–15:30

describe("matchActivityType", () => {
  it("accepts labels, codes and common AUX wording", () => {
    expect(matchActivityType("Meeting")).toBe("meeting")
    expect(matchActivityType("MTG")).toBe("meeting")
    expect(matchActivityType("team huddle")).toBe("meeting")
    expect(matchActivityType("AUX4")).toBe("training")
    expect(matchActivityType("1:1")).toBe("coaching")
    expect(matchActivityType("Sick")).toBe("absence")
    expect(matchActivityType("Leave of absence")).toBe("loa")
    expect(matchActivityType("other")).toBe("other")
    expect(matchActivityType("lunch")).toBeUndefined()
  })
})

describe("resolveActivityRows", () => {
  it("validates each row against the roster, shift and earlier rows", () => {
    const rows = [
      { "Agent ID": a1.id, Activity: "Meeting", Start: "10:00", End: "10:30", Note: "Q3" },
      { "Agent ID": "", "Agent Name": "", Activity: "" }, // blank → skipped
      { "Agent ID": a2.id, Activity: "", Start: "" }, // template row left empty → skipped
      { "Agent Name": a2.name, Activity: "LOA" }, // full shift by default
      { "Agent ID": a1.id, Activity: "Training", Start: "10:15", End: "11:00" }, // clashes with row 2
      { "Agent ID": "zz99", Activity: "Meeting", Start: "10:00", End: "10:30" },
      { "Agent ID": a1.id, Activity: "Lunch", Start: "12:00", End: "12:30" },
      { "Agent ID": a1.id, Activity: "Coaching" }, // needs times
      { "Agent ID": a1.id, Activity: "Coaching", Start: 0.5, End: 0.5208333 }, // Excel day-fractions 12:00–12:30
    ]
    const out = resolveActivityRows(rows, AGENTS, {})
    expect(out.map((r) => [r.row, r.ok])).toEqual([[2, true], [5, true], [6, false], [7, false], [8, false], [9, false], [10, true]])
    expect(out[0]).toMatchObject({ agent: a1, type: "meeting", segment: { start: toMins("10:00"), end: toMins("10:30"), note: "Q3" } })
    expect(out[1].segment).toMatchObject({ type: "loa", start: toMins("07:00"), end: toMins("15:30") })
    expect(out[2].reason).toMatch(/Clashes with Meeting 10:00–10:30/)
    expect(out[3].reason).toMatch(/Unknown agent "zz99"/)
    expect(out[4].reason).toMatch(/Unknown activity "Lunch"/)
    expect(out[5].reason).toMatch(/Missing start\/end/)
    expect(out[6].segment).toMatchObject({ type: "coaching", start: toMins("12:00"), end: toMins("12:30") })
  })

  it("respects activities already on the schedule", () => {
    const plan = { [a1.id]: [{ id: "x", type: "training" as const, start: toMins("09:30"), end: toMins("10:30") }] }
    const [r] = resolveActivityRows([{ "Agent ID": a1.id, Activity: "MTG", Start: "10:00", End: "10:30" }], AGENTS, plan)
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Clashes with Training/) })
  })
})
