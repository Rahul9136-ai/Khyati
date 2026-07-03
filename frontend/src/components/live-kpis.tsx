import { useQuery } from "@tanstack/react-query"
import { Radio } from "lucide-react"

import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

interface ServerKpis {
  as_of: string
  active_headcount: number
  required_fte_latest_week: number | null
  staffing_gap_latest_week: number | null
  approved_forecasts: number
  avg_forecast_mape_pct: number | null
  pending_requests: number
  absenteeism_rate_28d: number
  late_rate_28d: number
  shrinkage_rate_28d: number
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`

/** Server-of-record KPI strip fed by GET /reports/dashboard. */
export function LiveKpis() {
  const { data, isError } = useQuery({
    queryKey: ["dashboard-kpis"],
    queryFn: async () => (await api.get("/reports/dashboard")).data.data as ServerKpis,
    refetchInterval: 120_000,
  })

  if (isError || !data) return null // page still fully works on the local engine

  const cells: { label: string; value: string; tone?: "good" | "bad" }[] = [
    { label: "Active HC", value: String(data.active_headcount) },
    ...(data.required_fte_latest_week != null
      ? [{ label: "Required FTE (wk)", value: data.required_fte_latest_week.toFixed(1) }]
      : []),
    ...(data.staffing_gap_latest_week != null
      ? [{
          label: "Staffing gap",
          value: data.staffing_gap_latest_week.toFixed(1),
          tone: data.staffing_gap_latest_week >= 0 ? ("good" as const) : ("bad" as const),
        }]
      : []),
    ...(data.avg_forecast_mape_pct != null
      ? [{
          label: "Forecast MAPE",
          value: `${data.avg_forecast_mape_pct.toFixed(1)}%`,
          tone: data.avg_forecast_mape_pct <= 10 ? ("good" as const) : ("bad" as const),
        }]
      : []),
    { label: "Absenteeism 28d", value: pct(data.absenteeism_rate_28d) },
    { label: "Shrinkage 28d", value: pct(data.shrinkage_rate_28d) },
    { label: "Pending requests", value: String(data.pending_requests) },
  ]

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-card/60 px-4 py-2.5 backdrop-blur-xl">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-500">
        <Radio className="h-3 w-3 animate-pulse" /> Live API
      </span>
      {cells.map((cell) => (
        <span key={cell.label} className="text-xs text-muted-foreground">
          {cell.label}{" "}
          <span
            className={cn(
              "font-semibold tabular-nums text-foreground",
              cell.tone === "good" && "text-emerald-500",
              cell.tone === "bad" && "text-red-500",
            )}
          >
            {cell.value}
          </span>
        </span>
      ))}
    </div>
  )
}
