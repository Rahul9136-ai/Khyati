// Keeps the browser engine (engine.ts) and the API engine (backend
// app/modules/capacity/engine.py) giving the same numbers.
//
// This test runs the TypeScript engine on a set of scenarios and compares the
// output with backend/tests/fixtures/capacity_parity.json; the backend test
// (tests/test_capacity_parity.py) runs the Python engine on the same inputs
// and compares with the same file. Change the engine → regenerate with
//   UPDATE_PARITY=1 npx vitest run src/lib/capacity/parity.test.ts
// and both sides must agree again.
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { type CapacityConfig, DEFAULT_CONFIG } from "./config"
import { runEngine } from "./engine"
import { type Dataset, parseWorkbook } from "./parse"
import { miniWorkbook } from "./testWorkbook"

const FIXTURE = path.resolve(__dirname, "../../../../backend/tests/fixtures/capacity_parity.json")

const base: Dataset = Object.fromEntries(parseWorkbook(miniWorkbook(), "mini.xlsx").sheets.map((s) => [s.id, s]))
const clone = (): Dataset => structuredClone(base)

function withRamp(): Dataset {
  const ds = clone()
  ds.designationType!.rows.push({ __row: 99, DU: "D", Designation: "TRAINEE CODER", "User Type": "Trainee" })
  Object.assign(ds.userMapping!.rows[1], { "Job Name": "TRAINEE CODER", "Date of Production": "2026-08-31" })
  Object.assign(ds.userMapping!.rows[2], { "Date of Production": "2026-07-15" }) // Lateral, week 7 in Sep
  ds.ramp!.rows.push({ ...ds.ramp!.rows[0], __row: 3, "User Type": "Lateral",
    ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`Week ${i + 1} %`, Math.min(100, 15 + i * 10)])) })
  return ds
}

function dirty(): Dataset {
  const ds = withRamp()
  ds.forecast!.rows[0]["Units _ Oct'26"] = "n/a"
  ds.workingDays!.rows.push({ __row: 9, Month: "Octember", Days: 20 })
  ds.hiring!.rows[1]["S.No"] = 5
  ds.hiring!.rows.push({ ...ds.hiring!.rows[0], __row: 9, "S.No": 6, Location: "Pune", "Due to delivery month": "Dec'27" })
  ds.budgetBuffer!.rows.push({ ...ds.budgetBuffer!.rows[0], __row: 9 })
  ds.budgetAttrition!.rows.push({ ...ds.budgetAttrition!.rows[0], __row: 9, Month: "Oct'26", Denominator: 0 })
  ds.target!.rows.push({ ...ds.target!.rows[0], __row: 9, TaskNo: "T2", "Peak Target Prod": 0 })
  ds.forecast!.rows.push({ ...ds.forecast!.rows[0], __row: 9, "TASK_NUMBER (New)": "T2", BILL_TYPE: "Flat FTE", Location: "TRICHY" })
  ds.forecast!.rows.push({ ...ds.forecast!.rows[0], __row: 10, "TASK_NUMBER (New)": "T3", BILL_TYPE: "Hourly FTE", "Units _ Sep'26": 840 })
  ds.forecast!.rows.push({ ...ds.forecast!.rows[0], __row: 11, BILL_TYPE: "Additional Billing - Flat Rate", "Units _ Sep'26": -975.5 })
  ds.userMapping!.rows[3]["Date of Production"] = null
  ds.userMapping!.rows[4]["Job Name"] = "Subject Matter Expert"
  return ds
}

const T = "Transaction based - Hourly TAT"
const SCENARIOS: { name: string; ds: () => Dataset; config: Partial<CapacityConfig> }[] = [
  { name: "default", ds: clone, config: {} },
  { name: "ramp-grid", ds: withRamp, config: {} },
  { name: "ramp-flat-sampling-flat", ds: withRamp, config: { rampMode: "flat", rampFlatUnitsPerDay: 15, samplingMode: "flat" } },
  { name: "no-carry-forward", ds: withRamp, config: { carryForwardBudget: false } },
  { name: "exclude-task-qca-attrition", ds: withRamp, config: { missingPeakMode: "exclude-task", qcaAttritionMode: "attrition", snpPct: 0.3 } },
  { name: "fte-equivalent", ds: withRamp, config: { billTypeTreatment: { ...DEFAULT_CONFIG.billTypeTreatment, [T]: "fte" }, volumeForecastBasis: "equivalent" } },
  { name: "hourly-glide-budget-shrink", ds: withRamp, config: { billTypeTreatment: { ...DEFAULT_CONFIG.billTypeTreatment, [T]: "hourly" }, hoursPerDay: 7, glideActualPct: 0.01, volumeShrinkageSource: "budget" } },
  { name: "dirty-data", ds: dirty, config: {} },
  { name: "dirty-data-actual-shrink", ds: dirty, config: { volumeShrinkageSource: "actual", carryForwardBudget: false } },
]

/** What both engines must agree on: every result row (by key × month) and the exceptions (code, severity, row). */
function snapshot(ds: Dataset, config: Partial<CapacityConfig>) {
  const r = runEngine(ds, { ...DEFAULT_CONFIG, ...config })
  return {
    months: r.months,
    rows: r.rows.map(({ tasks, ...row }) => ({ ...row, tasks: tasks.map((t) => { const c: Partial<typeof t> = { ...t }; delete c.sourceRows; return c }) })),
    exceptions: r.exceptions.map((e) => ({ code: e.code, severity: e.severity, sheet: e.sheet, row: e.row }))
      .sort((a, b) => `${a.code}|${a.row}|${a.sheet}`.localeCompare(`${b.code}|${b.row}|${b.sheet}`)),
  }
}

const plainDataset = (ds: Dataset) => Object.fromEntries(Object.entries(ds).map(([id, s]) => [id, { rows: s!.rows, monthColumns: s!.monthColumns }]))

describe("browser ↔ API engine parity fixture", () => {
  const built = SCENARIOS.map((s) => {
    const ds = s.ds()
    return { name: s.name, dataset: plainDataset(ds), config: s.config, expected: snapshot(ds, s.config) }
  })

  it("matches backend/tests/fixtures/capacity_parity.json (regenerate with UPDATE_PARITY=1)", () => {
    if (process.env.UPDATE_PARITY) {
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true })
      fs.writeFileSync(FIXTURE, JSON.stringify({ generatedBy: "frontend/src/lib/capacity/parity.test.ts", scenarios: built }, null, 1))
    }
    const saved = JSON.parse(fs.readFileSync(FIXTURE, "utf8"))
    expect(saved.scenarios.map((s: { name: string }) => s.name)).toEqual(SCENARIOS.map((s) => s.name))
    expect(JSON.parse(JSON.stringify(built))).toEqual(saved.scenarios)
  })

  it("covers the paths that matter", () => {
    const ramp = built.find((b) => b.name === "ramp-grid")!.expected.rows.find((r) => r.month === "2026-09" && r.customer === "PROJECT X")!
    expect(ramp.vol.rampTrainee).toBe(1)
    expect(ramp.vol.rampLateral).toBe(1)
    const codes = new Set(built.find((b) => b.name === "dirty-data")!.expected.exceptions.map((e) => e.code))
    for (const c of ["non-numeric", "unparsable-month", "sno-gap", "unknown-location", "duplicate-lookup", "div-by-zero",
      "additional-billing", "missing-dop", "job-not-in-designation", "hiring-after-horizon", "approved-typo"])
      expect(codes, c).toContain(c)
  })
})
