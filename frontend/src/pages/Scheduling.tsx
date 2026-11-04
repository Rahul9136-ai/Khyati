import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle, ArrowRight, BarChart3, Bot, CalendarCheck, CalendarClock, CalendarRange, CheckCircle2, Clock, FileDown, Hand,
  Inbox, Lightbulb, RotateCcw, Scale, Send, Sparkles, Upload, Users, Wand2, type LucideIcon,
} from "lucide-react"
import { Link, useSearchParams } from "react-router-dom"

import { AiSummary } from "@/components/ai-summary"
import { SeriesChart } from "@/components/charts/series-chart"
import { ChannelAutoPlan } from "@/components/channel-auto-plan"
import { WorkRuleAlign } from "@/components/work-rule-align"
import { ContinuousSchedule } from "@/components/continuous-schedule"
import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { MySchedule } from "@/components/my-schedule"
import { PageHeader } from "@/components/page-header"
import { ScheduleDateBar } from "@/components/schedule-date-bar"
import { ScheduleOverview } from "@/components/schedule-overview"
import { ScheduleRequestCard } from "@/components/schedule-request-card"
import { AgentSlotOffers, SlotOffersManager } from "@/components/slot-offers"
import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { computeAbsenceRisk } from "@/lib/domain/absenceRisk"
import { breakAwareCoverage, optimiseBreaks } from "@/lib/domain/breaks"
import { activityCoverageLoss, overtimeAgents, toMins } from "@/lib/domain/channels"
import { intervalOutcomes, liveAgentStates, PATIENCE_SECS, soFar, type IntervalPhase } from "@/lib/domain/liveCoverage"
import { actualsFor, AUX, INTERVALS } from "@/lib/domain/seed"
import { planAutoSchedule, type AutoScheduleResult } from "@/lib/domain/autoschedule"
import { occupancy, trafficIntensity } from "@/lib/domain/erlang"
import { buildPlan, fmtPct, summarisePlan } from "@/lib/domain/planning"
import { fmtDayLong, isISODate, localISODate } from "@/lib/domain/horizon"
import { downloadTemplate, parseScheduleFile } from "@/lib/schedule"
import { switchScheduleDate, useScheduleSync } from "@/lib/scheduleSync"
import { cn } from "@/lib/utils"
import { useAuth } from "@/store/auth"
import { useWfm } from "@/store/wfm"

/** Contracted hours in the operating day — used to turn agent-hours into FTE. */
const HOURS_PER_FTE = 8

type MetricKey = "Forecast" | "Offered" | "Vol handled" | "Abandoned" | "ASA" | "AHT" | "Occupancy %" | "SL %" | "Required HC" | "Actual HC" | "O/U"

/** Interval metrics the user can plot. Percentages go on the right axis so they stay readable next to counts. */
const METRICS: { key: MetricKey; label: string; color: string; type?: "bar"; axis?: "right"; dashed?: boolean }[] = [
  { key: "Forecast", label: "Forecast (contacts)", color: "#3b82f6", type: "bar" },
  { key: "Offered", label: "Offered", color: "#64748b", dashed: true },
  { key: "Vol handled", label: "Vol handled", color: "#14b8a6" },
  { key: "Abandoned", label: "Abandoned", color: "#f43f5e", type: "bar" },
  { key: "ASA", label: "ASA (s)", color: "#eab308" },
  { key: "AHT", label: "AHT (s)", color: "#a855f7" },
  { key: "Occupancy %", label: "Occupancy %", color: "#06b6d4", axis: "right" },
  { key: "SL %", label: "SL %", color: "#22c55e", axis: "right" },
  { key: "Required HC", label: "Required HC", color: "#f59e0b", type: "bar" },
  { key: "Actual HC", label: "Actual HC", color: "#6366f1" },
  { key: "O/U", label: "O/U", color: "#ef4444", dashed: true },
]

type TabId = "day" | "mine" | "calendar" | "coverage" | "slots" | "automation" | "insights" | "requests"

/** Sub-tabs of the Scheduling page (?tab=), first = default. Agents get their own set. */
const STAFF_TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "day", label: "Daily plan", icon: Clock },
  { id: "calendar", label: "Multi-week", icon: CalendarRange },
  { id: "coverage", label: "Coverage & SL", icon: BarChart3 },
  { id: "slots", label: "Open slots", icon: Hand },
  { id: "automation", label: "Automation", icon: Bot },
  { id: "insights", label: "Insights", icon: Lightbulb },
  { id: "requests", label: "Requests", icon: Inbox },
]
const AGENT_TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "mine", label: "My schedule", icon: CalendarCheck },
  { id: "day", label: "Day view", icon: Clock },
  { id: "slots", label: "Open slots", icon: Hand },
  { id: "requests", label: "Requests", icon: Inbox },
]

/** Occupancy of the heads answering; nobody on with work waiting counts as 100%. */
function occupancyOf(heads: number, intensity: number): number {
  if (heads <= 0) return intensity > 0 ? 1 : 0
  return occupancy(heads, intensity)
}

const fmtSecs = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`)

export function Scheduling() {
  const { queueId, forecasts, shrinkage, agents: roster, setAgents, shiftPatterns, queues, breakOverrides, applyBreakOverrides, resetBreakOverrides, applyAutoSchedule, currentRole, currentAgentId, overtimePlan, activityPlan, scheduleDate, rta, nowIdx } = useWfm()
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
      p.set("tab", "day")
      return p
    }, { replace: true })
  }, [linkedDate, setParams])
  useEffect(() => () => void switchScheduleDate(localISODate()), [])
  const timelineRef = useRef<HTMLDivElement>(null)

  // View-only users (team leaders, agents) only see what's been published:
  // once the server has answered, unpublished agents drop off their roster.
  const { canWrite: syncCanWrite, serverAgents } = useScheduleSync()
  const publishedOnly = !syncCanWrite && serverAgents !== null
  const agents = useMemo(
    () => (publishedOnly ? roster.filter((a) => serverAgents![a.id]?.published) : roster),
    [roster, publishedOnly, serverAgents],
  )
  // Agents only ever see their own row — everyone else sees the full roster.
  const isAgent = currentRole === "Agent"
  const tabs = isAgent ? AGENT_TABS : STAFF_TABS.filter((t) => t.id !== "automation" || canEditSchedule)
  const tabParam = params.get("tab")
  const tab = tabs.find((t) => t.id === tabParam)?.id ?? tabs[0].id
  const setTab = (t: TabId) =>
    setParams((p) => {
      p.set("tab", t)
      return p
    }, { replace: true })
  // Opening a day from the multi-week views shows it on the timeline.
  const openDate = (d: string) => {
    void switchScheduleDate(d)
    setTab("day")
    requestAnimationFrame(() => timelineRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }))
  }
  const visibleAgents = isAgent ? agents.filter((a) => a.id === currentAgentId) : agents
  // Roster plus every OT block as an extra head, so overtime counts toward coverage & SL.
  const staffed = useMemo(() => [...agents, ...overtimeAgents(agents, overtimePlan)], [agents, overtimePlan])
  const plan = useMemo(() => buildPlan(forecasts[queue.id], queue.aht, queue, shrinkage, staffed), [forecasts, queue, shrinkage, staffed])
  const sum = useMemo(() => summarisePlan(plan), [plan])

  // Break- and activity-aware view: heads actually on the phones (not on
  // break/lunch, not in a meeting / training / LOA / absence) + Erlang SL per interval.
  const lost = useMemo(
    () => activityCoverageLoss(queue.id, agents, shiftPatterns, breakOverrides, activityPlan),
    [queue.id, agents, shiftPatterns, breakOverrides, activityPlan],
  )
  const onDuty = useMemo(() => {
    const base = breakAwareCoverage(queue.id, staffed, shiftPatterns, breakOverrides)
    return base.map((c, i) => Math.max(0, c - lost[i]))
  }, [queue.id, staffed, shiftPatterns, breakOverrides, lost])
  // Real-time coverage: today's intervals so far run on the actual volume, the
  // current one on the agents on queue right now (the Real-Time Monitor's live
  // states), the rest on the forecast and schedule. Other days are all projected.
  const isToday = scheduleDate === localISODate()
  const liveStates = useMemo(() => liveAgentStates(rta, agents, queue.id), [rta, agents, queue.id])
  const liveHeads = liveStates.filter((s) => s.onQueue).length
  const outcomes = useMemo(
    () => intervalOutcomes({
      queue, forecast: forecasts[queue.id] ?? [], actuals: actualsFor(queue.id, nowIdx), onDuty, shrinkage,
      nowIdx: isToday ? nowIdx : null, liveHeads,
    }),
    [queue, forecasts, nowIdx, onDuty, shrinkage, isToday, liveHeads],
  )
  const totals = useMemo(() => soFar(outcomes), [outcomes])
  const intervalDetail = useMemo(
    () =>
      plan.map((p, i) => {
        const o = outcomes[i]
        return {
          label: p.label,
          phase: o?.phase ?? ("projected" as IntervalPhase),
          "Required FTE": p.requiredGross,
          "Actual FTE": p.scheduled,
          "Over/Under": p.variance,
          Forecast: p.volume,
          Offered: o?.offered ?? p.volume,
          "Vol handled": o?.handled ?? 0,
          Abandoned: o?.abandoned ?? 0,
          "Abandon %": +((o?.abandonRate ?? 0) * 100).toFixed(1),
          ASA: Math.round(o?.asa ?? 0),
          "On-queue HC": o?.heads ?? 0,
          AHT: queue.aht,
          // Occupancy of the heads answering, on the contacts they handle.
          "Occupancy %": +(occupancyOf(o?.heads ?? 0, trafficIntensity(o?.handled ?? 0, queue.aht)) * 100).toFixed(1),
          "SL %": +((o?.sl ?? 0) * 100).toFixed(1),
          "Required HC": p.requiredGross,
          "Actual HC": p.scheduled,
          "O/U": p.variance,
        }
      }),
    [plan, outcomes, queue.aht],
  )
  const liveRow = intervalDetail.find((d) => d.phase === "live")
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

  // One card, shown under Insights for planners and under the day view for agents.
  const absenceCard = (
    <Card className="glass">
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
  )

  const tabCount: Partial<Record<TabId, number>> = { insights: flaggedAgents.length, coverage: sum.underIntervals }

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
            <Button variant="outline" asChild>
              <Link to="/shift-patterns"><CalendarClock className="h-4 w-4" /> Shift patterns</Link>
            </Button>
            <ExportButton
              filename={`schedule-${queue.id}`}
              sheets={() => [
                { name: "Roster", rows: agents.map((a) => ({ Name: a.name, Team: a.team, "Team Lead": a.tl, Shift: a.shift, Skills: a.skills.map((s) => queues.find((q) => q.id === s)?.name ?? s).join(", ") })) },
                { name: "Coverage", rows: intervalDetail.map((d) => ({ Interval: d.label, Basis: d.phase, Forecast: d.Forecast, Offered: d.Offered, "Vol handled": d["Vol handled"], Abandoned: d.Abandoned, "Abandon %": d["Abandon %"], "ASA (s)": d.ASA, "AHT (s)": d.AHT, "On-queue HC": d["On-queue HC"], "Occupancy %": d["Occupancy %"], "SL %": d["SL %"], "Required HC": d["Required HC"], "Actual HC": d["Actual HC"], "O/U": d["O/U"] })) },
              ]}
            />
          </>
        }
      />

      <ScheduleDateBar canPublish={canPublish} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList className="w-full flex-nowrap justify-start overflow-x-auto border bg-muted/50 p-1">
          {tabs.map((t) => {
            const count = tabCount[t.id]
            return (
              <TabsTrigger key={t.id} value={t.id}>
                <t.icon className="mr-1.5 h-4 w-4" />
                {t.label}
                {!!count && (
                  <span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 text-[11px] font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                    {count}
                  </span>
                )}
              </TabsTrigger>
            )
          })}
        </TabsList>

        {/* ------------------------------------------------ the selected day */}
        <TabsContent value="day" className="space-y-4">
          {!isAgent && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Required FTE" value={requiredFte.toFixed(1)} hint="incl. shrinkage" />
              <Stat label="Actual FTE" value={actualFte.toFixed(1)} hint={`skilled for ${queue.name}`} tone={overUnderFte >= 0 ? "good" : "warn"} />
              <Stat label="Over / Under" value={`${overUnderFte >= 0 ? "+" : ""}${overUnderFte.toFixed(1)}`} hint="actual − required" tone={overUnderFte >= 0 ? "good" : overUnderFte > -1 ? "warn" : "bad"} />
              <Stat label="Intervals short" value={sum.underIntervals} hint={`of ${plan.length} half-hours`} tone={sum.underIntervals ? "warn" : "good"} />
            </div>
          )}

          {autoResult && (
            <Card className="glass border-primary/40">
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
            <div className="rounded-lg border border-primary/40 px-4 py-2.5 text-sm text-primary">
              ✦ {optimMsg}
              <span className="text-muted-foreground"> Break markers below and the interval SL panel reflect the new placements.</span>
            </div>
          )}

          {importMsg && (
            <div className={`rounded-lg border px-4 py-2.5 text-sm ${importMsg.ok ? "border-emerald-500/40 text-emerald-500" : "border-destructive/40 text-destructive"}`}>
              {importMsg.ok ? "✓ " : "✕ "}
              {importMsg.text}
              {importMsg.ok && <span className="text-muted-foreground"> Coverage & plans updated across the app.</span>}
            </div>
          )}

          <Card className="glass scroll-mt-20" ref={timelineRef}>
            <CardHeader className="flex flex-col gap-3 space-y-0 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <CardTitle>Daily shift plan — {fmtDayLong(scheduleDate)}</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Break/lunch layout comes from each agent's <Link to="/shift-patterns" className="text-primary hover:underline">shift pattern</Link>.
                </p>
              </div>
              {!isAgent && (
                <PermissionGate module="scheduling">
                  <div className="flex flex-wrap items-center gap-2">
                    <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFile} />
                    <Button size="sm" onClick={onOptimise}>
                      <Wand2 className="h-4 w-4" /> Optimise breaks
                    </Button>
                    {optimised && (
                      <Button size="sm" variant="ghost" onClick={() => { resetBreakOverrides(); setOptimMsg("Break plan reset to shift-pattern defaults.") }}>
                        <RotateCcw className="h-4 w-4" /> Reset
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={onAutoSchedule}>
                      <Sparkles className="h-4 w-4" /> Auto-schedule
                    </Button>
                    <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
                    <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                      <Upload className="h-4 w-4" /> Import
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => downloadTemplate(agents)}>
                      <FileDown className="h-4 w-4" /> Template
                    </Button>
                  </div>
                </PermissionGate>
              )}
            </CardHeader>
            <CardContent>
              {publishedOnly && visibleAgents.length === 0 ? (
                <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                  {isAgent ? "Your schedule" : "The schedules"} for {fmtDayLong(scheduleDate)} {isAgent ? "hasn't" : "haven't"} been published yet.
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

          {isAgent && absenceCard}
        </TabsContent>

        {/* ------------------------------------------------ agents' own weeks */}
        <TabsContent value="mine">
          <MySchedule agentId={currentAgentId} onOpenDate={openDate} />
        </TabsContent>

        {/* ------------------------------------------------ every agent, many weeks */}
        <TabsContent value="calendar">
          <ScheduleOverview agents={agents} onOpenDate={openDate} />
        </TabsContent>

        {/* ------------------------------------------------ staffing analytics */}
        <TabsContent value="coverage" className="space-y-4">
          <Card className="glass overflow-hidden">
            <CardHeader className="flex flex-col gap-2 space-y-0 pb-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="flex items-center gap-2">
                {isToday ? (
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  </span>
                ) : (
                  <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/50" />
                )}
                {isToday && liveRow ? `Live now · ${liveRow.label} interval` : "Projected day"} — {queue.name}
              </CardTitle>
              <Link to="/rta" className="flex items-center gap-1 text-xs text-primary hover:underline">
                Real-Time Monitor <ArrowRight className="h-3 w-3" />
              </Link>
            </CardHeader>
            <CardContent className="space-y-4">
              {isToday && liveRow ? (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    <Stat label="Offered" value={liveRow.Offered} hint={`forecast ${liveRow.Forecast}`} />
                    <Stat label="Vol handled" value={liveRow["Vol handled"]} hint={`${totals.handled.toLocaleString()} so far today`} tone="good" />
                    <Stat
                      label="Abandoned"
                      value={liveRow.Abandoned}
                      hint={`${liveRow["Abandon %"]}% · ${totals.abandoned.toLocaleString()} today (${(totals.abandonRate * 100).toFixed(1)}%)`}
                      tone={liveRow["Abandon %"] > 5 ? "bad" : liveRow["Abandon %"] > 2 ? "warn" : "good"}
                    />
                    <Stat label="ASA" value={fmtSecs(liveRow.ASA)} hint={`${fmtSecs(totals.asa)} so far today`} tone={liveRow.ASA <= queue.targetTime ? "good" : liveRow.ASA <= queue.targetTime * 3 ? "warn" : "bad"} />
                    <Stat label="SL" value={`${liveRow["SL %"].toFixed(0)}%`} hint={`target ${fmtPct(queue.slTarget)} in ${queue.targetTime}s`} tone={liveRow["SL %"] >= queue.slTarget * 100 ? "good" : "bad"} />
                    <Stat
                      label="On queue now"
                      value={`${liveHeads}`}
                      hint={`need ${plan[nowIdx]?.requiredNet ?? 0} · plan ${Math.round((onDuty[nowIdx] ?? 0) * (1 - shrinkage))} net · ${liveStates.length} skilled`}
                      tone={liveHeads >= (plan[nowIdx]?.requiredNet ?? 0) ? "good" : "warn"}
                    />
                  </div>
                  <div>
                    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-semibold uppercase tracking-wide">Live agent states</span>
                      {AUX.map((a) => {
                        const n = liveStates.filter((s) => s.aux?.code === a.code).length
                        return n ? (
                          <span key={a.code} className="flex items-center gap-1.5">
                            <i className="h-2 w-2 rounded-full" style={{ background: a.color }} /> {a.label} <b className="tabular-nums text-foreground">{n}</b>
                          </span>
                        ) : null
                      })}
                    </div>
                    <div className="flex flex-wrap gap-1.5" aria-label="Live agent states">
                      {liveStates.map((s) => (
                        <span
                          key={s.agent.id}
                          title={`${s.agent.name} · ${s.aux?.label ?? "No state"}${s.onQueue ? " · on queue" : ""}`}
                          className={cn("h-3.5 w-3.5 rounded-full ring-offset-2 ring-offset-card transition-colors", s.onQueue && "ring-1 ring-emerald-500/60")}
                          style={{ background: s.aux?.color ?? "hsl(var(--muted-foreground))" }}
                        />
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {fmtDayLong(scheduleDate)} isn't today, so every interval is projected from the forecast on this day's schedule.
                  Live figures from the agents' real-time states show for today.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Vol handled, Abandoned and ASA use Erlang A with {PATIENCE_SECS / 60}-minute average caller patience.
                Earlier intervals use the actual volume, the current one the agents on queue right now (Available / After-call work),
                later ones the forecast on the schedule.
              </p>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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

          <Card className="glass">
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

          <Card className="glass">
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
              <div className="mt-4 overflow-auto rounded-lg border">
                <table className="w-full min-w-[900px] text-xs">
                  <tbody>
                    <tr className="border-b bg-muted/40 text-muted-foreground">
                      <td className="sticky left-0 bg-card px-2 py-1.5 font-semibold uppercase">Interval</td>
                      {intervalDetail.map((d) => (
                        <td key={d.label} className={cn("px-1 py-1.5 text-center tabular-nums", d.phase === "live" && "bg-emerald-500/15 font-semibold text-emerald-600 dark:text-emerald-400")}>
                          {d.label}
                          {d.phase === "live" && <span className="block text-[9px] uppercase tracking-wide">● live</span>}
                        </td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="sticky left-0 bg-card px-2 py-1.5 font-semibold">Forecast</td>
                      {intervalDetail.map((d) => (
                        <td key={d.label} className="px-1 py-1.5 text-center tabular-nums">{d.Forecast}</td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="sticky left-0 bg-card px-2 py-1.5 font-semibold">Offered</td>
                      {intervalDetail.map((d) => (
                        <td key={d.label} className={cn("px-1 py-1.5 text-center tabular-nums", cellTone(d.phase))}>{d.Offered}</td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="sticky left-0 bg-card px-2 py-1.5 font-semibold">Vol handled</td>
                      {intervalDetail.map((d) => (
                        <td key={d.label} className={cn("px-1 py-1.5 text-center tabular-nums", cellTone(d.phase))}>{d["Vol handled"]}</td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="sticky left-0 bg-card px-2 py-1.5 font-semibold">Abandoned</td>
                      {intervalDetail.map((d) => (
                        <td
                          key={d.label}
                          title={`${d["Abandon %"]}% of offered`}
                          className={cn(
                            "px-1 py-1.5 text-center tabular-nums",
                            cellTone(d.phase),
                            d["Abandon %"] > 5 ? "text-destructive" : d["Abandon %"] > 2 ? "text-amber-500" : "",
                          )}
                        >
                          {d.Abandoned}
                        </td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="sticky left-0 bg-card px-2 py-1.5 font-semibold">ASA</td>
                      {intervalDetail.map((d) => (
                        <td
                          key={d.label}
                          className={cn(
                            "px-1 py-1.5 text-center tabular-nums",
                            cellTone(d.phase),
                            d.ASA > queue.targetTime * 3 ? "text-destructive" : d.ASA > queue.targetTime ? "text-amber-500" : "",
                          )}
                        >
                          {fmtSecs(d.ASA)}
                        </td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="sticky left-0 bg-card px-2 py-1.5 font-semibold">On-queue HC</td>
                      {intervalDetail.map((d) => (
                        <td key={d.label} className={cn("px-1 py-1.5 text-center tabular-nums", cellTone(d.phase))}>{d["On-queue HC"]}</td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="sticky left-0 bg-card px-2 py-1.5 font-semibold">AHT</td>
                      {intervalDetail.map((d) => (
                        <td key={d.label} className="px-1 py-1.5 text-center tabular-nums text-muted-foreground">{d.AHT}s</td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="sticky left-0 bg-card px-2 py-1.5 font-semibold">Occupancy</td>
                      {intervalDetail.map((d) => (
                        <td
                          key={d.label}
                          className={cn("px-1 py-1.5 text-center tabular-nums", cellTone(d.phase), d["Occupancy %"] > 95 ? "text-destructive" : d["Occupancy %"] > 85 ? "text-amber-500" : "")}
                        >
                          {d["Occupancy %"].toFixed(0)}%
                        </td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="sticky left-0 bg-card px-2 py-1.5 font-semibold">SL %</td>
                      {intervalDetail.map((d) => (
                        <td
                          key={d.label}
                          className={cn(
                            "px-1 py-1.5 text-center font-semibold tabular-nums",
                            cellTone(d.phase),
                            d["SL %"] >= queue.slTarget * 100 ? "text-emerald-500" : "text-destructive",
                          )}
                        >
                          {d["SL %"].toFixed(0)}%
                        </td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="sticky left-0 bg-card px-2 py-1.5 font-semibold">Required HC</td>
                      {intervalDetail.map((d) => (
                        <td key={d.label} className="px-1 py-1.5 text-center tabular-nums">{d["Required HC"]}</td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="sticky left-0 bg-card px-2 py-1.5 font-semibold">Actual HC</td>
                      {intervalDetail.map((d) => (
                        <td key={d.label} className="px-1 py-1.5 text-center tabular-nums">{d["Actual HC"]}</td>
                      ))}
                    </tr>
                    <tr>
                      <td className="sticky left-0 bg-card px-2 py-1.5 font-semibold">O/U</td>
                      {intervalDetail.map((d) => (
                        <td
                          key={d.label}
                          className={cn(
                            "px-1 py-1.5 text-center font-semibold tabular-nums",
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
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm border bg-card" /> Actual so far</span>
                <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-emerald-500/30" /> Live — agents on queue now</span>
                <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-muted" /> <span className="italic">Projected</span> from forecast & schedule</span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Offered, Vol handled, Abandoned, ASA, On-queue HC, Occupancy and SL % follow the real-time coverage (see Live now above).
                Required HC includes {Math.round(shrinkage * 100)}% shrinkage; Actual HC = agents scheduled & skilled for {queue.name}; O/U = Actual − Required.
                SL % is Erlang C on the heads answering (on shift, not on break/lunch or in a meeting / training / LOA / absence, net of shrinkage — or, live, the agents on queue) at a {fmtPct(queue.slTarget)}/{queue.targetTime}s target.
                AHT is the queue's planning AHT.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------------------------ VTO / PTO / OT / leave */}
        <TabsContent value="slots">
          {isAgent ? (
            <AgentSlotOffers
              agentId={currentAgentId}
              staffPreview={!!user && (user.is_superuser || user.permission_codes.includes("employee:read"))}
            />
          ) : (
            <SlotOffersManager
              date={scheduleDate}
              queue={queue}
              plan={plan}
              lost={lost}
              firstIntervalStart={INTERVALS.length ? toMins(INTERVALS[0].label) : 7 * 60}
              agents={agents}
              canEdit={canEditSchedule && syncCanWrite}
            />
          )}
        </TabsContent>

        {/* ------------------------------------------------ bulk re-planning */}
        <TabsContent value="automation" className="space-y-4">
          <WorkRuleAlign canPublish={canPublish} />
          {syncCanWrite ? (
            <ChannelAutoPlan canPublish={canPublish} />
          ) : (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Auto-planning channels for future weeks needs the server connection.
            </p>
          )}
        </TabsContent>

        <TabsContent value="insights" className="space-y-4">
          <AiSummary insight={insight} title="AI Scheduling Summary" />
          {absenceCard}
        </TabsContent>

        <TabsContent value="requests">
          <ScheduleRequestCard source="scheduling" />
        </TabsContent>
      </Tabs>
    </>
  )
}

/** Interval-detail cells: live column highlighted, projected ones muted. */
function cellTone(phase: IntervalPhase): string {
  return phase === "live" ? "bg-emerald-500/10 font-semibold" : phase === "projected" ? "italic text-muted-foreground" : ""
}

/** A compact figure for the day view's summary strip. */
function Stat({ label, value, hint, tone = "neutral" }: { label: string; value: React.ReactNode; hint?: string; tone?: "good" | "warn" | "bad" | "neutral" }) {
  return (
    <div className="glass rounded-xl border px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn(
        "mt-0.5 text-2xl font-bold tabular-nums",
        tone === "good" && "text-emerald-500",
        tone === "warn" && "text-amber-500",
        tone === "bad" && "text-destructive",
      )}>
        {value}
      </div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}
