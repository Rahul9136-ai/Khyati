// Forecast-accuracy tracker: trailing MAPE/WAPE/bias, daily forecast-vs-actual
// error series, weekly rollups, and today's interval-level variance alerts
// driven by the configurable alert threshold.
import { useMemo } from "react"
import { AlertTriangle, Crosshair, Scale, Target } from "lucide-react"

import { SeriesChart } from "@/components/charts/series-chart"
import { KpiCard } from "@/components/kpi-card"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { accuracySummary, dailyAccuracy, intervalVarianceAlerts, weeklyAccuracy } from "@/lib/domain/accuracy"
import { fmtPct } from "@/lib/domain/planning"
import { actualsFor, INTERVALS } from "@/lib/domain/seed"
import { useWfm } from "@/store/wfm"

const fmtBias = (b: number) => `${b > 0 ? "+" : ""}${(b * 100).toFixed(1)}%`

export function ForecastAccuracy() {
  const { queueId, queues, importedActuals, forecasts, nowIdx, thresholds, ruleState } = useWfm()
  const queue = queues.find((q) => q.id === queueId)!
  const overlay = importedActuals[queue.id]

  const points = useMemo(() => dailyAccuracy(queue.id, 28, overlay), [queue.id, overlay])
  const sum = useMemo(() => accuracySummary(points), [points])
  const weeks = useMemo(() => weeklyAccuracy(points), [points])

  const actuals = useMemo(() => actualsFor(queue.id, nowIdx), [queue.id, nowIdx])
  const alerts = useMemo(
    () =>
      ruleState["variance-alert"] === false
        ? []
        : intervalVarianceAlerts(forecasts[queue.id], actuals, nowIdx, thresholds.varianceAlertPct, INTERVALS.map((i) => i.label)),
    [forecasts, queue.id, actuals, nowIdx, thresholds.varianceAlertPct, ruleState],
  )
  const critical = alerts.filter((a) => a.severity === "critical").length

  const chartData = points.map((p) => ({ label: p.label, Actual: p.actual, Forecast: p.forecast }))

  return (
    <Card className="glass">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle>Forecast accuracy — trailing 28 days</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Daily totals, forecast reconstructed as the system would have produced it (weighted same-weekday average).
          </p>
        </div>
        {alerts.length > 0 ? (
          <Badge variant="warning">
            {alerts.length} variance alert{alerts.length === 1 ? "" : "s"} today
          </Badge>
        ) : (
          <Badge variant="success">within tolerance today</Badge>
        )}
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard label="MAPE" value={fmtPct(sum.mape)} hint="mean daily error" tone={sum.mape <= 0.08 ? "good" : sum.mape <= 0.15 ? "warn" : "bad"} icon={Target} />
          <KpiCard label="WAPE" value={fmtPct(sum.wape)} hint="volume-weighted error" tone={sum.wape <= 0.08 ? "good" : sum.wape <= 0.15 ? "warn" : "bad"} icon={Crosshair} />
          <KpiCard label="Bias" value={fmtBias(sum.bias)} hint={sum.bias > 0 ? "over-forecasting" : sum.bias < 0 ? "under-forecasting" : "neutral"} tone={Math.abs(sum.bias) <= 0.03 ? "good" : Math.abs(sum.bias) <= 0.07 ? "warn" : "bad"} icon={Scale} />
          <KpiCard label="Interval alerts" value={alerts.length} hint={critical ? `${critical} critical (≥${fmtPct(thresholds.varianceAlertPct * 2)})` : `threshold ±${fmtPct(thresholds.varianceAlertPct)}`} tone={critical ? "bad" : alerts.length ? "warn" : "good"} icon={AlertTriangle} />
        </div>

        <div className="mt-4">
          <SeriesChart
            data={chartData}
            xKey="label"
            yLabel="contacts / day"
            height={240}
            series={[
              { key: "Actual", name: "Actual", color: "#0d9488" },
              { key: "Forecast", name: "Forecast (as-produced)", color: queue.color, dashed: true },
            ]}
          />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <h4 className="mb-2 text-sm font-semibold">Weekly rollup</h4>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Week</TableHead>
                  <TableHead>Actual</TableHead>
                  <TableHead>MAPE</TableHead>
                  <TableHead>WAPE</TableHead>
                  <TableHead>Bias</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {weeks.map((w) => (
                  <TableRow key={w.label}>
                    <TableCell className="font-medium">{w.label}</TableCell>
                    <TableCell>{w.actual.toLocaleString()}</TableCell>
                    <TableCell>{fmtPct(w.mape)}</TableCell>
                    <TableCell>{fmtPct(w.wape)}</TableCell>
                    <TableCell className={Math.abs(w.bias) > 0.07 ? "font-semibold text-destructive" : ""}>{fmtBias(w.bias)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div>
            <h4 className="mb-2 text-sm font-semibold">
              Interval variance alerts — today up to {INTERVALS[nowIdx].label}
            </h4>
            {alerts.length === 0 ? (
              <p className="rounded-lg border border-teal-600/30 px-3 py-2 text-sm text-muted-foreground">
                {ruleState["variance-alert"] === false
                  ? "Variance alerting is disabled in the rules engine."
                  : `Every interval so far is within ±${fmtPct(thresholds.varianceAlertPct)} of forecast.`}
              </p>
            ) : (
              <div className="max-h-64 space-y-1.5 overflow-auto pr-1">
                {alerts.map((a) => (
                  <div
                    key={a.idx}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                      a.severity === "critical" ? "border-destructive/50" : "border-amber-600/40"
                    }`}
                  >
                    <span className="font-medium tabular-nums">{a.label}</span>
                    <span className="text-muted-foreground">
                      fc {a.forecast} → act {a.actual}
                    </span>
                    <span className={`font-semibold tabular-nums ${a.severity === "critical" ? "text-destructive" : "text-amber-600"}`}>
                      {a.deltaPct > 0 ? "+" : ""}
                      {fmtPct(a.deltaPct)}
                    </span>
                    <Badge variant={a.severity === "critical" ? "destructive" : "warning"}>{a.severity}</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
