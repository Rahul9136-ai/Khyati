import { useMemo, useState } from "react"
import { ArrowRight, Bot, CheckCircle2, CircleAlert, CircleX, ListChecks, PlayCircle, RefreshCw, Workflow } from "lucide-react"

import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DEMO_RUN_INTERVAL_MS,
  fmtAgo,
  fmtIn,
  nextRunMs,
  PIPELINE,
  RULES,
  runsFor,
  THRESHOLD_META,
  type JobRun,
  type RunStatus,
} from "@/lib/domain/automation"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

const STATUS_ICON: Record<RunStatus, { icon: typeof CheckCircle2; cls: string }> = {
  success: { icon: CheckCircle2, cls: "text-teal-600" },
  warning: { icon: CircleAlert, cls: "text-amber-600" },
  failed: { icon: CircleX, cls: "text-destructive" },
}

// Audit actions that originate from an automated decision (vs a human click).
const AUTOMATED_ACTIONS = [
  "auto-approved",
  "Leave auto-approved",
  "Imported actuals & retrained",
  "Approved intraday action",
  "Recalled agents",
  "Optimised breaks",
  "Auto-scheduled new hires",
  "Ran data ingest",
  "Ran forecast refresh",
  "Ran capacity rebuild",
  "Ran schedule optimiser",
  "Ran RTA monitor",
]

export function Automation() {
  const { thresholds, setThreshold, ruleState, setRuleEnabled, auditLog, can, pipelineAutoRun, setPipelineAutoRun, runPipelineJob } = useWfm()
  const [now] = useState(() => Date.now())

  const runs = useMemo(() => {
    const all: JobRun[] = PIPELINE.flatMap((j) => runsFor(j.id, 4, now))
    return all.sort((a, b) => b.at - a.at)
  }, [now])

  const lastByJob = useMemo(() => {
    const m = new Map<string, JobRun>()
    for (const r of runs) if (!m.has(r.jobId)) m.set(r.jobId, r)
    return m
  }, [runs])

  const healthy = PIPELINE.filter((j) => lastByJob.get(j.id)?.status !== "failed").length
  const activeRules = RULES.filter((r) => ruleState[r.id] !== false).length
  const decisions = useMemo(
    () => auditLog.filter((e) => AUTOMATED_ACTIONS.some((a) => e.action.includes(a))),
    [auditLog],
  )

  const editable = can("automation", "edit")
  const jobName = (id: string) => PIPELINE.find((j) => j.id === id)?.name ?? id

  const fmtThreshold = (key: (typeof THRESHOLD_META)[number]["key"]) => {
    const meta = THRESHOLD_META.find((m) => m.key === key)!
    const v = thresholds[key]
    return meta.kind === "pct" ? `${(v * 100).toFixed(0)}%` : meta.kind === "mins" ? `${v} min` : `${v}pp`
  }

  return (
    <>
      <PageHeader
        title="Automation Center"
        subtitle="Scheduled pipeline · rules engine · every automated decision audited"
        actions={
          <ExportButton
            filename="automation-center"
            sheets={() => [
              { name: "Pipeline Runs", rows: runs.map((r) => ({ Job: jobName(r.jobId), When: new Date(r.at).toLocaleString(), "Duration (s)": r.durationSec, Status: r.status, Note: r.note })) },
              { name: "Rules", rows: RULES.map((r) => ({ Rule: r.name, Trigger: r.trigger, Action: r.action, Threshold: r.thresholdKey ? fmtThreshold(r.thresholdKey) : "—", Mode: r.requiresApproval ? "Human-in-the-loop" : "Fully automated", Enabled: ruleState[r.id] !== false ? "Yes" : "No" })) },
              { name: "Automated Decisions", rows: decisions.map((d) => ({ When: new Date(d.ts).toLocaleString(), User: d.user, Category: d.category, Action: d.action, Detail: d.detail })) },
            ]}
          />
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Pipeline health" value={`${healthy}/${PIPELINE.length}`} hint="jobs green on last run" tone={healthy === PIPELINE.length ? "good" : "warn"} icon={Workflow} />
        <KpiCard label="Active rules" value={`${activeRules}/${RULES.length}`} hint="rules engine" tone={activeRules ? "good" : "bad"} icon={ListChecks} />
        <KpiCard label="Automated decisions" value={decisions.length} hint="in the audit trail" icon={Bot} />
        <KpiCard label="Next forecast refresh" value={fmtIn(nextRunMs("forecast", now), now)} hint="daily 02:00 chain start" icon={RefreshCw} />
      </div>

      <Card className="glass mt-4">
        <CardHeader>
          <CardTitle>Orchestrated pipeline — no manual steps</CardTitle>
          <p className="text-xs text-muted-foreground">
            Data ingest → forecast → capacity → schedule → RTA monitoring, chained on schedule. Failures retry and alert.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 lg:grid-cols-5">
            {PIPELINE.map((job, i) => {
              const last = lastByJob.get(job.id)
              const S = STATUS_ICON[last?.status ?? "success"]
              return (
                <div key={job.id} className="relative rounded-lg border p-3">
                  {i < PIPELINE.length - 1 && (
                    <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden h-4 w-4 -translate-y-1/2 text-muted-foreground lg:block" />
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Stage {job.stage}</span>
                    <S.icon className={cn("h-4 w-4", S.cls)} />
                  </div>
                  <div className="mt-1 text-sm font-semibold">{job.name}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{job.schedule}</div>
                  <p className="mt-2 line-clamp-3 text-[11px] text-muted-foreground">{job.description}</p>
                  <div className="mt-2 border-t pt-2 text-[11px]">
                    <div className="flex justify-between text-muted-foreground">
                      <span>last {last ? fmtAgo(last.at, now) : "—"}</span>
                      <span>next {fmtIn(nextRunMs(job.id, now), now)}</span>
                    </div>
                  </div>
                  <PermissionGate module="automation" fallback={<div className="mt-2 border-t pt-2 text-[11px] text-muted-foreground">view only</div>}>
                    <div className="mt-2 flex items-center justify-between border-t pt-2">
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => runPipelineJob(job.id, false)}>
                        <PlayCircle className="h-3 w-3" /> Run now
                      </Button>
                      <label className="flex items-center gap-1 text-[10px] text-muted-foreground" title={`Auto-runs every ${Math.round((DEMO_RUN_INTERVAL_MS[job.id] ?? 60_000) / 1000)}s while enabled`}>
                        <input
                          type="checkbox"
                          className="accent-primary"
                          checked={!!pipelineAutoRun[job.id]}
                          onChange={(e) => setPipelineAutoRun(job.id, e.target.checked)}
                        />
                        auto
                      </label>
                    </div>
                  </PermissionGate>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card className="glass">
          <CardHeader>
            <CardTitle>Rules engine</CardTitle>
            <p className="text-xs text-muted-foreground">
              {editable ? "Toggle rules and tune thresholds — every change is audited." : "Read-only for your designation."}
            </p>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {RULES.map((rule) => {
              const enabled = ruleState[rule.id] !== false
              const meta = rule.thresholdKey ? THRESHOLD_META.find((m) => m.key === rule.thresholdKey) : undefined
              return (
                <div key={rule.id} className={cn("rounded-lg border p-3", !enabled && "opacity-60")}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{rule.name}</span>
                    <Badge variant={rule.requiresApproval ? "warning" : "success"}>
                      {rule.requiresApproval ? "human-in-the-loop" : "fully automated"}
                    </Badge>
                    <PermissionGate module="automation" fallback={<Badge className="ml-auto" variant={enabled ? "success" : "secondary"}>{enabled ? "on" : "off"}</Badge>}>
                      <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                        <input type="checkbox" checked={enabled} onChange={(e) => setRuleEnabled(rule.id, e.target.checked)} className="accent-primary" />
                        {enabled ? "on" : "off"}
                      </label>
                    </PermissionGate>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <b className="text-foreground/80">When</b> {rule.trigger.toLowerCase()} → <b className="text-foreground/80">then</b> {rule.action.toLowerCase()}.
                  </p>
                  {meta && rule.thresholdKey && (
                    <div className="mt-2 flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">{meta.label}:</span>
                      {editable ? (
                        <input
                          type="number"
                          className="h-7 w-20 rounded-md border bg-background px-2 tabular-nums"
                          min={meta.kind === "pct" ? meta.min * 100 : meta.min}
                          max={meta.kind === "pct" ? meta.max * 100 : meta.max}
                          step={meta.kind === "pct" ? meta.step * 100 : meta.step}
                          value={meta.kind === "pct" ? Math.round(thresholds[rule.thresholdKey] * 100) : thresholds[rule.thresholdKey]}
                          onChange={(e) => {
                            const raw = +e.target.value
                            if (Number.isFinite(raw)) setThreshold(rule.thresholdKey!, meta.kind === "pct" ? raw / 100 : raw)
                          }}
                        />
                      ) : (
                        <b>{fmtThreshold(rule.thresholdKey)}</b>
                      )}
                      <span className="text-muted-foreground">{meta.kind === "pct" ? "%" : meta.kind === "mins" ? "minutes" : "SL pp"}</span>
                    </div>
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="glass">
            <CardHeader>
              <CardTitle>Recent pipeline runs</CardTitle>
            </CardHeader>
            <CardContent className="max-h-72 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Dur.</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Output</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.slice(0, 14).map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{jobName(r.jobId)}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{fmtAgo(r.at, now)}</TableCell>
                      <TableCell className="tabular-nums">{r.durationSec}s</TableCell>
                      <TableCell>
                        <Badge variant={r.status === "success" ? "success" : r.status === "warning" ? "warning" : "destructive"}>{r.status}</Badge>
                      </TableCell>
                      <TableCell className="max-w-56 truncate text-xs text-muted-foreground" title={r.note}>{r.note}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="glass">
            <CardHeader>
              <CardTitle>Automated decision feed</CardTitle>
              <p className="text-xs text-muted-foreground">Rule-engine outcomes recorded in the immutable audit trail.</p>
            </CardHeader>
            <CardContent>
              {decisions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No automated decisions logged yet — approve an intraday action, auto-approve a swap, or import actuals to see them land here.
                </p>
              ) : (
                <div className="max-h-64 space-y-1.5 overflow-auto pr-1">
                  {decisions.slice(0, 12).map((d) => (
                    <div key={d.id} className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
                      <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal-600" />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{d.action}</div>
                        <div className="truncate text-xs text-muted-foreground">{d.detail} · {new Date(d.ts).toLocaleTimeString()}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
