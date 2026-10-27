import { beforeEach, describe, expect, it } from "vitest"

import { AGENTS } from "@/lib/domain/seed"
import { DEFAULT_SHIFT_PATTERNS } from "@/lib/domain/shiftPatterns"
import { DEFAULT_WORK_RULES } from "@/lib/domain/workRules"
import { parseBreaks, parseWeekOff, readPastedRows, resolveAgentRows, resolveRuleRows } from "@/lib/workRuleImport"
import { useWfm } from "@/store/wfm"

const known = DEFAULT_WORK_RULES.map((r) => ({ id: r.id, name: r.name, rule: r }))

describe("reading week offs and breaks", () => {
  it("understands days, ranges, presets and types", () => {
    expect(parseWeekOff("Sat, Sun")).toEqual({ days: [5, 6], mode: undefined })
    expect(parseWeekOff("Saturday Sunday")).toEqual({ days: [5, 6], mode: undefined })
    expect(parseWeekOff("Fri-Sun")).toEqual({ days: [4, 5, 6], mode: undefined })
    expect(parseWeekOff("Sun–Mon")).toEqual({ days: [0, 6], mode: undefined })
    expect(parseWeekOff("Fixed Sat–Sun")).toEqual({ days: [5, 6], mode: "fixed" })
    expect(parseWeekOff("Rotating Sat, Sun")).toEqual({ days: [5, 6], mode: "rotating" })
    expect(parseWeekOff("none")).toEqual({ days: [] })
    expect(parseWeekOff("Sat, Funday")).toEqual({ error: 'Unknown day "funday" in "Sat, Funday" (use Mon, Tue … Sun)' })
  })

  it("understands break patterns written several ways", () => {
    const want = [{ type: "break", minutes: 15 }, { type: "lunch", minutes: 30 }, { type: "break", minutes: 15 }]
    expect(parseBreaks("Break 15; Lunch 30; Break 15")).toEqual(want)
    expect(parseBreaks("15, 30L, 15")).toEqual(want)
    expect(parseBreaks("15m break + 30m lunch + 15m break")).toEqual(want)
    expect(parseBreaks("2x15 + 1h lunch")).toEqual([{ type: "break", minutes: 15 }, { type: "break", minutes: 15 }, { type: "lunch", minutes: 60 }])
    expect(parseBreaks("tea time")).toHaveProperty("error")
  })
})

describe("resolving rows", () => {
  it("creates new rules, updates ones with the same name and rejects bad rows", () => {
    const rows = resolveRuleRows(
      [
        { Name: "7h early", "Shift Hours": 7, Breaks: "15, 30L", "Week Off": "Sun", "Week Off Type": "Rotating", "Usual Start": "06:00" },
        { Name: DEFAULT_WORK_RULES[0].name, "Shift Hours": "8.5", Breaks: "Break 15; Lunch 30; Break 15", "Week Off": "Fri-Sat" },
        { Name: "Broken", "Shift Hours": 2, Breaks: "1h lunch, 1h lunch" },
      ],
      DEFAULT_WORK_RULES,
    )
    expect(rows[0]).toMatchObject({ ok: true, existingId: undefined, rule: { shiftMinutes: 420, weekOff: [6], weekOffMode: "rotating", defaultStart: "06:00" } })
    expect(rows[1]).toMatchObject({ ok: true, existingId: "wr-8h", rule: { shiftMinutes: 510, weekOff: [4, 5], weekOffMode: "fixed", defaultStart: "09:00" } })
    expect(rows[2]).toMatchObject({ ok: false, reason: "Breaks take up the whole shift" })
  })

  it("sets agents' rule, start and week off; blank rows are left alone", () => {
    const [a, b, c, d] = AGENTS
    const rows = resolveAgentRows(
      [
        { "Agent ID": a.id, "Work Rule": "9h · 1h lunch + 2×15m breaks", Start: "08:30", "Week Off": "Fixed Sat–Sun" },
        { "Agent ID": b.name, "Work Rule": "wr-6h" }, // by name; the rule's own week off
        { "Agent ID": c.id, "Week Off": "Mon, Tue", "Week Off Type": "Rotating" }, // only the week off
        { "Agent ID": d.id }, // nothing to change
        { "Agent ID": "zz9", "Work Rule": "wr-8h" },
        { "Agent ID": a.id, "Week Off": "Sun" },
        { "Agent ID": "a05", "Work Rule": "Night shift" },
      ],
      AGENTS,
      known,
    )
    expect(rows.map((r) => [r.row, r.ok, r.reason ?? r.summary])).toEqual([
      [2, true, "9h · 1h lunch + 2×15m breaks from 08:30 · week off Fixed · Sat, Sun"],
      [3, true, "6h part-time · 2×15m breaks from 10:00 · week off Fixed · Sat, Sun"],
      [4, true, "week off Rotating · from Mon, Tue"],
      [6, false, 'Unknown agent "zz9"'],
      [7, false, `${a.name} appears twice in the file`],
      [8, false, 'Unknown work rule "Night shift" (add it on the Work rules sheet)'],
    ])
  })

  it("reads rows pasted from Excel (tab-separated)", () => {
    const { agents, rules } = readPastedRows("Agent ID\tWork Rule\tWeek Off\na01\twr-8h\tSat, Sun\n")
    expect(rules).toEqual([])
    expect(agents).toEqual([{ "Agent ID": "a01", "Work Rule": "wr-8h", "Week Off": "Sat, Sun" }])
  })
})

describe("store: importWorkRules", () => {
  beforeEach(() => useWfm.setState({ agents: AGENTS.slice(0, 3), shiftPatterns: DEFAULT_SHIFT_PATTERNS, workRules: DEFAULT_WORK_RULES }))

  it("adds rules and points agents at new ones in one step", () => {
    const [a, b] = AGENTS
    useWfm.getState().importWorkRules(
      [{ rule: { name: "7h early", shiftMinutes: 420, breaks: [{ type: "break", minutes: 15 }, { type: "lunch", minutes: 30 }], weekOff: [6], weekOffMode: "fixed", defaultStart: "06:00" } }],
      [
        { agentId: a.id, ruleId: "new:7h early", start: "06:00", weekOff: [5, 6], weekOffMode: "rotating" },
        { agentId: b.id, weekOff: [0], weekOffMode: "fixed" },
      ],
    )
    const s = useWfm.getState()
    const rule = s.workRules.find((r) => r.name === "7h early")!
    expect(s.agents[0]).toMatchObject({ shiftPatternId: `wr:${rule.id}@06:00`, weekOff: [5, 6], weekOffMode: "rotating" })
    expect(s.shiftPatterns.find((p) => p.id === `wr:${rule.id}@06:00`)).toMatchObject({ start: "06:00", end: "13:00" })
    expect(s.agents[1]).toMatchObject({ weekOff: [0], weekOffMode: "fixed", shiftPatternId: b.shiftPatternId })
    expect(s.auditLog[0]).toMatchObject({ action: "Imported work rules", detail: "1 new rule · 2 agents set" })
  })
})
