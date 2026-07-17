// Over/under-staffing heatmap: every queue × every 30-min interval, coloured
// by net staffing (scheduled − required gross). Teal = surplus, amber/red =
// deficit; cells breaching the occupancy cap get a warning ring.
import { useMemo } from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { buildPlan, fmtPct } from "@/lib/domain/planning"
import { INTERVALS } from "@/lib/domain/seed"
import { useWfm } from "@/store/wfm"

function cellColor(variance: number): string {
  if (variance >= 3) return "#0d9488" // strong surplus
  if (variance > 0) return "#5eead4" // mild surplus
  if (variance === 0) return "#94a3b8" // exactly staffed
  if (variance >= -2) return "#d97706" // mild deficit
  return "#dc2626" // critical deficit
}

export function StaffingHeatmap() {
  const { queues, forecasts, shrinkage, agents, thresholds } = useWfm()

  const grid = useMemo(
    () =>
      queues.map((q) => ({
        queue: q,
        rows: buildPlan(forecasts[q.id], q.aht, q, shrinkage, agents),
      })),
    [queues, forecasts, shrinkage, agents],
  )

  const worst = useMemo(() => {
    let cell: { q: string; label: string; v: number } | null = null
    grid.forEach(({ queue, rows }) =>
      rows.forEach((r) => {
        if (!cell || r.variance < cell.v) cell = { q: queue.name, label: r.label, v: r.variance }
      }),
    )
    return cell as { q: string; label: string; v: number } | null
  }, [grid])

  const occBreaches = grid.reduce(
    (a, g) => a + g.rows.filter((r) => r.occupancy > thresholds.occupancyCap).length,
    0,
  )

  return (
    <Card className="glass">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle>Staffing heatmap — today, all queues</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Net staffing per 30-min interval (scheduled − required gross).
            {worst && worst.v < 0 && (
              <>
                {" "}Deepest gap: <b className="text-destructive">{worst.q} {worst.label} ({worst.v})</b>.
              </>
            )}
            {occBreaches > 0 && (
              <>
                {" "}<b className="text-amber-600">{occBreaches}</b> interval(s) above the {fmtPct(thresholds.occupancyCap)} occupancy cap (ringed).
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: "#0d9488" }} /> surplus</span>
          <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: "#d97706" }} /> short</span>
          <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: "#dc2626" }} /> critical</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full border-separate" style={{ borderSpacing: 2 }}>
            <thead>
              <tr>
                <th className="sticky left-0 bg-card pr-2 text-left text-xs font-medium text-muted-foreground">Queue</th>
                {INTERVALS.map((iv) => (
                  <th key={iv.idx} className="min-w-6 text-center text-[9px] font-normal tabular-nums text-muted-foreground">
                    {iv.idx % 4 === 0 ? iv.label : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map(({ queue, rows }) => (
                <tr key={queue.id}>
                  <td className="sticky left-0 whitespace-nowrap bg-card pr-2 text-xs font-semibold">{queue.name}</td>
                  {rows.map((r) => (
                    <td key={r.idx}>
                      <div
                        title={`${queue.name} ${r.label}: ${r.variance > 0 ? "+" : ""}${r.variance} agents · req ${r.requiredGross}, sched ${r.scheduled} · occ ${fmtPct(r.occupancy)} · proj SL ${fmtPct(r.projSL)}`}
                        className="flex h-7 items-center justify-center rounded-sm text-[9px] font-bold text-white/95"
                        style={{
                          background: cellColor(r.variance),
                          boxShadow: r.occupancy > thresholds.occupancyCap ? "inset 0 0 0 2px rgb(217 119 6 / 0.9)" : undefined,
                        }}
                      >
                        {r.variance > 0 ? `+${r.variance}` : r.variance}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
