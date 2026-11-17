import { CalendarRange } from "lucide-react"
import { Link } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { fmtTarget, targetById } from "@/lib/domain/publishedForecast"
import { useWfm } from "@/store/wfm"

/** The published forecast for a queue (from the Forecasting page), for any dashboard. */
export function PublishedForecastCard({ queueId }: { queueId: string }) {
  const p = useWfm((s) => s.publishedForecasts[queueId])
  return (
    <Card className="glass mt-4">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2"><CalendarRange className="h-4 w-4" /> Published forecast</CardTitle>
        {p ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {p.start} → {p.end} · {p.methodName} · MAPE {(p.mape * 100).toFixed(1)}%
            {p.auto && <Badge variant="secondary">auto</Badge>}
          </span>
        ) : (
          <Link to="/forecasting" className="text-xs text-primary hover:underline">Publish one on Forecasting →</Link>
        )}
      </CardHeader>
      {p && (
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          {p.targets.map((t) => (
            <div key={t} className="rounded-lg border px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{targetById[t]?.name ?? t}</div>
              <div className="text-base font-semibold tabular-nums">{fmtTarget(t, p.totals[t])}</div>
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  )
}
