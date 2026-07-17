import { useMemo, useRef, useState } from "react"
import { CalendarClock, CheckCircle2, FileDown, RotateCcw, Sparkles, Upload, Wand2 } from "lucide-react"
import { Link } from "react-router-dom"

import { AiSummary } from "@/components/ai-summary"
import { SeriesChart } from "@/components/charts/series-chart"
import { ExportButton } from "@/components/export-button"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { agentBreakMarkers, breakAwareCoverage, optimiseBreaks, projectedSLRow } from "@/lib/domain/breaks"
import { planAutoSchedule, type AutoScheduleResult } from "@/lib/domain/autoschedule"
import { buildPlan, fmtPct, summarisePlan } from "@/lib/domain/planning"
import { AUX_BY_CODE, INTERVALS } from "@/lib/domain/seed"
import { downloadTemplate, parseScheduleFile } from "@/lib/schedule"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

function coveredIdx(shift: string): boolean[] {
  const [s, e] = shift.split("–").map((t) => {
    const [h, m] = t.split(":").map(Number)
    return h * 60 + m
  })
  return INTERVALS.map(({ label }) => {
    const [h, m] = label.split(":").map(Number)
    const mins = h * 60 + m
    return mins >= s && mins < e
  })
}

export function Scheduling() {
  const { queueId, forecasts, shrinkage, agents, setAgents, shiftPatterns, queues, breakOverrides, applyBreakOverrides, resetBreakOverrides, applyAutoSchedule } = useWfm()
  const queue = queues.find((q) => q.id === queueId)!
  const plan = useMemo(() => buildPlan(forecasts[queue.id], queue.aht, queue, shrinkage, agents), [forecasts, queue, shrinkage, agents])
  const sum = useMemo(() => summarisePlan(plan), [plan])

  // Break-aware view: heads actually on the phones + Erlang SL per interval.
  const onDuty = useMemo(
    () => breakAwareCoverage(queue.id, agents, shiftPatterns, breakOverrides),
    [queue.id, agents, shiftPatterns, breakOverrides],
  )
  const slRow = useMemo(
    () => projectedSLRow(forecasts[queue.id] ?? [], onDuty, queue, shrinkage),
    [forecasts, queue, onDuty, shrinkage],
  )
  const intervalDetail = useMemo(
    () =>
      plan.map((p, i) => ({
        label: p.label,
        Volume: p.volume,
        Required: p.requiredGross,
        "On duty": onDuty[i],
        "Proj SL %": +(slRow[i] * 100).toFixed(1),
      })),
    [plan, onDuty, slRow],
  )
  const optimised = Object.keys(breakOverrides).length > 0

  const fileRef = useRef<HTMLInputElement>(null)
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [optimMsg, setOptimMsg] = useState<string | null>(null)
  const [autoResult, setAutoResult] = useState<AutoScheduleResult | null>(null)

  function onAutoSchedule() {
    const result = planAutoSchedule(queue, forecasts[queue.id] ?? [], shrinkage, agents, shiftPatterns)
    setAutoResult(result)
  }

  function applyAuto() {
    if (!autoResult || autoResult.totalAdded === 0) return
    applyAutoSchedule(queue.id, autoResult.additions)
    setAutoResult(null)
  }

  function onOptimise() {
    const res = optimiseBreaks(queues, forecasts, shrinkage, agents, shiftPatterns, breakOverrides)
    if (res.moved === 0) {
      setOptimMsg("Breaks are already optimally placed — no beneficial moves found.")
    } else {
      applyBreakOverrides(res.overrides, `${res.moved} break moves · under-target queue-intervals ${res.beforeUnder} → ${res.afterUnder}`)
      setOptimMsg(`Moved ${res.moved} break${res.moved > 1 ? "s" : ""} · under-target intervals ${res.beforeUnder} → ${res.afterUnder} across all queues.`)
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const { agents: imported, errors } = await parseScheduleFile(file, queues)
      if (!imported.length) {
        setImportMsg({ ok: false, text: `No valid rows in ${file.name}. ${errors.slice(0, 2).join("; ")}` })
      } else {
        setAgents(imported, `${imported.length} agents from ${file.name}`)
        setImportMsg({ ok: true, text: `Imported ${imported.length} agents from ${file.name}${errors.length ? ` (${errors.length} rows skipped)` : ""}.` })
      }
    } catch (err) {
      setImportMsg({ ok: false, text: `Could not read ${file.name}: ${(err as Error).message}` })
    }
    e.target.value = ""
  }

  const under = plan.filter((p) => p.variance < 0)
  const insight = {
    headline: under.length ? `Roster covers ${fmtPct(1 - under.length / plan.length)} of intervals; ${under.length} need a tweak.` : "Roster fully covers the forecast — well-shaped shift plan.",
    bullets: [
      `${agents.length} agents · ${sum.schedHours.toFixed(0)} scheduled hrs vs ${sum.reqHours.toFixed(0)} required.`,
      "Break & lunch optimisation places relief ~2h and ~4h into each shift.",
      "Skill-based routing: dual-skilled agents cover overlapping queues at peak.",
    ],
    tone: under.length > 6 ? ("warn" as const) : ("good" as const),
  }

  return (
    <>
      <PageHeader
        title="Scheduling"
        subtitle={`Daily roster · ${agents.length} agents · 07:00–19:00`}
        actions={
          <>
            <Badge variant="secondary" className="hidden lg:inline-flex">skilled for {queue.name}</Badge>
            <PermissionGate module="scheduling">
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFile} />
              <Button variant="outline" onClick={() => downloadTemplate(agents)}>
                <FileDown className="h-4 w-4" /> Template
              </Button>
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" /> Import schedule
              </Button>
              <Button variant="outline" onClick={onAutoSchedule}>
                <Sparkles className="h-4 w-4" /> Auto-schedule
              </Button>
              <Button onClick={onOptimise}>
                <Wand2 className="h-4 w-4" /> Optimise breaks
              </Button>
              {optimised && (
                <Button variant="ghost" onClick={() => { resetBreakOverrides(); setOptimMsg("Break plan reset to shift-pattern defaults.") }}>
                  <RotateCcw className="h-4 w-4" /> Reset
                </Button>
              )}
            </PermissionGate>
            <Button variant="outline" asChild>
              <Link to="/shift-patterns"><CalendarClock className="h-4 w-4" /> Shift patterns</Link>
            </Button>
            <ExportButton
              filename={`schedule-${queue.id}`}
              sheets={() => [
                { name: "Roster", rows: agents.map((a) => ({ Name: a.name, Team: a.team, "Team Lead": a.tl, Shift: a.shift, Skills: a.skills.map((s) => queues.find((q) => q.id === s)?.name ?? s).join(", ") })) },
                { name: "Coverage", rows: plan.map((p) => ({ Interval: p.label, Scheduled: p.scheduled, Required: p.requiredGross, Variance: p.variance })) },
              ]}
            />
          </>
        }
      />

      {autoResult && (
        <Card className="glass mb-4 border-primary/40">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> Auto-scheduler — {queue.name}</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setAutoResult(null)}>Dismiss</Button>
          </CardHeader>
          <CardContent>
            {autoResult.totalAdded === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Current roster already covers every forecasted interval for {queue.name} — no hires recommended.
              </p>
            ) : (
              <>
                <p className="mb-3 text-sm text-muted-foreground">
                  Recommends <b className="text-foreground">{autoResult.totalAdded} new agent{autoResult.totalAdded > 1 ? "s" : ""}</b> using existing shift patterns to close every forecasted gap:
                </p>
                <div className="mb-3 flex flex-wrap gap-2">
                  {autoResult.additions.map((a) => (
                    <Badge key={a.patternId} variant="secondary">{a.count}× {a.patternName} ({a.shift})</Badge>
                  ))}
                </div>
                <div className="mb-3 flex items-center gap-4 text-sm">
                  <span>SL {fmtPct(autoResult.beforeSL)} → <b className="text-emerald-500">{fmtPct(autoResult.afterSL)}</b></span>
                  <span>Under-target intervals {autoResult.beforeUnder} → <b className={autoResult.afterUnder === 0 ? "text-emerald-500" : "text-amber-500"}>{autoResult.afterUnder}</b></span>
                </div>
                <PermissionGate module="scheduling">
                  <Button onClick={applyAuto}><Sparkles className="h-4 w-4" /> Apply — add {autoResult.totalAdded} agent{autoResult.totalAdded > 1 ? "s" : ""}</Button>
                </PermissionGate>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {optimMsg && (
        <div className="mb-4 rounded-lg border border-primary/40 px-4 py-2.5 text-sm text-primary">
          ✦ {optimMsg}
          <span className="text-muted-foreground"> Break markers below and the interval SL panel reflect the new placements.</span>
        </div>
      )}

      {importMsg && (
        <div className={`mb-4 rounded-lg border px-4 py-2.5 text-sm ${importMsg.ok ? "border-emerald-500/40 text-emerald-500" : "border-destructive/40 text-destructive"}`}>
          {importMsg.ok ? "✓ " : "✕ "}
          {importMsg.text}
          {importMsg.ok && <span className="text-muted-foreground"> Coverage & plans updated across the app.</span>}
        </div>
      )}

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <AiSummary insight={insight} title="AI Scheduling Summary" />
        <Card className="glass lg:col-span-2">
          <CardHeader>
            <CardTitle>Legend</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-2"><i className="h-3 w-4 rounded" style={{ background: queue.color }} /> on queue ({queue.name})</span>
            <span className="flex items-center gap-2"><i className="h-3 w-4 rounded bg-slate-500" /> on shift, other skill</span>
            <span className="flex items-center gap-2"><i className="h-3 w-4 rounded" style={{ background: AUX_BY_CODE.AUX2.color }} /> lunch</span>
            <span className="flex items-center gap-2"><i className="h-3 w-4 rounded" style={{ background: AUX_BY_CODE.AUX1.color }} /> break</span>
            <span className="ml-auto text-xs">Break/lunch layout comes from each agent's <Link to="/shift-patterns" className="text-primary hover:underline">shift pattern</Link>.</span>
          </CardContent>
        </Card>
      </div>

      <Card className="glass">
        <CardHeader>
          <CardTitle>Daily shift plan</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto">
            <table className="w-full min-w-[900px] border-collapse text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="sticky left-0 bg-card px-2 py-1 text-left">Agent</th>
                  <th className="px-2 py-1 text-left">Shift</th>
                  {INTERVALS.map((iv, i) => (
                    <th key={i} className="px-0.5 py-1 text-[9px] font-normal">{i % 2 === 0 ? iv.label.slice(0, 5) : ""}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => {
                  const cov = coveredIdx(a.shift)
                  const skilled = a.skills.includes(queue.id)
                  const markers = agentBreakMarkers(a, shiftPatterns, breakOverrides)
                  return (
                    <tr key={a.id} className="hover:bg-muted/30">
                      <td className="sticky left-0 bg-card px-2 py-1 font-medium">{a.name}</td>
                      <td className="px-2 py-1 tabular-nums text-muted-foreground">{a.shift}</td>
                      {INTERVALS.map((_, i) => {
                        let bg = "transparent"
                        if (cov[i]) {
                          const mk = markers.get(i)
                          if (mk === "lunch") bg = AUX_BY_CODE.AUX2.color
                          else if (mk === "break") bg = AUX_BY_CODE.AUX1.color
                          else bg = skilled ? queue.color : "#64748b"
                        }
                        return (
                          <td key={i} className="p-[1px]">
                            <div className="h-4 rounded-sm" style={{ background: bg }} />
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td className="sticky left-0 bg-card px-2 py-1">Scheduled</td>
                  <td />
                  {plan.map((p, i) => (
                    <td key={i} className="px-0.5 text-center tabular-nums">{p.scheduled}</td>
                  ))}
                </tr>
                <tr className="font-semibold">
                  <td className="sticky left-0 bg-card px-2 py-1">On duty</td>
                  <td />
                  {onDuty.map((c, i) => (
                    <td key={i} className={`px-0.5 text-center tabular-nums ${c < plan[i].requiredGross ? "text-amber-500" : "text-muted-foreground"}`}>
                      {c}
                    </td>
                  ))}
                </tr>
                <tr className="font-semibold">
                  <td className="sticky left-0 bg-card px-2 py-1">Required</td>
                  <td />
                  {plan.map((p, i) => (
                    <td key={i} className={`px-0.5 text-center tabular-nums ${p.variance < 0 ? "text-destructive" : "text-emerald-500"}`}>
                      {p.requiredGross}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="glass mt-4">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Interval detail — volume & service level ({queue.name})</CardTitle>
          <Badge variant="secondary">breaks {optimised ? "optimised" : "from patterns"}</Badge>
        </CardHeader>
        <CardContent>
          <SeriesChart
            data={intervalDetail}
            xKey="label"
            series={[
              { key: "Volume", name: "Volume (contacts)", color: queue.color, type: "bar" },
              { key: "Proj SL %", name: "Projected SL (%)", color: "#22c55e" },
            ]}
          />
          <div className="mt-4 overflow-auto">
            <table className="w-full min-w-[900px] text-xs">
              <tbody>
                <tr className="border-b text-muted-foreground">
                  <td className="sticky left-0 bg-card px-2 py-1 font-semibold uppercase">Interval</td>
                  {intervalDetail.map((d) => (
                    <td key={d.label} className="px-1 py-1 text-center tabular-nums">{d.label}</td>
                  ))}
                </tr>
                <tr className="border-b">
                  <td className="sticky left-0 bg-card px-2 py-1 font-semibold">Volume</td>
                  {intervalDetail.map((d) => (
                    <td key={d.label} className="px-1 py-1 text-center tabular-nums">{d.Volume}</td>
                  ))}
                </tr>
                <tr className="border-b">
                  <td className="sticky left-0 bg-card px-2 py-1 font-semibold">On duty</td>
                  {intervalDetail.map((d) => (
                    <td key={d.label} className="px-1 py-1 text-center tabular-nums text-muted-foreground">{d["On duty"]}</td>
                  ))}
                </tr>
                <tr>
                  <td className="sticky left-0 bg-card px-2 py-1 font-semibold">Proj SL</td>
                  {intervalDetail.map((d) => (
                    <td
                      key={d.label}
                      className={cn(
                        "px-1 py-1 text-center font-semibold tabular-nums",
                        d["Proj SL %"] >= queue.slTarget * 100 ? "text-emerald-500" : "text-destructive",
                      )}
                    >
                      {d["Proj SL %"].toFixed(0)}%
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            On duty = agents on shift minus those on break/lunch. SL is Erlang C per interval at {fmtPct(queue.slTarget)}/{queue.targetTime}s target with {Math.round(shrinkage * 100)}% shrinkage.
          </p>
        </CardContent>
      </Card>
    </>
  )
}
