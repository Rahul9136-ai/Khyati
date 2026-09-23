// Assembles every WFM / operations KPI + metric into export-ready sheets.
// Used by the Reports "Export" workbooks. The workload sheets follow the selected date
// range and granularity (interval / day / week / month); the roster and real-time
// adherence sheets are point-in-time snapshots.
import { backtest } from "@/lib/domain/forecast"
import { fmtDay, parseYMD } from "@/lib/domain/dates"
import { fmtPct } from "@/lib/domain/planning"
import { agentAdherencePct, AUX_BY_CODE, inAdherence } from "@/lib/domain/seed"
import type { RtaEntry } from "@/lib/domain/types"
import type { Row, Sheet } from "@/lib/export"
import {
  centreTotals, granularRows, GRAN_SHEET, planRange, queueTotals,
  REPORT_GRANULARITIES, type ReportGran, type ReportInputs,
} from "@/lib/report-granularity"

export function allReportSheets(
  inp: ReportInputs,
  rta: RtaEntry[],
  range: { start: string; end: string },
  granularities: ReportGran[],
): Sheet[] {
  const { agents, queues } = inp
  const items = planRange(inp, parseYMD(range.start), parseYMD(range.end))
  const totals = centreTotals(items)
  const perQueue = queueTotals(items, queues)
  const adhCount = rta.filter((r) => inAdherence(r.actual, r.scheduled)).length
  const period = range.start === range.end ? fmtDay(parseYMD(range.start)) : `${range.start} → ${range.end}`
  const granNames = granularities.map((g) => REPORT_GRANULARITIES.find((x) => x.id === g)!.name).join(", ")

  // 1) Centre KPIs
  const centre: Row[] = [
    { Metric: "Period", Value: `${period} (${totals.days} day${totals.days === 1 ? "" : "s"})` },
    { Metric: "Granularity in this export", Value: granNames },
    { Metric: "Centre contact volume", Value: totals.volume },
    { Metric: "Centre service level", Value: fmtPct(totals.sl) },
    { Metric: "Required agent-hours", Value: totals.reqHrs.toFixed(0) },
    { Metric: "Scheduled agent-hours", Value: totals.schedHrs.toFixed(0) },
    { Metric: "Schedule efficiency", Value: fmtPct(totals.reqHrs / Math.max(1, totals.schedHrs)) },
    { Metric: "Headcount", Value: agents.length },
    { Metric: "Adherence (live snapshot)", Value: fmtPct(rta.length ? adhCount / rta.length : 0) },
    { Metric: "Agents in adherence (live snapshot)", Value: `${adhCount}/${rta.length}` },
    { Metric: "Generated", Value: new Date().toLocaleString() },
  ]

  // 2) Queue summary (over the selected range)
  const queueSummary: Row[] = perQueue.map(({ queue: q, volume, sl, reqHrs, schedHrs, under, occ }) => ({
    Queue: q.name,
    Volume: volume,
    "Service Level": fmtPct(sl),
    "SL Target": fmtPct(q.slTarget),
    AHT: `${q.aht}s`,
    "Required hrs": reqHrs.toFixed(0),
    "Scheduled hrs": schedHrs.toFixed(0),
    "Under-staffed intervals": under,
    "Avg occupancy": fmtPct(occ),
  }))

  // 3) Forecast accuracy (per queue × model MAPE)
  const accuracy: Row[] = queues.flatMap((q) => {
    const bt = backtest(q.id, inp.importedActuals[q.id])
    return bt.perMethod.map((m) => ({
      Queue: q.name,
      Model: m.name,
      Type: m.kind,
      MAPE: fmtPct(m.mape),
      Best: m.id === bt.best.id ? "★" : "",
    }))
  })

  // 4) Workload at each requested granularity (interval / day / week / month)
  const granular: Sheet[] = granularities.map((g) => ({ name: GRAN_SHEET[g], rows: granularRows(items, queues, g) }))

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
    ...granular,
    { name: "Roster", rows: roster },
    { name: "Real-Time Adherence", rows: realtime },
  ]
}
