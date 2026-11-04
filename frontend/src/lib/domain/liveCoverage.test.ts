import { describe, expect, it } from "vitest"

import { erlangA, erlangC } from "@/lib/domain/erlang"
import { intervalOutcomes, liveAgentStates, soFar } from "@/lib/domain/liveCoverage"
import type { Agent, Queue } from "@/lib/domain/types"

const queue: Queue = { id: "sales", name: "Sales", color: "#000", slTarget: 0.8, targetTime: 20, aht: 300 }

describe("Erlang A", () => {
  it("abandons more as fewer agents answer, and stays finite when overloaded", () => {
    const rates = [12, 10, 8, 6, 3, 0].map((n) => erlangA(n, 50, 300, 120).abandon)
    expect(rates[0]).toBeLessThan(0.05) // 8.3 Erlangs on 12 agents, 2-min patience ≈ 3%
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeGreaterThan(rates[i - 1])
    expect(rates.at(-1)).toBeCloseTo(1, 5) // nobody on → everyone hangs up
    const nobody = erlangA(0, 50, 300, 120)
    expect(nobody.wait).toBeCloseTo(120, 0) // they wait their patience, then go
    expect(erlangA(10, 0, 300, 120)).toEqual({ abandon: 0, wait: 0, waitProb: 0 })
  })

  it("approaches Erlang C's waiting probability when callers are very patient", () => {
    const a = erlangA(12, 50, 300, 1e7)
    expect(a.waitProb).toBeCloseTo(erlangC(12, (50 * 300) / 1800), 3)
    expect(a.abandon).toBeLessThan(1e-4)
  })
})

describe("interval outcomes", () => {
  const forecast = [40, 40, 40, 40]
  const actuals = [44, 30, 50, null]
  const onDuty = [12, 12, 12, 12]

  it("uses actual volume before now, live heads now, and the forecast after", () => {
    const rows = intervalOutcomes({ queue, forecast, actuals, onDuty, shrinkage: 0, nowIdx: 2, liveHeads: 5, patience: 120 })
    expect(rows.map((r) => r.phase)).toEqual(["actual", "actual", "live", "projected"])
    expect(rows.map((r) => r.offered)).toEqual([44, 30, 50, 40])
    expect(rows.map((r) => r.heads)).toEqual([12, 12, 5, 12])
    for (const r of rows) expect(r.handled + r.abandoned).toBe(r.offered)
    expect(rows[2].abandonRate).toBeGreaterThan(rows[1].abandonRate) // 5 live heads for 50 calls
    expect(rows[2].asa).toBeGreaterThan(rows[1].asa)

    const totals = soFar(rows)
    expect(totals.offered).toBe(124) // projected interval excluded
    expect(totals.handled + totals.abandoned).toBe(124)
  })

  it("projects every interval when the day isn't today", () => {
    const rows = intervalOutcomes({ queue, forecast, actuals, onDuty, shrinkage: 0.25, nowIdx: null, liveHeads: 0 })
    expect(rows.every((r) => r.phase === "projected" && r.offered === 40 && r.heads === 9)).toBe(true)
  })

  it("counts agents skilled for the queue who are Available or in ACW as on queue", () => {
    const agent = (id: string, skills: string[]) => ({ id, name: id, skills }) as unknown as Agent
    const states = liveAgentStates(
      [{ id: "a", actual: "AVAIL", scheduled: "AVAIL", secs: 1 }, { id: "b", actual: "AUX1", scheduled: "AVAIL", secs: 1 },
        { id: "c", actual: "ACW", scheduled: "AVAIL", secs: 1 }, { id: "d", actual: "AVAIL", scheduled: "AVAIL", secs: 1 }],
      [agent("a", ["sales"]), agent("b", ["sales"]), agent("c", ["support", "sales"]), agent("d", ["support"])],
      "sales",
    )
    expect(states.map((s) => [s.agent.id, s.onQueue])).toEqual([["a", true], ["b", false], ["c", true]])
  })
})
