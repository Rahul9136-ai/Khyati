import { useMemo, useState } from "react"

import { SeriesChart } from "@/components/charts/series-chart"
import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Activity, BarChart3, CalendarRange, Gauge, LineChart, Users } from "lucide-react"
import { addDays, fmtDay, parseYMD, PRESETS, TODAY, ymd } from "@/lib/domain/dates"
import { backtest } from "@/lib/domain/forecast"
import { fmtPct } from "@/lib/domain/planning"
import { allReportSheets } from "@/lib/report-data"
import {
  ALL_GRANULARITIES, centreTotals, coverageChart, granularRows, GRAN_SHEET, planRange,
  REPORT_GRANULARITIES, type ReportGran,
} from "@/lib/report-granularity"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

const REPORTS = [
  { name: "Executive Dashboard", icon: Gauge, desc: "Centre KPIs, SLA, occupancy trend" },
  { name: "Planner Dashboard", icon: CalendarRange, desc: "Forecast, requirement, coverage" },
  { name: "RTA Dashboard", icon: Activity, desc: "Adherence, AUX, exceptions" },
  { name: "Forecast Accuracy", icon: LineChart, desc: "MAPE / MAE / RMSE by model" },
  { name: "Capacity Dashboard", icon: BarChart3, desc: "FTE, shrinkage, hiring plan" },
  { name: "Scheduling Dashboard", icon: Users, desc: "Roster efficiency, compliance" },
]

const PREVIEW_ROWS = 10

export function Reports() {
  const { forecasts, forecastMethod, importedActuals, externalFactors, shrinkage, agents, rta, queues } = useWfm()

  const [gran, setGran] = useState<ReportGran>("day")
  const [start, setStart] = useState(ymd(TODAY))
  const [end, setEnd] = useState(ymd(TODAY))
  const rangeEnd = end < start ? start : end

  const inputs = useMemo(
    () => ({ forecasts, forecastMethod, importedActuals, externalFactors, shrinkage, agents, queues }),
    [forecasts, forecastMethod, importedActuals, externalFactors, shrinkage, agents, queues],
  )

  // every queue × day in the range, planned once; all the views below roll this up
  const items = useMemo(() => planRange(inputs, parseYMD(start), parseYMD(rangeEnd)), [inputs, start, rangeEnd])
  const totals = useMemo(() => centreTotals(items), [items])
  const rows = useMemo(() => granularRows(items, queues, gran), [items, queues, gran])
  const chart = useMemo(() => coverageChart(items, gran), [items, gran])
  const perQueueBt = useMemo(() => queues.map((q) => ({ q, bt: backtest(q.id, importedActuals[q.id]) })), [queues, importedActuals])

  const columns = rows.length ? Object.keys(rows[0]) : []
  const granName = REPORT_GRANULARITIES.find((g) => g.id === gran)!.name
  const periodText = start === rangeEnd ? fmtDay(parseYMD(start)) : `${fmtDay(parseYMD(start))} → ${fmtDay(parseYMD(rangeEnd))}`

  return (
    <>
      <PageHeader
        title="Reports & KPIs"
        subtitle="Centre-wide analytics across all queues"
        actions={
          <>
            <ExportButton
              filename={`flowforce-kpis-${gran}`}
              variant="default"
              label={`Export · ${granName}`}
              sheets={() => allReportSheets(inputs, rta, { start, end: rangeEnd }, [gran])}
            />
            <ExportButton
              filename="flowforce-kpis-all-granularities"
              label="Export · all granularities"
              sheets={() => allReportSheets(inputs, rta, { start, end: rangeEnd }, ALL_GRANULARITIES)}
            />
          </>
        }
      />

      <Card className="glass mb-4">
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-5 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Granularity</span>
            <div className="inline-flex rounded-lg bg-muted p-1">
              {REPORT_GRANULARITIES.map((g) => (
                <button
                  key={g.id}
                  title={g.sub}
                  onClick={() => setGran(g.id)}
                  className={cn("rounded-md px-3 py-1 text-sm font-medium", gran === g.id ? "bg-background shadow-sm" : "text-muted-foreground")}
                >
                  {g.name}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Period</span>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setStart(ymd(TODAY))
                  setEnd(ymd(addDays(TODAY, p.days)))
                }}
                className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
              >
                {p.label}
              </button>
            ))}
            <Input type="date" value={start} min={ymd(TODAY)} onChange={(e) => e.target.value && setStart(e.target.value)} className="w-auto" />
            <Input type="date" value={rangeEnd} min={start} onChange={(e) => e.target.value && setEnd(e.target.value)} className="w-auto" />
          </div>
          <span className="text-xs text-muted-foreground">
            {periodText} · {totals.days} day{totals.days === 1 ? "" : "s"} · {rows.length.toLocaleString()} {granName.toLowerCase()} rows
          </span>
        </CardContent>
      </Card>

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Centre volume" value={totals.volume.toLocaleString()} hint={totals.days === 1 ? "contacts today" : `contacts · ${totals.days} days`} icon={LineChart} />
        <KpiCard label="Centre SL" value={fmtPct(totals.sl)} hint="volume-weighted" tone={totals.sl >= 0.8 ? "good" : "warn"} icon={Gauge} />
        <KpiCard label="Required hrs" value={totals.reqHrs.toFixed(0)} hint="incl. shrinkage" icon={BarChart3} />
        <KpiCard label="Schedule eff." value={fmtPct(totals.reqHrs / Math.max(1, totals.schedHrs))} hint="required ÷ scheduled" tone={totals.schedHrs >= totals.reqHrs ? "good" : "bad"} icon={Users} />
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
            <CardTitle>{chart.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <SeriesChart
              data={chart.data}
              xKey="label"
              yLabel={chart.unit}
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
                {perQueueBt.map(({ q, bt }) => (
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

      <Card className="glass mt-4">
        <CardHeader>
          <CardTitle>Export preview — {GRAN_SHEET[gran]}</CardTitle>
          <p className="text-sm text-muted-foreground">
            First {Math.min(PREVIEW_ROWS, rows.length)} of {rows.length.toLocaleString()} rows in the "{GRAN_SHEET[gran]}" sheet. "Export ·
            all granularities" puts the interval, daily, weekly and monthly sheets in one workbook.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHead key={c} className="whitespace-nowrap">{c}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                <TableRow key={i}>
                  {columns.map((c, j) => (
                    <TableCell key={c} className={cn("whitespace-nowrap tabular-nums", j === 0 && "text-left font-medium")}>
                      {String(r[c] ?? "")}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  )
}
