// Runs against the real sample workbook when it's available locally (it isn't
// committed — it's client data). Point AFORCE_SAMPLE at the file to run it.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { DEFAULT_CONFIG } from "./config"
import { countByCode, runEngine } from "./engine"
import { type Dataset, parseWorkbook } from "./parse"
import { SHEETS } from "./schema"

const FILE = process.env.AFORCE_SAMPLE
  ?? path.join(os.homedir(), "Downloads", "Aforce - Sample data - East Division-v1.xlsx")
const have = fs.existsSync(FILE)

describe.skipIf(!have)("sample workbook — Definition of Done §8", () => {
  const buf = have ? fs.readFileSync(FILE) : Buffer.alloc(0)
  const parsed = parseWorkbook(new Uint8Array(buf), path.basename(FILE))
  const ds: Dataset = Object.fromEntries(parsed.sheets.map((s) => [s.id, s]))
  const res = runEngine(ds, DEFAULT_CONFIG)
  const codes = countByCode(res.exceptions)

  it("loads all 14 inputs with no header errors", () => {
    expect(parsed.errors).toEqual([])
    expect(parsed.missing).toEqual([])
  })
  for (const def of SHEETS)
    it(`${def.label} has ${def.expectedRows} rows`, () => {
      expect(ds[def.id]?.rows.length).toBe(def.expectedRows)
    })

  it("Hiring S.No runs 1…478 with no gaps", () => {
    const sno = ds.hiring!.rows.map((r) => r["S.No"])
    expect(sno).toEqual(Array.from({ length: 478 }, (_, i) => i + 1))
    expect(codes["sno-gap"] ?? 0).toBe(0)
  })

  it("§5 exceptions match the stated counts", () => {
    expect(codes["forecast-task-missing"]).toBe(7)
    expect(codes["forecast-duplicate"]).toBe(5)
    expect(codes["job-not-in-designation"]).toBe(4)
    expect(codes["approved-typo"]).toBe(56)
    expect(codes["hiring-before-horizon"]).toBe(37)
    expect(codes["additional-billing"]).toBe(5)
    expect(codes["no-budget-month"]).toBeGreaterThan(0)
  })

  it("Summary Actual HC reconciles with User Mapping (ACTIVE Production + Trainee)", () => {
    const um = ds.userMapping!.rows.filter((r) =>
      String(r["Employment Status"]).toUpperCase() === "ACTIVE"
      && ["02. PRODUCTION", "12. TRAINEE [DU & CUSTOMER SPECIFIC]"].includes(String(r["Employee Category"]).toUpperCase()))
    const sep = res.rows.filter((r) => r.month === "2026-09")
    expect(sep.reduce((s, r) => s + r.actualHc, 0)).toBe(um.length)
    const qa = ds.userMapping!.rows.filter((r) => r["Employee Category"] === "02. QA")
    expect(sep.reduce((s, r) => s + r.actualQa, 0)).toBe(qa.length)
  })

  it("Summary additions reconcile with Hiring (Approved + OPEN, in horizon)", () => {
    const horizon = new Set(res.months)
    const expected = res.counts.hiring.filter((h) => h.month && horizon.has(h.month)).reduce((s, h) => s + h.opening, 0)
    const actual = res.rows.reduce((s, r) => s + r.additionProd + r.additionQca, 0)
    expect(actual).toBe(expected)
    expect(expected).toBe(478 - 37)
  })

  it("no NaN / Infinity anywhere in the results", () => {
    const bad: string[] = []
    const walk = (v: unknown, p: string) => {
      if (typeof v === "number" && !Number.isFinite(v)) bad.push(p)
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`)
    }
    res.rows.forEach((r, i) => walk({ prod: r.prod, qca: r.qca, vol: r.vol, baseFte: r.baseFte }, `row${i}`))
    expect(bad.slice(0, 5)).toEqual([])
  })

  it("prints a profile of the run (for the report)", () => {
    const sep = res.rows.filter((r) => r.month === "2026-09")
    console.log(JSON.stringify({
      months: res.months.length, keys: sep.length, rows: res.rows.length, exceptions: codes,
      sepTotals: {
        volume: sep.reduce((s, r) => s + r.forecastVolume, 0),
        reqHc: sep.reduce((s, r) => s + (r.prod.reqHcProd ?? 0), 0),
        projHc: sep.reduce((s, r) => s + r.prod.projectedHc, 0),
        blankBase: sep.filter((r) => r.baseFte == null).length,
      },
    }, null, 1))
  })
})
