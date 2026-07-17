import { useMemo, useState } from "react"
import { CheckCircle2, ClipboardCheck, Clock3, ShieldCheck, UserX } from "lucide-react"

import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  buildAgentDay,
  DAY_END,
  DAY_MINS,
  DAY_START,
  fmtMin,
  scoreAgentDay,
  type TimelineSeg,
} from "@/lib/domain/adherence"
import { fmtPct } from "@/lib/domain/planning"
import { AUX_BY_CODE } from "@/lib/domain/seed"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

function Bar({ segs, dim }: { segs: TimelineSeg[]; dim?: boolean }) {
  return (
    <div className={cn("relative h-3.5 w-full overflow-hidden rounded-sm bg-muted", dim && "opacity-70")}>
      {segs.map((s, i) => (
        <div
          key={i}
          title={`${AUX_BY_CODE[s.code]?.label ?? s.code} ${fmtMin(s.startMin)}–${fmtMin(s.endMin)}`}
          className="absolute top-0 h-full"
          style={{
            left: `${((s.startMin - DAY_START) / DAY_MINS) * 100}%`,
            width: `${((s.endMin - s.startMin) / DAY_MINS) * 100}%`,
            background: AUX_BY_CODE[s.code]?.color ?? "#64748b",
          }}
        />
      ))}
    </div>
  )
}

export function Adherence() {
  const { agents, shiftPatterns, breakOverrides, exceptions, setExceptionStatus, thresholds, nowIdx } = useWfm()
  const [teamFilter, setTeamFilter] = useState<string>("all")
  const teams = useMemo(() => [...new Set(agents.map((a) => a.team))], [agents])

  const days = useMemo(
    () => agents.map((a) => ({ agent: a, day: buildAgentDay(a, shiftPatterns, breakOverrides) })),
    [agents, shiftPatterns, breakOverrides],
  )
  const scores = useMemo(
    () => days.map(({ agent, day }) => ({ agent, day, score: scoreAgentDay(day, exceptions) })),
    [days, exceptions],
  )
  const visible = teamFilter === "all" ? scores : scores.filter((s) => s.agent.team === teamFilter)

  const totals = useMemo(() => {
    const sched = scores.reduce((a, s) => a + s.score.schedMins, 0)
    const adh = scores.reduce((a, s) => a + s.score.adherentMins, 0)
    const worked = scores.reduce((a, s) => a + s.score.workedMins, 0)
    const schedWork = scores.reduce((a, s) => a + s.score.schedWorkMins, 0)
    const exMins = scores.reduce((a, s) => a + s.score.exceptionMins, 0)
    const below = scores.filter((s) => s.score.adherence < thresholds.adherenceTarget).length
    return {
      adherence: sched ? adh / sched : 1,
      conformance: schedWork ? worked / schedWork : 1,
      exMins,
      below,
    }
  }, [scores, thresholds.adherenceTarget])

  const teamRows = useMemo(
    () =>
      teams.map((t) => {
        const rows = scores.filter((s) => s.agent.team === t)
        const sched = rows.reduce((a, s) => a + s.score.schedMins, 0)
        const adh = rows.reduce((a, s) => a + s.score.adherentMins, 0)
        const worked = rows.reduce((a, s) => a + s.score.workedMins, 0)
        const schedWork = rows.reduce((a, s) => a + s.score.schedWorkMins, 0)
        return {
          team: t,
          tl: rows[0]?.agent.tl ?? "—",
          agents: rows.length,
          adherence: sched ? adh / sched : 1,
          conformance: schedWork ? worked / schedWork : 1,
          below: rows.filter((s) => s.score.adherence < thresholds.adherenceTarget).length,
        }
      }),
    [teams, scores, thresholds.adherenceTarget],
  )

  const pending = exceptions.filter((e) => e.status === "Pending")
  const nowMin = DAY_START + (nowIdx + 1) * 30
  const agentById = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents])

  // Hour ticks for the Gantt header.
  const ticks = Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => DAY_START + i * 60)

  return (
    <>
      <PageHeader
        title="Adherence & Scorecards"
        subtitle={`Schedule vs actual timelines · exceptions auto-applied · target ${fmtPct(thresholds.adherenceTarget)}`}
        actions={
          <>
            <select
              value={teamFilter}
              onChange={(e) => setTeamFilter(e.target.value)}
              className="h-9 rounded-md border bg-background px-3 text-sm"
            >
              <option value="all">All teams</option>
              {teams.map((t) => (
                <option key={t} value={t}>Team {t}</option>
              ))}
            </select>
            <ExportButton
              filename="adherence-scorecards"
              sheets={() => [
                { name: "Agent Scorecards", rows: scores.map(({ agent, score }) => ({
                  Agent: agent.name, Team: agent.team, Shift: agent.shift,
                  "Scheduled (min)": score.schedMins, "Off-plan (min)": score.offPlanMins,
                  "Exception (min)": score.exceptionMins, "Adherence %": fmtPct(score.adherence),
                  "Conformance %": fmtPct(score.conformance),
                  Status: score.adherence >= thresholds.adherenceTarget ? "On target" : "Below target",
                })) },
                { name: "Team Scorecards", rows: teamRows.map((t) => ({
                  Team: t.team, "Team Lead": t.tl, Agents: t.agents,
                  "Adherence %": fmtPct(t.adherence), "Conformance %": fmtPct(t.conformance), "Below target": t.below,
                })) },
                { name: "Exceptions", rows: exceptions.map((e) => ({
                  Agent: agentById[e.agentId]?.name ?? e.agentId, Activity: AUX_BY_CODE[e.code]?.label ?? e.code,
                  Window: `${fmtMin(e.startMin)}–${fmtMin(e.endMin)}`, Reason: e.reason,
                  "Requested by": e.requestedBy, Status: e.status,
                })) },
              ]}
            />
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Adherence (EOD)" value={fmtPct(totals.adherence)} hint={`target ${fmtPct(thresholds.adherenceTarget)}`} tone={totals.adherence >= thresholds.adherenceTarget ? "good" : "bad"} icon={ShieldCheck} />
        <KpiCard label="Conformance (EOD)" value={fmtPct(totals.conformance)} hint="worked ÷ scheduled productive" tone={totals.conformance >= 0.95 ? "good" : "warn"} icon={ClipboardCheck} />
        <KpiCard label="Below target" value={totals.below} hint={`of ${scores.length} agents`} tone={totals.below === 0 ? "good" : totals.below <= 3 ? "warn" : "bad"} icon={UserX} />
        <KpiCard label="Exception minutes" value={totals.exMins} hint={`${pending.length} pending approval`} tone={pending.length ? "warn" : "good"} icon={Clock3} />
      </div>

      <Card className="glass mt-4">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle>Agent adherence timeline (Gantt)</CardTitle>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {Object.values(AUX_BY_CODE).map((a) => (
              <span key={a.code} className="flex items-center gap-1">
                <i className="h-2.5 w-2.5 rounded-sm" style={{ background: a.color }} /> {a.label}
              </span>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <div className="relative">
            <div className="mb-1 ml-44 flex justify-between text-[10px] tabular-nums text-muted-foreground">
              {ticks.map((t) => (
                <span key={t}>{fmtMin(t)}</span>
              ))}
            </div>
            <div className="max-h-[26rem] space-y-2 overflow-y-auto pr-1">
              {visible.map(({ agent, day, score }) => (
                <div key={agent.id} className="flex items-center gap-2">
                  <div className="w-44 shrink-0">
                    <div className="truncate text-xs font-semibold">{agent.name}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {agent.team} · adh{" "}
                      <b className={score.adherence >= thresholds.adherenceTarget ? "text-teal-600" : "text-destructive"}>
                        {fmtPct(score.adherence)}
                      </b>
                    </div>
                  </div>
                  <div className="relative flex-1 space-y-0.5">
                    <Bar segs={day.scheduled} dim />
                    <Bar segs={day.actual} />
                    <div
                      className="pointer-events-none absolute -top-0.5 bottom-0 w-px bg-foreground/60"
                      style={{ left: `${(Math.min(nowMin - DAY_START, DAY_MINS) / DAY_MINS) * 100}%` }}
                      title={`now ${fmtMin(nowMin)}`}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Top bar = scheduled, bottom bar = actual (simulated ACD feed) · vertical line = now · approved exceptions count as adherent.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card className="glass">
          <CardHeader>
            <CardTitle>Exception management</CardTitle>
            <p className="text-xs text-muted-foreground">
              Approved activities (coaching, meetings…) are automatically credited in the adherence math.
            </p>
          </CardHeader>
          <CardContent>
            {exceptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No exceptions raised today.</p>
            ) : (
              <div className="max-h-80 space-y-1.5 overflow-auto pr-1">
                {exceptions.map((e) => (
                  <div key={e.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: AUX_BY_CODE[e.code]?.color }} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {agentById[e.agentId]?.name ?? e.agentId}
                        <span className="font-normal text-muted-foreground"> · {AUX_BY_CODE[e.code]?.label} {fmtMin(e.startMin)}–{fmtMin(e.endMin)}</span>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{e.reason} · raised by {e.requestedBy}</div>
                    </div>
                    {e.status === "Pending" ? (
                      <PermissionGate module="adherence" fallback={<Badge variant="warning">pending</Badge>}>
                        <Button size="sm" variant="outline" onClick={() => setExceptionStatus(e.id, "Approved")}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setExceptionStatus(e.id, "Denied")}>
                          Deny
                        </Button>
                      </PermissionGate>
                    ) : (
                      <Badge variant={e.status === "Approved" ? "success" : "destructive"}>{e.status.toLowerCase()}</Badge>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="glass">
          <CardHeader>
            <CardTitle>Team scorecards (end of day)</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Team</TableHead>
                  <TableHead>TL</TableHead>
                  <TableHead>Agents</TableHead>
                  <TableHead>Adherence</TableHead>
                  <TableHead>Conformance</TableHead>
                  <TableHead>Below target</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {teamRows.map((t) => (
                  <TableRow key={t.team}>
                    <TableCell className="font-medium">Team {t.team}</TableCell>
                    <TableCell>{t.tl}</TableCell>
                    <TableCell>{t.agents}</TableCell>
                    <TableCell className={cn("font-semibold", t.adherence >= thresholds.adherenceTarget ? "text-teal-600" : "text-destructive")}>
                      {fmtPct(t.adherence)}
                    </TableCell>
                    <TableCell>{fmtPct(t.conformance)}</TableCell>
                    <TableCell>{t.below || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card className="glass mt-4">
        <CardHeader>
          <CardTitle>Agent scorecards (end of day)</CardTitle>
        </CardHeader>
        <CardContent className="max-h-96 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>Shift</TableHead>
                <TableHead>Off-plan (min)</TableHead>
                <TableHead>Exception (min)</TableHead>
                <TableHead>Adherence</TableHead>
                <TableHead>Conformance</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...visible]
                .sort((a, b) => a.score.adherence - b.score.adherence)
                .map(({ agent, score }) => (
                  <TableRow key={agent.id}>
                    <TableCell className="font-medium">{agent.name}</TableCell>
                    <TableCell>{agent.team}</TableCell>
                    <TableCell className="tabular-nums">{agent.shift}</TableCell>
                    <TableCell>{score.offPlanMins}</TableCell>
                    <TableCell>{score.exceptionMins || "—"}</TableCell>
                    <TableCell className={cn("font-semibold", score.adherence >= thresholds.adherenceTarget ? "text-teal-600" : "text-destructive")}>
                      {fmtPct(score.adherence)}
                    </TableCell>
                    <TableCell>{fmtPct(score.conformance)}</TableCell>
                    <TableCell>
                      <Badge variant={score.adherence >= thresholds.adherenceTarget ? "success" : "destructive"}>
                        {score.adherence >= thresholds.adherenceTarget ? "on target" : "below target"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  )
}
