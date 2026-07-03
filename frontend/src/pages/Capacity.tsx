import { useMemo, useState } from "react"

import { AiSummary } from "@/components/ai-summary"
import { SeriesChart } from "@/components/charts/series-chart"
import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Briefcase, TrendingDown, UserPlus, Users } from "lucide-react"
import { addDays, fmtDay, parseYMD, PRESETS, TODAY, ymd } from "@/lib/domain/dates"
import { backtestG, type GranId, GRANULARITIES, rangePlan, summariseBuckets } from "@/lib/domain/granularity"
import { fmtPct } from "@/lib/domain/planning"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

const SHIFT_HRS = 8

export function Capacity() {
  const { queueId, shrinkage, setShrinkage, forecastMethod, agents, queues } = useWfm()
  const queue = queues.find((q) => q.id === queueId)!

  const [gran, setGran] = useState<GranId>("weekly")
  const [start, setStart] = useState(ymd(TODAY))
  const [end, setEnd] = useState(ymd(addDays(TODAY, 13)))

  const method = useMemo(() => {
    const sm = forecastMethod[queue.id]
    return sm === "manual" || sm === "baseline" ? backtestG(queue.id, gran).best.id : sm
  }, [forecastMethod, queue.id, gran])

  const cap = useMemo(
    () => rangePlan(queue.id, parseYMD(start), parseYMD(end), gran, method, queue.aht, queue, shrinkage, agents),
    [queue.id, start, end, gran, method, queue, shrinkage, agents],
  )
  const sum = useMemo(() => summariseBuckets(cap.rows), [cap])

  const reqHrs = cap.rows.reduce((a, r) => a + r.required, 0)
  const schedHrs = cap.rows.reduce((a, r) => a + r.scheduled, 0)
  const reqFte = reqHrs / SHIFT_HRS / Math.max(1, cap.rows.length)
  const gap = schedHrs - reqHrs
  const hireNeed = Math.max(0, Math.ceil(-gap / SHIFT_HRS / Math.max(1, cap.rows.length)))

  const data = cap.rows.map((r) => ({ label: r.label, Required: r.required, Scheduled: r.scheduled }))

  const insight = {
    headline: sum.under
      ? `${queue.name} (${gran}): ${sum.under} ${cap.bucket}s under requirement — worst at ${sum.worst?.label}.`
      : `${queue.name} (${gran}): fully resourced across the range.`,
    bullets: [
      `Required ${reqHrs.toLocaleString()} agent-hrs vs ${schedHrs.toLocaleString()} scheduled (${gap >= 0 ? "+" : ""}${gap.toLocaleString()} hrs).`,
      `≈ ${reqFte.toFixed(1)} FTE/bucket at ${SHIFT_HRS}h shifts, ${fmtPct(shrinkage)} shrinkage applied.`,
      hireNeed > 0 ? `Hiring recommendation: ~${hireNeed} additional FTE to close the deficit.` : "No hiring required for this horizon; surplus can absorb weekend dips.",
    ],
    tone: sum.under > Math.max(2, cap.rows.length / 4) ? ("bad" as const) : sum.under ? ("warn" as const) : ("good" as const),
  }

  return (
    <>
      <PageHeader
        title="Capacity Planning"
        subtitle={`${queue.name} · FTE · shrinkage · occupancy`}
        actions={
          <>
            <div className="inline-flex rounded-lg bg-muted p-1">
              {GRANULARITIES.map((g) => (
                <button key={g.id} onClick={() => setGran(g.id)} className={cn("rounded-md px-3 py-1 text-sm font-medium", gran === g.id ? "bg-background shadow-sm" : "text-muted-foreground")}>
                  {g.name}
                </button>
              ))}
            </div>
            <ExportButton
              filename={`capacity-${queue.id}-${gran}`}
              sheets={() => [
                { name: "KPIs", rows: [
                  { Metric: "Required agent-hrs", Value: reqHrs },
                  { Metric: "Scheduled agent-hrs", Value: schedHrs },
                  { Metric: "Gap (hrs)", Value: gap },
                  { Metric: "Avg FTE / bucket", Value: reqFte.toFixed(1) },
                  { Metric: "Hiring need (FTE)", Value: hireNeed },
                  { Metric: "Shrinkage", Value: fmtPct(shrinkage) },
                ] },
                { name: "Capacity", rows: cap.rows.map((r) => ({ [cap.bucket]: r.label, Volume: r.volume, Required: r.required, Scheduled: r.scheduled, Variance: r.variance, "Proj. SL": fmtPct(r.projSL) })) },
              ]}
            />
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Required agent-hrs" value={reqHrs.toLocaleString()} hint={`${cap.nDays}-day horizon`} icon={Briefcase} />
        <KpiCard label="Scheduled agent-hrs" value={schedHrs.toLocaleString()} hint={`${gap >= 0 ? "surplus" : "deficit"} ${Math.abs(gap).toLocaleString()}`} tone={gap >= 0 ? "good" : "bad"} icon={Users} />
        <KpiCard label="Avg FTE / bucket" value={reqFte.toFixed(1)} hint={`${SHIFT_HRS}h shifts`} icon={TrendingDown} />
        <KpiCard label="Hiring need" value={hireNeed} hint="additional FTE" tone={hireNeed > 0 ? "warn" : "good"} icon={UserPlus} />
      </div>

      <Card className="glass mt-4">
        <CardHeader className="flex-row flex-wrap items-end justify-between gap-3 space-y-0">
          <div>
            <CardTitle>Required vs scheduled ({cap.unit})</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {fmtDay(parseYMD(start))} → {fmtDay(parseYMD(end))} · {cap.rows.length} {cap.bucket}s
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => (
              <button key={p.id} onClick={() => { setStart(ymd(TODAY)); setEnd(ymd(addDays(TODAY, p.days))) }} className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent">
                {p.label}
              </button>
            ))}
            <Input type="date" value={start} min={ymd(TODAY)} onChange={(e) => setStart(e.target.value)} className="w-auto" />
            <Input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} className="w-auto" />
          </div>
        </CardHeader>
        <CardContent>
          <SeriesChart
            data={data}
            xKey="label"
            yLabel="agent-hrs"
            series={[
              { key: "Required", name: "Required", color: "#f59e0b", type: "bar" },
              { key: "Scheduled", name: "Scheduled", color: queue.color },
            ]}
          />
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="glass lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Capacity detail</CardTitle>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Shrinkage {fmtPct(shrinkage)}
              <input type="range" min={0} max={0.5} step={0.01} value={shrinkage} onChange={(e) => setShrinkage(+e.target.value)} className="accent-primary" />
            </label>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{cap.bucket}</TableHead>
                  <TableHead>Volume</TableHead>
                  <TableHead>Required</TableHead>
                  <TableHead>Scheduled</TableHead>
                  <TableHead>Variance</TableHead>
                  <TableHead>Proj. SL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cap.rows.map((r) => (
                  <TableRow key={r.label}>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    <TableCell>{r.volume.toLocaleString()}</TableCell>
                    <TableCell>{r.required.toLocaleString()}</TableCell>
                    <TableCell>{r.scheduled.toLocaleString()}</TableCell>
                    <TableCell className={r.variance < 0 ? "font-semibold text-destructive" : "font-semibold text-emerald-500"}>
                      {r.variance > 0 ? "+" : ""}
                      {r.variance.toLocaleString()}
                    </TableCell>
                    <TableCell>{fmtPct(r.projSL)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <AiSummary insight={insight} title="AI Planning Summary" />
      </div>
    </>
  )
}
