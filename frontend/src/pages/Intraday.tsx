import { useMemo } from "react"

import { SeriesChart } from "@/components/charts/series-chart"
import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Gauge, LineChart, Target, Timer } from "lucide-react"
import { fmtPct } from "@/lib/domain/planning"
import { actualsFor, INTERVALS } from "@/lib/domain/seed"
import { useWfm } from "@/store/wfm"

export function Intraday() {
  const { queueId, forecasts, nowIdx, setNowIdx, queues } = useWfm()
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

  const reforecast = useMemo(() => volume.map((v, i) => (i <= nowIdx ? actuals[i]! : Math.round(v * pacing))), [volume, actuals, nowIdx, pacing])

  const dayForecast = volume.reduce((a, v) => a + v, 0)
  const dayReforecast = reforecast.reduce((a, v) => a + v, 0)

  const data = INTERVALS.map((iv, i) => ({
    label: iv.label,
    Forecast: volume[i],
    Actual: actuals[i],
    Reforecast: i > nowIdx ? reforecast[i] : null,
  }))

  return (
    <>
      <PageHeader
        title="Intraday Management"
        subtitle={`${queue.name} · live tracking & reforecast · now ${INTERVALS[nowIdx].label}`}
        actions={
          <ExportButton
            filename={`intraday-${queue.id}`}
            sheets={() => [
              { name: "KPIs", rows: [
                { Metric: "Pacing vs forecast", Value: fmtPct(pacing - 1) },
                { Metric: "Original forecast", Value: dayForecast },
                { Metric: "Reforecast", Value: dayReforecast },
                { Metric: "Now interval", Value: INTERVALS[nowIdx].label },
              ] },
              { name: "Intraday", rows: data.map((d) => ({ Interval: d.label, Forecast: d.Forecast, Actual: d.Actual, Reforecast: d.Reforecast })) },
            ]}
          />
        }
      />

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
        <KpiCard label="Pacing vs forecast" value={`${pacing >= 1 ? "+" : ""}${fmtPct(pacing - 1)}`} hint="actual ÷ forecast, to-date" tone={Math.abs(pacing - 1) <= 0.05 ? "good" : Math.abs(pacing - 1) <= 0.12 ? "warn" : "bad"} icon={Gauge} />
        <KpiCard label="Original forecast" value={dayForecast.toLocaleString()} hint="contacts (full day)" icon={LineChart} />
        <KpiCard label="Reforecast" value={dayReforecast.toLocaleString()} hint="actuals + paced remainder" tone={dayReforecast > dayForecast ? "warn" : "good"} icon={Target} />
        <KpiCard label="Now interval" value={INTERVALS[nowIdx].label} hint={`${nowIdx + 1}/${INTERVALS.length}`} icon={Timer} />
      </div>

      <Card className="glass mt-4">
        <CardHeader>
          <CardTitle>Forecast vs actual vs reforecast</CardTitle>
        </CardHeader>
        <CardContent>
          <SeriesChart
            data={data}
            xKey="label"
            yLabel="contacts / 30-min"
            height={320}
            series={[
              { key: "Forecast", name: "Original forecast", color: queue.color, dashed: true },
              { key: "Actual", name: "Actual (to-date)", color: "#22c55e" },
              { key: "Reforecast", name: "Reforecast (paced)", color: "#f59e0b", dashed: true },
            ]}
          />
        </CardContent>
      </Card>
    </>
  )
}
