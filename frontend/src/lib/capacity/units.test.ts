// Unit tests: every §7 switch, formula edge cases, the store, display formatting
// and normalisation helpers.
import { beforeEach, describe, expect, it } from "vitest"

import { capacityTone, fmt, passes, EMPTY_FILTERS } from "@/pages/planning/capacity/ctx"

import { type CapacityConfig, DEFAULT_CONFIG, classifyBillType, treatmentFor } from "./config"
import { type ResultRow, runEngine } from "./engine"
import { baseFteTransaction, hcProduction, hcQca, maxOf, minOf, safeDiv, volumeBased } from "./formulas"
import { canonLocation, locationKey, normApproved, normHiringType, num, parseDate, parseMonth } from "./normalize"
import { type Dataset, parseWorkbook } from "./parse"
import { editKey, useCapacity } from "./store"
import { miniWorkbook } from "./testWorkbook"

const base: Dataset = Object.fromEntries(parseWorkbook(miniWorkbook(), "mini.xlsx").sheets.map((s) => [s.id, s]))
const clone = (): Dataset => structuredClone(base)
const run = (patch: Partial<CapacityConfig> = {}, ds: Dataset = base) => runEngine(ds, { ...DEFAULT_CONFIG, ...patch })
const row = (rows: ResultRow[], month: string) => rows.find((r) => r.month === month && r.customer === "PROJECT X")!

/** Mini workbook + one Trainee in week 1 of ramp in Sep'26 (DOP 31 Aug 2026). */
function withTraineeRamp(): Dataset {
  const ds = clone()
  ds.designationType!.rows.push({ __row: 99, DU: "D", Designation: "TRAINEE CODER", "User Type": "Trainee" })
  const u = ds.userMapping!.rows[1]
  u["Job Name"] = "TRAINEE CODER"
  u["Date of Production"] = "2026-08-31"
  return ds
}

describe("formulas — edge cases", () => {
  it("safeDiv returns null (blank) for ÷0, null and non-finite inputs", () => {
    expect(safeDiv(1, 0)).toBeNull()
    expect(safeDiv(null, 2)).toBeNull()
    expect(safeDiv(1, Infinity)).toBeNull()
    expect(safeDiv(6, 3)).toBe(2)
  })
  it("MIN / MAX use whichever value exists, null when neither", () => {
    expect(minOf(0.1, null)).toBe(0.1)
    expect(minOf(null, null)).toBeNull()
    expect(maxOf(null, 0.2)).toBe(0.2)
    expect(maxOf(0.11, 0.15)).toBe(0.15)
  })
  it("Base FTE per transaction task is blank when peak or W.days is 0", () => {
    expect(baseFteTransaction(100, 0, 10)).toBeNull()
    expect(baseFteTransaction(100, 20, 0)).toBeNull()
    expect(baseFteTransaction(2100, 21, 10)).toBe(10)
  })
  it("HC Production: blank Base FTE → blank Req, Capacity and VA, but Projected HC still computes", () => {
    const o = hcProduction({ baseFte: null, shrinkB: 0.1, shrinkA: null, glideB: null, glideA: null, growth: null,
      actualHc: 10, attrB: 0.1, attrA: null, snp: 0.2, addition: 2 })
    expect(o.reqHcProd).toBeNull()
    expect(o.capacityPct).toBeNull()
    expect(o.va).toBeNull()
    expect(o.projectedHc).toBe(11)
  })
  it("HC QCA: Req QCA = 0 → capacity blank", () => {
    const o = hcQca({ budgetQcaPct: 0, projectedProdHc: 50, actualQa: 3, attrB: null, attrA: null, snp: 0.2, addition: 0, mode: "snp" })
    expect(o.reqQca).toBe(0)
    expect(o.capacityPct).toBeNull()
  })
  it("Volume Based: no forecast volume → capacity blank, not ∞", () => {
    const o = volumeBased({ forecastVolume: 0, actualHc: 5, rampTrainee: 0, rampLateral: 0, rampProduction: 0, peak: 10, wdays: 20,
      shrinkagePct: 0.1, samplingPct: 0.15, actualQca: 1, peakQca: 50 })
    expect(o.actualProductivity).toBe(900)
    expect(o.capacityPct).toBeNull()
    expect(o.vaUnits).toBe(900)
  })
})

describe("§7 switches", () => {
  it("Q1 bill types: transaction / FTE / hourly / excluded", () => {
    const t = "Transaction based - Hourly TAT"
    expect(row(run().rows, "2026-09").baseFte).toBeCloseTo(10, 10)
    expect(row(run({ billTypeTreatment: { ...DEFAULT_CONFIG.billTypeTreatment, [t]: "fte" } }).rows, "2026-09").baseFte).toBe(2100)
    expect(row(run({ billTypeTreatment: { ...DEFAULT_CONFIG.billTypeTreatment, [t]: "hourly" } }).rows, "2026-09").baseFte).toBeCloseTo(2100 / (21 * 8), 10)
    expect(row(run({ billTypeTreatment: { ...DEFAULT_CONFIG.billTypeTreatment, [t]: "hourly" }, hoursPerDay: 7 }).rows, "2026-09").baseFte).toBeCloseTo(2100 / (21 * 7), 10)
    const ex = row(run({ billTypeTreatment: { ...DEFAULT_CONFIG.billTypeTreatment, [t]: "exclude" } }).rows, "2026-09")
    expect(ex.forecastVolume).toBe(0)
    expect(ex.baseFte).toBe(0)
  })
  it("Q1 unknown bill types are classified by name", () => {
    expect(classifyBillType("Additional Billing - Something")).toBe("exclude")
    expect(classifyBillType("Hourly FTE")).toBe("hourly")
    expect(classifyBillType("Hourly FTE Slab Based")).toBe("fte")
    expect(classifyBillType("Transaction based - Weekly")).toBe("transaction")
    expect(treatmentFor(DEFAULT_CONFIG, "flat fte")).toBe("fte")
  })
  it("Q2 Glide A: budget only by default, MIN(B, A) with a manual A", () => {
    expect(row(run().rows, "2026-09").prod.glide).toBeCloseTo(0.05, 10)
    expect(row(run({ glideActualPct: 0.01 }).rows, "2026-09").prod.glide).toBeCloseTo(0.01, 10)
    expect(row(run({ glideActualPct: 0.5 }).rows, "2026-09").prod.glide).toBeCloseTo(0.05, 10)
  })
  it("Q3 QCA Attrition HC: QA × SNP (sheet) or QA × Attrition %", () => {
    expect(row(run().rows, "2026-09").qca.attritionHc).toBeCloseTo(1 * 0.2, 10)
    expect(row(run({ snpPct: 0.3 }).rows, "2026-09").qca.attritionHc).toBeCloseTo(0.3, 10)
    expect(row(run({ qcaAttritionMode: "attrition" }).rows, "2026-09").qca.attritionHc).toBeCloseTo(0.05, 10) // budget 5 ÷ 100
  })
  it("Q4 ramp: Peak × Ramp Grid % (live) or flat units/day (sheet)", () => {
    const ds = withTraineeRamp()
    const g = row(run({}, ds).rows, "2026-09")
    expect(g.vol.rampTrainee).toBe(1)
    expect(g.vol.bauHc).toBe(9)
    expect(g.vol.rampProduction).toBeCloseTo(10 * 1 * 21, 10) // Trainee week 1 = 100% in the mini grid
    const f = row(run({ rampMode: "flat" }, ds).rows, "2026-09")
    expect(f.vol.rampProduction).toBe(1 * 15 * 21)
    expect(row(run({ rampMode: "flat", rampFlatUnitsPerDay: 20 }, ds).rows, "2026-09").vol.rampProduction).toBe(420)
    // by Oct'26 the trainee is in week 5 → still ramp; by Jan'27 (week 18) → BAU
    expect(row(run({}, ds).rows, "2026-10").vol.rampTrainee).toBe(1)
  })
  it("Q5 sampling: production-weighted Sampling Grid (live) or flat 18% (sheet)", () => {
    const ds = withTraineeRamp()
    // 9 BAU users at BAU 15% + 1 week-1 user at 100%, equal production each
    expect(row(run({}, ds).rows, "2026-09").vol.samplingPct).toBeCloseTo((9 * 0.15 + 1) / 10, 10)
    expect(row(run({ samplingMode: "flat" }, ds).rows, "2026-09").vol.samplingPct).toBe(0.18)
  })
  it("Q6 volume shrinkage: 1 − MIN (default), budget only, actual only", () => {
    const prod = (cfg: Partial<CapacityConfig>) => {
      const r = row(run(cfg).rows, "2026-09")
      return r.vol.actualProductivity! / r.vol.rawProduction!
    }
    expect(prod({})).toBeCloseTo(1 - 0.08, 10)
    expect(prod({ volumeShrinkageSource: "budget" })).toBeCloseTo(1 - 0.1, 10)
    expect(prod({ volumeShrinkageSource: "actual" })).toBeCloseTo(1 - 0.08, 10)
  })
  it("Q7 months with no budget: carried forward and flagged, or not", () => {
    const on = row(run().rows, "2026-10")
    expect(on.budgetCarried).toBe(true)
    expect(on.glideB).toBeCloseTo(0.05, 10)
    expect(on.flags.join()).toMatch(/carried forward from Sep'26/)
    const off = row(run({ carryForwardBudget: false }).rows, "2026-10")
    expect(off.budgetCarried).toBe(false)
    expect(off.glideB).toBeNull()
    expect(off.prod.shrinkage).toBeCloseTo(0.08, 10) // Actual only
  })
  it("A1 missing peak target: blank the key (strict) or drop only that task", () => {
    expect(row(run().rows, "2026-10").baseFte).toBeNull()
    const ex = row(run({ missingPeakMode: "exclude-task" }).rows, "2026-10")
    expect(ex.baseFte).toBe(0)
    expect(ex.flags.join()).toMatch(/T-MISSING: no peak target/)
  })
  it("A2 volume basis: units as-is or FTE-billed tasks as equivalent volume", () => {
    const fte = { billTypeTreatment: { ...DEFAULT_CONFIG.billTypeTreatment, "Transaction based - Hourly TAT": "fte" as const } }
    expect(row(run(fte).rows, "2026-09").vol.forecastVolume).toBe(2100)
    expect(row(run({ ...fte, volumeForecastBasis: "equivalent" }).rows, "2026-09").vol.forecastVolume).toBe(2100 * 10 * 21)
  })
})

describe("P2 peak target (volume-weighted)", () => {
  it("is the task's peak for a single task — not Peak × W.days", () => {
    const r = row(run().rows, "2026-09")
    expect(r.peakTarget).toBeCloseTo(10, 10)
    expect(r.vol.bauProduction).toBeCloseTo(10 * 10 * 21, 10) // BAU HC × Peak × W.days
  })
  it("weights several tasks so Volume ÷ W.days ÷ P2 = Σ Base FTE", () => {
    const ds = clone()
    const t = { ...ds.target!.rows[0], __row: 50, TaskNo: "T-MISSING", "Peak Target Prod": 20 }
    ds.target!.rows.push(t)
    ds.forecast!.rows[1]["Units _ Sep'26"] = 2100
    const r = row(run({}, ds).rows, "2026-09")
    expect(r.baseFte).toBeCloseTo(2100 / 21 / 10 + 2100 / 21 / 20, 10) // 10 + 5
    expect(r.peakTarget).toBeCloseTo(4200 / (2100 / 10 + 2100 / 20), 10) // 13.33
    expect(r.forecastVolume / r.wdays! / r.peakTarget!).toBeCloseTo(r.baseFte!, 10)
  })
})

describe("engine — inputs flow through", () => {
  it("editing Working Days changes Base FTE", () => {
    const ds = clone()
    ds.workingDays!.rows[0]["Days"] = 42
    expect(row(run({}, ds).rows, "2026-09").baseFte).toBeCloseTo(5, 10)
  })
  it("a non-numeric forecast unit is flagged and treated as 0", () => {
    const ds = clone()
    ds.forecast!.rows[0]["Units _ Sep'26"] = "abc"
    const r = run({}, ds)
    expect(r.exceptions.some((e) => e.code === "non-numeric" && e.value === "abc")).toBe(true)
    expect(row(r.rows, "2026-09").forecastVolume).toBe(0)
  })
  it("an unparsable Working Days month is flagged", () => {
    const ds = clone()
    ds.workingDays!.rows[1]["Month"] = "Octember"
    const r = run({}, ds)
    expect(r.months).toEqual(["2026-09"])
    expect(r.exceptions.some((e) => e.code === "unparsable-month")).toBe(true)
  })
  it("a hiring S.No gap is flagged", () => {
    const ds = clone()
    ds.hiring!.rows[2]["S.No"] = 7
    expect(run({}, ds).exceptions.some((e) => e.code === "sno-gap")).toBe(true)
  })
  it("errors only for problems that leave a value blank", () => {
    const sev = run().exceptions.filter((e) => e.severity === "error").map((e) => e.code)
    expect(sev).toEqual(["forecast-task-missing"])
  })
})

describe("store", () => {
  beforeEach(() => useCapacity.setState({ dataset: clone(), edits: {}, config: DEFAULT_CONFIG }))
  it("records the original value of an edited cell, and forgets it when edited back", () => {
    const { editCell } = useCapacity.getState()
    editCell("workingDays", 2, "Days", 30)
    expect(useCapacity.getState().edits[editKey("workingDays", 2, "Days")]).toBe(21)
    expect(useCapacity.getState().dataset.workingDays!.rows[0]["Days"]).toBe(30)
    editCell("workingDays", 2, "Days", 25)
    expect(useCapacity.getState().edits[editKey("workingDays", 2, "Days")]).toBe(21)
    editCell("workingDays", 2, "Days", 21)
    expect(useCapacity.getState().edits).toEqual({})
  })
  it("ignores edits to rows that don't exist", () => {
    useCapacity.getState().editCell("workingDays", 999, "Days", 5)
    expect(useCapacity.getState().edits).toEqual({})
  })
  it("sets and resets switches", () => {
    useCapacity.getState().setConfig({ rampMode: "flat" })
    expect(useCapacity.getState().config.rampMode).toBe("flat")
    useCapacity.getState().resetConfig()
    expect(useCapacity.getState().config).toEqual(DEFAULT_CONFIG)
  })
  it("Remove data clears the workbook and edits", () => {
    useCapacity.getState().editCell("workingDays", 2, "Days", 30)
    useCapacity.getState().clearData()
    expect(useCapacity.getState().dataset).toEqual({})
    expect(useCapacity.getState().edits).toEqual({})
  })
})

describe("display formatting & filters", () => {
  it("never shows NaN / Infinity; HC and % at 2 dp", () => {
    expect(fmt(null, "hc")).toBe("")
    expect(fmt(NaN, "pct")).toBe("")
    expect(fmt(Infinity, "num")).toBe("")
    expect(fmt(111.1111, "hc")).toBe("111.11")
    expect(fmt(0.7785, "pct")).toBe("77.85%")
    expect(fmt(-24.6111, "hc")).toBe("-24.61")
  })
  it("colours capacity: <95% red, 95–105% green, >105% amber", () => {
    expect(capacityTone(0.9, 0.95, 1.05)).toMatch(/red/)
    expect(capacityTone(1, 0.95, 1.05)).toMatch(/emerald/)
    expect(capacityTone(1.2, 0.95, 1.05)).toMatch(/amber/)
    expect(capacityTone(null, 0.95, 1.05)).toBe("")
  })
  it("filters compare case-insensitively and locations canonically", () => {
    const f = { ...EMPTY_FILTERS, customer: "project x", location: "Trichy" }
    expect(passes(f, { customer: "PROJECT X", location: "Tiruchirappalli" })).toBe(true)
    expect(passes(f, { customer: "PROJECT Y", location: "Trichy" })).toBe(false)
    expect(passes({ ...EMPTY_FILTERS, month: "2026-09" }, { month: "2026-10" })).toBe(false)
    expect(passes({ ...EMPTY_FILTERS, month: "2026-09" }, {})).toBe(true) // sheet without a month
  })
})

describe("normalisation helpers", () => {
  it("reads numbers, percentages and blanks", () => {
    expect(num("12%")).toBeCloseTo(0.12, 10)
    expect(num("1,234.5")).toBe(1234.5)
    expect(num("-")).toBeNull()
    expect(num("")).toBeNull()
    expect(num("abc")).toBeNull()
  })
  it("reads Excel serial dates and ISO / d-m-y text", () => {
    expect(parseDate(45000)!.toISOString().slice(0, 10)).toBe("2023-03-15")
    expect(parseDate("2026-08-31")!.toISOString().slice(0, 10)).toBe("2026-08-31")
    expect(parseDate("31/08/2026")!.toISOString().slice(0, 10)).toBe("2026-08-31")
    expect(parseMonth(46266)).toBe("2026-09")
  })
  it("normalises hiring type, approval typo and unknown locations", () => {
    expect(normHiringType("Laterals")).toBe("Lateral")
    expect(normApproved("Apprvoed")).toEqual({ value: "Approved", typo: true })
    expect(normApproved("Approved")).toEqual({ value: "Approved", typo: false })
    expect(canonLocation("Pune")).toBeNull()
    expect(locationKey("Pune")).toBe("PUNE")
  })
})
