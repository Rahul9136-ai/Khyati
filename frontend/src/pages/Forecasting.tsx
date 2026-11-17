import { useEffect, useMemo, useRef, useState } from "react"
import { Bot, CalendarRange, Copy, Database, FileDown, Loader2, Radio, Send, Target, Upload, X } from "lucide-react"

import { AiSummary } from "@/components/ai-summary"
import { SeriesChart } from "@/components/charts/series-chart"
import { ExportButton } from "@/components/export-button"
import { ExternalFactorsPanel } from "@/components/external-factors-panel"
import { ForecastAccuracy } from "@/components/forecast-accuracy"
import { ForecastDriversPanel } from "@/components/forecast-drivers-panel"
import { PageHeader } from "@/components/page-header"
import { LockedHint, PermissionGate } from "@/components/permission-gate"
import { RampPlanner } from "@/components/ramp-planner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { parseActualsFile, downloadActualsTemplate } from "@/lib/actuals"
import { api } from "@/lib/api"
import { addDays, fmtDay, MAX_RANGE_DAYS, parseYMD, TODAY, ymd } from "@/lib/domain/dates"
import { appliesTo } from "@/lib/domain/drivers"
import { generate, methodById } from "@/lib/domain/forecast"
import {
  adjustedBacktest, backtestG, backtestGAsync, backtestWindowFor, cachedBacktest, HOURS_PER_FTE_DAY, rangePlan, summariseBuckets,
} from "@/lib/domain/granularity"
import { daysAppendedBeyondBase, historyFor } from "@/lib/domain/history"
import { fmtPct } from "@/lib/domain/planning"
import {
  buildPublished, downloadPublishedCsv, downloadPublishedJson, FORECAST_TARGETS, fmtTarget, publishFingerprint,
  targetById, type TargetId,
} from "@/lib/domain/publishedForecast"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

const dateCls =
  "flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
/** Targets that have a meaningful "before drivers & events" baseline to compare against. */
const HAS_BASELINE: ReadonlySet<TargetId> = new Set(["volume", "aht", "required", "fte"])
const ago = (ts: number) => {
  const m = Math.round((Date.now() - ts) / 60000)
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(ts).toLocaleDateString()
}

export function Forecasting() {
  const {
    queueId, applyForecast, shrinkage, agents, importedActuals, importActuals, clearActuals, can, queues,
    externalFactors, forecastDrivers, forecastMethod, forecastPeriod, setForecastPeriod, forecastTargets, setForecastTargets,
    forecastAutomation, setForecastAutomation, publishedForecasts, publishForecast, unpublishForecast, currentUser,
  } = useWfm()
  const queue = queues.find((q) => q.id === queueId)!
  const overlay = importedActuals[queue.id]
  const editable = can("forecasting", "edit")
  const { start, end } = forecastPeriod
  const targets = forecastTargets
  const nDays = Math.max(1, Math.round((parseYMD(end).getTime() - parseYMD(start).getTime()) / 86400000) + 1)
  const window = backtestWindowFor(nDays)

  // The back-test the page shows. A new window is worked out a step at a time
  // (it refits every model per held-out day), so the page never freezes.
  const [shown, setShown] = useState(() => ({ window, bt: backtestG(queue.id, window, overlay) }))
  const [backtesting, setBacktesting] = useState(false)
  useEffect(() => {
    let cancelled = false
    const hit = cachedBacktest(queue.id, window, overlay)
    if (hit) {
      setShown({ window, bt: hit })
      setBacktesting(false)
      return
    }
    setBacktesting(true)
    void backtestGAsync(queue.id, window, overlay, () => cancelled).then((bt) => {
      if (cancelled || !bt) return
      setShown({ window, bt })
      setBacktesting(false)
    })
    return () => {
      cancelled = true
    }
  }, [queue.id, window, overlay])
  const bt = shown.bt

  // Model: the most accurate one while auto-select is on, else the one picked by hand.
  const [picked, setPicked] = useState<string>(() => (methodById[forecastMethod[queue.id]] ? forecastMethod[queue.id] : bt.best.id))
  const method = forecastAutomation.autoSelectBest ? bt.best.id : (bt.perMethod.some((m) => m.id === picked) ? picked : bt.best.id)
  const previewMethod = bt.perMethod.find((m) => m.id === method) ?? bt.best

  const queueDrivers = useMemo(() => forecastDrivers.filter((d) => appliesTo(d, queue.id)), [forecastDrivers, queue.id])
  const rp = useMemo(
    () => rangePlan({ queue, start: parseYMD(start), end: parseYMD(end), methodId: method, shrinkage, agents, overlay, factors: externalFactors, drivers: forecastDrivers }),
    [queue, start, end, method, shrinkage, agents, overlay, externalFactors, forecastDrivers],
  )
  // Baseline (no events, no drivers) over the same period — the honest before/after.
  const rpBaseline = useMemo(
    () => rangePlan({ queue, start: parseYMD(start), end: parseYMD(end), methodId: method, shrinkage, agents, overlay }),
    [queue, start, end, method, shrinkage, agents, overlay],
  )
  const bsum = useMemo(() => summariseBuckets(rp.rows), [rp])
  const relevantFactors = useMemo(
    () => externalFactors.filter((f) => (f.queueId === "all" || f.queueId === queue.id) && f.to >= start && f.from <= end),
    [externalFactors, queue.id, start, end],
  )
  const adjusted = rp.totals.volume !== rpBaseline.totals.volume || rp.totals.aht !== rpBaseline.totals.aht
  const btAdj = useMemo(() => adjustedBacktest(bt, previewMethod, queue.id, externalFactors, forecastDrivers), [bt, previewMethod, queue.id, externalFactors, forecastDrivers])

  const trainingHistory = useMemo(() => historyFor(queue.id, overlay), [queue.id, overlay])
  const appendedDays = useMemo(() => daysAppendedBeyondBase(queue.id, overlay), [queue.id, overlay])

  // ---- publishing (manual + automatic) ----
  const candidate = useMemo(
    () => buildPublished({
      queueId: queue.id, queueName: queue.name, start, end, plan: rp, methodId: previewMethod.id, methodName: previewMethod.name,
      mape: previewMethod.mape, targets, drivers: queueDrivers, events: relevantFactors.length, publishedBy: currentUser, auto: false,
    }),
    [queue.id, queue.name, start, end, rp, previewMethod, targets, queueDrivers, relevantFactors.length, currentUser],
  )
  const published = publishedForecasts[queue.id]
  const inSync = publishFingerprint(published) === publishFingerprint(candidate)

  function publishNow(auto: boolean) {
    if (!editable) return
    if (forecastMethod[queue.id] !== previewMethod.id) applyForecast(queue.id, generate(queue.id, previewMethod.id, overlay), previewMethod.id, previewMethod.name)
    publishForecast({ ...candidate, auto, publishedAt: Date.now() })
  }
  const publishRef = useRef(publishNow)
  publishRef.current = publishNow
  useEffect(() => {
    if (!forecastAutomation.autoPublish || !editable || backtesting || inSync) return
    const t = setTimeout(() => publishRef.current(true), 900)
    return () => clearTimeout(t)
  }, [forecastAutomation.autoPublish, editable, backtesting, inSync, candidate])

  function pickModel(id: string) {
    if (!editable) return
    if (forecastAutomation.autoSelectBest && id !== bt.best.id) setForecastAutomation({ autoSelectBest: false })
    setPicked(id)
    applyForecast(queue.id, generate(queue.id, id, overlay), id, methodById[id]?.name)
  }

  function toggleTarget(id: TargetId) {
    setForecastTargets(targets.includes(id) ? targets.filter((t) => t !== id) : FORECAST_TARGETS.map((t) => t.id).filter((t) => t === id || targets.includes(t)))
  }
  const [chartTarget, setChartTarget] = useState<TargetId>("volume")
  const chartT: TargetId = targets.includes(chartTarget) ? chartTarget : targets[0]

  // ---- actual-data import ----
  const fileRef = useRef<HTMLInputElement>(null)
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const { rows, errors, skippedOtherQueue } = await parseActualsFile(file, queue.id, queues)
      if (!rows.length) {
        setImportMsg({ ok: false, text: `No valid rows in ${file.name}. ${errors.slice(0, 2).join("; ")}` })
      } else {
        const res = importActuals(queue.id, rows, file.name)
        const notes = [
          errors.length ? `${errors.length} row(s) skipped` : null,
          skippedOtherQueue ? `${skippedOtherQueue} row(s) for other queues ignored` : null,
        ].filter(Boolean).join(", ")
        setImportMsg({
          ok: true,
          text: `Imported ${rows.length} day(s) from ${file.name}${notes ? ` (${notes})` : ""}. Retrained → applied ${res.methodName} (${fmtPct(res.mape)} MAPE).`,
        })
      }
    } catch (err) {
      setImportMsg({ ok: false, text: `Could not read ${file.name}: ${(err as Error).message}` })
    }
    e.target.value = ""
  }

  function onClear() {
    clearActuals(queue.id)
    setImportMsg(null)
  }

  const feedUrl = `${api.defaults.baseURL}/forecasting/published?queue=${encodeURIComponent(queue.id)}&format=csv`
  const [copied, setCopied] = useState(false)
  async function copyFeed() {
    try {
      await navigator.clipboard.writeText(feedUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — the URL is shown for manual copy */
    }
  }

  const btData = bt.labels.map((l, i) => ({
    label: l, Actual: bt.actual[i], Forecast: previewMethod.pred[i], ...(btAdj.changed ? { Adjusted: Math.round(btAdj.pred[i]) } : {}),
  }))
  const chartData = rp.rows.map((r, i) => {
    const scale = chartT === "projSL" || chartT === "occupancy" ? 100 : 1
    return { label: r.label, Value: Math.round(r[chartT] * scale * 10) / 10, Baseline: Math.round((rpBaseline.rows[i]?.[chartT] ?? 0) * scale * 10) / 10 }
  })
  const showBaseline = adjusted && HAS_BASELINE.has(chartT)

  const bestOfKind = (kind: string) => {
    const m = bt.perMethod.filter((p) => p.kind === kind).sort((a, b) => a.mape - b.mape)[0]
    return m ? `${m.name} (${fmtPct(m.mape)})` : "—"
  }
  const volDelta = rpBaseline.totals.volume ? rp.totals.volume / rpBaseline.totals.volume - 1 : 0

  const insight = {
    headline: `${bt.best.name} is the most accurate model for ${queue.name} (${fmtPct(bt.best.mape)} MAPE over the last ${bt.window} days).`,
    bullets: [
      `Best statistical ${bestOfKind("Statistical")} · best ML ${bestOfKind("ML")} · best deep learning ${bestOfKind("DL")}.`,
      `${previewMethod.name} predicts ${rp.totals.volume.toLocaleString()} contacts from ${fmtDay(parseYMD(start))} to ${fmtDay(parseYMD(end))} (${rp.nDays} days), peaking ${bsum.peakLabel}. That needs ${rp.totals.fte} FTE a day on average.`,
      ...(adjusted ? [`${queueDrivers.length} driver(s) and ${relevantFactors.length} event(s) move volume ${volDelta >= 0 ? "+" : ""}${(volDelta * 100).toFixed(1)}% against the pure model${btAdj.changed ? `, and back-test error goes ${fmtPct(previewMethod.mape)} → ${fmtPct(btAdj.mape)}` : ""}.`] : []),
      method === bt.best.id ? "You're on the most accurate model, a good basis for staffing." : `Switch to ${bt.best.name} for ${fmtPct(previewMethod.mape - bt.best.mape)} lower error.`,
      ...(overlay?.length ? [`Trained on ${trainingHistory.days.length.toLocaleString()} days incl. ${overlay.length} imported actual day(s) (last known day: ${fmtDay(trainingHistory.lastDate)}).`] : []),
    ],
    tone: method === bt.best.id ? ("good" as const) : ("warn" as const),
  }

  const Toggle = ({ on, label, sub, onChange }: { on: boolean; label: string; sub: string; onChange: (v: boolean) => void }) => (
    <label className={cn("flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2", on && "border-primary/50 bg-primary/5", !editable && "cursor-default opacity-70")}>
      <input type="checkbox" checked={on} disabled={!editable} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{sub}</span>
      </span>
    </label>
  )

  return (
    <>
      <PageHeader
        title="Forecasting"
        subtitle={`${queue.name} · statistical + ML + deep-learning models · drivers & events · auto-published to every dashboard`}
        actions={
          <>
            <PermissionGate module="forecasting" fallback={<LockedHint label="Template & import need forecasting edit access" />}>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFile} />
              <Button variant="outline" onClick={() => downloadActualsTemplate(queue.name, addDays(trainingHistory.lastDate, 1))}>
                <FileDown className="h-4 w-4" /> Template
              </Button>
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" /> Import actuals
              </Button>
            </PermissionGate>
            <ExportButton
              filename={`forecast-${queue.id}-${start}-to-${end}`}
              sheets={() => [
                { name: "Forecast", rows: rp.rows.map((r) => ({ [rp.bucket]: r.label, ...Object.fromEntries(targets.map((t) => [targetById[t].name, fmtTarget(t, r[t])])) })) },
                { name: "Daily", rows: rp.days.map((d) => ({ Date: d.date, ...Object.fromEntries(targets.map((t) => [targetById[t].name, fmtTarget(t, d[t])])), "Events ×": d.eventMult.toFixed(3), "Volume drivers ×": d.volumeDriverMult.toFixed(3), "AHT drivers ×": d.ahtDriverMult.toFixed(3) })) },
                { name: "Model Accuracy", rows: bt.perMethod.map((m) => ({ Model: m.name, Type: m.kind, MAPE: fmtPct(m.mape), Best: m.id === bt.best.id ? "★" : "" })) },
                { name: "Back-test", rows: bt.labels.map((l, i) => ({ Day: l, Actual: bt.actual[i], [previewMethod.name]: previewMethod.pred[i] })) },
                ...(forecastDrivers.length ? [{ name: "Drivers", rows: forecastDrivers.map((d) => ({ Name: d.name, Kind: d.kind, Queue: d.queueId === "all" ? "All queues" : queues.find((q) => q.id === d.queueId)?.name ?? d.queueId, Target: d.target, Reference: d.reference, Elasticity: d.elasticity, Source: d.elasticitySource, Enabled: d.enabled ? "yes" : "no" })) }] : []),
                ...(overlay?.length ? [{ name: "Imported Actuals", rows: overlay.map((r) => ({ Date: r.date, Volume: r.volume })) }] : []),
                ...(externalFactors.length ? [{ name: "External Factors", rows: externalFactors.map((f) => ({ Name: f.name, Category: f.category, Queue: f.queueId === "all" ? "All queues" : queues.find((q) => q.id === f.queueId)?.name ?? f.queueId, From: f.from, To: f.to, "Impact %": f.impactPct, Note: f.note ?? "" })) }] : []),
              ]}
            />
          </>
        }
      />

      {importMsg && (
        <div className={`mb-4 rounded-lg border px-4 py-2.5 text-sm ${importMsg.ok ? "border-emerald-500/40 text-emerald-500" : "border-destructive/40 text-destructive"}`}>
          {importMsg.ok ? "✓ " : "✕ "}
          {importMsg.text}
        </div>
      )}

      <Card className="glass mb-4">
        <CardContent className="flex flex-wrap items-center gap-3 pt-5 text-sm">
          <Database className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">
            Trained on <b className="text-foreground">{trainingHistory.days.length.toLocaleString()}</b> days · last known day{" "}
            <b className="text-foreground">{fmtDay(trainingHistory.lastDate)}</b>
          </span>
          {overlay?.length ? (
            <>
              <Badge variant="success">{overlay.length} imported day{overlay.length === 1 ? "" : "s"}</Badge>
              {appendedDays > 0 && <span className="text-muted-foreground">· extends baseline by {appendedDays} day{appendedDays === 1 ? "" : "s"}</span>}
              <PermissionGate module="forecasting">
                <Button variant="ghost" size="sm" className="ml-auto" onClick={onClear}>
                  <X className="h-3.5 w-3.5" /> Clear imported actuals
                </Button>
              </PermissionGate>
            </>
          ) : (
            <span className="text-muted-foreground">· no imported actuals yet. Download the template to add real data.</span>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---- period + targets ---- */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><CalendarRange className="h-4 w-4" /> Forecast period & targets</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Start date</span>
                <input
                  type="date"
                  aria-label="Forecast start date"
                  value={start}
                  min={ymd(TODAY)}
                  onChange={(e) => e.target.value && setForecastPeriod(e.target.value, e.target.value > end ? e.target.value : end)}
                  className={dateCls}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">End date</span>
                <input
                  type="date"
                  aria-label="Forecast end date"
                  value={end}
                  min={start}
                  max={ymd(addDays(parseYMD(start), MAX_RANGE_DAYS - 1))}
                  onChange={(e) => e.target.value && setForecastPeriod(start, e.target.value)}
                  className={dateCls}
                />
              </label>
              <p className="pb-2 text-sm text-muted-foreground">
                <b className="text-foreground">{rp.nDays}</b> day{rp.nDays === 1 ? "" : "s"} · shown by {rp.bucket}
                {rp.truncated && <span className="text-amber-500"> · capped at {MAX_RANGE_DAYS} days</span>}
              </p>
            </div>
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Target className="h-3.5 w-3.5" /> Targets to predict</p>
              <div className="flex flex-wrap gap-2">
                {FORECAST_TARGETS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => toggleTarget(t.id)}
                    aria-pressed={targets.includes(t.id)}
                    className={cn("rounded-full border px-3 py-1 text-xs font-medium", targets.includes(t.id) ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent")}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ---- automation + sync ---- */}
        <Card className="glass">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2"><Bot className="h-4 w-4" /> Automation & sync</CardTitle>
            {published ? (
              <Badge variant={inSync ? "success" : "warning"}>{inSync ? "Published · in sync" : "Changes not published"}</Badge>
            ) : (
              <Badge variant="secondary">Not published</Badge>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Toggle on={forecastAutomation.autoSelectBest} onChange={(v) => setForecastAutomation({ autoSelectBest: v })} label="Auto-select best model" sub="Re-runs the back-test on new actuals and uses the lowest-MAPE model" />
              <Toggle on={forecastAutomation.autoPublish} onChange={(v) => setForecastAutomation({ autoPublish: v })} label="Auto-publish" sub="Publishes the period again whenever the model, drivers, events or dates change" />
            </div>
            <div className="text-xs text-muted-foreground">
              {published ? (
                <>Last published {ago(published.publishedAt)}{published.auto ? " (automatic)" : ""} by {published.publishedBy}: {published.start} → {published.end} · {published.methodName} · {published.totals.volume.toLocaleString()} contacts.</>
              ) : "Nothing published for this queue yet."}{" "}
              The plan is used by the Dashboard, Reports, Scenario Studio, Capacity and Scheduling, and outside dashboards can read it through the feed below.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <PermissionGate module="forecasting" fallback={<LockedHint label="Publishing needs forecasting edit access" />}>
                <Button size="sm" onClick={() => publishNow(false)} disabled={inSync || backtesting}>
                  <Send className="h-4 w-4" /> {inSync ? "Published" : "Publish now"}
                </Button>
                {published && (
                  <Button size="sm" variant="ghost" onClick={() => unpublishForecast(queue.id)}>
                    <X className="h-3.5 w-3.5" /> Unpublish
                  </Button>
                )}
              </PermissionGate>
              <Button size="sm" variant="outline" disabled={!Object.keys(publishedForecasts).length} onClick={() => downloadPublishedCsv(Object.values(publishedForecasts))}>
                <FileDown className="h-4 w-4" /> CSV feed
              </Button>
              <Button size="sm" variant="outline" disabled={!Object.keys(publishedForecasts).length} onClick={() => downloadPublishedJson(Object.values(publishedForecasts))}>
                <FileDown className="h-4 w-4" /> JSON
              </Button>
            </div>
            <div className="rounded-lg border bg-muted/30 p-2.5">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-medium"><Radio className="h-3.5 w-3.5" /> Live feed for Power BI, Tableau, Looker, Grafana or Excel</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={feedUrl}>{feedUrl}</code>
                <Button size="sm" variant="ghost" onClick={copyFeed} aria-label="Copy feed URL"><Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}</Button>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Send an API key with scope <code>forecast:read</code> (Settings → Connect). Leave out <code>queue</code> for all queues. Subscribe to the
                <code> forecast.published</code> webhook to refresh the moment a new forecast is published.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="glass my-4">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Model selection
            {forecastAutomation.autoSelectBest && <Badge variant="secondary">auto: best model</Badge>}
            {backtesting && (
              <span role="status" className="flex items-center gap-1.5 text-xs font-normal text-primary">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Back-testing every model over the last {window} days…
              </span>
            )}
          </CardTitle>
          {!editable && <p className="text-xs text-muted-foreground">Read-only for your designation: showing accuracy only.</p>}
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {bt.perMethod.map((m) => (
              <button
                key={m.id}
                onClick={() => pickModel(m.id)}
                disabled={!editable}
                className={cn(
                  "flex flex-col items-start rounded-lg border px-4 py-2 text-left transition-colors",
                  m.id === method ? "border-primary bg-primary/10" : "hover:bg-accent",
                  !editable && "cursor-default opacity-70 hover:bg-transparent",
                )}
              >
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{m.kind === "DL" ? "Deep learning" : m.kind}</span>
                <span className="text-sm font-semibold">{m.name}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-xs tabular-nums">
                  {fmtPct(m.mape)}
                  {m.id === bt.best.id && <Badge variant="success">best</Badge>}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="glass lg:col-span-2">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <CardTitle>Back-test: {previewMethod.name}</CardTitle>
            <div className="flex gap-2">
              <Badge variant={previewMethod.id === bt.best.id ? "success" : "warning"}>MAPE {fmtPct(previewMethod.mape)}</Badge>
              {btAdj.changed && <Badge variant={btAdj.mape <= previewMethod.mape ? "success" : "warning"}>with drivers & events {fmtPct(btAdj.mape)}</Badge>}
            </div>
          </CardHeader>
          <CardContent>
            <SeriesChart
              data={btData}
              xKey="label"
              yLabel={bt.unit}
              series={[
                { key: "Actual", name: "Actual (held-out)", color: "#22c55e" },
                { key: "Forecast", name: previewMethod.name, color: queue.color, dashed: true },
                ...(btAdj.changed ? [{ key: "Adjusted", name: "With drivers & events", color: "#f59e0b", dashed: true }] : []),
              ]}
            />
          </CardContent>
        </Card>
        <AiSummary insight={insight} title="AI Forecast Summary" />
      </div>

      <ForecastDriversPanel queueId={queue.id} history={trainingHistory} start={start} end={end} />

      <ExternalFactorsPanel
        title="Events log"
        description="Known one-off events (campaigns, holidays, weather, outages, client wins and losses, launches), each with a volume impact %. They're applied on top of the model and the drivers. Managed here and on the Scenario Studio tab, so an event logged in either place shows up in both."
      />

      {/* ---- results ---- */}
      <Card className="glass mt-4">
        <CardHeader className="flex-row flex-wrap items-end justify-between gap-3 space-y-0">
          <div>
            <CardTitle>Forecast: {fmtDay(parseYMD(start))} → {fmtDay(parseYMD(end))}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {rp.nDays} days → {rp.rows.length} {rp.bucket}{rp.rows.length === 1 ? "" : "s"} · {previewMethod.name}
              {queueDrivers.length > 0 && ` · ${queueDrivers.length} driver${queueDrivers.length === 1 ? "" : "s"}`}
              {relevantFactors.length > 0 && ` · ${relevantFactors.length} event${relevantFactors.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Chart
            <Select value={chartT} onChange={(e) => setChartTarget(e.target.value as TargetId)} options={targets.map((t) => ({ value: t, label: targetById[t].name }))} />
          </label>
        </CardHeader>
        <CardContent>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
            {targets.map((t) => {
              const v = rp.totals[t]
              const b = rpBaseline.totals[t]
              const d = HAS_BASELINE.has(t) && b ? v / b - 1 : 0
              return (
                <div key={t} className="rounded-lg border px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{targetById[t].name}</div>
                  <div className="text-lg font-semibold tabular-nums">{fmtTarget(t, v)}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {t === "fte" ? `avg / day (${HOURS_PER_FTE_DAY} h)` : targetById[t].total ? "period total" : "period average"}
                    {Math.abs(d) >= 0.0005 && <span className={cn("ml-1 font-semibold", d > 0 ? "text-amber-500" : "text-emerald-500")}>{d > 0 ? "+" : ""}{(d * 100).toFixed(1)}%</span>}
                  </div>
                </div>
              )
            })}
          </div>
          <SeriesChart
            data={chartData}
            xKey="label"
            yLabel={targetById[chartT].unit}
            series={[
              { key: "Value", name: showBaseline ? `${targetById[chartT].name} (drivers & events applied)` : targetById[chartT].name, color: queue.color, type: "bar" as const },
              ...(showBaseline ? [{ key: "Baseline", name: "Model only", color: "#94a3b8", dashed: true }] : []),
            ]}
          />
          <div className="mt-4 max-h-80 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="capitalize">{rp.bucket}</TableHead>
                  {targets.map((t) => <TableHead key={t}>{targetById[t].name}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rp.rows.map((r) => (
                  <TableRow key={r.label}>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    {targets.map((t) => (
                      <TableCell key={t} className={cn("tabular-nums", t === "variance" && (r.variance < 0 ? "font-semibold text-destructive" : "font-semibold text-emerald-500"))}>
                        {fmtTarget(t, r[t])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                <TableRow className="border-t-2">
                  <TableCell className="font-semibold">Total / avg</TableCell>
                  {targets.map((t) => <TableCell key={t} className="font-semibold tabular-nums">{fmtTarget(t, rp.totals[t])}</TableCell>)}
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="mt-4">
        <ForecastAccuracy />
      </div>

      <div className="mt-4">
        <RampPlanner />
      </div>
    </>
  )
}
