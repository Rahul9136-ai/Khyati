import { describe, expect, it } from "vitest"

import { addDays, parseYMD, TODAY, ymd } from "./dates"
import { driverMultiplier, driverMultipliers, learnElasticity, planValues, type ForecastDriver } from "./drivers"
import { adjustedBacktest, backtestG, bucketFor, rangePlan } from "./granularity"
import { historyFor } from "./history"
import { buildPublished, publishedRows, publishFingerprint } from "./publishedForecast"
import { AGENTS, QUEUES, SHRINKAGE } from "./seed"

const queue = QUEUES[0]
const drv = (over: Partial<ForecastDriver> = {}): ForecastDriver => ({
  id: "d1", name: "Spend", kind: "Marketing spend", unit: "$", queueId: "all", target: "volume",
  reference: 100, elasticity: 0.5, elasticitySource: "manual", values: [], enabled: true, createdAt: 0, ...over,
})

describe("forecast drivers", () => {
  it("multiplies by (value / reference) ^ elasticity, and is neutral without a value", () => {
    const d = drv({ values: [{ from: "2026-07-01", to: "2026-07-03", value: 121 }] })
    expect(driverMultiplier(d, "2026-07-02")).toBeCloseTo(1.1, 6) // √1.21
    expect(driverMultiplier(d, "2026-07-04")).toBe(1)
    expect(driverMultiplier({ ...d, elasticity: -1 }, "2026-07-01")).toBeCloseTo(100 / 121, 6)
  })

  it("compounds drivers per target and respects queue + enabled", () => {
    const vals = [{ from: "2026-07-01", to: "2026-07-01", value: 200 }]
    const list = [
      drv({ id: "a", elasticity: 1, values: vals }),
      drv({ id: "b", elasticity: 1, values: vals, queueId: "other" }),
      drv({ id: "c", elasticity: 1, values: vals, enabled: false }),
      drv({ id: "e", elasticity: 0.1, values: vals, target: "aht" }),
    ]
    const m = driverMultipliers(list, queue.id, "2026-07-01")
    expect(m.volume).toBeCloseTo(2, 6)
    expect(m.aht).toBeCloseTo(Math.pow(2, 0.1), 6)
  })

  it("plans a linear ramp day by day", () => {
    const v = planValues("2026-07-01", "2026-07-05", 100, 140)
    expect(v.map((x) => x.value)).toEqual([100, 110, 120, 130, 140])
    expect(planValues("2026-07-01", "2026-07-05", 90)).toEqual([{ from: "2026-07-01", to: "2026-07-05", value: 90 }])
  })

  it("learns the elasticity a driver really has on history", () => {
    const h = historyFor(queue.id)
    // a synthetic driver whose deviation explains volume's deviation with elasticity 0.8
    const values = h.dateKeys.slice(-200).map((date) => {
      const i = h.dateKeys.indexOf(date)
      const tot = (k: number) => h.days[k].reduce((a, b) => a + b, 0)
      const usual = [1, 2, 3, 4].map((k) => tot(i - 7 * k)).reduce((a, b) => a + b, 0) / 4
      return { from: date, to: date, value: 100 * Math.pow(tot(i) / usual, 1 / 0.8) }
    })
    const r = learnElasticity(drv({ values }), h)
    if ("error" in r) throw new Error(r.error)
    expect(r.elasticity).toBeCloseTo(0.8, 2)
    expect(r.r2).toBeGreaterThan(0.99)
    expect(learnElasticity(drv({ values: values.slice(0, 5) }), h)).toHaveProperty("error")
  })
})

describe("period forecast", () => {
  const start = TODAY
  it("picks the row size from the period length", () => {
    expect(bucketFor(1)).toBe("day")
    expect(bucketFor(31)).toBe("day")
    expect(bucketFor(60)).toBe("week")
    expect(bucketFor(200)).toBe("month")
  })

  it("forecasts every target and applies drivers on top of the model", () => {
    const end = addDays(start, 13)
    const base = rangePlan({ queue, start, end, methodId: "prophet", shrinkage: SHRINKAGE, agents: AGENTS })
    expect(base.nDays).toBe(14)
    expect(base.rows).toHaveLength(14)
    expect(base.days[0].date).toBe(ymd(start))
    expect(base.totals.volume).toBe(base.rows.reduce((a, r) => a + r.volume, 0))
    expect(base.totals.aht).toBe(queue.aht)
    expect(base.totals.fte).toBeGreaterThan(0)

    const spend = drv({ elasticity: 1, values: planValues(ymd(start), ymd(end), 150) })
    const aht = drv({ id: "x", target: "aht", elasticity: 1, values: planValues(ymd(start), ymd(end), 110) })
    const withDrivers = rangePlan({ queue, start, end, methodId: "prophet", shrinkage: SHRINKAGE, agents: AGENTS, drivers: [spend, aht] })
    expect(withDrivers.totals.volume / base.totals.volume).toBeCloseTo(1.5, 1)
    expect(withDrivers.totals.aht).toBe(Math.round(queue.aht * 1.1))
    // +50% volume × +10% AHT = 1.65× workload; Erlang C needs less than that in hours (economies of scale)
    expect(withDrivers.totals.required).toBeGreaterThan(base.totals.required * 1.3)
    expect(withDrivers.totals.required).toBeLessThan(base.totals.required * 1.65)
    expect(withDrivers.days[0].volumeDriverMult).toBeCloseTo(1.5, 6)
  })

  it("scores drivers on the held-out days of the back-test", () => {
    const bt = backtestG(queue.id, 7)
    expect(bt.dates).toHaveLength(7)
    const none = adjustedBacktest(bt, bt.best, queue.id, [], [])
    expect(none.changed).toBe(false)
    const d = drv({ elasticity: 1, values: bt.dates.map((date) => ({ from: date, to: date, value: 130 })) })
    const adj = adjustedBacktest(bt, bt.best, queue.id, [], [d])
    expect(adj.changed).toBe(true)
    expect(adj.pred[0]).toBeCloseTo(bt.best.pred[0] * 1.3, 6)
  })

  it("publishes a flat, BI-ready feed whose fingerprint ignores who and when", () => {
    const end = addDays(start, 2)
    const plan = rangePlan({ queue, start, end, methodId: "holt", shrinkage: SHRINKAGE, agents: AGENTS })
    const args = {
      queueId: queue.id, queueName: queue.name, start: ymd(start), end: ymd(end), plan, methodId: "holt", methodName: "Holt-Winters",
      mape: 0.05, targets: ["volume" as const], drivers: [], events: 0, publishedBy: "A", auto: false,
    }
    const a = buildPublished(args)
    const b = { ...buildPublished({ ...args, publishedBy: "B", auto: true }), publishedAt: a.publishedAt + 5000 }
    expect(publishFingerprint(a)).toBe(publishFingerprint(b))
    const rows = publishedRows([a])
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ queue_id: queue.id, date: ymd(start), model: "Holt-Winters" })
    expect(parseYMD(String(rows[2].date)).getTime()).toBe(end.getTime())
  })
})
