import { useMemo } from "react"

import { SeriesChart } from "@/components/charts/series-chart"
import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Gauge, LineChart, Target, Timer, Zap } from "lucide-react"
import { buildPlan, fmtPct } from "@/lib/domain/planning"
import { actualsFor, INTERVALS } from "@/lib/domain/seed"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

export function Intraday() {
  const { queueId, forecasts, nowIdx, setNowIdx, queues, shrinkage, agents, thresholds, ruleState, logAudit } = useWfm()
  const queue = queues.find((q) => q.id === queueId)!
  const volume = forecasts[queue.id]
  const actuals = useMemo(() => actualsFor(queue.id, nowIdx), [queue.id, nowIdx])

  const pacing = useMemo(() => {
    let af = 0, ff = 0
    for (let i = 0; i <= nowIdx; i++) {
      af += actuals[i] ?? 0
      ff += volume[i]
    }
    return ff ? af / ff : 1
  }, [actuals, volume, nowIdx])

  // Auto-reforecast fires when to-date deviation breaches the configured
  // threshold (rules engine can disable it) — the remaining day is repaced.
  const deviation = pacing - 1
  const reforecastActive = ruleState["auto-reforecast"] !== false && Math.abs(deviation) >= thresholds.reforecastPct
  const reforecast = useMemo(
    () => volume.map((v, i) => (i <= nowIdx ? (actuals[i] ?? v) : Math.round(v * pacing))),
    [volume, actuals, nowIdx, pacing],
  )
  const effective = reforecastActive ? reforecast : volume

  const dayForecast = volume.reduce((a, v) => a + v, 0)
  const dayReforecast = reforecast.reduce((a, v) => a + v, 0)

  // Net staffing for the remaining day against the effective (re)forecast.
  const plan = useMemo(() => buildPlan(effective, queue.aht, queue, shrinkage, agents), [effective, queue, shrinkage, agents])
  const remaining = plan.filter((r) => r.idx > nowIdx)
  const surplusHrs = remaining.reduce((a, r) => a + Math.max(0, r.variance), 0) * 0.5
  const deficitHrs = remaining.reduce((a, r) => a + Math.max(0, -r.variance), 0) * 0.5
  const underIntervals = remaining.filter((r) => r.variance < 0)

  // Rule-gated intraday actions the desk can take with one click.
  const vtoEnabled = ruleState["vto-offer"] !== false
  const proposals = useMemo(() => {
    if (!vtoEnabled) return []
    const out: { id: string; title: string; detail: string; tone: "surplus" | "deficit" }[] = []
    if (surplusHrs >= 4)
      out.push({
        id: "vto",
        title: `Offer ${Math.floor(surplusHrs)}h of VTO`,
        detail: `Remaining day runs ${surplusHrs.toFixed(1)} agent-hrs over requirement — release surplus as voluntary time off, biggest blocks first.`,
        tone: "surplus",
      })
    if (deficitHrs >= 2)
      out.push({
        id: "ot",
        title: `Post ${Math.ceil(deficitHrs)}h of overtime`,
        detail: `${underIntervals.length} interval(s) short by ${deficitHrs.toFixed(1)} agent-hrs (worst at ${underIntervals[0]?.label ?? "—"}) — offer OT blocks or extend late shifts.`,
        tone: "deficit",
      })
    if (deficitHrs >= 1)
      out.push({
        id: "breaks",
        title: "Re-stagger remaining breaks",
        detail: "Run the break optimiser against the reforecast to move afternoon breaks out of the trough intervals.",
        tone: "deficit",
      })
    return out
  }, [vtoEnabled, surplusHrs, deficitHrs, underIntervals])

  const data = INTERVALS.map((iv, i) => ({
    label: iv.label,
    Forecast: volume[i],
    Actual: actuals[i],
    Reforecast: i > nowIdx ? reforecast[i] : null,
    "Net staffing": plan[i].variance,
  }))

  return (
    <>
      <PageHeader
        title="Intraday Management"
        subtitle={`${queue.name} · live tracking · auto-reforecast at ±${fmtPct(thresholds.reforecastPct)} deviation`}
        actions={
          <ExportButton
            filename={`intraday-${queue.id}`}
            sheets={() => [
              { name: "KPIs", rows: [
                { Metric: "Pacing vs forecast", Value: fmtPct(deviation) },
                { Metric: "Auto-reforecast", Value: reforecastActive ? "ACTIVE" : "not triggered" },
                { Metric: "Original forecast", Value: dayForecast },
                { Metric: "Reforecast", Value: dayReforecast },
                { Metric: "Remaining surplus (hrs)", Value: surplusHrs.toFixed(1) },
                { Metric: "Remaining deficit (hrs)", Value: deficitHrs.toFixed(1) },
                { Metric: "Now interval", Value: INTERVALS[nowIdx].label },
              ] },
              { name: "Intraday", rows: data.map((d) => ({ Interval: d.label, Forecast: d.Forecast, Actual: d.Actual, Reforecast: d.Reforecast, "Net staffing": d["Net staffing"] })) },
            ]}
          />
        }
      />

      <div
        className={cn(
          "mb-4 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2.5 text-sm",
          reforecastActive ? "border-amber-600/50" : "border-teal-600/30",
        )}
      >
        <Zap className={cn("h-4 w-4", reforecastActive ? "text-amber-600" : "text-teal-600")} />
        {reforecastActive ? (
          <>
            <b>Auto-reforecast active:</b> actuals are running {deviation > 0 ? "+" : ""}
            {fmtPct(deviation)} vs forecast (trigger ±{fmtPct(thresholds.reforecastPct)}). Remaining day repaced; staffing plan below uses the reforecast.
            <Badge variant="warning" className="ml-auto">automated</Badge>
          </>
        ) : (
          <>
            Volume within ±{fmtPct(thresholds.reforecastPct)} of forecast ({deviation > 0 ? "+" : ""}
            {fmtPct(deviation)}) — no reforecast needed.
            {ruleState["auto-reforecast"] === false && <Badge variant="secondary" className="ml-auto">rule disabled</Badge>}
          </>
        )}
      </div>

      <Card className="glass mb-4">
        <CardContent className="pt-5">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Day clock — drag to advance "now"</span>
            <span className="font-semibold tabular-nums">{INTERVALS[nowIdx].label}</span>
          </div>
          <input type="range" min={0} max={INTERVALS.length - 1} value={nowIdx} onChange={(e) => setNowIdx(+e.target.value)} className="w-full accent-primary" />
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Pacing vs forecast" value={`${deviation >= 0 ? "+" : ""}${fmtPct(deviation)}`} hint={`auto-reforecast at ±${fmtPct(thresholds.reforecastPct)}`} tone={Math.abs(deviation) < thresholds.reforecastPct ? "good" : Math.abs(deviation) <= thresholds.reforecastPct * 1.5 ? "warn" : "bad"} icon={Gauge} />
        <KpiCard label="Original forecast" value={dayForecast.toLocaleString()} hint="contacts (full day)" icon={LineChart} />
        <KpiCard label="Reforecast" value={dayReforecast.toLocaleString()} hint={reforecastActive ? "applied to staffing" : "standby (not triggered)"} tone={dayReforecast > dayForecast ? "warn" : "good"} icon={Target} />
        <KpiCard label="Remaining net staffing" value={`${surplusHrs >= deficitHrs ? "+" : "−"}${Math.abs(surplusHrs - deficitHrs).toFixed(1)}h`} hint={`${underIntervals.length} interval(s) short`} tone={deficitHrs > surplusHrs ? "bad" : "good"} icon={Timer} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="glass lg:col-span-2">
          <CardHeader>
            <CardTitle>Forecast vs actual vs reforecast</CardTitle>
          </CardHeader>
          <CardContent>
            <SeriesChart
              data={data}
              xKey="label"
              yLabel="contacts / 30-min"
              height={300}
              series={[
                { key: "Forecast", name: "Original forecast", color: queue.color, dashed: true },
                { key: "Actual", name: "Actual (to-date)", color: "#0d9488" },
                { key: "Reforecast", name: "Reforecast (paced)", color: "#d97706", dashed: true },
              ]}
            />
          </CardContent>
        </Card>

        <Card className="glass">
          <CardHeader>
            <CardTitle>⚡ Intraday actions</CardTitle>
            <p className="text-xs text-muted-foreground">
              {vtoEnabled ? "Rule-engine proposals for the remaining day — human approval required." : "VTO/OT proposals are disabled in the rules engine."}
            </p>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {proposals.length === 0 ? (
              <p className="text-sm text-muted-foreground">Remaining day is balanced — no VTO, overtime or break moves needed.</p>
            ) : (
              proposals.map((p) => (
                <div key={p.id} className={cn("rounded-lg border p-3", p.tone === "deficit" ? "border-amber-600/40" : "border-teal-600/40")}>
                  <div className="text-sm font-semibold">{p.title}</div>
                  <p className="mt-1 text-xs text-muted-foreground">{p.detail}</p>
                  <PermissionGate module="intraday" fallback={<span className="mt-2 block text-xs text-muted-foreground">view only</span>}>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      onClick={() => logAudit("Real-Time", "Approved intraday action", `${queue.name} · ${p.title}`)}
                    >
                      Approve & log
                    </Button>
                  </PermissionGate>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="glass mt-4">
        <CardHeader>
          <CardTitle>Net staffing by interval {reforecastActive && <Badge variant="warning" className="ml-2">vs reforecast</Badge>}</CardTitle>
        </CardHeader>
        <CardContent>
          <SeriesChart
            data={data}
            xKey="label"
            yLabel="agents over/under"
            height={220}
            series={[{ key: "Net staffing", name: "Scheduled − required (gross)", color: "#64748b", type: "bar" }]}
          />
        </CardContent>
      </Card>
    </>
  )
}
