import { useEffect, useMemo, useState } from "react"

import { AiSummary } from "@/components/ai-summary"
import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ArrowRight, Activity, ClipboardCheck, PhoneCall, RefreshCw, Siren, UserX, Zap } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { buildAgentDay, DAY_START, escalationFor, scoreAgentDay, type EscalationLevel } from "@/lib/domain/adherence"
import { agentAdherencePct, AUX, AUX_BY_CODE, inAdherence } from "@/lib/domain/seed"
import { buildPlan, fmtPct } from "@/lib/domain/planning"
import { CAN_APPROVE_SKILL_CHANGE_OPS, CAN_APPROVE_SKILL_CHANGE_WFM } from "@/lib/domain/roles"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`

export function Rta() {
  const {
    agents, rta, recallAgent, recallMany, forecasts, shrinkage, nowIdx, queues, thresholds,
    shiftPatterns, breakOverrides, ruleState, currentRole,
    skillChangeRecommendations, scanSkillRecommendations, approveSkillChange, rejectSkillChange,
  } = useWfm()
  const byId = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents])

  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const [surge, setSurge] = useState(true)

  const underQueues = useMemo(
    () =>
      queues.filter((q) => {
        const plan = buildPlan(forecasts[q.id], q.aht, q, shrinkage, agents)
        return plan[nowIdx].variance < 0
      }).map((q) => q.id),
    [forecasts, shrinkage, agents, nowIdx, queues],
  )
  const slAtRisk = surge || underQueues.length > 0
  const pressured = surge ? queues.map((q) => q.id) : underQueues

  const live = useMemo(
    () =>
      rta
        .map((r) => {
          const live = r.recalled ? tick : r.secs + tick
          const off = !inAdherence(r.actual, r.scheduled)
          return {
            ...r,
            agent: byId[r.id],
            aux: AUX_BY_CODE[r.actual],
            live,
            adh: agentAdherencePct({ ...r, secs: live }),
            level: escalationFor(off, live, thresholds.graceMins, thresholds.escalateMins) as EscalationLevel,
          }
        })
        .filter((r) => r.agent),
    [rta, byId, tick, thresholds.graceMins, thresholds.escalateMins],
  )

  // Escalation ladder: grace → flagged → escalated-to-TL, per configured windows.
  const ladder = useMemo(() => {
    const off = live.filter((r) => r.level !== "in").sort((a, b) => b.live - a.live)
    return {
      grace: off.filter((r) => r.level === "grace"),
      flagged: off.filter((r) => r.level === "flagged"),
      escalated: off.filter((r) => r.level === "escalated"),
    }
  }, [live])

  // Live conformance: productive minutes delivered ÷ scheduled, up to "now".
  const conformance = useMemo(() => {
    const nowMin = DAY_START + (nowIdx + 1) * 30
    let worked = 0
    let schedWork = 0
    for (const a of agents) {
      const s = scoreAgentDay(buildAgentDay(a, shiftPatterns, breakOverrides), [], nowMin)
      worked += s.workedMins
      schedWork += s.schedWorkMins
    }
    return schedWork ? worked / schedWork : 1
  }, [agents, shiftPatterns, breakOverrides, nowIdx])

  const recs = useMemo(() => {
    if (!slAtRisk) return []
    return live
      .filter((r) => r.aux?.deferrable && !r.recalled)
      .filter((r) => r.agent.skills.some((s) => pressured.includes(s)))
      .sort((a, b) => b.live - a.live)
      .map((r) => ({ id: r.id, name: r.agent.name, tl: r.agent.tl, aux: r.aux.label, helps: r.agent.skills.filter((s) => pressured.includes(s)) }))
  }, [live, slAtRisk, pressured])

  const stats = useMemo(() => {
    const total = live.length
    const inAdh = live.filter((r) => inAdherence(r.actual, r.scheduled)).length
    const cat = (c: string) => live.filter((r) => r.aux?.cat === c).length
    return { total, inAdh, outAdh: total - inAdh, adherence: total ? inAdh / total : 0, onPhone: cat("productive"), offline: cat("offline") }
  }, [live])

  const dist = AUX.map((a) => ({ ...a, count: live.filter((r) => r.actual === a.code).length })).filter((a) => a.count)

  const queueById = useMemo(() => Object.fromEntries(queues.map((q) => [q.id, q])), [queues])
  const canApproveWfm = CAN_APPROVE_SKILL_CHANGE_WFM.includes(currentRole)
  const canApproveOps = CAN_APPROVE_SKILL_CHANGE_OPS.includes(currentRole)
  const pendingSkillChanges = skillChangeRecommendations.filter((r) => r.status === "Pending")
  const decidedSkillChanges = skillChangeRecommendations.filter((r) => r.status !== "Pending").slice(0, 5)

  const insight = {
    headline: slAtRisk ? `SL at risk: ${recs.length} break recall${recs.length === 1 ? "" : "s"} recommended.` : `Floor healthy — ${fmtPct(stats.adherence)} adherence, ${stats.onPhone} on the phones.`,
    bullets: [
      `${stats.inAdh}/${stats.total} in adherence; ${stats.outAdh} off-plan now.`,
      recs.length ? `Recall ${recs.slice(0, 3).map((r) => r.name.split(" ")[0]).join(", ")}${recs.length > 3 ? ` +${recs.length - 3}` : ""} — flag TLs ${[...new Set(recs.map((r) => r.tl))].join(", ")}.` : "All scheduled breaks within plan.",
      `${stats.onPhone} on the phones · ${stats.offline} logged out.`,
    ],
    tone: slAtRisk ? ("warn" as const) : ("good" as const),
  }

  return (
    <>
      <PageHeader
        title="Real-Time Monitor (RTA)"
        subtitle="AUX wallboard · live adherence · AI break recovery"
        actions={
          <ExportButton
            filename="realtime-adherence"
            sheets={() => [
              { name: "KPIs", rows: [
                { Metric: "Adherence", Value: fmtPct(stats.adherence) },
                { Metric: "In adherence", Value: `${stats.inAdh}/${stats.total}` },
                { Metric: "Off-plan", Value: stats.outAdh },
                { Metric: "On the phones", Value: stats.onPhone },
                { Metric: "Logged out", Value: stats.offline },
                { Metric: "SL risk", Value: slAtRisk ? "At risk" : "Stable" },
              ] },
              { name: "AUX Distribution", rows: dist.map((a) => ({ Code: a.code, State: a.label, Category: a.cat, Agents: a.count })) },
              { name: "Agent States", rows: live.map((r) => ({ Name: r.agent.name, Team: r.agent.team, "Actual state": r.aux?.label, "Scheduled state": AUX_BY_CODE[r.scheduled]?.label, Adherence: inAdherence(r.actual, r.scheduled) ? "In" : "Out", "Adherence %": fmtPct(r.adh), "Time (s)": r.live })) },
              { name: "Break Recovery", rows: recs.map((r) => ({ Name: r.name, "On break": r.aux, "Team Lead": r.tl, Helps: r.helps.map((h) => queues.find((q) => q.id === h)?.name).join(", ") })) },
            ]}
          />
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <KpiCard label="Adherence" value={fmtPct(stats.adherence)} hint={`${stats.inAdh}/${stats.total} on plan`} tone={stats.adherence >= thresholds.adherenceTarget ? "good" : stats.adherence >= 0.8 ? "warn" : "bad"} icon={Activity} />
        <KpiCard label="Conformance" value={fmtPct(conformance)} hint="worked ÷ scheduled, to now" tone={conformance >= 0.95 ? "good" : "warn"} icon={ClipboardCheck} />
        <KpiCard label="On the phones" value={stats.onPhone} hint="available + ACW" tone="good" icon={PhoneCall} />
        <KpiCard label="Off-plan now" value={stats.outAdh} hint={`${ladder.escalated.length} escalated to TL`} tone={ladder.escalated.length ? "bad" : stats.outAdh ? "warn" : "good"} icon={UserX} />
        <KpiCard label="Live SL risk" value={slAtRisk ? "AT RISK" : "STABLE"} hint={slAtRisk ? `${pressured.length} queue(s)` : "within target"} tone={slAtRisk ? "bad" : "good"} icon={Zap} />
      </div>

      <Card className={cn("glass mt-4", ladder.escalated.length && "border-destructive/50")}>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex items-center gap-2">
            <Siren className="h-4 w-4 text-destructive" /> Adherence escalations
          </CardTitle>
          <span className="text-xs text-muted-foreground">
            grace {thresholds.graceMins} min → flag → escalate to TL at {thresholds.escalateMins} min
            {ruleState["adherence-escalation"] === false && " · rule disabled"}
          </span>
        </CardHeader>
        <CardContent>
          {ruleState["adherence-escalation"] === false ? (
            <p className="text-sm text-muted-foreground">Escalation rule is switched off in the Automation Center.</p>
          ) : ladder.flagged.length + ladder.escalated.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No agents past the grace period{ladder.grace.length ? ` — ${ladder.grace.length} within grace, watching` : ""}.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {[...ladder.escalated, ...ladder.flagged].map((r) => (
                <div key={r.id} className={cn("rounded-lg border p-3", r.level === "escalated" ? "border-destructive/50" : "border-amber-600/40")}>
                  <div className="flex items-center justify-between">
                    <span className="truncate text-sm font-semibold">{r.agent.name}</span>
                    <span className={cn("text-[10px] font-bold uppercase", r.level === "escalated" ? "text-destructive" : "text-amber-600")}>
                      {r.level}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {r.aux?.label} instead of {AUX_BY_CODE[r.scheduled]?.label} · {fmtTime(r.live)} off-plan
                  </div>
                  <div className="mt-1 text-xs">
                    {r.level === "escalated" ? (
                      <span className="font-medium text-destructive">TL {r.agent.tl} notified</span>
                    ) : (
                      <span className="text-muted-foreground">escalates to {r.agent.tl} at {thresholds.escalateMins}:00</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <AiSummary insight={insight} title="AI Real-Time Summary" />
        <Card className={cn("glass", slAtRisk && "border-amber-500/40")}>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>⚡ AI Break Recovery</CardTitle>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={surge} onChange={(e) => setSurge(e.target.checked)} /> simulate surge
            </label>
          </CardHeader>
          <CardContent>
            {!slAtRisk ? (
              <p className="text-sm text-muted-foreground">Service level holding — no break recalls needed.</p>
            ) : recs.length === 0 ? (
              <p className="text-sm text-destructive">SL at risk but no deferrable breaks — escalate for overtime.</p>
            ) : (
              <>
                <p className="mb-2 text-sm text-muted-foreground">Recall these agents — flagged to their TL. Lunch & training are protected.</p>
                <div className="space-y-1">
                  {recs.map((r) => (
                    <div key={r.id} className="flex items-center gap-3 border-b py-2 last:border-0">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">
                          {r.name} <span className="font-normal text-muted-foreground">· {r.aux}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          helps {r.helps.map((h) => queues.find((q) => q.id === h)?.name).join(", ")} · TL <b>{r.tl}</b>
                        </div>
                      </div>
                      <PermissionGate module="realtime" fallback={<span className="ml-auto text-xs text-muted-foreground">view only</span>}>
                        <Button size="sm" className="ml-auto" onClick={() => recallAgent(r.id)}>
                          Recall
                        </Button>
                      </PermissionGate>
                    </div>
                  ))}
                </div>
                <PermissionGate module="realtime">
                  <Button className="mt-3 w-full" onClick={() => recallMany(recs.map((r) => r.id))}>
                    Recall all {recs.length} & notify TLs
                  </Button>
                </PermissionGate>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="glass mt-4">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle>RTA skill re-balancing</CardTitle>
            <p className="text-xs text-muted-foreground">
              Runs automatically in the background — the moment SL drops or volume spikes on a queue, AI proposes
              moving an agent with the right skills from a queue running a surplus. It only switches once a WFM
              Manager <i>and</i> an Operations Manager have both approved.
            </p>
          </div>
          <PermissionGate module="realtime" fallback={<Badge variant="secondary">view only</Badge>}>
            <Button size="sm" variant="outline" onClick={() => scanSkillRecommendations()}>
              <RefreshCw className="h-4 w-4" /> Check now
            </Button>
          </PermissionGate>
        </CardHeader>
        <CardContent className="space-y-2">
          {pendingSkillChanges.length === 0 && decidedSkillChanges.length === 0 && (
            <p className="text-sm text-muted-foreground">Every queue is balanced right now — nothing to recommend.</p>
          )}
          {pendingSkillChanges.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-background/40 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {r.agentName}
                  <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                    <span className="rounded px-1.5 py-0.5" style={{ background: `${queueById[r.fromQueueId]?.color}26`, color: queueById[r.fromQueueId]?.color }}>{r.fromQueueName}</span>
                    <ArrowRight className="h-3 w-3" />
                    <span className="rounded px-1.5 py-0.5" style={{ background: `${queueById[r.toQueueId]?.color}26`, color: queueById[r.toQueueId]?.color }}>{r.toQueueName}</span>
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground" title={r.reason}>{r.reason}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <Badge variant={r.wfmApprovedBy ? "success" : "warning"}>WFM {r.wfmApprovedBy ? "✓" : "pending"}</Badge>
                <Badge variant={r.opsApprovedBy ? "success" : "warning"}>Ops {r.opsApprovedBy ? "✓" : "pending"}</Badge>
              </div>
              <div className="flex items-center gap-1.5">
                {canApproveWfm && !r.wfmApprovedBy && (
                  <Button size="sm" variant="outline" onClick={() => approveSkillChange(r.id, "wfm")}>Approve (WFM)</Button>
                )}
                {canApproveOps && !r.opsApprovedBy && (
                  <Button size="sm" variant="outline" onClick={() => approveSkillChange(r.id, "ops")}>Approve (Ops)</Button>
                )}
                {(canApproveWfm || canApproveOps) && (
                  <Button size="sm" variant="ghost" onClick={() => rejectSkillChange(r.id)}>Reject</Button>
                )}
              </div>
            </div>
          ))}
          {decidedSkillChanges.length > 0 && (
            <div className="border-t pt-2">
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Recent decisions</p>
              <div className="space-y-1.5">
                {decidedSkillChanges.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant={r.status === "Applied" ? "success" : "destructive"}>{r.status.toLowerCase()}</Badge>
                    <span className="text-muted-foreground">
                      {r.agentName} · {r.fromQueueName} → {r.toQueueName}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="glass mt-4">
        <CardHeader>
          <CardTitle>AUX state distribution</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          {dist.map((a) => (
            <span key={a.code} className="flex items-center gap-2">
              <i className="h-2.5 w-2.5 rounded" style={{ background: a.color }} /> {a.label} <b className="text-foreground">{a.count}</b>
            </span>
          ))}
        </CardContent>
      </Card>

      <Card className="glass mt-4">
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <CardTitle>Live agent board</CardTitle>
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
          <span className="text-xs text-muted-foreground">time-in-state ticking live</span>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {live.map((r) => {
              const off = !inAdherence(r.actual, r.scheduled)
              return (
                <div
                  key={r.id}
                  className={cn("relative rounded-lg border bg-card/60 p-3", off && "ring-1 ring-destructive/50", r.recalled && "ring-1 ring-emerald-500/60")}
                  style={{ borderLeft: `3px solid ${r.aux?.color}` }}
                >
                  {off && <span className="absolute right-2 top-2 text-[9px] font-bold text-destructive">OFF-PLAN</span>}
                  {r.recalled && <span className="absolute right-2 top-2 text-[9px] font-bold text-emerald-500">RECALLED</span>}
                  <div className="truncate text-sm font-semibold">{r.agent.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{r.agent.team} · {r.agent.skills.join("/")}</div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-semibold">
                      <span className="h-2 w-2 rounded-sm" style={{ background: r.aux?.color }} /> {r.aux?.code}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">{fmtTime(r.live)}</span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between border-t pt-1.5" title="Actual adherence to schedule today">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Adherence</span>
                    <span
                      className={cn(
                        "text-xs font-bold tabular-nums",
                        r.adh >= 0.95 ? "text-emerald-500" : r.adh >= 0.9 ? "text-amber-500" : "text-destructive",
                      )}
                    >
                      {fmtPct(r.adh)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>
    </>
  )
}
