import { describe, expect, it } from "vitest"

import {
  activityCoverageLoss,
  agentDay,
  agentTimeline,
  applyEdit,
  channelCoverage,
  dayTimeline,
  dayToPatch,
  describeEdit,
  editBounds,
  equivalentOp,
  markAux,
  moveDay,
  unmarkActivitiesAt,
  overtimeAgents,
  proposeActivity,
  proposeOvertime,
  scheduleExportSheets,
  sortSchedules,
  staggeredWindow,
  fmtHM,
  timelineWindow,
  toMins,
  validateAgentPlan,
  withOvertimeAdded,
  type ActivitySegment,
  type AgentDay,
  type ChannelSegment,
  type EditOp,
  type OtRequest,
} from "./channels"
import { buildPlan } from "./planning"
import { AGENTS, QUEUES, forecastFor } from "./seed"
import { DEFAULT_SHIFT_PATTERNS } from "./shiftPatterns"

const agent = AGENTS[0] // 07:00–15:30, Early pattern
const seg = (id: string, channel: ChannelSegment["channel"], start: string, end: string): ChannelSegment => ({
  id,
  channel,
  start: toMins(start),
  end: toMins(end),
})

describe("agentTimeline", () => {
  it("covers the whole shift continuously, with breaks cut out of channel blocks", () => {
    const plan = { [agent.id]: [seg("1", "phone", "07:00", "11:00"), seg("2", "chat", "11:00", "15:30")] }
    const tl = agentTimeline(agent, DEFAULT_SHIFT_PATTERNS, {}, plan, {}).filter((s) => s.kind !== "ot")
    const minutes = tl.reduce((t, s) => t + s.end - s.start, 0)
    expect(minutes).toBe(8.5 * 60)
    // Contiguous, no overlaps.
    tl.forEach((s, i) => i > 0 && expect(s.start).toBe(tl[i - 1].end))
    // Morning break at +2h (09:00) splits the phone block.
    expect(tl.find((s) => s.kind === "break")).toMatchObject({ start: toMins("09:00"), end: toMins("09:15") })
    expect(tl.filter((s) => s.kind === "channel" && s.channel === "phone")).toHaveLength(2)
  })

  it("marks uncovered shift time as unassigned and appends OT blocks", () => {
    const plan = { [agent.id]: [seg("1", "email", "07:00", "08:00")] }
    const ot = { [agent.id]: [seg("o", "chat", "15:30", "17:00")] }
    const tl = agentTimeline(agent, DEFAULT_SHIFT_PATTERNS, {}, plan, ot)
    expect(tl.some((s) => s.kind === "unassigned")).toBe(true)
    expect(tl.at(-1)).toMatchObject({ kind: "ot", channel: "chat", end: toMins("17:00") })
  })
})

describe("validateAgentPlan", () => {
  it("accepts a clean plan", () => {
    expect(validateAgentPlan(agent, [seg("1", "phone", "07:00", "15:30")], [seg("o", "phone", "15:30", "16:30")])).toEqual([])
  })
  it("rejects blocks outside the shift, overlaps, and OT inside the shift", () => {
    const errs = validateAgentPlan(
      agent,
      [seg("1", "phone", "06:00", "10:00"), seg("2", "chat", "09:00", "15:30")],
      [seg("o", "phone", "14:00", "16:00")],
    )
    expect(errs.join(" ")).toMatch(/inside the shift/)
    expect(errs.join(" ")).toMatch(/overlap each other/)
    expect(errs.join(" ")).toMatch(/overlaps the contracted shift/)
  })
})

describe("overtime coverage", () => {
  it("adds OT heads to the queue plan and widens the timeline window", () => {
    const sales = QUEUES[0]
    const salesAgent = AGENTS.find((a) => a.skills.includes(sales.id) && a.shift.startsWith("07:00"))!
    const ot = { [salesAgent.id]: [seg("o", "phone", "15:30", "17:30")] }
    const base = buildPlan(forecastFor(sales.id), sales.aht, sales, 0.25, AGENTS)
    const withOt = buildPlan(forecastFor(sales.id), sales.aht, sales, 0.25, [...AGENTS, ...overtimeAgents(AGENTS, ot)])
    const i1600 = base.findIndex((p) => p.label === "16:00")
    expect(withOt[i1600].scheduled).toBe(base[i1600].scheduled + 1)

    const early = { [AGENTS[0].id]: [seg("o", "phone", "05:30", "07:00")] }
    expect(timelineWindow(AGENTS, early)[0]).toBe(toMins("05:00"))
  })

  it("counts OT in channel coverage", () => {
    const ot = { [agent.id]: [seg("o", "email", "19:00", "20:00")] }
    const cov = channelCoverage([agent], DEFAULT_SHIFT_PATTERNS, {}, {}, ot, [toMins("19:00"), toMins("20:00")])
    expect(cov.map((s) => s.email)).toEqual([1, 1])
    expect(cov.map((s) => s.ot)).toEqual([1, 1])
  })
})

describe("moving & resizing on the timeline", () => {
  // Early pattern: break 09:00–09:15 (b1), lunch 11:00–11:30 (b2), break 13:00–13:15 (b3).
  const split = { [agent.id]: [seg("p", "phone", "07:00", "11:00"), seg("c", "chat", "11:00", "15:30")] }
  const ot = { [agent.id]: [seg("o", "email", "16:00", "17:00")] }
  const day = () => agentDay(agent, DEFAULT_SHIFT_PATTERNS, {}, split, ot)
  const brk = (d: AgentDay, id: string) => d.breaks.find((b) => b.id === id)!

  it("bounds an AUX move between neighbouring AUX segments", () => {
    expect(editBounds(day(), { kind: "aux-move", segId: "b2" })).toEqual([toMins("09:15"), toMins("12:30")])
    expect(editBounds(day(), { kind: "aux-move", segId: "b1" })).toEqual([toMins("07:00"), toMins("10:45")])
  })

  it("moves one AUX, clamps it, and leaves the others alone", () => {
    const moved = applyEdit(day(), { kind: "aux-move", segId: "b2" }, toMins("12:05"))
    expect(brk(moved, "b2")).toMatchObject({ start: toMins("12:05"), end: toMins("12:35") })
    expect(brk(moved, "b1").start).toBe(toMins("09:00"))
    expect(brk(applyEdit(day(), { kind: "aux-move", segId: "b2" }, toMins("14:00")), "b2").start).toBe(toMins("12:30"))
  })

  it("lengthens / shortens an AUX from either edge, with a 5-min minimum", () => {
    expect(brk(applyEdit(day(), { kind: "aux-resize", segId: "b2", edge: "end" }, toMins("11:45")), "b2")).toMatchObject({ start: toMins("11:00"), end: toMins("11:45") })
    expect(brk(applyEdit(day(), { kind: "aux-resize", segId: "b2", edge: "start" }, toMins("10:40")), "b2").start).toBe(toMins("10:40"))
    expect(brk(applyEdit(day(), { kind: "aux-resize", segId: "b2", edge: "end" }, toMins("10:00")), "b2").end).toBe(toMins("11:05"))
    // Can't grow into the afternoon break.
    expect(brk(applyEdit(day(), { kind: "aux-resize", segId: "b2", edge: "end" }, toMins("14:00")), "b2").end).toBe(toMins("13:00"))
  })

  it("moves a shared Phone/Chat boundary, resizing both blocks", () => {
    const d = applyEdit(day(), { kind: "channel-resize", segId: "p", edge: "end" }, toMins("12:30"))
    expect(d.channels).toEqual([seg("p", "phone", "07:00", "12:30"), seg("c", "chat", "12:30", "15:30")])
    // The neighbour keeps at least 15 min.
    const max = applyEdit(day(), { kind: "channel-resize", segId: "p", edge: "end" }, toMins("16:00"))
    expect(max.channels[1]).toMatchObject({ start: toMins("15:15"), end: toMins("15:30") })
  })

  it("shrinking a lone channel block leaves unassigned time", () => {
    const solo = agentDay(agent, DEFAULT_SHIFT_PATTERNS, {}, { [agent.id]: [seg("p", "phone", "07:00", "15:30")] }, {})
    const d = applyEdit(solo, { kind: "channel-resize", segId: "p", edge: "end" }, toMins("14:00"))
    expect(dayTimeline(d).find((s) => s.kind === "unassigned")).toMatchObject({ start: toMins("14:00"), end: toMins("15:30") })
  })

  it("resizes OT without letting it run into the shift", () => {
    expect(applyEdit(day(), { kind: "ot-resize", segId: "o", edge: "end" }, toMins("18:30")).ot[0].end).toBe(toMins("18:30"))
    expect(applyEdit(day(), { kind: "ot-resize", segId: "o", edge: "start" }, toMins("14:00")).ot[0].start).toBe(toMins("15:30"))
  })

  it("lengthens the shift: edge channel block follows, breaks keep their clock times", () => {
    const d = applyEdit(day(), { kind: "shift-resize", edge: "start" }, toMins("06:00"))
    expect(d.shift).toEqual([toMins("06:00"), toMins("15:30")])
    expect(d.channels[0]).toMatchObject({ start: toMins("06:00"), end: toMins("11:00") })
    expect(brk(d, "b1").start).toBe(toMins("09:00"))
    // Patch stores breaks as offsets from the NEW start, so they don't drift.
    const patch = dayToPatch(d)
    expect(patch.shift).toBe("06:00–15:30")
    expect(patch.breaks.find((b) => b.id === "b1")?.offsetMinutes).toBe(180)
  })

  it("shortens the shift: clipped by the last break, can't overlap OT", () => {
    const shorter = applyEdit(day(), { kind: "shift-resize", edge: "end" }, toMins("14:30"))
    expect(shorter.shift[1]).toBe(toMins("14:30"))
    expect(shorter.channels[1].end).toBe(toMins("14:30"))
    expect(applyEdit(day(), { kind: "shift-resize", edge: "end" }, toMins("12:00")).shift[1]).toBe(toMins("13:15"))
    expect(applyEdit(day(), { kind: "shift-resize", edge: "end" }, toMins("17:00")).shift[1]).toBe(toMins("16:00"))
  })

  it("describes the edit for the audit log", () => {
    const before = day()
    const op: EditOp = { kind: "aux-resize", segId: "b2", edge: "end" }
    expect(describeEdit(before, applyEdit(before, op, toMins("11:45")), op)).toBe("Lunch 11:00–11:30 → 11:00–11:45")
  })
})

describe("bulk editing helpers", () => {
  const phone = { [agent.id]: [seg("p", "phone", "07:00", "15:30")] }
  const acts = { [agent.id]: [{ id: "m", type: "meeting" as const, start: toMins("10:00"), end: toMins("10:30") }] }
  const ot = { [agent.id]: [seg("o", "chat", "15:30", "16:30")] }
  const day = () => agentDay(agent, DEFAULT_SHIFT_PATTERNS, {}, phone, ot, acts)

  it("moveDay shifts everything together and keeps break offsets", () => {
    const d = moveDay(day(), 30)
    expect(d.shift).toEqual([toMins("07:30"), toMins("16:00")])
    expect(d.channels[0]).toMatchObject({ start: toMins("07:30"), end: toMins("16:00") })
    expect(d.activities[0]).toMatchObject({ start: toMins("10:30"), end: toMins("11:00") })
    expect(d.ot[0]).toMatchObject({ start: toMins("16:00"), end: toMins("17:00") })
    expect(dayToPatch(d).breaks.map((b) => b.offsetMinutes)).toEqual(dayToPatch(day()).breaks.map((b) => b.offsetMinutes))
    // Clamped at the edges of the calendar day.
    expect(moveDay(day(), -24 * 60).shift[0]).toBe(0)
  })

  it("equivalentOp matches shift edges, breaks by id, activities by type + start", () => {
    const other = agentDay(AGENTS[1], DEFAULT_SHIFT_PATTERNS, {}, {}, {}, { [AGENTS[1].id]: [{ id: "z", type: "meeting", start: toMins("10:00"), end: toMins("10:45") }] })
    const none = agentDay(AGENTS[1], DEFAULT_SHIFT_PATTERNS, {}, {}, {}, {})
    expect(equivalentOp(day(), { kind: "shift-resize", edge: "end" }, other)).toEqual({ kind: "shift-resize", edge: "end" })
    expect(equivalentOp(day(), { kind: "aux-move", segId: "b2" }, other)).toEqual({ kind: "aux-move", segId: "b2" })
    expect(equivalentOp(day(), { kind: "activity-move", segId: "m" }, other)).toEqual({ kind: "activity-move", segId: "z" })
    expect(equivalentOp(day(), { kind: "activity-move", segId: "m" }, none)).toBeNull()
    expect(equivalentOp(day(), { kind: "channel-resize", segId: "p", edge: "end" }, other)).toBeNull()
  })
})

describe("markAux (right-click menu)", () => {
  const day = () => agentDay(agent, DEFAULT_SHIFT_PATTERNS, {}, { [agent.id]: [seg("p", "phone", "07:00", "15:30")] }, {}, {})

  it("adds an extra break that cuts the channel block and stores as a break override", () => {
    const r = markAux(day(), "break", toMins("14:00"), 15, false, "x1")
    expect(r).toMatchObject({ ok: true, start: toMins("14:00"), end: toMins("14:15") })
    if (!r.ok) return
    expect(dayTimeline(r.day).find((s) => s.segId === "x1")).toMatchObject({ kind: "break", label: "Break" })
    expect(dayToPatch(r.day).breaks.find((b) => b.id === "x1")).toEqual({ id: "x1", type: "break", label: "Break", offsetMinutes: 420, durationMinutes: 15 })
  })

  it("adds activities to the overlay; LOA as full shift", () => {
    const r = markAux(day(), "loa", 0, 0, true, "x2")
    expect(r.ok && r.day.activities[0]).toMatchObject({ type: "loa", start: toMins("07:00"), end: toMins("15:30") })
  })

  it("rejects clashes within the same layer and times outside the shift", () => {
    expect(markAux(day(), "lunch", toMins("11:15"), 30, false, "x")).toMatchObject({ ok: false, reason: expect.stringMatching(/Clashes with Lunch/) })
    // A meeting may sit over lunch — it's the overlay layer.
    expect(markAux(day(), "meeting", toMins("11:15"), 30, false, "x").ok).toBe(true)
    expect(markAux(day(), "meeting", toMins("15:15"), 30, false, "x")).toMatchObject({ ok: false, reason: expect.stringMatching(/Outside shift/) })
  })

  it("unmarkActivitiesAt clears only what's under the cursor", () => {
    const d = { ...day(), activities: [{ id: "a", type: "meeting" as const, start: toMins("10:00"), end: toMins("10:30") }, { id: "b", type: "training" as const, start: toMins("12:00"), end: toMins("13:00") }] }
    expect(unmarkActivitiesAt(d, toMins("10:15")).activities.map((x) => x.id)).toEqual(["b"])
  })
})

describe("sortSchedules", () => {
  const rows = [
    { name: "maya holt", start: toMins("09:30") },
    { name: "Ava Mendez", start: toMins("07:00") },
    { name: "Zara Khan", start: toMins("07:00") },
    { name: "ava mendez", start: toMins("10:30") },
    { name: "Liam Carter", start: toMins("08:00") },
  ]
  const order = (sort: Parameters<typeof sortSchedules>[1]) => sortSchedules(rows, sort, (r) => r).map((r) => `${r.name}@${fmtHM(r.start)}`)

  it("keeps roster order by default", () => {
    expect(sortSchedules(rows, "roster", (r) => r)).toBe(rows)
  })
  it("sorts names A→Z / Z→A case-insensitively, ties by earliest start", () => {
    expect(order("name-asc")).toEqual(["Ava Mendez@07:00", "ava mendez@10:30", "Liam Carter@08:00", "maya holt@09:30", "Zara Khan@07:00"])
    expect(order("name-desc")).toEqual(["Zara Khan@07:00", "maya holt@09:30", "Liam Carter@08:00", "Ava Mendez@07:00", "ava mendez@10:30"])
  })
  it("sorts by scheduled start earliest/latest first, ties by name", () => {
    expect(order("start-asc")).toEqual(["Ava Mendez@07:00", "Zara Khan@07:00", "Liam Carter@08:00", "maya holt@09:30", "ava mendez@10:30"])
    expect(order("start-desc")).toEqual(["ava mendez@10:30", "maya holt@09:30", "Liam Carter@08:00", "Ava Mendez@07:00", "Zara Khan@07:00"])
  })
})

describe("adding OT for a channel", () => {
  const req = (over: Partial<OtRequest> = {}): OtRequest => ({ channel: "chat", timing: "after", duration: 60, ...over })

  it("places OT straight after or before the shift", () => {
    expect(proposeOvertime(agent, [], req())).toEqual({ ok: true, segment: { channel: "chat", start: toMins("15:30"), end: toMins("16:30") } })
    expect(proposeOvertime(agent, [], req({ timing: "before", duration: 90 }))).toMatchObject({ segment: { start: toMins("05:30"), end: toMins("07:00") } })
  })

  it("chains onto OT already worked after the shift", () => {
    const existing = [seg("o", "phone", "15:30", "16:30")]
    expect(proposeOvertime(agent, existing, req())).toMatchObject({ segment: { start: toMins("16:30"), end: toMins("17:30") } })
  })

  it("rejects custom OT that overlaps the shift or existing OT", () => {
    expect(proposeOvertime(agent, [], req({ timing: "custom", start: toMins("15:00"), end: toMins("16:00") }))).toMatchObject({ ok: false, reason: expect.stringMatching(/Overlaps shift/) })
    const existing = [seg("o", "phone", "17:00", "18:00")]
    expect(proposeOvertime(agent, existing, req({ timing: "custom", start: toMins("17:30"), end: toMins("18:30") }))).toMatchObject({ ok: false, reason: expect.stringMatching(/Clashes with OT 17:00–18:00/) })
    expect(proposeOvertime(agent, [], req({ timing: "custom", start: toMins("18:00"), end: toMins("18:10") }))).toMatchObject({ ok: false, reason: expect.stringMatching(/at least 15 min/) })
  })

  it("merges touching OT on the same channel, keeps other channels separate", () => {
    const existing = [seg("a", "chat", "15:30", "16:30"), seg("b", "email", "17:30", "18:00")]
    const out = withOvertimeAdded(existing, seg("new", "chat", "16:30", "17:30"))
    expect(out).toEqual([seg("a", "chat", "15:30", "17:30"), seg("b", "email", "17:30", "18:00")])
  })
})

describe("activities (meeting, LOA, absence…)", () => {
  const act = (id: string, type: ActivitySegment["type"], start: string, end: string): ActivitySegment => ({ id, type, start: toMins(start), end: toMins(end) })
  const phoneAllDay = { [agent.id]: [seg("p", "phone", "07:00", "15:30")] }

  it("proposes full-shift LOA and timed meetings, rejecting clashes and out-of-shift times", () => {
    expect(proposeActivity(agent, [], { type: "loa", fullShift: true })).toEqual({ ok: true, segment: { type: "loa", start: toMins("07:00"), end: toMins("15:30") } })
    expect(proposeActivity(agent, [], { type: "meeting", fullShift: false, start: toMins("10:00"), end: toMins("10:30"), note: "Huddle" })).toMatchObject({
      ok: true,
      segment: { note: "Huddle" },
    })
    expect(proposeActivity(agent, [], { type: "meeting", fullShift: false, start: toMins("15:00"), end: toMins("16:00") })).toMatchObject({ ok: false, reason: expect.stringMatching(/Outside shift/) })
    expect(proposeActivity(agent, [act("m", "training", "10:00", "11:00")], { type: "meeting", fullShift: false, start: toMins("10:30"), end: toMins("11:30") })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Clashes with Training 10:00–11:00/),
    })
  })

  it("overlays the timeline without cutting the base schedule", () => {
    const tl = agentTimeline(agent, DEFAULT_SHIFT_PATTERNS, {}, phoneAllDay, {}, { [agent.id]: [act("m", "meeting", "10:00", "10:30")] })
    expect(tl.find((s) => s.kind === "activity")).toMatchObject({ activity: "meeting", start: toMins("10:00"), end: toMins("10:30"), segId: "m" })
    // Base phone piece 09:15–11:00 is still whole underneath.
    expect(tl.some((s) => s.kind === "channel" && s.start === toMins("09:15") && s.end === toMins("11:00"))).toBe(true)
  })

  it("takes the agent off the channel in coverage and counts them as in-activity", () => {
    const cov = channelCoverage([agent], DEFAULT_SHIFT_PATTERNS, {}, phoneAllDay, {}, [toMins("10:00"), toMins("11:00")], {
      [agent.id]: [act("m", "meeting", "10:00", "10:30")],
    })
    expect(cov.map((s) => s.phone)).toEqual([0, 1])
    expect(cov.map((s) => s.activity)).toEqual([1, 0])
  })

  it("reduces on-duty heads for the queue, but not twice where a break already did", () => {
    const sales = QUEUES[0]
    const salesAgent = AGENTS.find((a) => a.skills.includes(sales.id) && a.shift.startsWith("07:00"))!
    const plan = { [salesAgent.id]: [act("m", "meeting", "08:30", "09:30")] }
    const loss = activityCoverageLoss(sales.id, AGENTS, DEFAULT_SHIFT_PATTERNS, {}, plan)
    const idx = (hhmm: string) => (toMins(hhmm) - toMins("07:00")) / 30
    expect(loss[idx("08:30")]).toBe(1)
    expect(loss[idx("09:00")]).toBe(0) // on the 09:00 break already
    expect(loss[idx("09:30")]).toBe(0)
    expect(activityCoverageLoss("billing", [salesAgent].filter((a) => !a.skills.includes("billing")), DEFAULT_SHIFT_PATTERNS, {}, plan).every((n) => n === 0)).toBe(true)
  })

  it("moves/resizes activities and blocks shrinking the shift past them", () => {
    const d = agentDay(agent, DEFAULT_SHIFT_PATTERNS, {}, phoneAllDay, {}, { [agent.id]: [act("m", "meeting", "10:00", "10:30"), act("t", "training", "14:00", "15:00")] })
    expect(applyEdit(d, { kind: "activity-move", segId: "m" }, toMins("13:45")).activities[0]).toMatchObject({ start: toMins("13:30"), end: toMins("14:00") })
    expect(applyEdit(d, { kind: "activity-resize", segId: "m", edge: "end" }, toMins("11:15")).activities[0].end).toBe(toMins("11:15"))
    expect(applyEdit(d, { kind: "shift-resize", edge: "end" }, toMins("14:00")).shift[1]).toBe(toMins("15:00"))
    expect(dayToPatch(d).activities).toHaveLength(2)
  })

  it("staggers bulk activities into waves", () => {
    const w = (i: number) => staggeredWindow(i, toMins("10:00"), 30, 3, 30).map(fmtHM)
    expect([w(0), w(2), w(3), w(7)]).toEqual([["10:00", "10:30"], ["10:00", "10:30"], ["10:30", "11:00"], ["11:00", "11:30"]])
  })

  it("exports activities in every sheet", () => {
    const plan = { [agent.id]: [{ ...act("m", "meeting", "10:00", "10:30"), note: "Q3 update" }, act("a", "absence", "13:15", "15:30")] }
    const [segments, summary, grid, coverage, legend] = scheduleExportSheets([agent], QUEUES, DEFAULT_SHIFT_PATTERNS, {}, phoneAllDay, {}, plan)
    expect(segments.rows.find((r) => r.Code === "MTG")).toMatchObject({ Activity: "Meeting", Type: "Activity (overlay)", Start: "10:00", End: "10:30", Note: "Q3 update" })
    expect(summary.rows[0]).toMatchObject({ "Meeting min": 30, "Absence min": 135 })
    expect(summary.rows[0].Activities).toMatch(/Meeting · Q3 update 10:00–10:30; Absence 13:15–15:30/)
    expect(grid.rows[0]["10:15"]).toBe("MTG") // overlay wins over Phone
    expect(grid.rows[0]["13:15"]).toBe("ABS")
    expect(grid.rows[0]["09:00"]).toBe("BRK")
    expect(coverage.rows.find((r) => r.Interval === "10:00–10:30")).toMatchObject({ "In activities": 1, "Phone HC": 0 })
    expect(legend.rows.map((r) => r.Code)).toEqual(expect.arrayContaining(["MTG", "TRN", "COA", "LOA", "ABS", "OTH"]))
  })
})

describe("scheduleExportSheets", () => {
  it("exports every agent across all schedule sheets", () => {
    const ot = { [agent.id]: [seg("o", "phone", "15:30", "16:30")] }
    const sheets = scheduleExportSheets(AGENTS, QUEUES, DEFAULT_SHIFT_PATTERNS, {}, {}, ot)
    expect(sheets.map((s) => s.name)).toEqual(["Schedule segments", "Agent summary", "Interval grid (15 min)", "Channel coverage", "Legend"])
    const summary = sheets[1].rows
    expect(summary).toHaveLength(AGENTS.length)
    expect(summary[0]["OT hrs"]).toBe(1)
    const grid = sheets[2].rows
    expect(grid[0]["15:45"]).toMatch(/^OT-PH$/)
    expect(grid[0]["09:00"]).toBe("BRK")
  })
})
