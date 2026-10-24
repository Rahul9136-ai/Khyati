import { describe, expect, it } from "vitest"

import { agentDay, toMins, type AgentDay } from "./channels"
import { checkCompliance, effectiveLaw, fmtDuration, LABOUR_LAW_BY_CODE, LABOUR_LAWS } from "./labourLaw"
import { AGENTS } from "./seed"
import { DEFAULT_SHIFT_PATTERNS } from "./shiftPatterns"

// 07:00–15:30, breaks 09:00 (15m) · lunch 11:00 (30m) · 13:00 (15m) → 7h30 worked.
const base = (): AgentDay => agentDay(AGENTS[0], DEFAULT_SHIFT_PATTERNS, {}, {}, {}, {})
const withOt = (mins: number): AgentDay => ({ ...base(), ot: [{ id: "o", channel: "phone", start: toMins("15:30"), end: toMins("15:30") + mins }] })
const rules = (code: string, day = base()) => checkCompliance(day, LABOUR_LAW_BY_CODE[code]).map((i) => i.rule)

describe("labour-law presets", () => {
  it("every preset is well-formed", () => {
    expect(LABOUR_LAWS.length).toBeGreaterThanOrEqual(15)
    for (const l of LABOUR_LAWS) {
      expect(l.code && l.name && l.source && l.notes).toBeTruthy()
      for (const r of l.breakRules) expect(r.afterHours > 0 && r.minBreakMinutes > 0).toBe(true)
    }
    expect(new Set(LABOUR_LAWS.map((l) => l.code)).size).toBe(LABOUR_LAWS.length)
  })

  it("overrides layer on top of the preset", () => {
    expect(effectiveLaw("DE", { maxDailyHours: 9 })).toMatchObject({ name: "Germany", maxDailyHours: 9, maxContinuousWorkHours: 6 })
    expect(effectiveLaw(null)).toBeNull()
  })

  it("formats durations like the backend", () => {
    expect([fmtDuration(450), fmtDuration(480), fmtDuration(45)]).toEqual(["7h30", "8h", "0h45"])
  })
})

describe("checkCompliance — standard 8.5h shift", () => {
  it.each(["DE", "GB", "FR", "ES", "IN", "US", "US-CA", "CA", "AU", "AE", "SG", "MX"])("%s: compliant", (code) => {
    expect(checkCompliance(base(), LABOUR_LAW_BY_CODE[code])).toEqual([])
  })

  it("Philippines / Brazil / South Africa need one 60-min meal break", () => {
    for (const code of ["PH", "BR", "ZA"]) expect(rules(code)).toEqual(["breakRules"])
    expect(checkCompliance(base(), LABOUR_LAW_BY_CODE.PH)[0].message).toBe("Needs one break of ≥60 min after 5h worked — longest is 30 min")
  })

  it("a full-shift absence has nothing to check", () => {
    const day = { ...base(), activities: [{ id: "a", type: "absence" as const, start: toMins("07:00"), end: toMins("15:30") }] }
    expect(rules("PH", day)).toEqual([])
  })
})

describe("checkCompliance — overtime & long days", () => {
  it("Germany: 10h daily max and 6h without a break", () => {
    expect(rules("DE", withOt(120))).toEqual([]) // 9h30 worked, 45 min needed, 60 taken
    expect(rules("DE", withOt(180))).toEqual(["maxDailyHours"]) // 10h30
    expect(rules("DE", withOt(240))).toEqual(["maxDailyHours", "maxContinuousWorkHours"]) // 13:15→19:30 unbroken
    expect(checkCompliance(withOt(180), LABOUR_LAW_BY_CODE.DE)[0].message).toBe("Works 10h30 — max 10h a day")
  })

  it("UAE: at most 2h overtime a day (and 5h without breaks)", () => {
    // 3h OT → 10h30 worked, 3h overtime, and 13:15→18:30 is 5h15 unbroken.
    expect(rules("AE", withOt(180))).toEqual(["maxDailyHours", "maxDailyOtHours", "maxContinuousWorkHours"])
    expect(checkCompliance(withOt(180), LABOUR_LAW_BY_CODE.AE)[1].message).toBe("3h overtime — max 2h a day")
    expect(rules("AE", withOt(90))).toEqual([]) // 9h worked, 1h30 OT, 13:15→17:00
  })

  it("Germany needs 45 min of ≥15-min breaks after 9h: short breaks don't count", () => {
    const day = withOt(120) // 9h40 worked
    day.breaks = [
      { id: "x", type: "break", label: "Break", start: toMins("09:00"), end: toMins("09:10") },
      { id: "y", type: "lunch", label: "Lunch", start: toMins("11:00"), end: toMins("11:30") },
    ]
    // Only the 30-min lunch counts; 11:30→17:30 is exactly 6h, which is allowed.
    expect(rules("DE", day)).toEqual(["breakRules"])
    expect(checkCompliance(day, LABOUR_LAW_BY_CODE.DE)[0].message).toBe("Needs ≥45 min of breaks after 9h worked — has 30 min")
  })

  it("India: 10h30 spread-over and 5h without a 30-min rest", () => {
    // 2h30 OT → 07:00→18:00 spans 11h; 11:30→18:00 is 6h30 without a 30-min rest.
    expect(rules("IN", withOt(150))).toEqual(["maxSpreadHours", "maxContinuousWorkHours"])
    expect(rules("IN", withOt(60))).toEqual([]) // 07:00→16:30, 11:30→16:30 = 5h
  })

  it("a gap between shift and OT resets the continuous-work clock", () => {
    const day = { ...base(), ot: [{ id: "o", channel: "phone" as const, start: toMins("16:30"), end: toMins("20:00") }] }
    expect(rules("DE", day)).toEqual(["maxDailyHours"]) // 11h worked, but no 6h unbroken stretch
  })
})
