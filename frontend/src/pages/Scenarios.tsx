import { useMemo, useState } from "react"
import { ArrowRight, CalendarClock, FlaskConical, Plus, Sparkles, Trash2 } from "lucide-react"

import { SeriesChart } from "@/components/charts/series-chart"
import { ExportButton } from "@/components/export-button"
import { ExternalFactorsPanel } from "@/components/external-factors-panel"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { addDays, fmtDay, parseYMD, TODAY, ymd } from "@/lib/domain/dates"
import { eventImpactTimeline } from "@/lib/domain/eventImpact"
import { combinedFactorPct, factorStatus } from "@/lib/domain/externalFactors"
import { buildPlan, fmtPct, summarisePlan } from "@/lib/domain/planning"
import { runScenario, type ScenarioResult } from "@/lib/domain/scenario"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

const IMPACT_PRESETS = [
  { id: "past30", label: "Past 30d", from: -30, to: 0 },
  { id: "past90", label: "Past 90d", from: -90, to: 0 },
  { id: "straddle60", label: "±60d", from: -60, to: 60 },
  { id: "next30", label: "Next 30d", from: 0, to: 30 },
  { id: "next90", label: "Next 90d", from: 0, to: 90 },
] as const

function DeltaChip({ value, suffix = "", goodWhenUp = true }: { value: number; suffix?: string; goodWhenUp?: boolean }) {
  if (Math.abs(value) < 0.05) return <span className="text-xs text-muted-foreground">±0{suffix}</span>
  const up = value > 0
  const good = up === goodWhenUp
  return (
    <span className={cn("text-xs font-semibold", good ? "text-emerald-500" : "text-destructive")}>
      {up ? "+" : ""}{value.toFixed(1)}{suffix}
    </span>
  )
}

export function Scenarios() {
  const {
    queues, forecasts, forecastMethod, importedActuals, externalFactors, shrinkage, agents,
    scenarios, addScenario, removeScenario,
  } = useWfm()
  const inputs = useMemo(
    () => ({ forecasts, forecastMethod, importedActuals, externalFactors, shrinkage, agents, queues }),
    [forecasts, forecastMethod, importedActuals, externalFactors, shrinkage, agents, queues],
  )

  // ---- events → volume & requirement impact timeline ----
  const [impactScope, setImpactScope] = useState("all")
  const [impactStart, setImpactStart] = useState(ymd(addDays(TODAY, -60)))
  const [impactEnd, setImpactEnd] = useState(ymd(addDays(TODAY, 60)))
  const impact = useMemo(
    () => eventImpactTimeline(inputs, parseYMD(impactStart), parseYMD(impactEnd), impactScope),
    [inputs, impactStart, impactEnd, impactScope],
  )
  const volDeltaPct = impact.totalBaselineVolume ? (impact.totalAdjustedVolume - impact.totalBaselineVolume) / impact.totalBaselineVolume : 0
  const reqDeltaPct = impact.totalBaselineReqHours ? (impact.totalAdjustedReqHours - impact.totalBaselineReqHours) / impact.totalBaselineReqHours : 0
  const volChartData = impact.points.map((p) => ({ label: p.label, Baseline: p.baselineVolume, Adjusted: p.adjustedVolume }))
  const reqChartData = impact.points.map((p) => ({ label: p.label, Baseline: Math.round(p.baselineReqHours), Adjusted: Math.round(p.adjustedReqHours) }))

  const eventsInWindow = useMemo(
    () => externalFactors.filter((f) => (impactScope === "all" || f.queueId === "all" || f.queueId === impactScope) && f.to >= impactStart && f.from <= impactEnd),
    [externalFactors, impactScope, impactStart, impactEnd],
  )

  // ---- scenario form state ----
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [scope, setScope] = useState("all")
  const [volumePct, setVolumePct] = useState(20)
  const [ahtPct, setAhtPct] = useState(0)
  const [shrinkOverride, setShrinkOverride] = useState("") // empty = keep live setting
  const [agentDelta, setAgentDelta] = useState(0)
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([])
  const [error, setError] = useState("")

  const baseline = useMemo(() => {
    const per = queues.map((q) => summarisePlan(buildPlan(forecasts[q.id] ?? [], q.aht, q, shrinkage, agents)))
    const vol = per.reduce((a, s) => a + s.totalVol, 0)
    return {
      sl: vol ? per.reduce((a, s) => a + s.wSL * s.totalVol, 0) / vol : 0,
      reqHours: per.reduce((a, s) => a + s.reqHours, 0),
      schedHours: per.reduce((a, s) => a + s.schedHours, 0),
      under: per.reduce((a, s) => a + s.underIntervals, 0),
    }
  }, [queues, forecasts, shrinkage, agents])

  const results: ScenarioResult[] = useMemo(
    () => scenarios.map((sc) => runScenario(sc, queues, forecasts, shrinkage, agents)),
    [scenarios, queues, forecasts, shrinkage, agents],
  )

  const chartData = useMemo(
    () => [
      { label: "Baseline", "Projected SL": +(baseline.sl * 100).toFixed(1) },
      ...results.map((r) => ({ label: r.scenario.name, "Projected SL": +(r.modSL * 100).toFixed(1) })),
    ],
    [baseline, results],
  )

  const combinedFromSelected = combinedFactorPct(externalFactors, selectedEventIds)

  function resetForm() {
    setName("")
    setScope("all")
    setVolumePct(20)
    setAhtPct(0)
    setShrinkOverride("")
    setAgentDelta(0)
    setSelectedEventIds([])
    setError("")
  }

  function toggleEvent(id: string) {
    setSelectedEventIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
  }

  function useComputedVolume() {
    setVolumePct(Math.round(combinedFromSelected * 10) / 10)
  }

  function submit() {
    if (!name.trim()) return setError("Name is required.")
    if (scenarios.some((s) => s.name.toLowerCase() === name.trim().toLowerCase())) {
      return setError("A scenario with that name already exists.")
    }
    const shrink = shrinkOverride.trim() === "" ? null : +shrinkOverride
    if (shrink != null && (isNaN(shrink) || shrink < 0 || shrink > 60)) {
      return setError("Shrinkage override must be between 0 and 60%.")
    }
    addScenario({
      name: name.trim(), queueId: scope, volumePct, ahtPct, shrinkagePct: shrink, agentDelta,
      eventIds: selectedEventIds.length ? selectedEventIds : undefined,
    })
    resetForm()
    setOpen(false)
  }

  return (
    <>
      <PageHeader
        title="Scenario Studio"
        subtitle="Events (past & future) → forecast volume → staffing requirement, in one place"
        actions={
          <>
            <ExportButton
              filename="scenarios"
              sheets={() => [
                {
                  name: "Scenario Comparison",
                  rows: results.map((r) => ({
                    Scenario: r.scenario.name,
                    Scope: r.scenario.queueId === "all" ? "All queues" : queues.find((q) => q.id === r.scenario.queueId)?.name ?? r.scenario.queueId,
                    "Volume %": r.scenario.volumePct,
                    "Built from events": r.scenario.eventIds?.length
                      ? externalFactors.filter((f) => r.scenario.eventIds!.includes(f.id)).map((f) => f.name).join("; ") : "",
                    "AHT %": r.scenario.ahtPct,
                    "Shrinkage %": r.scenario.shrinkagePct ?? `${Math.round(shrinkage * 100)} (live)`,
                    "Agent Δ": r.scenario.agentDelta,
                    "Baseline SL": fmtPct(r.baseSL),
                    "Scenario SL": fmtPct(r.modSL),
                    "Required hrs": r.modReqHours.toFixed(0),
                    "Scheduled hrs": r.modSchedHours.toFixed(0),
                    "FTE gap": r.fteGap,
                  })),
                },
                {
                  name: "Event Impact Timeline",
                  rows: impact.points.map((p) => ({
                    Date: p.date, "Baseline volume": p.baselineVolume, "Adjusted volume": p.adjustedVolume,
                    "Baseline req. hrs": Math.round(p.baselineReqHours), "Adjusted req. hrs": Math.round(p.adjustedReqHours),
                  })),
                },
              ]}
            />
            <PermissionGate module="scenarios">
              <Button onClick={() => { resetForm(); setOpen(true) }}>
                <Plus className="h-4 w-4" /> New scenario
              </Button>
            </PermissionGate>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Baseline SL" value={fmtPct(baseline.sl)} hint="live plan, all queues" tone={baseline.sl >= 0.8 ? "good" : "warn"} icon={FlaskConical} />
        <KpiCard label="Required hrs" value={baseline.reqHours.toFixed(0)} hint="baseline, incl. shrinkage" icon={FlaskConical} />
        <KpiCard label="Scheduled hrs" value={baseline.schedHours.toFixed(0)} hint="current roster" icon={FlaskConical} />
        <KpiCard label="Scenarios" value={scenarios.length} hint="saved simulations" icon={FlaskConical} />
      </div>

      {/* ---- Events → volume & requirement impact ---- */}
      <Card className="glass mb-4">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4" /> Volume & requirement impact</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Every logged event (below), applied to Forecasting's date-range engine and then to the same Erlang
              requirement math as the live plan — past events show what actually happened; future ones show what
              to staff for.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={impactScope} onChange={(e) => setImpactScope(e.target.value)}
              options={[{ value: "all", label: "All queues" }, ...queues.map((q) => ({ value: q.id, label: q.name }))]} />
            {IMPACT_PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => { setImpactStart(ymd(addDays(TODAY, p.from))); setImpactEnd(ymd(addDays(TODAY, p.to))) }}
                className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
              >
                {p.label}
              </button>
            ))}
            <Input type="date" value={impactStart} onChange={(e) => e.target.value && setImpactStart(e.target.value)} className="w-auto" />
            <Input type="date" value={impactEnd} min={impactStart} onChange={(e) => e.target.value && setImpactEnd(e.target.value)} className="w-auto" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-wrap items-center gap-6 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
            <span className="text-muted-foreground">{fmtDay(parseYMD(impactStart))} → {fmtDay(parseYMD(impactEnd))}:</span>
            <span className="tabular-nums">
              Volume {impact.totalBaselineVolume.toLocaleString()} → <b className="text-foreground">{impact.totalAdjustedVolume.toLocaleString()}</b>{" "}
              <DeltaChip value={volDeltaPct * 100} suffix="%" goodWhenUp={false} />
            </span>
            <span className="tabular-nums">
              Required hrs {impact.totalBaselineReqHours.toFixed(0)} → <b className="text-foreground">{impact.totalAdjustedReqHours.toFixed(0)}</b>{" "}
              <DeltaChip value={reqDeltaPct * 100} suffix="%" goodWhenUp={false} />
            </span>
            <span className="text-xs text-muted-foreground">{eventsInWindow.length} event(s) active in this window</span>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Volume — contacts/day</p>
              <SeriesChart
                data={volChartData}
                xKey="label"
                series={[
                  { key: "Baseline", name: "Baseline (no events)", color: "#94a3b8", dashed: true },
                  { key: "Adjusted", name: "Adjusted (with events)", color: "#6366f1" },
                ]}
              />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Staffing requirement — agent-hrs/day</p>
              <SeriesChart
                data={reqChartData}
                xKey="label"
                series={[
                  { key: "Baseline", name: "Baseline (no events)", color: "#94a3b8", dashed: true },
                  { key: "Adjusted", name: "Adjusted (with events)", color: "#f59e0b" },
                ]}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---- shared events log (also editable from Forecasting) ---- */}
      <ExternalFactorsPanel />

      {results.length > 0 && (
        <Card className="glass mb-4 mt-4">
          <CardHeader>
            <CardTitle>Projected service level by scenario</CardTitle>
          </CardHeader>
          <CardContent>
            <SeriesChart
              data={chartData}
              xKey="label"
              series={[{ key: "Projected SL", name: "Projected SL (%)", color: "#6366f1", type: "bar" }]}
            />
          </CardContent>
        </Card>
      )}

      {results.length === 0 && (
        <Card className="glass mt-4">
          <CardContent className="py-12 text-center text-muted-foreground">
            <FlaskConical className="mx-auto mb-3 h-8 w-8 opacity-50" />
            No scenarios yet. Build one from the events above, or type a change directly —
            e.g. "Volume +20% in December" or "5 agents resign".
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {results.map((r) => {
          const sc = r.scenario
          const scopeLabel = sc.queueId === "all" ? "All queues" : queues.find((q) => q.id === sc.queueId)?.name ?? sc.queueId
          const builtFrom = sc.eventIds?.length ? externalFactors.filter((f) => sc.eventIds!.includes(f.id)) : []
          return (
            <Card key={sc.id} className="glass">
              <CardHeader className="flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle>{sc.name}</CardTitle>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <Badge variant="outline">{scopeLabel}</Badge>
                    {sc.volumePct !== 0 && <Badge variant="secondary">Volume {sc.volumePct > 0 ? "+" : ""}{sc.volumePct}%</Badge>}
                    {sc.ahtPct !== 0 && <Badge variant="secondary">AHT {sc.ahtPct > 0 ? "+" : ""}{sc.ahtPct}%</Badge>}
                    {sc.shrinkagePct != null && <Badge variant="secondary">Shrinkage {sc.shrinkagePct}%</Badge>}
                    {sc.agentDelta !== 0 && <Badge variant="secondary">{sc.agentDelta > 0 ? "+" : ""}{sc.agentDelta} agents</Badge>}
                  </div>
                  {builtFrom.length > 0 && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Built from: {builtFrom.map((f) => f.name).join(", ")}
                    </p>
                  )}
                </div>
                <PermissionGate module="scenarios">
                  <Button size="sm" variant="ghost" onClick={() => removeScenario(sc.id)} aria-label={`Delete ${sc.name}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </PermissionGate>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between border-b py-1.5">
                  <span className="text-muted-foreground">Service level</span>
                  <span className="flex items-center gap-2 font-medium tabular-nums">
                    {fmtPct(r.baseSL)} <ArrowRight className="h-3 w-3 text-muted-foreground" /> {fmtPct(r.modSL)}
                    <DeltaChip value={(r.modSL - r.baseSL) * 100} suffix="pp" />
                  </span>
                </div>
                <div className="flex items-center justify-between border-b py-1.5">
                  <span className="text-muted-foreground">Required agent-hrs</span>
                  <span className="flex items-center gap-2 font-medium tabular-nums">
                    {r.baseReqHours.toFixed(0)} <ArrowRight className="h-3 w-3 text-muted-foreground" /> {r.modReqHours.toFixed(0)}
                    <DeltaChip value={r.modReqHours - r.baseReqHours} goodWhenUp={false} />
                  </span>
                </div>
                <div className="flex items-center justify-between border-b py-1.5">
                  <span className="text-muted-foreground">Scheduled agent-hrs</span>
                  <span className="font-medium tabular-nums">{r.modSchedHours.toFixed(0)}</span>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-muted-foreground">Verdict</span>
                  {r.fteGap > 0 ? (
                    <Badge variant="destructive">Hire ~{r.fteGap} FTE to hold target</Badge>
                  ) : r.modSL >= r.baseSL - 0.005 ? (
                    <Badge variant="success">Coverage holds</Badge>
                  ) : (
                    <Badge variant="warning">SL degrades — monitor</Badge>
                  )}
                </div>
                {sc.queueId === "all" && (
                  <div className="pt-1">
                    {r.perQueue.map(({ queue, base, mod }) => (
                      <div key={queue.id} className="flex items-center justify-between py-1 text-xs">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <span className="h-2 w-2 rounded-full" style={{ background: queue.color }} /> {queue.name}
                        </span>
                        <span className="tabular-nums">
                          {fmtPct(base.wSL)} → {fmtPct(mod.wSL)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New scenario"
        description="Perturb the live plan's inputs and see the Erlang C impact instantly. The live plan is never modified."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit}><FlaskConical className="h-4 w-4" /> Run scenario</Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Scenario name</span>
            <Input value={name} onChange={(e) => { setName(e.target.value); setError("") }} placeholder="e.g. December volume spike" autoFocus />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Scope</span>
            <Select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              options={[{ value: "all", label: "All queues" }, ...queues.map((q) => ({ value: q.id, label: q.name }))]}
              className="w-full"
            />
          </label>

          {externalFactors.length > 0 && (
            <div className="rounded-lg border p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5" /> Build volume % from logged events (optional)
              </p>
              <div className="max-h-32 space-y-1 overflow-auto">
                {externalFactors.map((f) => (
                  <label key={f.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="accent-primary" checked={selectedEventIds.includes(f.id)} onChange={() => toggleEvent(f.id)} />
                    <span>{f.name}</span>
                    <Badge variant="outline" className="text-[10px]">{factorStatus(f)}</Badge>
                    <span className={cn("ml-auto tabular-nums", f.impactPct >= 0 ? "text-amber-500" : "text-emerald-500")}>
                      {f.impactPct >= 0 ? "+" : ""}{f.impactPct}%
                    </span>
                  </label>
                ))}
              </div>
              {selectedEventIds.length > 0 && (
                <div className="mt-2 flex items-center justify-between border-t pt-2 text-sm">
                  <span className="text-muted-foreground">
                    Combined (compounded): <b className={combinedFromSelected >= 0 ? "text-amber-500" : "text-emerald-500"}>
                      {combinedFromSelected >= 0 ? "+" : ""}{combinedFromSelected.toFixed(1)}%
                    </b>
                  </span>
                  <Button size="sm" variant="outline" onClick={useComputedVolume}>Use this for Volume %</Button>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Volume change (%)</span>
              <Input type="number" step={5} value={volumePct} onChange={(e) => setVolumePct(+e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">AHT change (%)</span>
              <Input type="number" step={5} value={ahtPct} onChange={(e) => setAhtPct(+e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Shrinkage override (%)</span>
              <Input type="number" min={0} max={60} placeholder={`${Math.round(shrinkage * 100)} (live)`} value={shrinkOverride} onChange={(e) => { setShrinkOverride(e.target.value); setError("") }} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Headcount change (±)</span>
              <Input type="number" step={1} value={agentDelta} onChange={(e) => setAgentDelta(Math.round(+e.target.value))} />
            </label>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </Dialog>
    </>
  )
}
