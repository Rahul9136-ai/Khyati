// One-click auto-scheduler: greedily adds the fewest new agents — picking
// from the existing global shift patterns — needed to close a queue's
// forecasted coverage gap, then projects the result through the same
// Erlang C planning math used everywhere else so the before/after is honest.
// Additive and non-destructive: it recommends, a human applies.
import { buildPlan, summarisePlan } from "./planning"
import { INTERVALS } from "./seed"
import { shiftStringFor, type ShiftPattern } from "./shiftPatterns"
import type { Agent, Queue } from "./types"

export interface ScheduleAddition {
  patternId: string
  patternName: string
  shift: string
  count: number
}

export interface AutoScheduleResult {
  additions: ScheduleAddition[]
  totalAdded: number
  beforeSL: number
  afterSL: number
  beforeUnder: number
  afterUnder: number
}

const toMins = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

function patternCoverage(pattern: ShiftPattern): boolean[] {
  const s = toMins(pattern.start)
  const e = toMins(pattern.end)
  return INTERVALS.map(({ label }) => {
    const mins = toMins(label)
    return mins >= s && mins < e
  })
}

/** Build synthetic agents for a projected "after" plan — never written to the roster. */
function projectedAgentsFor(queueId: string, additions: ScheduleAddition[], patterns: ShiftPattern[]): Agent[] {
  const out: Agent[] = []
  additions.forEach(({ patternId, count }) => {
    const pattern = patterns.find((p) => p.id === patternId)
    if (!pattern) return
    for (let i = 0; i < count; i++) {
      out.push({
        id: `sim-${patternId}-${i}`,
        name: "(projected hire)",
        skills: [queueId],
        shift: shiftStringFor(pattern),
        shiftPatternId: pattern.id,
        team: "—",
        tl: "—",
      })
    }
  })
  return out
}

export function planAutoSchedule(
  queue: Queue,
  forecast: number[],
  shrinkage: number,
  agents: Agent[],
  patterns: ShiftPattern[],
  maxAgentsToAdd = 40,
): AutoScheduleResult {
  const basePlan = buildPlan(forecast, queue.aht, queue, shrinkage, agents)
  const beforeSum = summarisePlan(basePlan)
  const remaining = basePlan.map((p) => Math.max(0, -p.variance))
  const coverage = patterns.map((p) => ({ pattern: p, cov: patternCoverage(p) }))

  const byPattern = new Map<string, number>()
  let addedTotal = 0

  while (remaining.some((d) => d > 0) && addedTotal < maxAgentsToAdd) {
    let best: { patternId: string; score: number } | null = null
    for (const { pattern, cov } of coverage) {
      const score = cov.reduce((a, on, i) => a + (on ? remaining[i] : 0), 0)
      if (score > 0 && (!best || score > best.score)) best = { patternId: pattern.id, score }
    }
    if (!best) break
    const chosen = coverage.find((c) => c.pattern.id === best!.patternId)!
    chosen.cov.forEach((on, i) => {
      if (on) remaining[i] = Math.max(0, remaining[i] - 1)
    })
    byPattern.set(best.patternId, (byPattern.get(best.patternId) ?? 0) + 1)
    addedTotal++
  }

  const additions: ScheduleAddition[] = [...byPattern.entries()].map(([patternId, count]) => {
    const pattern = patterns.find((p) => p.id === patternId)!
    return { patternId, patternName: pattern.name, shift: shiftStringFor(pattern), count }
  })

  const projected = [...agents, ...projectedAgentsFor(queue.id, additions, patterns)]
  const afterPlan = buildPlan(forecast, queue.aht, queue, shrinkage, projected)
  const afterSum = summarisePlan(afterPlan)

  return {
    additions,
    totalAdded: addedTotal,
    beforeSL: beforeSum.wSL,
    afterSL: afterSum.wSL,
    beforeUnder: basePlan.filter((p) => p.variance < 0).length,
    afterUnder: afterPlan.filter((p) => p.variance < 0).length,
  }
}
