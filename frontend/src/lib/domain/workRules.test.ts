import { beforeEach, describe, expect, it } from "vitest"

import type { AgentDay } from "@/lib/domain/channels"
import { AGENTS } from "@/lib/domain/seed"
import {
  applyWorkRuleToDay,
  checkWorkDay,
  checkWorkRule,
  checkWorkWeeks,
  DEFAULT_WORK_COMPLIANCE as C,
  DEFAULT_WORK_RULES,
  describeBreaks,
  describeWeekOff,
  isOffOn,
  offDaysOn,
  placeBreaks,
  WEEK_OFF_PRESETS,
  weekdayOf,
  workRulePattern,
  workRulePatternId,
} from "@/lib/domain/workRules"
import { DEFAULT_SHIFT_PATTERNS } from "@/lib/domain/shiftPatterns"
import { scheduleForDate, useWfm } from "@/store/wfm"

const at = (h: number, m = 0) => h * 60 + m
const rule = (id: string) => DEFAULT_WORK_RULES.find((r) => r.id === id)!
/** A shift with breaks given as [start, minutes, type?]. */
function day(start: number, end: number, breaks: [number, number, ("break" | "lunch")?][] = [], over: Partial<AgentDay> = {}): AgentDay {
  return {
    shift: [start, end],
    breaks: breaks.map(([s, m, type = "break"], i) => ({ id: `b${i}`, type, label: type, start: s, end: s + m })),
    channels: [{ id: "c", channel: "phone", start, end }],
    ot: [],
    activities: [],
    ...over,
  }
}

describe("break patterns", () => {
  it("spreads the breaks so the work is split into equal stretches", () => {
    // 8h: 420 min of work in four 105-min stretches.
    expect(placeBreaks(rule("wr-8h")).map((b) => [b.label, b.offsetMinutes, b.durationMinutes])).toEqual([
      ["Break 1", 105, 15],
      ["Lunch", 225, 30],
      ["Break 2", 360, 15],
    ])
    // 9h with a 1h lunch: 110-min stretches, the last takes the rounding (120).
    expect(placeBreaks(rule("wr-9h")).map((b) => b.offsetMinutes)).toEqual([110, 235, 405])
    expect(describeBreaks(rule("wr-9h").breaks)).toBe("1h lunch + 2×15m breaks")
    expect(describeBreaks(rule("wr-8h").breaks)).toBe("30m lunch + 2×15m breaks")
  })

  it("every preset passes the default compliance rules", () => {
    for (const r of DEFAULT_WORK_RULES) expect(checkWorkRule(r, C), r.name).toEqual([])
  })

  it("flags a rule without breaks or with too long a stretch", () => {
    expect(checkWorkRule({ shiftMinutes: 240, breaks: [] }, C).map((i) => i.rule)).toEqual(["breakRequired", "maxContinuousWork"])
    // Exactly 3h: needs a break, but 3h in a row is still allowed.
    expect(checkWorkRule({ shiftMinutes: 180, breaks: [] }, C).map((i) => i.rule)).toEqual(["breakRequired"])
    const long = checkWorkRule({ shiftMinutes: 540, breaks: [{ type: "lunch", minutes: 60 }] }, C)
    expect(long.map((i) => i.message)).toEqual(["4h of work without a break — max 3h in a row", "4h of work without a break — max 3h in a row"])
  })

  it("makes a generated shift pattern for a start time", () => {
    const p = workRulePattern(rule("wr-9h"), "08:30")
    expect(p).toMatchObject({ id: workRulePatternId("wr-9h", "08:30"), start: "08:30", end: "17:30" })
    expect(p.breaks).toHaveLength(3)
  })
})

describe("daily compliance", () => {
  it("outlines a stretch over 3h without a break", () => {
    const issues = checkWorkDay(day(at(9), at(17), [[at(13), 30, "lunch"]]), C)
    expect(issues.map((i) => i.rule)).toEqual(["maxContinuousWork", "maxContinuousWork"])
    expect(issues[0]).toMatchObject({ span: { start: at(9), end: at(13) }, message: "Works 09:00–13:00 (4h) without a break — max 3h in a row" })
  })

  it("needs a break in a 3h shift and a lunch on long ones", () => {
    expect(checkWorkDay(day(at(9), at(12)), C).map((i) => i.rule)).toEqual(["breakRequired"])
    const noLunch = day(at(9), at(17), [[at(11), 15], [at(13), 15], [at(15), 15]])
    expect(checkWorkDay(noLunch, C).map((i) => i.rule)).toEqual(["lunchRequired"])
    expect(checkWorkDay(day(at(9), at(17), [[at(11), 15], [at(13), 30, "lunch"], [at(15), 15]]), C)).toEqual([])
  })

  it("counts overtime run straight on from the shift as the same stretch", () => {
    const d = day(at(9), at(17), [[at(11), 15], [at(13), 30, "lunch"], [at(15), 15]], { ot: [{ id: "o", channel: "phone", start: at(17), end: at(19) }] })
    expect(checkWorkDay(d, C)[0]).toMatchObject({ rule: "maxContinuousWork", span: { start: at(15, 15), end: at(19) } })
  })

  it("leaves a week off alone, but flags overtime on it", () => {
    const off = { activities: [{ id: "week-off", type: "off" as const, start: at(9), end: at(12) }] }
    expect(checkWorkDay(day(at(9), at(12), [], off), C)).toEqual([])
    const ot = checkWorkDay(day(at(9), at(12), [], { ...off, ot: [{ id: "o", channel: "chat", start: at(12), end: at(14) }] }), C)
    expect(ot.map((i) => i.rule)).toEqual(["otOnWeekOff"])
  })

  it("switches a rule off with null", () => {
    expect(checkWorkDay(day(at(9), at(13)), { ...C, breakRequiredAfterHours: null, maxContinuousWorkHours: null })).toEqual([])
  })
})

describe("weekly compliance", () => {
  const good = () => day(at(9), at(17), [[at(11), 15], [at(13), 30, "lunch"], [at(15), 15]])
  const offDay = () => ({ ...good(), activities: [{ id: "week-off", type: "off" as const, start: at(9), end: at(17) }] })
  // 2026-11-02 is a Monday.
  const week = (mk: (i: number) => AgentDay) => Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-0${i + 2}`, day: mk(i) }))

  it("flags seven days in a row and a week with no day off", () => {
    const rules = checkWorkWeeks(week(good), C).map((i) => [i.rule, i.date])
    // 7 × 7h worked = 49h, over the 48h week too.
    expect(rules).toEqual([["maxConsecutiveWorkDays", "2026-11-08"], ["minDaysOffPerWeek", "2026-11-02"], ["maxWeeklyHours", "2026-11-02"]])
  })

  it("is happy with a Sat–Sun week off", () => {
    expect(checkWorkWeeks(week((i) => (i >= 5 ? offDay() : good())), C)).toEqual([])
  })

  it("checks weekly hours and the rest between shifts", () => {
    const long = week((i) => (i === 6 ? offDay() : day(at(7), at(17), [[at(9), 15], [at(11), 30, "lunch"], [at(13), 15], [at(15), 15]])))
    expect(checkWorkWeeks(long, C).map((i) => i.rule)).toEqual(["maxWeeklyHours"])
    const late = { date: "2026-11-02", day: day(at(14), at(22), [[at(16), 15], [at(18), 30, "lunch"], [at(20), 15]]) }
    expect(checkWorkWeeks([late, { date: "2026-11-03", day: good() }], C)).toEqual([]) // 22:00 → 09:00 is exactly 11h
    expect(checkWorkWeeks([late, { date: "2026-11-03", day: day(at(7), at(15), [[at(9), 15], [at(11), 30, "lunch"], [at(13), 15]]) }], C)[0]).toMatchObject({
      rule: "minRestBetweenShifts",
      message: "Only 9h rest before 2026-11-03 (finished 22:00, starts 07:00) — needs 11h",
    })
  })
})

describe("writing a rule into a day", () => {
  const pattern = workRulePattern(rule("wr-9h"), "08:00")
  it("sets the rule's shift and breaks and stretches the channels", () => {
    const before = day(at(7), at(15, 30), [[at(9), 15]], { channels: [{ id: "a", channel: "phone", start: at(7), end: at(12) }, { id: "b", channel: "chat", start: at(12), end: at(15, 30) }] })
    const after = applyWorkRuleToDay(before, pattern, [5, 6], "2026-11-02") // a Monday
    expect(after.shift).toEqual([at(8), at(17)])
    expect(after.breaks.map((b) => b.start)).toEqual([at(9, 50), at(11, 55), at(14, 45)])
    expect(after.channels.map((c) => [c.channel, c.start, c.end])).toEqual([["phone", at(8), at(12)], ["chat", at(12), at(17)]])
    expect(after.activities).toEqual([])
  })

  it("marks the week off, and takes a stale one away", () => {
    expect(weekdayOf("2026-11-07")).toBe(5) // Saturday
    const sat = applyWorkRuleToDay(day(at(8), at(17)), pattern, [5, 6], "2026-11-07")
    expect(sat.activities).toEqual([{ id: "week-off", type: "off", start: at(8), end: at(17), note: "Week off" }])
    expect(applyWorkRuleToDay(sat, pattern, [6], "2026-11-07").activities).toEqual([])
    // No rule: shift and breaks stay, only the week off changes.
    const own = applyWorkRuleToDay(day(at(7), at(15), [[at(9), 15]]), null, [5], "2026-11-07")
    expect(own.shift).toEqual([at(7), at(15)])
    expect(own.breaks).toHaveLength(1)
    expect(own.activities[0].type).toBe("off")
  })
})

describe("fixed and rotating week offs", () => {
  it("keeps fixed days every week and moves rotating ones a day later each week", () => {
    // 2026-11-02 is a Monday, 43 weeks after the 2026-01-05 anchor (43 % 7 = 1).
    expect(offDaysOn([5, 6], "fixed", "2026-11-02")).toEqual([5, 6])
    expect(offDaysOn([5, 6], "rotating", "2026-01-07")).toEqual([5, 6])
    expect(offDaysOn([5, 6], "rotating", "2026-01-12")).toEqual([0, 6]) // Sun–Mon
    expect(offDaysOn([5, 6], "rotating", "2026-01-19")).toEqual([0, 1]) // Mon–Tue
    expect(offDaysOn([5, 6], "rotating", "2026-11-02")).toEqual([0, 6])
    expect(isOffOn([5, 6], "fixed", "2026-11-07")).toBe(true) // Saturday
    expect(isOffOn([5, 6], "rotating", "2026-11-07")).toBe(false)
    expect(isOffOn([5, 6], "rotating", "2026-11-02")).toBe(true)
    expect(describeWeekOff([6, 5], "fixed")).toBe("Fixed · Sat, Sun")
    expect(describeWeekOff([5, 6], "rotating")).toBe("Rotating · from Sat, Sun")
    expect(WEEK_OFF_PRESETS[0]).toMatchObject({ label: "Fixed Sat–Sun", mode: "fixed", days: [5, 6] })
  })

  it("a rotating week off still gives a day off every week", () => {
    const d = (date: string) => ({ date, day: applyWorkRuleToDay(day(at(9), at(17), [[at(11), 15], [at(13), 30, "lunch"], [at(15), 15]]), null, [5, 6], date, "rotating") })
    const fourWeeks = Array.from({ length: 28 }, (_, i) => d(new Date(Date.UTC(2026, 10, 2 + i)).toISOString().slice(0, 10)))
    expect(checkWorkWeeks(fourWeeks, C)).toEqual([])
  })
})

describe("store: assigning work rules", () => {
  const a = AGENTS[0]
  beforeEach(() => useWfm.setState({ agents: AGENTS.slice(0, 3), shiftPatterns: DEFAULT_SHIFT_PATTERNS, workRules: DEFAULT_WORK_RULES, scheduleDate: "2026-10-26", dayStore: {} }))

  it("puts agents on a generated pattern and gives unopened dates their week off", () => {
    useWfm.getState().assignWorkRule([a.id], { ruleId: "wr-9h", start: "08:00", weekOff: [6, 5] })
    const s = useWfm.getState()
    const me = s.agents.find((x) => x.id === a.id)!
    expect(me).toMatchObject({ shiftPatternId: "wr:wr-9h@08:00", weekOff: [5, 6] })
    expect(s.shiftPatterns.find((p) => p.id === "wr:wr-9h@08:00")).toMatchObject({ start: "08:00", end: "17:00" })

    const sat = scheduleForDate(s, "2026-11-07")
    expect(sat.agents.find((x) => x.id === a.id)!.shift).toBe("08:00–17:00")
    expect(sat.activityPlan[a.id]).toEqual([{ id: "week-off", type: "off", start: at(8), end: at(17), note: "Week off" }])
    expect(scheduleForDate(s, "2026-11-06").activityPlan[a.id]).toBeUndefined() // Friday: working

    useWfm.getState().setWeekOff([a.id], [5, 6], "rotating")
    const r = useWfm.getState()
    expect(r.agents.find((x) => x.id === a.id)!.weekOffMode).toBe("rotating")
    expect(scheduleForDate(r, "2026-11-07").activityPlan[a.id]).toBeUndefined() // this week it's Sun–Mon
    expect(scheduleForDate(r, "2026-11-02").activityPlan[a.id]?.[0].type).toBe("off")
  })

  it("follows rule edits, and frees agents when the rule goes", () => {
    useWfm.getState().assignWorkRule([a.id], { ruleId: "wr-8h", start: "09:00", weekOff: [5, 6] })
    useWfm.getState().updateWorkRule("wr-8h", { shiftMinutes: 450 })
    expect(useWfm.getState().shiftPatterns.find((p) => p.id === "wr:wr-8h@09:00")!.end).toBe("16:30")
    useWfm.getState().removeWorkRule("wr-8h")
    const s = useWfm.getState()
    expect(s.agents.find((x) => x.id === a.id)).toMatchObject({ shiftPatternId: undefined, weekOff: undefined })
    expect(s.shiftPatterns.some((p) => p.id.startsWith("wr:"))).toBe(false)
  })
})
