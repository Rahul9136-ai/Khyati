import { describe, expect, it } from "vitest"

import { computeAbsenceRisk } from "./absenceRisk"
import type { Agent } from "./types"

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: "a1", name: "Test Agent", skills: ["voice"], shift: "07:00–15:00", team: "A", tl: "TL",
  ...over,
})

describe("computeAbsenceRisk", () => {
  it("is deterministic for the same agent id", () => {
    const r1 = computeAbsenceRisk([agent({ id: "emp-42" })])
    const r2 = computeAbsenceRisk([agent({ id: "emp-42" })])
    expect(r1[0].riskPct).toBe(r2[0].riskPct)
    expect(r1[0].recentAbsences).toBe(r2[0].recentAbsences)
    expect(r1[0].recentLates).toBe(r2[0].recentLates)
  })

  it("gives different agents (different ids) their own scores, not all identical", () => {
    const results = computeAbsenceRisk([
      agent({ id: "emp-1", name: "A" }),
      agent({ id: "emp-2", name: "B" }),
      agent({ id: "emp-3", name: "C" }),
      agent({ id: "emp-4", name: "D" }),
    ])
    const distinct = new Set(results.map((r) => r.riskPct))
    expect(distinct.size).toBeGreaterThan(1)
  })

  it("every score is within 0-100 and matches its level thresholds", () => {
    const results = computeAbsenceRisk(
      Array.from({ length: 30 }, (_, i) => agent({ id: `emp-${i}`, name: `Agent ${i}` })),
    )
    for (const r of results) {
      expect(r.riskPct).toBeGreaterThanOrEqual(0)
      expect(r.riskPct).toBeLessThanOrEqual(100)
      if (r.level === "high") expect(r.riskPct).toBeGreaterThanOrEqual(30)
      else if (r.level === "medium") expect(r.riskPct).toBeGreaterThanOrEqual(15)
      else expect(r.riskPct).toBeLessThan(15)
    }
  })

  it("sorts by risk descending", () => {
    const results = computeAbsenceRisk(
      Array.from({ length: 15 }, (_, i) => agent({ id: `emp-${i}`, name: `Agent ${i}` })),
    )
    for (let i = 1; i < results.length; i++) {
      expect(results[i].riskPct).toBeLessThanOrEqual(results[i - 1].riskPct)
    }
  })

  it("gives a clean-record reason only when there are zero absences and lates", () => {
    const results = computeAbsenceRisk(
      Array.from({ length: 20 }, (_, i) => agent({ id: `emp-${i}`, name: `Agent ${i}` })),
    )
    for (const r of results) {
      if (r.recentAbsences === 0 && r.recentLates === 0) {
        expect(r.reason).toContain("Clean record")
      } else {
        expect(r.reason).toContain(String(r.recentAbsences))
        expect(r.reason).toContain(String(r.recentLates))
      }
    }
  })
})
