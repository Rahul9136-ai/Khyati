import { Activity, Gauge, Percent, Phone, Users } from "lucide-react"
import { useMemo } from "react"

import { AiSummary } from "@/components/ai-summary"
import { SeriesChart } from "@/components/charts/series-chart"
import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { LiveKpis } from "@/components/live-kpis"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { actualsFor, INTERVALS, inAdherence } from "@/lib/domain/seed"
import { buildPlan, fmtPct, fmtSec, summarisePlan } from "@/lib/domain/planning"
import { useWfm } from "@/store/wfm"

export function Dashboard() {
  const { forecasts, shrinkage, nowIdx, agents, rta, queueId, queues } = useWfm()
  const queue = queues.find((q) => q.id === queueId)!
  const volume = forecasts[queue.id]

  const plan = useMemo(() => buildPlan(volume, queue.aht, queue, shrinkage, agents), [volume, queue, shrinkage, agents])
  const sum = useMemo(() => summarisePlan(plan), [plan])
  const actuals = useMemo(() => actualsFor(queue.id, nowIdx), [queue.id, nowIdx])
  const now = plan[nowIdx]

  const adhCount = rta.filter((r) => inAdherence(r.actual, r.scheduled)).length
  const adherence = rta.length ? adhCount / rta.length : 0

  const intradayData = INTERVALS.map((iv, i) => ({ label: iv.label, Forecast: volume[i], Actual: actuals[i] }))
  const coverageData = plan.map((p) => ({ label: p.label, Required: p.requiredGross, Scheduled: p.scheduled }))

  // centre-wide SL by queue
  const queueSL = queues.map((q) => {
    const p = buildPlan(forecasts[q.id], q.aht, q, shrinkage, agents)
    return { q, wSL: summarisePlan(p).wSL }
  })

  const insight = {
    headline: sum.underIntervals
      ? `${queue.name}: ${sum.underIntervals} intervals are under-staffed today; projected day SL ${fmtPct(sum.wSL)}.`
      : `${queue.name} is fully covered today — projected day SL ${fmtPct(sum.wSL)}.`,
    bullets: [
      `${sum.totalVol.toLocaleString()} forecast contacts · ${sum.reqHours.toFixed(0)} required agent-hrs vs ${sum.schedHours.toFixed(0)} scheduled.`,
      `Centre adherence ${fmtPct(adherence)} (${adhCount}/${rta.length} agents on plan).`,
      now.projSL >= queue.slTarget
        ? `Current interval (${now.label}) is healthy at ${fmtPct(now.projSL)} SL.`
        : `Current interval (${now.label}) is at risk — ${fmtPct(now.projSL)} SL, add cover.`,
    ],
    tone: sum.underIntervals > 6 ? ("bad" as const) : sum.underIntervals ? ("warn" as const) : ("good" as const),
  }

  return (
    <>
      <PageHeader
        title="Operations Dashboard"
        subtitle={`Live view · ${queue.name} · interval ${now.label}`}
        actions={
          <ExportButton
            filename={`dashboard-${queue.id}`}
            sheets={() => [
              { name: "KPIs", rows: [
                { Metric: "Service Level", Value: fmtPct(now.projSL) },
                { Metric: "ASA", Value: fmtSec(now.asa) },
                { Metric: "Occupancy", Value: fmtPct(now.occupancy) },
                { Metric: "Adherence", Value: fmtPct(adherence) },
                { Metric: "Forecast volume", Value: sum.totalVol },
                { Metric: "Required agent-hrs", Value: sum.reqHours.toFixed(0) },
                { Metric: "Scheduled agent-hrs", Value: sum.schedHours.toFixed(0) },
                { Metric: "Day service level", Value: fmtPct(sum.wSL) },
              ] },
              { name: "Intraday", rows: intradayData.map((d) => ({ Interval: d.label, Forecast: d.Forecast, Actual: d.Actual })) },
              { name: "Coverage", rows: coverageData.map((d) => ({ Interval: d.label, Required: d.Required, Scheduled: d.Scheduled })) },
              { name: "SL by Queue", rows: queueSL.map((x) => ({ Queue: x.q.name, "Service Level": fmtPct(x.wSL), Target: fmtPct(x.q.slTarget) })) },
            ]}
          />
        }
      />

      <LiveKpis />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Service Level" value={fmtPct(now.projSL)} hint={`target ${fmtPct(queue.slTarget)} in ${queue.targetTime}s`} tone={now.projSL >= queue.slTarget ? "good" : "bad"} icon={Gauge} />
        <KpiCard label="ASA" value={fmtSec(now.asa)} hint="avg speed of answer" tone={now.asa <= queue.targetTime ? "good" : "warn"} icon={Activity} />
        <KpiCard label="Occupancy" value={fmtPct(now.occupancy)} hint="agent utilisation" tone={now.occupancy <= 0.9 ? "good" : "warn"} icon={Percent} />
        <KpiCard label="Adherence" value={fmtPct(adherence)} hint={`${adhCount}/${rta.length} on plan`} tone={adherence >= 0.9 ? "good" : adherence >= 0.8 ? "warn" : "bad"} icon={Users} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="glass lg:col-span-2">
          <CardHeader>
            <CardTitle>Intraday — forecast vs actual</CardTitle>
          </CardHeader>
          <CardContent>
            <SeriesChart
              data={intradayData}
              xKey="label"
              series={[
                { key: "Forecast", name: "Forecast", color: queue.color, dashed: true },
                { key: "Actual", name: "Actual", color: "#22c55e" },
              ]}
            />
          </CardContent>
        </Card>
        <AiSummary insight={insight} title="AI Operations Summary" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="glass lg:col-span-2">
          <CardHeader>
            <CardTitle>Staffing — required vs scheduled</CardTitle>
          </CardHeader>
          <CardContent>
            <SeriesChart
              data={coverageData}
              xKey="label"
              series={[
                { key: "Required", name: "Required (incl. shrinkage)", color: "#f59e0b", type: "bar" },
                { key: "Scheduled", name: "Scheduled", color: queue.color },
              ]}
            />
          </CardContent>
        </Card>
        <Card className="glass">
          <CardHeader>
            <CardTitle>Service level by queue</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {queueSL.map(({ q, wSL }) => (
              <div key={q.id}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: q.color }} />
                    {q.name}
                  </span>
                  <span className="tabular-nums">
                    {fmtPct(wSL)} <span className="text-muted-foreground">/ {fmtPct(q.slTarget)}</span>
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.min(100, wSL * 100)}%`, background: wSL >= q.slTarget ? "#22c55e" : "#ef4444" }}
                  />
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
              <Phone className="h-3.5 w-3.5" /> {agents.length} agents rostered across 3 teams
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
