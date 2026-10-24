import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle, CalendarClock, CheckCircle2, FileDown, RotateCcw, Scale, Send, Sparkles, Upload, Users, Wand2,
} from "lucide-react"
import { Link, useSearchParams } from "react-router-dom"

import { AiSummary } from "@/components/ai-summary"
import { SeriesChart } from "@/components/charts/series-chart"
import { ContinuousSchedule } from "@/components/continuous-schedule"
import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { MySchedule } from "@/components/my-schedule"
import { PageHeader } from "@/components/page-header"
import { ScheduleDateBar } from "@/components/schedule-date-bar"
import { ScheduleOverview } from "@/components/schedule-overview"
import { ScheduleRequestCard } from "@/components/schedule-request-card"
import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { computeAbsenceRisk } from "@/lib/domain/absenceRisk"
import { breakAwareCoverage, optimiseBreaks, projectedSLRow } from "@/lib/domain/breaks"
import { activityCoverageLoss, overtimeAgents } from "@/lib/domain/channels"
import { planAutoSchedule, type AutoScheduleResult } from "@/lib/domain/autoschedule"
import { occupancy } from "@/lib/domain/erlang"
import { buildPlan, fmtPct, summarisePlan } from "@/lib/domain/planning"
import { fmtDayLong, isISODate, localISODate } from "@/lib/domain/horizon"
import { downloadTemplate, parseScheduleFile } from "@/lib/schedule"
import { switchScheduleDate, useScheduleSync } from "@/lib/scheduleSync"
import { cn } from "@/lib/utils"
import { useAuth } from "@/store/auth"
import { useWfm } from "@/store/wfm"

/** Contracted hours in the operating day — used to turn agent-hours into FTE. */
const HOURS_PER_FTE = 8

type MetricKey = "Forecast" | "AHT" | "Occupancy %" | "SL %" | "Required HC" | "Actual HC" | "O/U"

/** Interval metrics the user can plot. Percentages go on the right axis so they stay readable next to counts. */
const METRICS: { key: MetricKey; label: string; color: string; type?: "bar"; axis?: "right"; dashed?: boolean }[] = [
  { key: "Forecast", label: "Forecast (contacts)", color: "#3b82f6", type: "bar" },
  { key: "AHT", label: "AHT (s)", color: "#a855f7" },
  { key: "Occupancy %", label: "Occupancy %", color: "#06b6d4", axis: "right" },
  { key: "SL %", label: "SL %", color: "#22c55e", axis: "right" },
  { key: "Required HC", label: "Required HC", color: "#f59e0b", type: "bar" },
  { key: "Actual HC", label: "Actual HC", color: "#6366f1" },
  { key: "O/U", label: "O/U", color: "#ef4444", dashed: true },
]

/** Occupancy of on-duty heads net of shrinkage; nobody available with work waiting counts as 100%. */
function occupancyOnDuty(heads: number, intensity: number, shrinkage: number): number {
  const net = Math.round(heads * (1 - shrinkage))
  if (net <= 0) return intensity > 0 ? 1 : 0
  return occupancy(net, intensity)
}

export function Scheduling() {
  const { queueId, forecasts, shrinkage, agents: roster, setAgents, shiftPatterns, queues, breakOverrides, applyBreakOverrides, resetBreakOverrides, applyAutoSchedule, currentRole, currentAgentId, overtimePlan, activityPlan, scheduleDate } = useWfm()
  const canEditSchedule = useWfm((s) => s.can("scheduling", "edit"))
  const user = useAuth((s) => s.user)
  const canPublish = !!user && (user.is_superuser || user.permission_codes.includes("schedule:publish"))
  const queue = queues.find((q) => q.id === queueId)!

  // The page shows one day at a time within the next 3 months: ?date= (from a
  // schedule notification) opens that day; leaving the page returns to today,
  // which every other page shows.
  const [params, setParams] = useSearchParams()
  const linkedDate = params.get("date")
  useEffect(() => {
    if (!isISODate(linkedDate)) return
    void switchScheduleDate(linkedDate)
    setParams((p) => {
      p.delete("date")
      return p
    }, { replace: true })
  }, [linkedDate, setParams])
  useEffect(() => () => void switchScheduleDate(localISODate()), [])
  const timelineRef = useRef<HTMLDivElement>(null)
  const openDate = (d: string) => {
    void switchScheduleDate(d)
    timelineRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  // View-only users (team leaders, agents) only see what's been published:
  // once the server has answered, unpublished agents drop off their roster.
  const { canWrite: syncCanWrite, serverAgents } = useScheduleSync()
  const publishedOnly = !syncCanWrite && serverAgents !== null
  const agents = useMemo(
    () => (publishedOnly ? roster.filter((a) => serverAgents![a.id]?.published) : roster),
    [roster, publishedOnly, serverAgents],
  )
  // Agents only ever see their own row — everyone else sees the full roster.
  const visibleAgents = currentRole === "Agent" ? agents.filter((a) => a.id === currentAgentId) : agents
  // Roster plus every OT block as an extra head, so overtime counts toward coverage & SL.
  const staffed = useMemo(() => [...agents, ...overtimeAgents(agents, overtimePlan)], [agents, overtimePlan])
  const plan = useMemo(() => buildPlan(forecasts[queue.id], queue.aht, queue, shrinkage, staffed), [forecasts, queue, shrinkage, staffed])
  const sum = useMemo(() => summarisePlan(plan), [plan])

  // Break- and activity-aware view: heads actually on the phones (not on
  // break/lunch, not in a meeting / training / LOA / absence) + Erlang SL per interval.
  const onDuty = useMemo(() => {
    const base = breakAwareCoverage(queue.id, staffed, shiftPatterns, breakOverrides)
    const lost = activityCoverageLoss(queue.id, agents, shiftPatterns, breakOverrides, activityPlan)
    return base.map((c, i) => Math.max(0, c - lost[i]))
  }, [queue.id, staffed, agents, shiftPatterns, breakOverrides, activityPlan])
  const slRow = useMemo(
    () => projectedSLRow(forecasts[queue.id] ?? [], onDuty, queue, shrinkage),
    [forecasts, queue, onDuty, shrinkage],
  )
  const intervalDetail = useMemo(
    () =>
      plan.map((p, i) => ({
        label: p.label,
        "Required FTE": p.requiredGross,
        "Actual FTE": p.scheduled,
        "Over/Under": p.variance,
        Forecast: p.volume,
        AHT: queue.aht,
        // Occupancy of the heads actually on the phones (after breaks & shrinkage).
        "Occupancy %": +(occupancyOnDuty(onDuty[i], p.intensity, shrinkage) * 100).toFixed(1),
        "SL %": +(slRow[i] * 100).toFixed(1),
        "Required HC": p.requiredGross,
        "Actual HC": p.scheduled,
        "O/U": p.variance,
      })),
    [plan, onDuty, slRow, queue.aht, shrinkage],
  )
  const [chartMetrics, setChartMetrics] = useState<MetricKey[]>(["Forecast", "SL %"])
  const toggleMetric = (k: MetricKey) =>
    setChartMetrics((cur) => (cur.includes(k) ? cur.filter((m) => m !== k) : [...cur, k]))
  const requiredFte = sum.reqHours / HOURS_PER_FTE
  const actualFte = sum.schedHours / HOURS_PER_FTE
  const overUnderFte = actualFte - requiredFte
  const optimised = Object.keys(breakOverrides).length > 0

  // AI absence/no-show risk — flags agents statistically likely to be absent
  // or late for today's shift, from a synthetic-but-deterministic attendance
  // ledger (see lib/domain/absenceRisk.ts), so buffer can be built in before
  // it happens rather than reacting on the day.
  const absenceRisk = useMemo(() => computeAbsenceRisk(visibleAgents), [visibleAgents])
  const absenceRiskById = useMemo(
    () => new Map(absenceRisk.map((r) => [r.agentId, r])),
    [absenceRisk],
  )
  const flaggedAgents = absenceRisk.filter((r) => r.level !== "low")

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
        subtitle={`${fmtDayLong(scheduleDate)} · ${agents.length} agents · 07:00–19:00`}
        actions={
          <>
            <Badge variant="secondary" className="hidden lg:inline-flex">skilled for {queue.name}</Badge>
            <PermissionGate module="approvals">
              <Button asChild variant="outline">
                <Link to="/approvals?source=scheduling&raise=1">
                  <Send className="h-4 w-4" /> Request OM sign-off
                </Link>
              </Button>
            </PermissionGate>
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
                { name: "Coverage", rows: intervalDetail.map((d) => ({ Interval: d.label, Forecast: d.Forecast, "AHT (s)": d.AHT, "Occupancy %": d["Occupancy %"], "SL %": d["SL %"], "Required HC": d["Required HC"], "Actual HC": d["Actual HC"], "O/U": d["O/U"] })) },
              ]}
            />
          </>
        }
      />

      <ScheduleDateBar canPublish={canPublish} />
      {currentRole === "Agent" ? (
        <MySchedule agentId={currentAgentId} onOpenDate={openDate} />
      ) : (
        <ScheduleOverview agents={agents} onOpenDate={openDate} />
      )}

      <ScheduleRequestCard source="scheduling" />

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          label="Required FTE"
          value={requiredFte.toFixed(1)}
          hint={`${sum.reqHours.toFixed(0)} agent-hrs ÷ ${HOURS_PER_FTE}h (incl. shrinkage)`}
          icon={Users}
        />
        <KpiCard
          label="Actual FTE"
          value={actualFte.toFixed(1)}
          hint={`${sum.schedHours.toFixed(0)} scheduled agent-hrs · skilled for ${queue.name}`}
          icon={Users}
          tone={overUnderFte >= 0 ? "good" : "warn"}
        />
        <KpiCard
          label="Over/Under"
          value={`${overUnderFte >= 0 ? "+" : ""}${overUnderFte.toFixed(1)}`}
          hint={overUnderFte >= 0 ? "Actual − Required · surplus" : `${sum.underIntervals} interval(s) short`}
          icon={Scale}
          tone={overUnderFte >= 0 ? "good" : overUnderFte > -1 ? "warn" : "bad"}
        />
      </div>

      <Card className="glass mb-4">
        <CardHeader>
          <CardTitle>FTE — required vs actual ({queue.name})</CardTitle>
        </CardHeader>
        <CardContent>
          <SeriesChart
            data={intervalDetail}
            xKey="label"
            yLabel="FTE"
            series={[
              { key: "Required FTE", name: "Required FTE", color: "#f59e0b", type: "bar" },
              { key: "Actual FTE", name: "Actual FTE", color: queue.color },
              { key: "Over/Under", name: "Over/Under", color: overUnderFte >= 0 ? "#22c55e" : "#ef4444", dashed: true },
            ]}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Interval FTE is heads on the phones (30-min slots). Day FTE above is agent-hours ÷ {HOURS_PER_FTE} contracted hours.
            Over/Under = Actual − Required.
          </p>
        </CardContent>
      </Card>

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

      <div className="mb-4">
        <AiSummary insight={insight} title="AI Scheduling Summary" />
      </div>

      <Card className="glass mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-primary" /> AI Absence Risk
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Flags agents statistically likely to be absent or late for today's shift, from each
            agent's own attendance pattern — build in buffer before it happens, not after.
          </p>
        </CardHeader>
        <CardContent>
          {flaggedAgents.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" /> No agents flagged for today — everyone's recent attendance is clean.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {flaggedAgents.map((r) => (
                <div key={r.agentId} className={cn(
                  "rounded-lg border p-2.5",
                  r.level === "high" ? "border-destructive/50" : "border-amber-500/40",
                )}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{r.name}</span>
                    <Badge variant={r.level === "high" ? "destructive" : "warning"}>{r.riskPct}% risk</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{r.reason}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="glass scroll-mt-20" ref={timelineRef}>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Daily shift plan — {fmtDayLong(scheduleDate)}</CardTitle>
          <span className="text-xs text-muted-foreground">
            Break/lunch layout comes from each agent's <Link to="/shift-patterns" className="text-primary hover:underline">shift pattern</Link>.
          </span>
        </CardHeader>
        <CardContent>
          {publishedOnly && visibleAgents.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              {currentRole === "Agent" ? "Your schedule" : "The schedules"} for {fmtDayLong(scheduleDate)} {currentRole === "Agent" ? "hasn't" : "haven't"} been published yet.
            </p>
          ) : (
            <ContinuousSchedule
              agents={visibleAgents}
              queue={queue}
              plan={plan}
              onDuty={onDuty}
              canEdit={canEditSchedule}
              riskById={absenceRiskById}
            />
          )}
        </CardContent>
      </Card>

      <Card className="glass mt-4">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Interval detail — all metrics ({queue.name})</CardTitle>
          <Badge variant="secondary">breaks {optimised ? "optimised" : "from patterns"}</Badge>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Show on graph:</span>
            {METRICS.map((m) => {
              const on = chartMetrics.includes(m.key)
              const color = m.key === "Forecast" ? queue.color : m.color
              return (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => toggleMetric(m.key)}
                  aria-pressed={on}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                    on ? "border-primary/60 bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted/40",
                  )}
                >
                  <i className="h-2 w-2 rounded-full" style={{ background: on ? color : "hsl(var(--muted-foreground))" }} />
                  {m.label}
                </button>
              )
            })}
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setChartMetrics(METRICS.map((m) => m.key))}>All</Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setChartMetrics([])}>None</Button>
          </div>
          {chartMetrics.length ? (
            <SeriesChart
              data={intervalDetail}
              xKey="label"
              yRightLabel="%"
              series={METRICS.filter((m) => chartMetrics.includes(m.key)).map((m) => ({
                key: m.key,
                name: m.label,
                color: m.key === "Forecast" ? queue.color : m.color,
                type: m.type,
                axis: m.axis,
                dashed: m.dashed,
              }))}
            />
          ) : (
            <div className="flex h-[260px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              Select one or more metrics above to plot them.
            </div>
          )}
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
                  <td className="sticky left-0 bg-card px-2 py-1 font-semibold">Forecast</td>
                  {intervalDetail.map((d) => (
                    <td key={d.label} className="px-1 py-1 text-center tabular-nums">{d.Forecast}</td>
                  ))}
                </tr>
                <tr className="border-b">
                  <td className="sticky left-0 bg-card px-2 py-1 font-semibold">AHT</td>
                  {intervalDetail.map((d) => (
                    <td key={d.label} className="px-1 py-1 text-center tabular-nums text-muted-foreground">{d.AHT}s</td>
                  ))}
                </tr>
                <tr className="border-b">
                  <td className="sticky left-0 bg-card px-2 py-1 font-semibold">Occupancy</td>
                  {intervalDetail.map((d) => (
                    <td
                      key={d.label}
                      className={cn("px-1 py-1 text-center tabular-nums", d["Occupancy %"] > 95 ? "text-destructive" : d["Occupancy %"] > 85 ? "text-amber-500" : "")}
                    >
                      {d["Occupancy %"].toFixed(0)}%
                    </td>
                  ))}
                </tr>
                <tr className="border-b">
                  <td className="sticky left-0 bg-card px-2 py-1 font-semibold">SL %</td>
                  {intervalDetail.map((d) => (
                    <td
                      key={d.label}
                      className={cn(
                        "px-1 py-1 text-center font-semibold tabular-nums",
                        d["SL %"] >= queue.slTarget * 100 ? "text-emerald-500" : "text-destructive",
                      )}
                    >
                      {d["SL %"].toFixed(0)}%
                    </td>
                  ))}
                </tr>
                <tr className="border-b">
                  <td className="sticky left-0 bg-card px-2 py-1 font-semibold">Required HC</td>
                  {intervalDetail.map((d) => (
                    <td key={d.label} className="px-1 py-1 text-center tabular-nums">{d["Required HC"]}</td>
                  ))}
                </tr>
                <tr className="border-b">
                  <td className="sticky left-0 bg-card px-2 py-1 font-semibold">Actual HC</td>
                  {intervalDetail.map((d) => (
                    <td key={d.label} className="px-1 py-1 text-center tabular-nums">{d["Actual HC"]}</td>
                  ))}
                </tr>
                <tr>
                  <td className="sticky left-0 bg-card px-2 py-1 font-semibold">O/U</td>
                  {intervalDetail.map((d) => (
                    <td
                      key={d.label}
                      className={cn(
                        "px-1 py-1 text-center font-semibold tabular-nums",
                        d["O/U"] < 0 ? "text-destructive" : d["O/U"] > 0 ? "text-emerald-500" : "text-muted-foreground",
                      )}
                    >
                      {d["O/U"] > 0 ? `+${d["O/U"]}` : d["O/U"]}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Required HC includes {Math.round(shrinkage * 100)}% shrinkage; Actual HC = agents scheduled & skilled for {queue.name}; O/U = Actual − Required.
            SL % and Occupancy are Erlang C on heads actually on the phones (on shift, not on break/lunch or in a meeting / training / LOA / absence, net of shrinkage) at a {fmtPct(queue.slTarget)}/{queue.targetTime}s target.
            AHT is the queue's planning AHT.
          </p>
        </CardContent>
      </Card>
    </>
  )
}
