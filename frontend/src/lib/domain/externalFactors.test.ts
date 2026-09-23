import { describe, expect, it } from "vitest"

import { combinedFactorPct, factorStatus } from "./externalFactors"
import type { ExternalFactor } from "./externalFactors"

const f = (over: Partial<ExternalFactor> = {}): ExternalFactor => ({
  id: "f1", name: "x", category: "Other", queueId: "all", from: "2026-01-01", to: "2026-01-01",
  impactPct: 0, createdAt: 0, ...over,
})

describe("factorStatus", () => {
  it("classifies past, active and upcoming relative to a given 'today'", () => {
    expect(factorStatus(f({ from: "2026-01-01", to: "2026-01-05" }), "2026-01-10")).toBe("past")
    expect(factorStatus(f({ from: "2026-01-01", to: "2026-01-20" }), "2026-01-10")).toBe("active")
    expect(factorStatus(f({ from: "2026-01-15", to: "2026-01-20" }), "2026-01-10")).toBe("upcoming")
    // single-day event, today == that day → active
    expect(factorStatus(f({ from: "2026-01-10", to: "2026-01-10" }), "2026-01-10")).toBe("active")
  })
})

describe("combinedFactorPct", () => {
  it("returns 0 for no selected ids", () => {
    expect(combinedFactorPct([f({ id: "a", impactPct: 20 })], [])).toBe(0)
  })

  it("returns a single factor's own impact", () => {
    expect(combinedFactorPct([f({ id: "a", impactPct: 25 })], ["a"])).toBeCloseTo(25, 6)
  })

  it("compounds multiplicatively, not additively — two +20%s aren't +40%", () => {
    const factors = [f({ id: "a", impactPct: 20 }), f({ id: "b", impactPct: 20 })]
    // 1.2 * 1.2 = 1.44 → +44%, not +40%
    expect(combinedFactorPct(factors, ["a", "b"])).toBeCloseTo(44, 6)
  })

  it("a positive and a negative factor partially offset", () => {
    const factors = [f({ id: "a", impactPct: 50 }), f({ id: "b", impactPct: -50 })]
    // 1.5 * 0.5 = 0.75 → -25%
    expect(combinedFactorPct(factors, ["a", "b"])).toBeCloseTo(-25, 6)
  })

  it("ignores ids not present in the factor list", () => {
    expect(combinedFactorPct([f({ id: "a", impactPct: 10 })], ["a", "ghost"])).toBeCloseTo(10, 6)
  })
})
