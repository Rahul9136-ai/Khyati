import { describe, expect, it, vi } from "vitest"

import { agentDay, dayTimeline, overtimeAgents, scheduleExportSheets, type AgentDay } from "@/lib/domain/channels"
import { workedMinutes } from "@/lib/domain/labourLaw"
import { dayOtBreaks, otBreakRuleOf, otBreaksFor, otMinutes, otStretches } from "@/lib/domain/otBreaks"
import { scheduledAux } from "@/lib/domain/liveState"
import { AGENTS, QUEUES } from "@/lib/domain/seed"
import { checkWorkDay, DEFAULT_WORK_COMPLIANCE, type WorkCompliance } from "@/lib/domain/workRules"
import { lobReport, personReport, type ReportInput } from "@/lib/performanceReport"

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }))

const at = (h: number, m = 0) => h * 60 + m
const RULE = { everyMinutes: 120, breakMinutes: 15, paid: false }
const on: WorkCompliance = { ...DEFAULT_WORK_COMPLIANCE, otBreakEveryMinutes: 120, otBreakMinutes: 15, otBreakPaid: false }
const spans = (xs: { start: number; end: number }[]) => xs.map((x) => [x.start, x.end])

function day(ot: [number, number][], rule: typeof RULE | null = RULE): AgentDay {
  return {
    shift: [at(9), at(17)],
    breaks: [
      { id: "b1", type: "break", label: "Break", start: at(11), end: at(11, 15) },
      { id: "b2", type: "lunch", label: "Lunch", start: at(13), end: at(13, 30) },
      { id: "b3", type: "break", label: "Break", start: at(15), end: at(15, 15) },
    ],
    channels: [{ id: "c", channel: "phone", start: at(9), end: at(17) }],
    ot: ot.map(([s, e], i) => ({ id: `o${i}`, channel: i ? "chat" : "phone", start: s, end: e })),
    activities: [],
    ...(rule ? { otBreakRule: rule } : {}),
  }
}

describe("overtime-break rule", () => {
  it("is off unless switched on, and refuses a break as long as its OT", () => {
    expect(otBreakRuleOf(DEFAULT_WORK_COMPLIANCE)).toBeUndefined()
    expect(otBreakRuleOf({ otBreakEveryMinutes: null })).toBeUndefined()
    expect(otBreakRuleOf({ otBreakEveryMinutes: 60, otBreakMinutes: 60 })).toBeUndefined()
    expect(otBreakRuleOf(on)).toEqual(RULE)
    expect(otBreakRuleOf({ ...on, otBreakPaid: true })?.paid).toBe(true)
  })

  it("places one break per full stretch of OT, evenly, on a 5-minute grid", () => {
    expect(otBreaksFor([{ start: at(17), end: at(18, 30) }], RULE)).toEqual([]) // 1h30 < 2h: none
    expect(spans(otBreaksFor([{ start: at(17), end: at(19) }], RULE))).toEqual([[at(17, 55), at(18, 10)]])
    // 4h of OT → two breaks, at the thirds
    expect(spans(otBreaksFor([{ start: at(17), end: at(21) }], RULE))).toEqual([[at(18, 15), at(18, 30)], [at(19, 35), at(19, 50)]])
    expect(otBreaksFor([{ start: at(17), end: at(19) }], undefined)).toEqual([])
  })

  it("counts touching OT blocks as one stretch, but OT before and after the shift apart", () => {
    const touching = [{ start: at(17), end: at(18) }, { start: at(18), end: at(19) }]
    expect(otStretches(touching)).toEqual([{ start: at(17), end: at(19) }])
    expect(otBreaksFor(touching, RULE)).toHaveLength(1)
    const split = [{ start: at(7), end: at(9) }, { start: at(17), end: at(19) }]
    expect(spans(otBreaksFor(split, RULE))).toEqual([[at(7, 55), at(8, 10)], [at(17, 55), at(18, 10)]])
  })

  it("splits OT into scheduled, breaks, worked and paid", () => {
    expect(otMinutes(day([[at(17), at(19)]]))).toEqual({ scheduled: 120, breaks: 15, worked: 105, paid: 105 })
    expect(otMinutes(day([[at(17), at(19)]], { ...RULE, paid: true }))).toEqual({ scheduled: 120, breaks: 15, worked: 105, paid: 120 })
    expect(otMinutes(day([[at(17), at(19)]], null))).toEqual({ scheduled: 120, breaks: 0, worked: 120, paid: 120 })
    expect(otMinutes(day([[at(17), at(19)]], null), RULE).breaks).toBe(15) // the compliance rule as fallback
  })
})

describe("OT breaks in the schedule", () => {
  it("cut the OT block on the timeline and show as their own segment", () => {
    const tl = dayTimeline(day([[at(17), at(19)]]))
    expect(spans(tl.filter((s) => s.kind === "ot"))).toEqual([[at(17), at(17, 55)], [at(18, 10), at(19)]])
    const brk = tl.find((s) => s.kind === "ot-break")!
    expect(brk).toMatchObject({ start: at(17, 55), end: at(18, 10), paid: false, label: "OT break (unpaid)" })
    expect(tl.filter((s) => s.kind === "ot").every((s) => s.segId === "o0")).toBe(true) // still the same OT block
  })

  it("aren't worked time, nor heads on the phones, and the agent is scheduled on break", () => {
    expect(workedMinutes(day([[at(17), at(19)]], null)) - workedMinutes(day([[at(17), at(19)]]))).toBe(15)
    const agent = { ...AGENTS[0], id: "x1", shift: "09:00–17:00" }
    const heads = overtimeAgents([agent], { x1: [{ id: "o", channel: "phone", start: at(17), end: at(19) }] }, RULE)
    expect(heads.map((h) => h.shift)).toEqual(["17:00–17:55", "18:10–19:00"])
    expect(overtimeAgents([agent], { x1: [{ id: "o", channel: "phone", start: at(17), end: at(19) }] }).map((h) => h.shift)).toEqual(["17:00–19:00"])
    expect(scheduledAux(day([[at(17), at(19)]]), at(18))).toBe("AUX1")
    expect(scheduledAux(day([[at(17), at(19)]], null), at(18))).not.toBe("AUX1")
  })

  it("count as a break for 'max work in a row'", () => {
    // 15:15–19:00 is 3h45 straight without OT breaks; with one at 17:55 it isn't
    const long = day([[at(17), at(19)]], null)
    const strict = { ...DEFAULT_WORK_COMPLIANCE, maxContinuousWorkHours: 3 }
    expect(checkWorkDay(long, strict).map((i) => i.rule)).toContain("maxContinuousWork")
    expect(checkWorkDay(long, { ...strict, otBreakEveryMinutes: 120, otBreakMinutes: 15 }).map((i) => i.rule)).not.toContain("maxContinuousWork")
  })

  it("are in the schedule export, apart from overtime worked", () => {
    const agent = { ...AGENTS[0], id: "x1", name: "Ava", shift: "09:00–17:00", shiftPatternId: undefined }
    const sheets = scheduleExportSheets([agent], QUEUES, [], {}, {}, { x1: [{ id: "o", channel: "phone", start: at(17), end: at(19) }] }, {}, null, { ...RULE, paid: true })
    const segs = sheets.find((s) => s.name === "Schedule segments")!.rows
    expect(segs.find((r) => r.Code === "OT-BRK")).toMatchObject({ Type: "OT break (paid)", Start: "17:55", End: "18:10", "Duration (min)": 15 })
    const summary = sheets.find((s) => s.name === "Agent summary")!.rows[0]
    expect(summary).toMatchObject({ "OT hrs": 2, "OT break min": 15, "OT worked hrs": 1.75, "OT paid hrs": 2, "OT breaks": "17:55–18:10 paid" })
    const grid = sheets.find((s) => s.name === "Interval grid (15 min)")!.rows[0]
    expect(grid["18:00"]).toBe("OT-BRK")
    const legend = sheets.find((s) => s.name === "Legend")!.rows
    expect(legend.find((r) => r.Code === "OT-BRK")!.Meaning).toMatch(/15 min break for every 2h of OT \(paid\)/)
    expect(agentDay(agent, [], {}, {}, {}, {}, RULE).otBreakRule).toEqual(RULE)
    expect(dayOtBreaks(agentDay(agent, [], {}, {}, { x1: [{ id: "o", channel: "phone", start: at(17), end: at(19) }] }, {}, RULE))).toHaveLength(1)
  })
})

describe("OT breaks in performance reports", () => {
  const ava = { ...AGENTS[0], id: "a01", name: "Ava", skills: [QUEUES[0].id] }
  const input = (c: WorkCompliance): ReportInput => ({
    start: "2026-11-02", end: "2026-11-03", agents: [ava], queues: QUEUES, compliance: c, actuals: null,
    days: new Map([["a01", [
      { date: "2026-11-02", day: day([[at(17), at(19)]], null), source: "published" },
      { date: "2026-11-03", day: day([[at(17), at(21)]], null), source: "published" },
    ]]]),
  })

  it("show OT scheduled, OT breaks, OT worked and OT paid separately", () => {
    const { summary, sheets } = personReport(input(on), ava)
    expect(summary).toMatchObject({ otMins: 360, otBreakMins: 45, otWorkedMins: 315, otPaidMins: 315 })
    const daily = sheets.find((s) => s.name === "Daily detail")!.rows
    expect(daily[0]).toMatchObject({ "Overtime hours": 2, "OT break hours": 0.25, "OT worked hours": 1.75, "OT paid hours": 1.75 })
    expect(daily[1]).toMatchObject({ "Overtime hours": 4, "OT break hours": 0.5, "OT worked hours": 3.5 })
    const about = sheets.find((s) => s.name === "About this report")!.rows.map((r) => String(r.Detail))
    expect(about.some((d) => d.startsWith("Overtime breaks: 15 min break for every 2h of OT (unpaid)"))).toBe(true)
    // worked time drops by the OT breaks
    const off = personReport(input(DEFAULT_WORK_COMPLIANCE), ava).summary
    expect(off).toMatchObject({ otMins: 360, otBreakMins: 0, otWorkedMins: 360, otPaidMins: 360 })
    expect(off.workedMins - summary.workedMins).toBe(45)
  })

  it("paid OT breaks count in OT paid hours, and the LOB report rolls them up", () => {
    const paid = { ...on, otBreakPaid: true }
    expect(personReport(input(paid), ava).summary).toMatchObject({ otBreakMins: 45, otWorkedMins: 315, otPaidMins: 360 })
    const lob = lobReport(input(paid), [], null)
    expect(lob.rows.find((r) => r.lob === QUEUES[0].name)).toMatchObject({ otMins: 360, otBreakMins: 45, otWorkedMins: 315, otPaidMins: 360 })
    const summaryRow = lob.sheets.flatMap((s) => s.rows).find((r) => r.LOB === QUEUES[0].name && "OT break hours" in r)
    expect(summaryRow).toMatchObject({ "Overtime hours": 6, "OT break hours": 0.75, "OT worked hours": 5.25, "OT paid hours": 6 })
  })
})
