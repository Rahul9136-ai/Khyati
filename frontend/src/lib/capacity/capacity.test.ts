import { describe, expect, it } from "vitest"
import * as XLSX from "xlsx"

import { DEFAULT_CONFIG } from "./config"
import { runEngine } from "./engine"
import { GOLDEN_CASES, GOLDEN_INPUTS, goldenPass, runCalculator } from "./golden"
import { canonLocation, monthLabel, parseMonth, slKey } from "./normalize"
import { parseWorkbook } from "./parse"
import { miniWorkbook } from "./testWorkbook"

describe("§6 golden test cases (Calculation & Logics)", () => {
  const r = runCalculator(GOLDEN_INPUTS)
  for (const c of GOLDEN_CASES) {
    it(`${c.section} — ${c.label} = ${c.expected}`, () => {
      const actual = c.actual(r)
      expect(goldenPass(c, actual), `actual ${actual}`).toBe(true)
    })
  }
  it("QCA attrition switch (§7 Q3) uses Attrition % instead of SNP", () => {
    const alt = runCalculator({ ...GOLDEN_INPUTS, qcaMode: "attrition" })
    expect(alt.qca.attritionHc).toBeCloseTo(10 * 0.15, 10)
  })
})

describe("§3 normalisation", () => {
  it("maps locations to one canonical value", () => {
    expect(canonLocation("TRICHY")).toBe("Trichy")
    expect(canonLocation("Tiruchirappalli")).toBe("Trichy")
    expect(canonLocation("BENGALURU")).toBe("Bangalore")
    expect(canonLocation("Navi Mumbai")).toBe("Mumbai")
    expect(canonLocation(" chennai ")).toBe("Chennai")
  })
  it("matches service lines case-insensitively", () => {
    expect(slKey("PAYMENT POSTING")).toBe(slKey("Payment posting"))
    expect(slKey("CODING")).toBe(slKey("Coding"))
  })
  it("parses Mon'YY months", () => {
    expect(parseMonth("Sep'26")).toBe("2026-09")
    expect(parseMonth("Aug'27")).toBe("2027-08")
    expect(monthLabel("2026-09")).toBe("Sep'26")
    expect(parseMonth("Sept 2026")).toBe("2026-09")
    expect(parseMonth("garbage")).toBeNull()
  })
})

describe("engine on a small synthetic workbook", () => {
  const parsed = parseWorkbook(miniWorkbook(), "mini.xlsx")
  const ds = Object.fromEntries(parsed.sheets.map((s) => [s.id, s]))
  const res = runEngine(ds, DEFAULT_CONFIG)
  const sep = res.rows.find((r) => r.month === "2026-09" && r.customer === "PROJECT X")!
  const oct = res.rows.find((r) => r.month === "2026-10" && r.customer === "PROJECT X")!

  it("parses every sheet without header errors", () => {
    expect(parsed.errors).toEqual([])
    expect(parsed.missing).toEqual([])
  })
  it("joins roster on City with case-insensitive SL", () => {
    expect(sep.actualHc).toBe(10)
    expect(sep.actualQa).toBe(1)
  })
  it("computes P4 = Volume ÷ W.days ÷ Peak, and P5 = MIN(B, A)", () => {
    expect(sep.baseFte).toBeCloseTo(2100 / 21 / 10, 10)
    expect(sep.prod.shrinkage).toBeCloseTo(0.08, 10)
    expect(sep.prod.glide).toBeCloseTo(0.05, 10)
    expect(sep.prod.reqHcProd).toBeCloseTo(10 * 1.13, 10)
  })
  it("uses MAX(B, A) for attrition and splits hiring by designation user type", () => {
    expect(sep.prod.attrition).toBeCloseTo(0.1, 10)
    expect(sep.additionProd).toBe(2)
    expect(sep.additionQca).toBe(1)
    expect(sep.prod.projectedHc).toBeCloseTo(10 - 1 + 2, 10)
  })
  it("blanks Base FTE when a transaction task has no peak target (not 0, not ∞)", () => {
    expect(oct.baseFte).toBeNull()
    expect(oct.prod.capacityPct).toBeNull()
    expect(res.exceptions.some((e) => e.code === "forecast-task-missing" && e.value === "T-MISSING")).toBe(true)
  })
  it("carries the budget forward to months without one, and flags it", () => {
    expect(oct.budgetCarried).toBe(true)
    expect(oct.shrinkB).toBeCloseTo(0.1, 10)
  })
  it("logs the Apprvoed typo and hiring before the horizon", () => {
    expect(res.exceptions.filter((e) => e.code === "approved-typo")).toHaveLength(1)
    expect(res.exceptions.filter((e) => e.code === "hiring-before-horizon")).toHaveLength(1)
  })
  it("rejects a sheet with a missing required column", () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Month"], ["Sep'26"]]), "W.days")
    const r = parseWorkbook(XLSX.write(wb, { type: "array", bookType: "xlsx" }), "bad.xlsx", "workingDays")
    expect(r.sheets).toHaveLength(0)
    expect(r.errors[0].message).toMatch(/Days/)
  })
  it("never produces NaN / Infinity", () => {
    for (const row of res.rows)
      for (const v of [row.prod.capacityPct, row.prod.va, row.qca.capacityPct, row.vol.capacityPct, row.vol.vaHc, row.vol.qcaCapacityPct])
        expect(v === null || Number.isFinite(v)).toBe(true)
  })
})
