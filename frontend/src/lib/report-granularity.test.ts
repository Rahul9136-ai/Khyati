import { describe, expect, it } from "vitest"

import { addDays, TODAY, ymd } from "./domain/dates"
import { allReportSheets } from "./report-data"
import {
  ALL_GRANULARITIES, centreTotals, coverageChart, granularRows, GRAN_SHEET, planRange, queueTotals, type ReportInputs,
} from "./report-granularity"
import { useWfm } from "@/store/wfm"

function inputs(): ReportInputs {
  const s = useWfm.getState()
  return {
    forecasts: s.forecasts, forecastMethod: s.forecastMethod, importedActuals: s.importedActuals,
    externalFactors: s.externalFactors, shrinkage: s.shrinkage, agents: s.agents, queues: s.queues,
  }
}

const sum = (rows: Record<string, unknown>[], key: string) => rows.reduce((a, r) => a + Number(r[key] ?? 0), 0)
const nQueues = () => useWfm.getState().queues.length

describe("report granularities", () => {
  const inp = inputs()
  const week = planRange(inp, TODAY, addDays(TODAY, 13)) // 14 days: spans two Mon–Sun weeks, maybe a month edge

  it("today's volume is exactly the applied forecast", () => {
    const today = planRange(inp, TODAY, TODAY)
    for (const q of inp.queues) {
      const item = today.find((i) => i.queue.id === q.id)!
      expect(item.sum.totalVol).toBe(inp.forecasts[q.id].reduce((a, b) => a + b, 0))
    }
  })

  it("interval view: 24 rows per queue per day, plus 24 'All queues' rows", () => {
    const rows = granularRows(week, inp.queues, "interval")
    expect(rows).toHaveLength(14 * (nQueues() + 1) * 24)
    expect(new Set(rows.map((r) => r.Interval)).size).toBe(24)
    expect(rows[0]).toHaveProperty("Required (gross)")
  })

  it("interval rows add up to the day rows", () => {
    const interval = granularRows(week, inp.queues, "interval")
    const day = granularRows(week, inp.queues, "day")
    expect(day).toHaveLength(14 * (nQueues() + 1))
    for (const d of day.filter((r) => r.Queue !== "All queues").slice(0, 12)) {
      const mine = interval.filter((r) => r.Date === d.Date && r.Queue === d.Queue)
      expect(sum(mine, "Volume")).toBe(d.Volume)
      expect(sum(mine, "Required (gross)") * 0.5).toBeCloseTo(Number(d["Required hrs"]), 0)
    }
  })

  it("'All queues' equals the sum of the queues at every granularity", () => {
    for (const g of ["interval", "day", "week", "month"] as const) {
      const rows = granularRows(week, inp.queues, g)
      const key = g === "interval" ? "Date" : g === "day" ? "Date" : "Period"
      const all = rows.filter((r) => r.Queue === "All queues")
      const perQ = rows.filter((r) => r.Queue !== "All queues")
      expect(sum(all, "Volume")).toBe(sum(perQ, "Volume"))
      expect(all.length).toBeGreaterThan(0)
      expect(key in rows[0]).toBe(true)
    }
  })

  it("weekly and monthly buckets add up to the daily rows", () => {
    const day = granularRows(week, inp.queues, "day").filter((r) => r.Queue === "All queues")
    for (const g of ["week", "month"] as const) {
      const rows = granularRows(week, inp.queues, g).filter((r) => r.Queue === "All queues")
      expect(sum(rows, "Volume")).toBe(sum(day, "Volume"))
      expect(sum(rows, "Days")).toBe(14)
      expect(sum(rows, "Required hrs")).toBeCloseTo(sum(day, "Required hrs"), 0)
    }
    expect(granularRows(week, inp.queues, "week").filter((r) => r.Queue === "All queues").length).toBeGreaterThanOrEqual(2)
  })

  it("KPI totals match the queue totals and the daily rows", () => {
    const t = centreTotals(week)
    const q = queueTotals(week, inp.queues)
    expect(q.reduce((a, x) => a + x.volume, 0)).toBe(t.volume)
    expect(t.days).toBe(14)
    const day = granularRows(week, inp.queues, "day").filter((r) => r.Queue === "All queues")
    expect(sum(day, "Volume")).toBe(t.volume)
  })

  it("chart data follows the granularity", () => {
    expect(coverageChart(week, "interval").data).toHaveLength(24)
    expect(coverageChart(week, "day").data).toHaveLength(14)
    expect(coverageChart(week, "week").data.length).toBeGreaterThanOrEqual(2)
    expect(coverageChart(week, "month").data.length).toBeGreaterThanOrEqual(1)
  })

  it("workbook has the sheet(s) for the chosen granularity and every one for 'all'", () => {
    const range = { start: ymd(TODAY), end: ymd(addDays(TODAY, 6)) }
    const one = allReportSheets(inp, useWfm.getState().rta, range, ["day"]).map((s) => s.name)
    expect(one).toContain(GRAN_SHEET.day)
    expect(one).not.toContain(GRAN_SHEET.interval)
    const all = allReportSheets(inp, useWfm.getState().rta, range, ALL_GRANULARITIES).map((s) => s.name)
    for (const g of ALL_GRANULARITIES) expect(all).toContain(GRAN_SHEET[g])
    expect(all).toEqual(expect.arrayContaining(["Centre KPIs", "Queue Summary", "Forecast Accuracy", "Roster", "Real-Time Adherence"]))
  })

  it("plans a 90-day range fast enough for the page", () => {
    const t0 = performance.now()
    const items = planRange(inp, TODAY, addDays(TODAY, 89))
    granularRows(items, inp.queues, "interval")
    const ms = performance.now() - t0
    console.log(`90-day plan + interval rows: ${ms.toFixed(0)} ms (${items.length} queue-days)`)
    expect(ms).toBeLessThan(6000)
  })
})
