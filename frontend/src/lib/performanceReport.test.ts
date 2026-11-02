import { describe, expect, it, vi } from "vitest"

import type { AgentDay } from "@/lib/domain/channels"
import { AGENTS, QUEUES } from "@/lib/domain/seed"
import { DEFAULT_WORK_COMPLIANCE } from "@/lib/domain/workRules"
import { dayStatus, lobReport, personReport, type PerformanceActuals, type ReportInput } from "@/lib/performanceReport"
import type { QueueDay } from "@/lib/report-granularity"
import type { RangeDay } from "@/lib/workRuleApply"

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }))

const at = (h: number) => h * 60
const q = QUEUES[0]
const [ava, liam] = [
  { ...AGENTS[0], id: "a01", name: "Ava", skills: [q.id] },
  { ...AGENTS[1], id: "a02", name: "Liam", skills: [q.id] },
]
const other = { ...AGENTS[2], id: "a03", name: "Noah", skills: [QUEUES[1].id] }

function working(ot = 0): AgentDay {
  return {
    shift: [at(9), at(17)],
    breaks: [
      { id: "b1", type: "break", label: "Break", start: at(11), end: at(11) + 15 },
      { id: "b2", type: "lunch", label: "Lunch", start: at(13), end: at(13) + 30 },
      { id: "b3", type: "break", label: "Break", start: at(15), end: at(15) + 15 },
    ],
    channels: [{ id: "c", channel: "phone", start: at(9), end: at(17) }],
    ot: ot ? [{ id: "o", channel: "phone", start: at(17), end: at(17) + ot }] : [],
    activities: [],
  }
}
const whole = (type: "off" | "leave" | "absence"): AgentDay => ({ ...working(), activities: [{ id: "x", type, start: at(9), end: at(17) }] })
const rd = (date: string, day: AgentDay, source: RangeDay["source"] = "published"): RangeDay => ({ date, day, source })

const actuals: PerformanceActuals = {
  attendance: [
    { employee_code: "A01", employee_name: "Ava", team: "Alpha", lob: "Support", date: "2026-11-02", code: "Late", category: "late", minutes_late: 12, minutes_early_logout: 5 },
    { employee_code: "a01", employee_name: "Ava", team: "Alpha", lob: "Support", date: "2026-11-03", code: "Sick", category: "sick", minutes_late: 0, minutes_early_logout: 0 },
    { employee_code: "a99", employee_name: "Someone", team: "", lob: "", date: "2026-11-03", code: "Late", category: "late", minutes_late: 99, minutes_early_logout: 0 },
  ],
  queues: [
    { lob: "Other", queue: q.name, channel: "voice", date: "2026-11-02", offered: 100, handled: 90, aht_seconds: 300, service_level_pct: 80, sl_target_pct: 80, occupancy_pct: 85 },
    { lob: "Other", queue: "Unrelated", channel: "chat", date: "2026-11-02", offered: 5, handled: 5, aht_seconds: 100, service_level_pct: 90, sl_target_pct: 80, occupancy_pct: 50 },
  ],
}
const input: ReportInput = {
  start: "2026-11-02",
  end: "2026-11-04",
  agents: [ava, liam, other],
  queues: QUEUES,
  compliance: DEFAULT_WORK_COMPLIANCE,
  actuals,
  days: new Map([
    ["a01", [rd("2026-11-02", working(60)), rd("2026-11-03", whole("leave")), rd("2026-11-04", whole("off"), "planned")]],
    ["a02", [rd("2026-11-02", working()), rd("2026-11-03", whole("absence"))]],
    ["a03", [rd("2026-11-02", working())]],
  ]),
}
const plan = (id: string, key: string, totalVol: number, wSL: number): QueueDay =>
  ({ key, date: new Date(`${key}T00:00:00`), queue: QUEUES.find((x) => x.id === id)!, plan: [], sum: { totalVol, wSL, reqHours: 10, schedHours: 8, underIntervals: 0, avgOcc: 0.8, peakIdx: 0 } })

describe("performance reports", () => {
  it("reads a day's status only from whole-shift activities", () => {
    expect(dayStatus(working())).toBe("Working")
    expect(dayStatus(whole("off"))).toBe("Week off")
    expect(dayStatus({ ...working(), activities: [{ id: "x", type: "absence", start: at(9), end: at(10) }] })).toBe("Working")
  })

  it("adds up one person's period and shows only their attendance", () => {
    const { summary, sheets } = personReport(input, ava)
    expect(summary).toMatchObject({ days: 3, working: 1, weekOff: 1, leave: 1, absence: 0, scheduledMins: 480, breakMins: 60, otMins: 60 })
    expect(summary.workedMins).toBe(420 + 60) // 7h on shift + 1h OT; leave and week off count 0
    expect(summary.attendance).toEqual({ records: 2, absent: 1, late: 1, lateMins: 12, earlyMins: 5 })
    expect(sheets.map((s) => s.name)).toEqual(["About this report", "Summary", "Daily detail", "Compliance issues", "Attendance"])
    const daily = sheets[2].rows
    expect(daily.map((r) => [r.Date, r.Status, r["Planned work hours"], r.Source])).toEqual([
      ["2026-11-02", "Working", 8, "Published"],
      ["2026-11-03", "Leave", 0, "Published"],
      ["2026-11-04", "Week off", 0, "Planned"],
    ])
    expect(sheets[4].rows).toHaveLength(2)
    expect(summary.notSaved).toBe(1)
    expect(sheets[1].rows[0]["Days not saved (plan only)"]).toBe(1)
    expect(JSON.stringify(sheets[0].rows)).toContain("simulated")
    expect(JSON.stringify(sheets[0].rows)).toContain("Planned")
  })

  it("says so when a person has no attendance records, rather than showing zero", () => {
    const { summary, sheets } = personReport(input, liam)
    expect(summary.attendance).toBeNull()
    expect(sheets[1].rows[0]["Minutes late"]).toBe("No records")
  })

  it("rolls up one LOB by primary skill, weighting projected SL by volume", () => {
    const planned = [plan(q.id, "2026-11-02", 100, 0.9), plan(q.id, "2026-11-03", 300, 0.7), plan(QUEUES[1].id, "2026-11-02", 500, 0.1)]
    const r = lobReport(input, planned, q.id)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ lob: q.name, agents: 2, leave: 1, absence: 1, weekOff: 1, otMins: 60, lateMins: 12, volume: 400, requiredHours: 20 })
    expect(r.rows[0].projectedSl).toBeCloseTo(0.75)
    expect(r.people.map((p) => p.agent.id)).toEqual(["a01", "a02"])
    expect(r.actualRows).toBe(1) // the unrelated queue stays out
    const daily = r.sheets.find((s) => s.name === "LOB daily")!.rows
    expect(daily[1]).toMatchObject({ Date: "2026-11-03", "On leave": 1, Absent: 1, "Agents working": 0 })
    expect(JSON.stringify(r.sheets[0].rows)).toContain("forecasts from the current roster")
  })

  it("all LOBs keeps every queue's results and each agent once", () => {
    const r = lobReport(input, [], null)
    expect(r.rows).toHaveLength(QUEUES.length)
    expect(r.people.map((p) => p.agent.id).sort()).toEqual(["a01", "a02", "a03"])
    expect(r.actualRows).toBe(2)
  })

  it("notes when actuals couldn't load", () => {
    const { sheets } = personReport({ ...input, actuals: null }, ava)
    expect(JSON.stringify(sheets[0].rows)).toContain("couldn't be loaded")
  })
})
