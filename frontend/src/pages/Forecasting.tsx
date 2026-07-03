import { useEffect, useMemo, useRef, useState } from "react"
import { Database, FileDown, Upload, X } from "lucide-react"

import { AiSummary } from "@/components/ai-summary"
import { SeriesChart } from "@/components/charts/series-chart"
import { ExportButton } from "@/components/export-button"
import { PageHeader } from "@/components/page-header"
import { LockedHint, PermissionGate } from "@/components/permission-gate"
import { RampPlanner } from "@/components/ramp-planner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { parseActualsFile, downloadActualsTemplate } from "@/lib/actuals"
import { addDays, fmtDay, parseYMD, PRESETS, TODAY, ymd } from "@/lib/domain/dates"
import { generate, methodById } from "@/lib/domain/forecast"
import { backtestG, type GranId, GRANULARITIES, rangePlan, summariseBuckets } from "@/lib/domain/granularity"
import { daysAppendedBeyondBase, historyFor } from "@/lib/domain/history"
import { fmtPct } from "@/lib/domain/planning"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

export function Forecasting() {
  const { queueId, applyForecast, shrinkage, agents, importedActuals, importActuals, clearActuals, can, queues } = useWfm()
  const queue = queues.find((q) => q.id === queueId)!
  const overlay = importedActuals[queue.id]

  const [gran, setGran] = useState<GranId>("weekly")
  const [start, setStart] = useState(ymd(TODAY))
  const [end, setEnd] = useState(ymd(addDays(TODAY, 6)))

  const bt = useMemo(() => backtestG(queue.id, gran, overlay), [queue.id, gran, overlay])
  const [method, setMethod] = useState(bt.best.id)
  useEffect(() => setMethod(bt.best.id), [bt.best.id])
  const previewMethod = bt.perMethod.find((m) => m.id === method) ?? bt.best

  const rp = useMemo(
    () => rangePlan(queue.id, parseYMD(start), parseYMD(end), gran, method, queue.aht, queue, shrinkage, agents, overlay),
    [queue.id, start, end, gran, method, queue, shrinkage, agents, overlay],
  )
  const bsum = useMemo(() => summariseBuckets(rp.rows), [rp])

  const trainingHistory = useMemo(() => historyFor(queue.id, overlay), [queue.id, overlay])
  const appendedDays = useMemo(() => daysAppendedBeyondBase(queue.id, overlay), [queue.id, overlay])

  function apply(id: string) {
    if (!can("forecasting", "edit")) return
    setMethod(id)
    applyForecast(queue.id, generate(queue.id, id, overlay), id, methodById[id]?.name)
  }

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

  const btData = bt.labels.map((l, i) => ({ label: l, Actual: bt.actual[i], Forecast: previewMethod.pred[i] }))
  const fwdData = rp.rows.map((r) => ({ label: r.label, Volume: r.volume }))

  const insight = {
    headline: `${bt.best.name} is the most accurate model for ${queue.name} (${fmtPct(bt.best.mape)} MAPE, ${gran}).`,
    bullets: [
      `Best ML model ${bt.perMethod.filter((m) => m.kind === "ML").sort((a, b) => a.mape - b.mape)[0]?.name} vs best statistical ${bt.perMethod.filter((m) => m.kind === "Statistical").sort((a, b) => a.mape - b.mape)[0]?.name}.`,
      `Applied (${previewMethod.name}) projects ${bsum.totalVol.toLocaleString()} contacts over ${rp.nDays} days, peaking ${bsum.peakLabel}.`,
      method === bt.best.id ? "You're on the most accurate model — good basis for staffing." : `Switch to ${bt.best.name} for ${fmtPct(previewMethod.mape - bt.best.mape)} lower error.`,
      ...(overlay?.length ? [`Trained on ${trainingHistory.days.length.toLocaleString()} days incl. ${overlay.length} imported actual day(s) (last known day: ${fmtDay(trainingHistory.lastDate)}).`] : []),
    ],
    tone: method === bt.best.id ? ("good" as const) : ("warn" as const),
  }

  return (
    <>
      <PageHeader
        title="Forecasting"
        subtitle={`${queue.name} · statistical + ML models · back-tested MAPE`}
        actions={
          <>
            <div className="inline-flex rounded-lg bg-muted p-1">
              {GRANULARITIES.map((g) => (
                <button
                  key={g.id}
                  onClick={() => setGran(g.id)}
                  className={cn("rounded-md px-3 py-1 text-sm font-medium", gran === g.id ? "bg-background shadow-sm" : "text-muted-foreground")}
                >
                  {g.name}
                </button>
              ))}
            </div>
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
              filename={`forecast-${queue.id}-${gran}`}
              sheets={() => [
                { name: "Model Accuracy", rows: bt.perMethod.map((m) => ({ Model: m.name, Type: m.kind, MAPE: fmtPct(m.mape), Best: m.id === bt.best.id ? "★" : "" })) },
                { name: "Forecast", rows: rp.rows.map((r) => ({ [rp.bucket]: r.label, Volume: r.volume, "Required hrs": r.required, "Scheduled hrs": r.scheduled, Variance: r.variance, "Proj. SL": fmtPct(r.projSL) })) },
                { name: "Back-test", rows: bt.labels.map((l, i) => ({ Bucket: l, Actual: bt.actual[i], [previewMethod.name]: previewMethod.pred[i] })) },
                ...(overlay?.length ? [{ name: "Imported Actuals", rows: overlay.map((r) => ({ Date: r.date, Volume: r.volume })) }] : []),
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
            <span className="text-muted-foreground">· no imported actuals yet — download the template to add real data</span>
          )}
        </CardContent>
      </Card>

      <Card className="glass mb-4">
        <CardHeader>
          <CardTitle>Model selection</CardTitle>
          {!can("forecasting", "edit") && <p className="text-xs text-muted-foreground">Read-only for your designation — showing accuracy only.</p>}
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {bt.perMethod.map((m) => (
              <button
                key={m.id}
                onClick={() => apply(m.id)}
                disabled={!can("forecasting", "edit")}
                className={cn(
                  "flex flex-col items-start rounded-lg border px-4 py-2 text-left transition-colors",
                  m.id === method ? "border-primary bg-primary/10" : "hover:bg-accent",
                  !can("forecasting", "edit") && "cursor-default opacity-70 hover:bg-transparent",
                )}
              >
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{m.kind}</span>
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
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Back-test — {previewMethod.name}</CardTitle>
            <Badge variant={previewMethod.id === bt.best.id ? "success" : "warning"}>MAPE {fmtPct(previewMethod.mape)}</Badge>
          </CardHeader>
          <CardContent>
            <SeriesChart
              data={btData}
              xKey="label"
              yLabel={bt.unit}
              series={[
                { key: "Actual", name: "Actual (held-out)", color: "#22c55e" },
                { key: "Forecast", name: previewMethod.name, color: queue.color, dashed: true },
              ]}
            />
          </CardContent>
        </Card>
        <AiSummary insight={insight} title="AI Forecast Summary" />
      </div>

      <Card className="glass mt-4">
        <CardHeader className="flex-row flex-wrap items-end justify-between gap-3 space-y-0">
          <div>
            <CardTitle>Forecast by {rp.bucket}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {fmtDay(parseYMD(start))} → {fmtDay(parseYMD(end))} · {rp.nDays} days → {rp.rows.length} {rp.bucket}
              {rp.rows.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setStart(ymd(TODAY))
                  setEnd(ymd(addDays(TODAY, p.days)))
                }}
                className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
              >
                {p.label}
              </button>
            ))}
            <Input type="date" value={start} min={ymd(TODAY)} onChange={(e) => setStart(e.target.value)} className="w-auto" />
            <Input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} className="w-auto" />
          </div>
        </CardHeader>
        <CardContent>
          <SeriesChart data={fwdData} xKey="label" series={[{ key: "Volume", name: "Forecast volume", color: queue.color, type: "bar" }]} />
          <div className="mt-4 max-h-72 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{rp.bucket}</TableHead>
                  <TableHead>Volume</TableHead>
                  <TableHead>Req. (hrs)</TableHead>
                  <TableHead>Scheduled (hrs)</TableHead>
                  <TableHead>Variance</TableHead>
                  <TableHead>Proj. SL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rp.rows.map((r) => (
                  <TableRow key={r.label}>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    <TableCell>{r.volume.toLocaleString()}</TableCell>
                    <TableCell>{r.required.toLocaleString()}</TableCell>
                    <TableCell>{r.scheduled.toLocaleString()}</TableCell>
                    <TableCell className={r.variance < 0 ? "font-semibold text-destructive" : "font-semibold text-emerald-500"}>
                      {r.variance > 0 ? "+" : ""}
                      {r.variance.toLocaleString()}
                    </TableCell>
                    <TableCell>{fmtPct(r.projSL)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="mt-4">
        <RampPlanner />
      </div>
    </>
  )
}
