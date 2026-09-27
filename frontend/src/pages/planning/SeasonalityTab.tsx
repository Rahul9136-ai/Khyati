import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarClock, CheckCircle2, Plus, Sparkles, Trash2, TrendingUp } from "lucide-react"
import { useState } from "react"

import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  applySeasonality, createPromotion, deletePromotion, getConfig, getSeasonality,
  listPromotions, monthLabel, updateConfig, type PromotionInput,
} from "@/lib/hcplanning"
import { cn } from "@/lib/utils"

const PCT_KEYS = ["ooo", "io", "attrition"] as const
const PCT_LABEL: Record<(typeof PCT_KEYS)[number], string> = {
  ooo: "OOO", io: "IO", attrition: "Attrition",
}

function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${(v * 100).toFixed(2)}%`
}

export function SeasonalityTab({ lobId }: { lobId: string }) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [applyDemand, setApplyDemand] = useState(true)
  const [applyAssumptions, setApplyAssumptions] = useState(true)
  const [growthInput, setGrowthInput] = useState<string | null>(null)

  const [form, setForm] = useState<PromotionInput>({
    lob_id: lobId, name: "", month_from: "", month_to: "", demand_impact_pct: 0, recurring: true, note: "",
  })

  const { data: cfg } = useQuery({
    queryKey: ["planning-config", lobId], queryFn: () => getConfig(lobId), enabled: !!lobId,
  })
  const { data: seasonality, isLoading } = useQuery({
    queryKey: ["planning-seasonality", lobId], queryFn: () => getSeasonality(lobId), enabled: !!lobId,
  })
  const { data: promotions = [] } = useQuery({
    queryKey: ["planning-promotions", lobId], queryFn: () => listPromotions(lobId), enabled: !!lobId,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["planning-seasonality", lobId] })
    qc.invalidateQueries({ queryKey: ["planning-promotions", lobId] })
    qc.invalidateQueries({ queryKey: ["planning-config", lobId] })
    qc.invalidateQueries({ queryKey: ["planning-capacity", lobId] })
    qc.invalidateQueries({ queryKey: ["planning-batches", lobId] })
  }

  const saveGrowth = useMutation({
    mutationFn: (v: number) => updateConfig({ lob_id: lobId, yoy_growth_pct: v }),
    onSuccess: refresh,
  })
  const addPromotion = useMutation({
    mutationFn: () => createPromotion(form),
    onSuccess: () => {
      setForm({ lob_id: lobId, name: "", month_from: "", month_to: "", demand_impact_pct: 0, recurring: true, note: "" })
      refresh()
    },
  })
  const removePromotion = useMutation({ mutationFn: (id: string) => deletePromotion(id), onSuccess: refresh })
  const apply = useMutation({
    mutationFn: () => applySeasonality({
      lob_id: lobId, months: [...selected], apply_demand: applyDemand, apply_assumptions: applyAssumptions,
    }),
    onSuccess: () => { setSelected(new Set()); refresh() },
  })

  const months = seasonality?.months ?? []
  const toggle = (month: string) => setSelected((s) => {
    const next = new Set(s)
    if (next.has(month)) next.delete(month); else next.add(month)
    return next
  })
  const toggleAll = () => setSelected((s) =>
    s.size === months.length ? new Set() : new Set(months.map((m) => m.month)))

  return (
    <div className="space-y-4">
      <Card className="glass">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <TrendingUp className="h-4 w-4 text-primary" /> Trend & seasonality
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Every assumption below comes from last year's same month for this LOB — peak months
            suggest higher demand automatically, non-peak months lower — plus your expected
            year-over-year growth and any logged promotions. Nothing is written until you select
            months and apply.
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">YoY demand growth</span>
            <PermissionGate module="planning" fallback={<span className="tabular-nums">{cfg?.yoy_growth_pct ?? 0}%</span>}>
              <Input
                type="number" step="0.5" className="h-8 w-20 text-right tabular-nums"
                value={growthInput ?? cfg?.yoy_growth_pct ?? 0}
                onChange={(e) => setGrowthInput(e.target.value)}
                onBlur={(e) => {
                  const v = parseFloat(e.target.value)
                  setGrowthInput(null)
                  if (!Number.isNaN(v) && v !== cfg?.yoy_growth_pct) saveGrowth.mutate(v)
                }}
              />
            </PermissionGate>
            <span className="text-muted-foreground">%</span>
          </label>
          <span className="text-xs text-muted-foreground">
            applied on top of last year's same month before promotions
          </span>
        </CardContent>
      </Card>

      <Card className="glass">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <CalendarClock className="h-4 w-4 text-primary" /> Fixed promotions
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            A known recurring event (a sale, a tax season, an annual launch) with a fixed time of
            year and an expected demand impact — logged once, reapplied automatically every year
            it recurs. A blank LOB applies the promotion to every LOB.
          </p>
        </CardHeader>
        <CardContent>
          <PermissionGate module="planning">
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Name</span>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Q4 Holiday Surge" className="h-9 w-44" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">From (YYYY-MM)</span>
                <Input value={form.month_from} onChange={(e) => setForm({ ...form, month_from: e.target.value })}
                  placeholder="2026-11" className="h-9 w-28" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">To (YYYY-MM)</span>
                <Input value={form.month_to} onChange={(e) => setForm({ ...form, month_to: e.target.value })}
                  placeholder="2026-12" className="h-9 w-28" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Demand impact %</span>
                <Input type="number" step="1" value={form.demand_impact_pct}
                  onChange={(e) => setForm({ ...form, demand_impact_pct: +e.target.value })}
                  className="h-9 w-24" />
              </label>
              <label className="flex h-9 items-center gap-1.5 text-sm text-muted-foreground">
                <input type="checkbox" checked={form.recurring}
                  onChange={(e) => setForm({ ...form, recurring: e.target.checked })} />
                recurs every year
              </label>
              <Button
                disabled={!form.name || !form.month_from || !form.month_to || addPromotion.isPending}
                onClick={() => addPromotion.mutate()}
              >
                <Plus className="h-4 w-4" /> Add promotion
              </Button>
            </div>
          </PermissionGate>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Months</TableHead>
                <TableHead>Recurs</TableHead>
                <TableHead className="text-right">Demand impact</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {promotions.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    {p.name}
                    {!p.lob_id && <Badge variant="outline" className="ml-2">all LOBs</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.month_from} → {p.month_to}</TableCell>
                  <TableCell>{p.recurring ? <Badge variant="secondary">yearly</Badge> : <Badge variant="outline">one-off</Badge>}</TableCell>
                  <TableCell className={cn("text-right tabular-nums font-semibold",
                    p.demand_impact_pct >= 0 ? "text-emerald-600" : "text-destructive")}>
                    {p.demand_impact_pct >= 0 ? "+" : ""}{p.demand_impact_pct}%
                  </TableCell>
                  <TableCell className="text-right">
                    <PermissionGate module="planning" fallback={null}>
                      <Button size="sm" variant="ghost" onClick={() => removePromotion.mutate(p.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </PermissionGate>
                  </TableCell>
                </TableRow>
              ))}
              {promotions.length === 0 && (
                <TableRow><TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                  No promotions logged yet — demand suggestions use trend only.
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="glass">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Sparkles className="h-4 w-4 text-primary" /> Suggested demand & assumptions
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Select the months you agree with, then apply — this writes the same Billable FTE
              demand and per-month OOO/IO/Attrition overrides a manual edit would.
            </p>
          </div>
          <PermissionGate module="planning">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={applyDemand} onChange={(e) => setApplyDemand(e.target.checked)} /> demand
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={applyAssumptions} onChange={(e) => setApplyAssumptions(e.target.checked)} /> assumptions
              </label>
              <Button size="sm" disabled={selected.size === 0 || apply.isPending} onClick={() => apply.mutate()}>
                <CheckCircle2 className="h-3.5 w-3.5" /> Apply {selected.size || ""} month{selected.size === 1 ? "" : "s"}
              </Button>
            </div>
          </PermissionGate>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input type="checkbox" checked={months.length > 0 && selected.size === months.length}
                    onChange={toggleAll} />
                </TableHead>
                <TableHead>Month</TableHead>
                <TableHead className="text-right">Current demand</TableHead>
                <TableHead className="text-right">Last year</TableHead>
                <TableHead className="text-right">+ growth</TableHead>
                <TableHead>Promotions</TableHead>
                <TableHead className="text-right">Suggested demand</TableHead>
                {PCT_KEYS.map((k) => (
                  <TableHead key={k} className="text-right">{PCT_LABEL[k]}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {months.map((m) => {
                const d = m.demand_suggestion
                const changed = d.suggested != null && m.current_demand != null
                  && Math.round(d.suggested) !== Math.round(m.current_demand)
                return (
                  <TableRow key={m.month}>
                    <TableCell><input type="checkbox" checked={selected.has(m.month)} onChange={() => toggle(m.month)} /></TableCell>
                    <TableCell className="font-medium">{monthLabel(m.month)}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.current_demand ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground" title={`from ${d.base_month}`}>
                      {d.base_value ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{d.trended ?? "—"}</TableCell>
                    <TableCell>
                      {d.matched_promotions.length > 0
                        ? d.matched_promotions.map((n) => <Badge key={n} variant="secondary" className="mr-1">{n}</Badge>)
                        : <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className={cn("text-right tabular-nums font-semibold",
                      changed && "text-primary")} title={d.reason ?? undefined}>
                      {d.suggested ?? "—"}
                    </TableCell>
                    {PCT_KEYS.map((k) => (
                      <TableCell key={k} className="text-right tabular-nums text-muted-foreground">
                        {pct(m.assumption_suggestions[k]?.suggested)}
                      </TableCell>
                    ))}
                  </TableRow>
                )
              })}
              {!isLoading && months.length === 0 && (
                <TableRow><TableCell colSpan={7 + PCT_KEYS.length} className="py-8 text-center text-muted-foreground">
                  No editable demand months yet — add demand in Capacity Planning first.
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
