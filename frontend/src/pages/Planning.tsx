import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Activity, ArrowRight, ArrowRightLeft, CalendarRange, Download, FlaskConical, Info,
  Layers, Plus, Trash2, TrendingUp, UserPlus, Users,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import {
  Bar, BarChart, CartesianGrid, Legend, Line, ComposedChart, ResponsiveContainer,
  Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"

import { KpiCard } from "@/components/kpi-card"
import { MovementTab } from "@/pages/planning/MovementTab"
import { NewHireTab } from "@/pages/planning/NewHireTab"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  BREAKDOWN_ROWS, CATEGORY_ROWS, FORMULA_NOTES, type MonthResult,
  type ScenarioResult, exportCapacityXlsx, getCapacity, getPipeline, listAgents, listLobs,
  monthLabel, runScenario, updateConfig, updateDemand,
} from "@/lib/hcplanning"
import { cn } from "@/lib/utils"

function fmt(v: number | null | undefined, field: keyof MonthResult): string {
  if (v === null || v === undefined) return "—"
  if (field === "capacity_pct" || field.toString().includes("util") || field === "buffer_pct")
    return `${(v * 100).toFixed(0)}%`
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}

export function Planning() {
  const qc = useQueryClient()
  const [lobId, setLobId] = useState<string>("")
  // Backed by the URL (not local state) so the sidebar's four sub-links under
  // Capacity Planning — and browser back/forward — land on the right tab.
  const [params, setParams] = useSearchParams()
  const tab = params.get("tab") ?? "capacity"
  const setTab = (t: string) => setParams((prev) => {
    const p = new URLSearchParams(prev)
    if (t === "capacity") p.delete("tab")
    else p.set("tab", t)
    return p
  }, { replace: true })

  const { data: lobs = [] } = useQuery({ queryKey: ["planning-lobs"], queryFn: listLobs })
  useEffect(() => {
    if (!lobId && lobs.length) setLobId(lobs[0].id)
  }, [lobs, lobId])

  const { data: table } = useQuery({
    queryKey: ["planning-capacity", lobId],
    queryFn: () => getCapacity(lobId),
    enabled: !!lobId,
  })
  // Shared across sub-sections: New Hire's pipeline and Movement's roster both feed
  // straight into the Capacity numbers above (see build_capacity_table on the backend),
  // so the connection strip below reads the same queries those tabs use — React Query
  // dedupes the fetch, no extra network cost — to show the link with live numbers.
  const { data: pipeline = [] } = useQuery({
    queryKey: ["planning-pipeline", lobId], queryFn: () => getPipeline(lobId), enabled: !!lobId,
  })
  const { data: agents = [] } = useQuery({
    queryKey: ["planning-agents", lobId], queryFn: () => listAgents(lobId), enabled: !!lobId,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ["planning-capacity", lobId] })
  const goTo = (t: string) => setTab(t)

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

  const chartData = useMemo(
    () => results.map((r) => ({
      month: monthLabel(r.month),
      Required: r.required_hc,
      Closing: r.closing_hc,
      "Capacity %": r.capacity_pct ? Number((r.capacity_pct * 100).toFixed(0)) : null,
    })),
    [results],
  )

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

      <ConnectionStrip
        tab={tab} onGoTo={goTo}
        pipelineCount={pipeline.length}
        pipelineProd={pipeline.reduce((s, p) => s + p.production, 0)}
        movementPending={agents.filter((a) => a.move_out_date || a.move_in_date).length}
        cur={cur}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="capacity">Capacity Planning</TabsTrigger>
          <TabsTrigger value="newhire">New Hire Planning</TabsTrigger>
          <TabsTrigger value="movement">Agent Movement</TabsTrigger>
          <TabsTrigger value="summary">Summary</TabsTrigger>
        </TabsList>

        <TabsContent value="capacity">
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
        </TabsContent>

        <TabsContent value="newhire">
          {lobId && <NewHireTab lobId={lobId} onGoToCapacity={() => goTo("capacity")} requiredHc={cur?.required_hc} />}
        </TabsContent>
        <TabsContent value="movement">{lobId && <MovementTab lobId={lobId} lobs={lobs} onGoToCapacity={() => goTo("capacity")} />}</TabsContent>

        <TabsContent value="summary">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="glass">
              <CardHeader><CardTitle>Required HC vs Closing HC</CardTitle></CardHeader>
              <CardContent style={{ height: 300 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis dataKey="month" fontSize={11} />
                    <YAxis fontSize={11} />
                    <RTooltip />
                    <Legend />
                    <Bar dataKey="Required" fill="#94a3b8" />
                    <Bar dataKey="Closing" fill="#0ea5e9" />
                    <Line type="monotone" dataKey="Capacity %" stroke="#10b981" yAxisId={0} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            <Card className="glass">
              <CardHeader><CardTitle>Excess / Deficit by month</CardTitle></CardHeader>
              <CardContent style={{ height: 300 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={results.map((r) => ({ month: monthLabel(r.month), value: r.excess_deficit }))}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis dataKey="month" fontSize={11} />
                    <YAxis fontSize={11} />
                    <RTooltip />
                    <Bar dataKey="value" fill="#0ea5e9" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
          {lobId && results.length > 0 && (
            <ScenarioPanel
              lobId={lobId} from={results[0].month} to={results[results.length - 1].month}
              onGoToNewHire={() => goTo("newhire")}
            />
          )}
        </TabsContent>
      </Tabs>
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

/** A persistent strip, visible on every sub-tab, showing how Demand, New Hire
 *  Planning, Agent Movement and Assumptions all flow into the Required/Closing
 *  HC numbers at the top of the page — each node jumps straight to the tab
 *  that owns it. Pure navigation + live counts; no calculation happens here. */
function ConnectionStrip({
  tab, onGoTo, pipelineCount, pipelineProd, movementPending, cur,
}: {
  tab: string
  onGoTo: (t: string) => void
  pipelineCount: number
  pipelineProd: number
  movementPending: number
  cur: MonthResult | undefined
}) {
  const node = (
    id: string, label: string, hint: string, Icon: typeof Users, active: boolean,
  ) => (
    <button
      type="button"
      onClick={() => onGoTo(id)}
      className={cn(
        "flex min-w-[9rem] flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
        active ? "border-primary/50 bg-primary/5" : "border-border/60 hover:bg-muted/40",
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium">
        <Icon className="h-3.5 w-3.5 text-primary" /> {label}
      </span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  )
  const arrow = <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />

  return (
    <Card className="glass mb-4">
      <CardContent className="flex flex-wrap items-center gap-2 py-3">
        <span className="mr-1 shrink-0 text-xs font-semibold text-muted-foreground">Connected inputs:</span>
        {node("capacity", "Demand & Assumptions", cur ? `${cur.billable_fte} Billable FTE` : "set demand", CalendarRange, tab === "capacity")}
        {arrow}
        {node("newhire", "New Hire Planning", `${pipelineCount} batch${pipelineCount === 1 ? "" : "es"} · +${pipelineProd} agents`, UserPlus, tab === "newhire")}
        {arrow}
        {node("movement", "Agent Movement", `${movementPending} move${movementPending === 1 ? "" : "s"} planned`, ArrowRightLeft, tab === "movement")}
        {arrow}
        {node("capacity", "Ramp → Closing HC", cur ? `${cur.closing_hc} this month` : "…", Layers, false)}
        {arrow}
        {node("summary", "Capacity % & Scenarios", cur?.capacity_pct != null ? `${(cur.capacity_pct * 100).toFixed(0)}%` : "…", Activity, tab === "summary")}
      </CardContent>
    </Card>
  )
}

function ScenarioPanel({
  lobId, from, to, onGoToNewHire,
}: { lobId: string; from: string; to: string; onGoToNewHire: () => void }) {
  const [ooo, setOoo] = useState("")
  const [attr, setAttr] = useState("")
  const [demandPct, setDemandPct] = useState("")
  const [extraHires, setExtraHires] = useState<{ hire_date: string; count: number }[]>([])
  const [newHireDate, setNewHireDate] = useState("")
  const [newHireCount, setNewHireCount] = useState("")
  const [result, setResult] = useState<ScenarioResult | null>(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    try {
      setResult(await runScenario(lobId, from, to, {
        ooo_shrinkage: ooo ? +ooo / 100 : undefined,
        attrition: attr ? +attr / 100 : undefined,
        demand_pct: demandPct ? +demandPct : undefined,
        extra_hires: extraHires.length ? extraHires : undefined,
      }))
    } finally {
      setBusy(false)
    }
  }

  function addExtraHire() {
    if (!newHireDate || !newHireCount) return
    setExtraHires((h) => [...h, { hire_date: newHireDate, count: +newHireCount }])
    setNewHireDate("")
    setNewHireCount("")
  }

  const b = result?.baseline[0]
  const s = result?.scenario[0]
  const delta = (get: (r: MonthResult) => number | null) =>
    b && s ? ((get(s) ?? 0) - (get(b) ?? 0)) : 0

  return (
    <Card className="glass mt-4">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm"><FlaskConical className="h-4 w-4 text-primary" /> Scenario planning</CardTitle>
        <p className="text-xs text-muted-foreground">What-if against the live plan — the baseline is never changed.</p>
      </CardHeader>
      <CardContent>
        <PermissionGate module="planning" fallback={<p className="text-sm text-muted-foreground">Read-only.</p>}>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm"><span className="mb-1 block text-muted-foreground">OOO Shrinkage %</span>
              <Input type="number" value={ooo} onChange={(e) => setOoo(e.target.value)} placeholder="baseline" className="h-9 w-28" /></label>
            <label className="text-sm"><span className="mb-1 block text-muted-foreground">Attrition %</span>
              <Input type="number" value={attr} onChange={(e) => setAttr(e.target.value)} placeholder="baseline" className="h-9 w-28" /></label>
            <label className="text-sm"><span className="mb-1 block text-muted-foreground">Demand ±%</span>
              <Input type="number" value={demandPct} onChange={(e) => setDemandPct(e.target.value)} placeholder="0" className="h-9 w-28" /></label>
          </div>

          <div className="mt-4 rounded-lg border border-dashed p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <UserPlus className="h-4 w-4 text-primary" /> Extra hires (what-if)
              </span>
              <button type="button" onClick={onGoToNewHire} className="text-xs text-primary hover:underline">
                Make it a real batch in New Hire Planning →
              </button>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              Test a hiring batch without committing it — runs through the same Hiring → Training → Nesting →
              Production pipeline as New Hire Planning and lands in Ramp on the scenario side only.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-sm"><span className="mb-1 block text-muted-foreground">Hire date</span>
                <Input type="date" value={newHireDate} onChange={(e) => setNewHireDate(e.target.value)} className="h-9 w-40" /></label>
              <label className="text-sm"><span className="mb-1 block text-muted-foreground">Count</span>
                <Input type="number" min={0} value={newHireCount} onChange={(e) => setNewHireCount(e.target.value)} className="h-9 w-24" /></label>
              <Button size="sm" variant="outline" disabled={!newHireDate || !newHireCount} onClick={addExtraHire}>
                <Plus className="h-3.5 w-3.5" /> Add
              </Button>
            </div>
            {extraHires.length > 0 && (
              <ul className="mt-2 space-y-1">
                {extraHires.map((h, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ArrowRight className="h-3 w-3" /> {h.count} hires on {h.hire_date}
                    <button type="button" onClick={() => setExtraHires((arr) => arr.filter((_, j) => j !== i))}
                      className="text-destructive hover:underline">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Button className="mt-3" disabled={busy} onClick={run}><FlaskConical className="h-4 w-4" /> Run scenario</Button>
        </PermissionGate>
        {result && b && s && (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {([
              ["Required HC", (r: MonthResult) => r.required_hc],
              ["Closing HC", (r: MonthResult) => r.closing_hc],
              ["Capacity %", (r: MonthResult) => r.capacity_pct],
              ["Excess/Deficit", (r: MonthResult) => r.excess_deficit],
            ] as const).map(([label, get]) => (
              <div key={label} className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">{label} ({monthLabel(from)})</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-sm text-muted-foreground line-through">{fmtKpi(get(b), label)}</span>
                  <span className="text-lg font-semibold">{fmtKpi(get(s), label)}</span>
                </div>
                <div className={cn("text-xs", delta(get) >= 0 ? "text-emerald-600" : "text-destructive")}>
                  {delta(get) >= 0 ? "+" : ""}{fmtDelta(delta(get), label)}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function fmtKpi(v: number | null, label: string): string {
  if (v === null || v === undefined) return "—"
  return label === "Capacity %" ? `${(v * 100).toFixed(0)}%` : String(v)
}

// Headcount metrics are whole numbers from the API; the capacity delta is a fraction of 1.
function fmtDelta(d: number, label: string): string {
  return label === "Capacity %" ? `${(d * 100).toFixed(0)}pp` : String(d)
}

