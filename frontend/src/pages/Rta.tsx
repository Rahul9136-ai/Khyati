import { useEffect, useMemo, useState } from "react"

import { AiSummary } from "@/components/ai-summary"
import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Activity, PhoneCall, UserX, Zap } from "lucide-react"
import { agentAdherencePct, AUX, AUX_BY_CODE, inAdherence } from "@/lib/domain/seed"
import { buildPlan, fmtPct } from "@/lib/domain/planning"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`

export function Rta() {
  const { agents, rta, recallAgent, recallMany, forecasts, shrinkage, nowIdx, queues } = useWfm()
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
          return { ...r, agent: byId[r.id], aux: AUX_BY_CODE[r.actual], live, adh: agentAdherencePct({ ...r, secs: live }) }
        })
        .filter((r) => r.agent),
    [rta, byId, tick],
  )

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

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Adherence" value={fmtPct(stats.adherence)} hint={`${stats.inAdh}/${stats.total} on plan`} tone={stats.adherence >= 0.9 ? "good" : stats.adherence >= 0.8 ? "warn" : "bad"} icon={Activity} />
        <KpiCard label="On the phones" value={stats.onPhone} hint="available + ACW" tone="good" icon={PhoneCall} />
        <KpiCard label="Off-plan now" value={stats.outAdh} hint="actual ≠ schedule" tone={stats.outAdh === 0 ? "good" : "bad"} icon={UserX} />
        <KpiCard label="Live SL risk" value={slAtRisk ? "AT RISK" : "STABLE"} hint={slAtRisk ? `${pressured.length} queue(s)` : "within target"} tone={slAtRisk ? "bad" : "good"} icon={Zap} />
      </div>

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
