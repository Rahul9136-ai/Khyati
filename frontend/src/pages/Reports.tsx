import { useMemo } from "react"

import { SeriesChart } from "@/components/charts/series-chart"
import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Activity, BarChart3, CalendarRange, Gauge, LineChart, Users } from "lucide-react"
import { backtest } from "@/lib/domain/forecast"
import { buildPlan, fmtPct, summarisePlan } from "@/lib/domain/planning"
import { INTERVALS } from "@/lib/domain/seed"
import { allReportSheets } from "@/lib/report-data"
import { useWfm } from "@/store/wfm"

const REPORTS = [
  { name: "Executive Dashboard", icon: Gauge, desc: "Centre KPIs, SLA, occupancy trend" },
  { name: "Planner Dashboard", icon: CalendarRange, desc: "Forecast, requirement, coverage" },
  { name: "RTA Dashboard", icon: Activity, desc: "Adherence, AUX, exceptions" },
  { name: "Forecast Accuracy", icon: LineChart, desc: "MAPE / MAE / RMSE by model" },
  { name: "Capacity Dashboard", icon: BarChart3, desc: "FTE, shrinkage, hiring plan" },
  { name: "Scheduling Dashboard", icon: Users, desc: "Roster efficiency, compliance" },
]

export function Reports() {
  const { forecasts, shrinkage, agents, rta, queues } = useWfm()

  const perQueue = useMemo(
    () =>
      queues.map((q) => {
        const plan = buildPlan(forecasts[q.id], q.aht, q, shrinkage, agents)
        return { q, plan, sum: summarisePlan(plan), bt: backtest(q.id) }
      }),
    [forecasts, shrinkage, agents, queues],
  )

  const centreVol = perQueue.reduce((a, x) => a + x.sum.totalVol, 0)
  const centreSL = centreVol ? perQueue.reduce((a, x) => a + x.sum.wSL * x.sum.totalVol, 0) / centreVol : 0
  const reqHrs = perQueue.reduce((a, x) => a + x.sum.reqHours, 0)
  const schedHrs = perQueue.reduce((a, x) => a + x.sum.schedHours, 0)

  const coverage = INTERVALS.map((iv, i) => ({
    label: iv.label,
    Required: perQueue.reduce((a, x) => a + x.plan[i].requiredGross, 0),
    Scheduled: perQueue.reduce((a, x) => a + x.plan[i].scheduled, 0),
  }))

  return (
    <>
      <PageHeader
        title="Reports & KPIs"
        subtitle="Centre-wide analytics across all queues"
        actions={
          <ExportButton
            filename="flowforce-all-kpis"
            variant="default"
            label="Export all KPIs"
            sheets={() => allReportSheets(forecasts, shrinkage, agents, rta, queues)}
          />
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Centre volume" value={centreVol.toLocaleString()} hint="contacts today" icon={LineChart} />
        <KpiCard label="Centre SL" value={fmtPct(centreSL)} hint="volume-weighted" tone={centreSL >= 0.8 ? "good" : "warn"} icon={Gauge} />
        <KpiCard label="Required hrs" value={reqHrs.toFixed(0)} hint="incl. shrinkage" icon={BarChart3} />
        <KpiCard label="Schedule eff." value={fmtPct(reqHrs / Math.max(1, schedHrs))} hint="required ÷ scheduled" tone={schedHrs >= reqHrs ? "good" : "bad"} icon={Users} />
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((r) => (
          <Card key={r.name} className="glass cursor-pointer transition-colors hover:border-primary/50">
            <CardContent className="flex items-center gap-3 p-4">
              <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/15 text-primary">
                <r.icon className="h-5 w-5" />
              </div>
              <div>
                <div className="text-sm font-semibold">{r.name}</div>
                <div className="text-xs text-muted-foreground">{r.desc}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="glass lg:col-span-2">
          <CardHeader>
            <CardTitle>Centre coverage — required vs scheduled</CardTitle>
          </CardHeader>
          <CardContent>
            <SeriesChart
              data={coverage}
              xKey="label"
              series={[
                { key: "Required", name: "Required", color: "#f59e0b", type: "bar" },
                { key: "Scheduled", name: "Scheduled", color: "#6366f1" },
              ]}
            />
          </CardContent>
        </Card>
        <Card className="glass">
          <CardHeader>
            <CardTitle>Forecast accuracy by queue</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Queue</TableHead>
                  <TableHead>Best model</TableHead>
                  <TableHead>MAPE</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {perQueue.map(({ q, bt }) => (
                  <TableRow key={q.id}>
                    <TableCell className="text-left font-medium">{q.name}</TableCell>
                    <TableCell>{bt.best.name}</TableCell>
                    <TableCell className="text-emerald-500">{fmtPct(bt.best.mape)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
