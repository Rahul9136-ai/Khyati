import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Activity, CalendarRange, Download, Info, Layers, TrendingUp, Users } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import {
  BREAKDOWN_ROWS, CATEGORY_ROWS, FORMULA_NOTES, type MonthResult,
  exportCapacityXlsx, getCapacity, listLobs, monthLabel, updateConfig, updateDemand,
} from "@/lib/hcplanning"
import { cn } from "@/lib/utils"
import { CapacityModule } from "@/pages/planning/capacity/CapacityModule"

function fmt(v: number | null | undefined, field: keyof MonthResult): string {
  if (v === null || v === undefined) return "—"
  if (field === "capacity_pct" || field.toString().includes("util") || field === "buffer_pct")
    return `${(v * 100).toFixed(0)}%`
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}

export function Planning() {
  const qc = useQueryClient()
  const [lobId, setLobId] = useState<string>("")

  const { data: lobs = [] } = useQuery({ queryKey: ["planning-lobs"], queryFn: listLobs })
  useEffect(() => {
    if (!lobId && lobs.length) setLobId(lobs[0].id)
  }, [lobs, lobId])

  const { data: table } = useQuery({
    queryKey: ["planning-capacity", lobId],
    queryFn: () => getCapacity(lobId),
    enabled: !!lobId,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ["planning-capacity", lobId] })

  const saveDemand = useMutation({
    mutationFn: (v: { month: string; billable_fte: number }) =>
      updateDemand(lobId, [v]),
    onSuccess: refresh,
  })
  const saveConfig = useMutation({
    mutationFn: (patch: Record<string, number>) => updateConfig({ lob_id: lobId, ...patch }),
    onSuccess: refresh,
  })

  const results = useMemo(() => table?.results ?? [], [table])
  const cur = results[0]
  const cfg = table?.config

  return (
    <>
      <PageHeader
        title="Planning"
        subtitle="Monthly headcount capacity planning (AGS Health CP model) — dynamically driven by Agent Details"
        actions={
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">LOB</span>
            <Select value={lobId} onChange={(e) => setLobId(e.target.value)}
              options={lobs.map((l) => ({ value: l.id, label: l.name }))} />
          </label>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <KpiCard label="Required HC" value={cur ? String(cur.required_hc) : "…"} hint="current month" icon={Users} />
        <KpiCard label="Closing HC" value={cur ? String(cur.closing_hc) : "…"} hint="FTE + Ramp" icon={Layers} tone="good" />
        <KpiCard label="Capacity %" value={cur?.capacity_pct != null ? `${(cur.capacity_pct * 100).toFixed(0)}%` : "…"}
          hint="Closing / Required" icon={Activity}
          tone={cur && cur.capacity_pct != null ? (cur.capacity_pct >= 1 ? "good" : "warn") : "neutral"} />
        <KpiCard label="Excess / Deficit" value={cur ? String(cur.excess_deficit) : "…"} hint="Closing − Required"
          icon={TrendingUp} tone={cur ? (cur.excess_deficit >= 0 ? "good" : "bad") : "neutral"} />
        <KpiCard label="Agents in plan" value={table?.agent_count ?? "…"} hint="from Agent Details" icon={Users} />
      </div>

          <CapacityModule legacy={<>
          <ConfigStrip cfg={cfg} onSave={(p) => saveConfig.mutate(p)} />
          <Card className="glass mt-4">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Monthly Capacity Plan {table?.lob_name ? `· ${table.lob_name}` : ""}</CardTitle>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-sky-500/70" /> Editable</span>
                <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500/70" /> Calculated</span>
                {table && results.length > 0 && (
                  <Button size="sm" variant="outline" onClick={() => exportCapacityXlsx(table)}>
                    <Download className="h-3.5 w-3.5" /> Export
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="sticky left-0 bg-card px-2 py-2 text-left font-medium">Metric</th>
                    {results.map((r) => (
                      <th key={r.month} className="px-2 py-2 text-right font-medium tabular-nums">{monthLabel(r.month)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {CATEGORY_ROWS.map((row) => (
                    <tr key={row.field} className="border-b border-border/50">
                      <td className={cn("sticky left-0 bg-card px-2 py-1.5 text-left",
                        row.kind === "edit" ? "text-sky-600 dark:text-sky-400" : "")}>
                        <span className="inline-flex items-center gap-1">
                          {row.label}
                          {FORMULA_NOTES[row.field] && (
                            <span className="group relative">
                              <Info className="h-3 w-3 text-muted-foreground" />
                              <span className="pointer-events-none absolute left-4 top-0 z-10 hidden w-56 rounded-md border bg-popover p-2 text-xs text-popover-foreground shadow-lg group-hover:block">
                                {FORMULA_NOTES[row.field]}
                              </span>
                            </span>
                          )}
                        </span>
                      </td>
                      {results.map((r) => (
                        <td key={r.month} className="px-2 py-1 text-right tabular-nums">
                          {row.field === "billable_fte" ? (
                            <PermissionGate module="planning" fallback={<span>{fmt(r.billable_fte, row.field)}</span>}>
                              <input key={`${r.month}-${r.billable_fte}`} type="number" step="1" min="0" defaultValue={r.billable_fte}
                                className="w-16 rounded border border-sky-500/30 bg-sky-500/5 px-1 text-right tabular-nums"
                                onBlur={(e) => {
                                  const v = Math.ceil(parseFloat(e.target.value)) // demand is whole FTE
                                  if (!Number.isNaN(v) && v !== r.billable_fte)
                                    saveDemand.mutate({ month: r.month, billable_fte: v })
                                  else e.target.value = String(r.billable_fte)
                                }} />
                            </PermissionGate>
                          ) : (
                            <span className={cn(row.field === "excess_deficit" &&
                              (r.excess_deficit < 0 ? "text-destructive" : "text-emerald-600"),
                              r.closing_overridden && row.field === "closing_hc" && "font-semibold underline decoration-dotted")}>
                              {fmt(r[row.field] as number, row.field)}
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr><td className="px-2 pt-3 pb-1 text-left text-xs font-semibold text-muted-foreground" colSpan={results.length + 1}>Population breakdown</td></tr>
                  {BREAKDOWN_ROWS.map((row) => (
                    <tr key={row.field} className="border-b border-border/30 text-muted-foreground">
                      <td className="sticky left-0 bg-card px-2 py-1 text-left">{row.label}</td>
                      {results.map((r) => (
                        <td key={r.month} className="px-2 py-1 text-right tabular-nums">{fmt(r[row.field] as number, row.field)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {results.length === 0 && (
                <p className="py-8 text-center text-muted-foreground">
                  No demand for this LOB yet. Add monthly Billable FTE to build the plan.
                </p>
              )}
            </CardContent>
          </Card>
          </>} />
    </>
  )
}

function ConfigStrip({
  cfg, onSave,
}: {
  cfg: { ooo_shrinkage: number; io_shrinkage: number; attrition: number } | undefined
  onSave: (patch: Record<string, number>) => void
}) {
  if (!cfg) return null
  const field = (label: string, key: string, value: number) => (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <PermissionGate module="planning" fallback={<span className="tabular-nums">{(value * 100).toFixed(2)}%</span>}>
        <Input type="number" step="0.25" defaultValue={+(value * 100).toFixed(2)}
          className="h-8 w-20 text-right tabular-nums"
          onBlur={(e) => {
            const v = parseFloat(e.target.value) / 100
            if (!Number.isNaN(v) && v !== value) onSave({ [key]: v })
          }} />
      </PermissionGate>
      <span className="text-muted-foreground">%</span>
    </label>
  )
  return (
    <Card className="glass">
      <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><CalendarRange className="h-4 w-4 text-primary" /> Planning assumptions</CardTitle></CardHeader>
      <CardContent className="flex flex-wrap items-center gap-5">
        {field("OOO Shrinkage", "ooo_shrinkage", cfg.ooo_shrinkage)}
        {field("IO Shrinkage", "io_shrinkage", cfg.io_shrinkage)}
        {field("Attrition", "attrition", cfg.attrition)}
      </CardContent>
    </Card>
  )
}




