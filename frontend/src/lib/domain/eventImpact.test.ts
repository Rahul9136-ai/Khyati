import { describe, expect, it } from "vitest"

import { addDays, TODAY } from "./dates"
import { eventImpactTimeline } from "./eventImpact"
import type { ExternalFactor } from "./externalFactors"
import { useWfm } from "@/store/wfm"
import type { ReportInputs } from "@/lib/report-granularity"

function inputs(factors: ExternalFactor[] = []): ReportInputs {
  const s = useWfm.getState()
  return {
    forecasts: s.forecasts, forecastMethod: s.forecastMethod, importedActuals: s.importedActuals,
    externalFactors: factors, shrinkage: s.shrinkage, agents: s.agents, queues: s.queues,
  }
}

const factor = (over: Partial<ExternalFactor> = {}): ExternalFactor => ({
  id: "f1", name: "Test campaign", category: "Marketing", queueId: "all",
  from: "2026-07-01", to: "2026-07-05", impactPct: 25, createdAt: Date.now(), ...over,
})

describe("eventImpactTimeline", () => {
  it("with no events, baseline equals adjusted for every day", () => {
    const r = eventImpactTimeline(inputs(), TODAY, addDays(TODAY, 6), "all")
    expect(r.points).toHaveLength(7)
    for (const p of r.points) {
      expect(p.adjustedVolume).toBe(p.baselineVolume)
      expect(p.adjustedReqHours).toBeCloseTo(p.baselineReqHours, 3)
    }
    expect(r.totalAdjustedVolume).toBe(r.totalBaselineVolume)
  })

  it("a +25% future event raises adjusted volume and required hours on its dates only", () => {
    const start = addDays(TODAY, 5), end = addDays(TODAY, 12)
    const r = eventImpactTimeline(inputs([factor({ queueId: "all" })]), start, end, "all")
    for (const p of r.points) {
      const inRange = p.date >= "2026-07-01" && p.date <= "2026-07-05"
      if (inRange) {
        expect(p.adjustedVolume).toBeGreaterThan(p.baselineVolume)
        expect(p.adjustedReqHours).toBeGreaterThanOrEqual(p.baselineReqHours)
      } else {
        expect(p.adjustedVolume).toBe(p.baselineVolume)
      }
    }
    expect(r.totalAdjustedVolume).toBeGreaterThan(r.totalBaselineVolume)
    expect(r.totalAdjustedReqHours).toBeGreaterThan(r.totalBaselineReqHours)
  })

  it("a negative event lowers volume and required hours", () => {
    const r = eventImpactTimeline(
      inputs([factor({ impactPct: -50, from: "2026-07-01", to: "2026-07-01" })]),
      new Date(2026, 6, 1), new Date(2026, 6, 1), "all",
    )
    expect(r.points).toHaveLength(1)
    expect(r.points[0].adjustedVolume).toBeLessThan(r.points[0].baselineVolume)
    expect(r.points[0].adjustedReqHours).toBeLessThanOrEqual(r.points[0].baselineReqHours)
  })

  it("scopes to a single queue when queueId is not 'all'", () => {
    const s = useWfm.getState()
    const qid = s.queues[0].id
    const allScope = eventImpactTimeline(inputs([factor({ queueId: qid })]), TODAY, addDays(TODAY, 0), "all")
    const oneScope = eventImpactTimeline(inputs([factor({ queueId: qid })]), TODAY, addDays(TODAY, 0), qid)
    // single-queue scope's volume can't exceed the all-queues total for the same day
    expect(oneScope.points[0].adjustedVolume).toBeLessThanOrEqual(allScope.points[0].adjustedVolume)
    expect(oneScope.points[0].adjustedVolume).toBeGreaterThan(0)
  })

  it("works for a date range entirely in the past", () => {
    const past = addDays(TODAY, -30)
    const r = eventImpactTimeline(inputs(), past, addDays(past, 6), "all")
    expect(r.points).toHaveLength(7)
    expect(r.points.every((p) => p.baselineVolume >= 0)).toBe(true)
  })

  it("runs a ±60 day window fast enough for the UI", () => {
    const t0 = performance.now()
    const r = eventImpactTimeline(inputs([factor()]), addDays(TODAY, -60), addDays(TODAY, 60), "all")
    const ms = performance.now() - t0
    console.log(`eventImpactTimeline ±60d: ${ms.toFixed(0)} ms`)
    expect(r.points).toHaveLength(121)
    expect(ms).toBeLessThan(8000)
  })
})
