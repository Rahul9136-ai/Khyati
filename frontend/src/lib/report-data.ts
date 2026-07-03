// Assembles every WFM / operations KPI + metric into export-ready sheets.
// Used by the Reports "Export all" workbook and reused where handy.
import { backtest } from "@/lib/domain/forecast"
import { buildPlan, fmtPct, fmtSec, summarisePlan } from "@/lib/domain/planning"
import { agentAdherencePct, AUX_BY_CODE, inAdherence } from "@/lib/domain/seed"
import type { Agent, Queue, RtaEntry } from "@/lib/domain/types"
import type { Row, Sheet } from "@/lib/export"

export function allReportSheets(
  forecasts: Record<string, number[]>,
  shrinkage: number,
  agents: Agent[],
  rta: RtaEntry[],
  queues: Queue[],
): Sheet[] {
  const perQueue = queues.map((q) => {
    const plan = buildPlan(forecasts[q.id], q.aht, q, shrinkage, agents)
    return { q, plan, sum: summarisePlan(plan), bt: backtest(q.id) }
  })
  const centreVol = perQueue.reduce((a, x) => a + x.sum.totalVol, 0)
  const centreSL = centreVol ? perQueue.reduce((a, x) => a + x.sum.wSL * x.sum.totalVol, 0) / centreVol : 0
  const reqHrs = perQueue.reduce((a, x) => a + x.sum.reqHours, 0)
  const schedHrs = perQueue.reduce((a, x) => a + x.sum.schedHours, 0)
  const adhCount = rta.filter((r) => inAdherence(r.actual, r.scheduled)).length

  // 1) Centre KPIs
  const centre: Row[] = [
    { Metric: "Centre contact volume", Value: centreVol },
    { Metric: "Centre service level", Value: fmtPct(centreSL) },
    { Metric: "Required agent-hours", Value: reqHrs.toFixed(0) },
    { Metric: "Scheduled agent-hours", Value: schedHrs.toFixed(0) },
    { Metric: "Schedule efficiency", Value: fmtPct(reqHrs / Math.max(1, schedHrs)) },
    { Metric: "Headcount", Value: agents.length },
    { Metric: "Adherence", Value: fmtPct(rta.length ? adhCount / rta.length : 0) },
    { Metric: "Agents in adherence", Value: `${adhCount}/${rta.length}` },
    { Metric: "Generated", Value: new Date().toLocaleString() },
  ]

  // 2) Queue summary
  const queueSummary: Row[] = perQueue.map(({ q, sum }) => ({
    Queue: q.name,
    Volume: sum.totalVol,
    "Service Level": fmtPct(sum.wSL),
    "SL Target": fmtPct(q.slTarget),
    AHT: `${q.aht}s`,
    "Required hrs": sum.reqHours.toFixed(0),
    "Scheduled hrs": sum.schedHours.toFixed(0),
    "Under-staffed intervals": sum.underIntervals,
    "Avg occupancy": fmtPct(sum.avgOcc),
  }))

  // 3) Forecast accuracy (per queue × model MAPE)
  const accuracy: Row[] = perQueue.flatMap(({ q, bt }) =>
    bt.perMethod.map((m) => ({
      Queue: q.name,
      Model: m.name,
      Type: m.kind,
      MAPE: fmtPct(m.mape),
      Best: m.id === bt.best.id ? "★" : "",
    })),
  )

  // 4) Interval requirement (per queue × interval)
  const intervals: Row[] = perQueue.flatMap(({ q, plan }) =>
    plan.map((p) => ({
      Queue: q.name,
      Interval: p.label,
      Volume: p.volume,
      "Required (net)": p.requiredNet,
      "Required (gross)": p.requiredGross,
      Scheduled: p.scheduled,
      Variance: p.variance,
      "Proj. SL": fmtPct(p.projSL),
      ASA: fmtSec(p.asa),
      Occupancy: fmtPct(p.occupancy),
    })),
  )

  // 5) Roster / employees
  const roster: Row[] = agents.map((a) => ({
    "Agent ID": a.id,
    Name: a.name,
    Team: a.team,
    "Team Lead": a.tl,
    Shift: a.shift,
    Skills: a.skills.map((s) => queues.find((q) => q.id === s)?.name ?? s).join(", "),
  }))

  // 6) Real-time adherence snapshot
  const realtime: Row[] = rta.map((r) => {
    const a = agents.find((x) => x.id === r.id)
    return {
      Name: a?.name ?? r.id,
      Team: a?.team ?? "",
      "Actual state": AUX_BY_CODE[r.actual]?.label ?? r.actual,
      "Scheduled state": AUX_BY_CODE[r.scheduled]?.label ?? r.scheduled,
      Adherence: inAdherence(r.actual, r.scheduled) ? "In" : "Out",
      "Adherence %": fmtPct(agentAdherencePct(r)),
      "Time in state (s)": r.secs,
    }
  })

  return [
    { name: "Centre KPIs", rows: centre },
    { name: "Queue Summary", rows: queueSummary },
    { name: "Forecast Accuracy", rows: accuracy },
    { name: "Interval Requirement", rows: intervals },
    { name: "Roster", rows: roster },
    { name: "Real-Time Adherence", rows: realtime },
  ]
}
