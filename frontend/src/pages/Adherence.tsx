import { useMemo, useState } from "react"
import { CheckCircle2, ClipboardCheck, Clock3, PlayCircle, Plus, ShieldCheck, UserX } from "lucide-react"

import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  buildAgentDay,
  DAY_END,
  DAY_MINS,
  DAY_START,
  fmtMin,
  inOfficeShrinkageByCode,
  scoreAgentDay,
  type RequestKind,
  type TimelineSeg,
} from "@/lib/domain/adherence"
import { effectiveSegments } from "@/lib/domain/breaks"
import { fmtPct } from "@/lib/domain/planning"
import { CAN_APPLY_ADHERENCE_REQUEST, CAN_APPROVE_ADHERENCE_REQUEST, CAN_RAISE_ADHERENCE_REQUEST } from "@/lib/domain/roles"
import { AUX, AUX_BY_CODE } from "@/lib/domain/seed"
import type { BreakType } from "@/lib/domain/shiftPatterns"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

const EXCEPTION_CODES = AUX.filter((a) => a.cat === "shrink")
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
const todayISO = () => new Date().toISOString().slice(0, 10)

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
  const {
    agents, shiftPatterns, breakOverrides, ptoRequests, exceptions,
    addException, setExceptionStatus, applyException,
    thresholds, nowIdx, currentUser, currentRole,
  } = useWfm()
  const [teamFilter, setTeamFilter] = useState<string>("all")
  const teams = useMemo(() => [...new Set(agents.map((a) => a.team))], [agents])
  const canRaise = CAN_RAISE_ADHERENCE_REQUEST.includes(currentRole)
  const canApprove = CAN_APPROVE_ADHERENCE_REQUEST.includes(currentRole)
  const canApply = CAN_APPLY_ADHERENCE_REQUEST.includes(currentRole)

  const [exOpen, setExOpen] = useState(false)
  const [exKind, setExKind] = useState<RequestKind>("exception")
  const [exAgentId, setExAgentId] = useState(agents[0]?.id ?? "")
  const [exCode, setExCode] = useState(EXCEPTION_CODES[0]?.code ?? "AUX3")
  const [exSegId, setExSegId] = useState("new")
  const [exSegType, setExSegType] = useState<BreakType>("break")
  const [exFrom, setExFrom] = useState(toHHMM(DAY_START + 240))
  const [exTo, setExTo] = useState(toHHMM(DAY_START + 260))
  const [exReason, setExReason] = useState("")
  const [exError, setExError] = useState("")

  const exAgentSegs = useMemo(() => {
    const agent = agents.find((a) => a.id === exAgentId)
    return agent ? effectiveSegments(agent, shiftPatterns, breakOverrides) : []
  }, [agents, exAgentId, shiftPatterns, breakOverrides])

  function resetExForm() {
    setExKind("exception")
    setExAgentId(agents[0]?.id ?? "")
    setExCode(EXCEPTION_CODES[0]?.code ?? "AUX3")
    setExSegId("new")
    setExSegType("break")
    setExFrom(toHHMM(DAY_START + 240))
    setExTo(toHHMM(DAY_START + 260))
    setExReason("")
    setExError("")
  }

  function submitException() {
    const startMin = toMin(exFrom)
    const endMin = toMin(exTo)
    if (!exAgentId) return setExError("Select an employee.")
    if (endMin <= startMin) return setExError("End time must be after the start time.")
    if (startMin < DAY_START || endMin > DAY_END) return setExError(`Window must fall within ${fmtMin(DAY_START)}–${fmtMin(DAY_END)}.`)
    if (!exReason.trim()) return setExError("A reason is required — it's what the approver reviews.")
    if (exKind === "exception") {
      addException({ kind: "exception", agentId: exAgentId, code: exCode, startMin, endMin, reason: exReason.trim(), requestedBy: currentUser })
    } else {
      addException({ kind: "breakChange", agentId: exAgentId, code: exSegType === "lunch" ? "AUX2" : "AUX1", segId: exSegId, segType: exSegType, startMin, endMin, reason: exReason.trim(), requestedBy: currentUser })
    }
    resetExForm()
    setExOpen(false)
  }

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
  const approved = exceptions.filter((e) => e.status === "Approved")
  const nowMin = DAY_START + (nowIdx + 1) * 30
  const agentById = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents])

  // In-office shrinkage: scheduled break/lunch/meeting/training/coaching minutes,
  // by AUX code — time spent shrinking while still physically at work.
  const inOfficeShrinkage = useMemo(() => {
    const totals = inOfficeShrinkageByCode(days.map((d) => d.day))
    return Object.entries(totals)
      .map(([code, mins]) => ({ code, mins, label: AUX_BY_CODE[code]?.label ?? code, color: AUX_BY_CODE[code]?.color }))
      .sort((a, b) => b.mins - a.mins)
  }, [days])
  const inOfficeTotal = inOfficeShrinkage.reduce((a, s) => a + s.mins, 0)

  // Out-of-office shrinkage: agents on approved/auto-approved leave that covers today.
  const outOfOffice = useMemo(() => {
    const today = todayISO()
    return ptoRequests
      .filter((r) => (r.status === "Approved" || r.status === "Auto-Approved") && r.from <= today && r.to >= today)
      .map((r) => ({ ...r, agentName: agentById[r.agentId]?.name ?? r.agentId, team: agentById[r.agentId]?.team ?? "—" }))
  }, [ptoRequests, agentById])

  // Hour ticks for the Gantt header.
  const ticks = Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => DAY_START + i * 60)

  return (
    <>
      <PageHeader
        title="Adherence & Scorecards"
        subtitle={`Schedule vs actual timelines · raise → approve → apply · target ${fmtPct(thresholds.adherenceTarget)}`}
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
        <KpiCard label="Exception minutes" value={totals.exMins} hint={`${pending.length} to approve · ${approved.length} to apply`} tone={pending.length || approved.length ? "warn" : "good"} icon={Clock3} />
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
              Top bar = scheduled, bottom bar = actual (simulated ACD feed) · vertical line = now · applied exceptions count as adherent.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card className="glass">
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle>Adherence & shrinkage requests</CardTitle>
              <p className="text-xs text-muted-foreground">
                Raise (Agent/TL) → Approve (Ops Manager/Business Admin) → Apply (RTA/Scheduler/Planner) — only an Applied
                request counts toward adherence or moves a break.
              </p>
            </div>
            {canRaise && (
              <Button size="sm" onClick={() => { resetExForm(); setExOpen(true) }}>
                <Plus className="h-4 w-4" /> Raise request
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {exceptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No requests raised today.</p>
            ) : (
              <div className="max-h-80 space-y-1.5 overflow-auto pr-1">
                {exceptions.map((e) => (
                  <div key={e.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: AUX_BY_CODE[e.code]?.color }} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {agentById[e.agentId]?.name ?? e.agentId}
                        <span className="font-normal text-muted-foreground">
                          {" "}· {e.kind === "breakChange" ? "Break/shrinkage change" : AUX_BY_CODE[e.code]?.label} {fmtMin(e.startMin)}–{fmtMin(e.endMin)}
                        </span>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{e.reason} · raised by {e.requestedBy}</div>
                    </div>
                    {e.status === "Pending" && canApprove && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => setExceptionStatus(e.id, "Approved")}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setExceptionStatus(e.id, "Denied")}>
                          Deny
                        </Button>
                      </>
                    )}
                    {e.status === "Approved" && canApply && (
                      <Button size="sm" variant="outline" onClick={() => applyException(e.id)}>
                        <PlayCircle className="h-3.5 w-3.5" /> Apply
                      </Button>
                    )}
                    {(e.status !== "Pending" || !canApprove) && (e.status !== "Approved" || !canApply) && (
                      <Badge variant={e.status === "Applied" ? "success" : e.status === "Approved" ? "warning" : e.status === "Denied" ? "destructive" : "warning"}>
                        {e.status.toLowerCase()}
                      </Badge>
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

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card className="glass">
          <CardHeader>
            <CardTitle>In-office shrinkage</CardTitle>
            <p className="text-xs text-muted-foreground">
              Scheduled break/lunch/meeting/training/coaching minutes today — shrinkage while still at work.
            </p>
          </CardHeader>
          <CardContent>
            {inOfficeShrinkage.length === 0 ? (
              <p className="text-sm text-muted-foreground">No shrinkage scheduled.</p>
            ) : (
              <div className="space-y-2">
                {inOfficeShrinkage.map((s) => (
                  <div key={s.code} className="flex items-center gap-2 text-sm">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    <span className="tabular-nums text-muted-foreground">{s.mins} min</span>
                    <span className="w-12 shrink-0 text-right font-semibold tabular-nums">{fmtPct(inOfficeTotal ? s.mins / inOfficeTotal : 0)}</span>
                  </div>
                ))}
                <div className="mt-1 flex items-center justify-between border-t pt-2 text-sm font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">{inOfficeTotal} min</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="glass">
          <CardHeader>
            <CardTitle>Out-of-office shrinkage</CardTitle>
            <p className="text-xs text-muted-foreground">Agents on approved PTO/leave covering today.</p>
          </CardHeader>
          <CardContent>
            {outOfOffice.length === 0 ? (
              <p className="text-sm text-muted-foreground">No one is on approved leave today.</p>
            ) : (
              <div className="max-h-64 space-y-1.5 overflow-auto pr-1">
                {outOfOffice.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{r.agentName}</div>
                      <div className="truncate text-xs text-muted-foreground">Team {r.team} · {r.type} · {r.from}–{r.to}</div>
                    </div>
                    <Badge variant={r.status === "Auto-Approved" ? "secondary" : "success"}>{r.status.toLowerCase()}</Badge>
                  </div>
                ))}
                <div className="mt-1 flex items-center justify-between border-t pt-2 text-sm font-semibold">
                  <span>Agents out today</span>
                  <span className="tabular-nums">{outOfOffice.length}</span>
                </div>
              </div>
            )}
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

      <Dialog
        open={exOpen}
        onClose={() => setExOpen(false)}
        title="Raise a request"
        description="An adherence exception credits off-schedule time once applied; a break/shrinkage change moves or adds a break/lunch segment once applied."
        footer={
          <>
            <Button variant="outline" onClick={() => setExOpen(false)}>Cancel</Button>
            <Button onClick={submitException}><Plus className="h-4 w-4" /> Raise request</Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Request type</span>
            <Select
              value={exKind}
              onChange={(e) => setExKind(e.target.value as RequestKind)}
              options={[
                { value: "exception", label: "Adherence exception (justified off-schedule activity)" },
                { value: "breakChange", label: "Break / in-office shrinkage change" },
              ]}
              className="w-full"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Employee</span>
            <Select value={exAgentId} onChange={(e) => { setExAgentId(e.target.value); setExSegId("new"); setExError("") }} options={agents.map((a) => ({ value: a.id, label: `${a.name} · ${a.team}` }))} className="w-full" />
          </label>
          {exKind === "exception" ? (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Activity</span>
              <Select value={exCode} onChange={(e) => setExCode(e.target.value)} options={EXCEPTION_CODES.map((a) => ({ value: a.code, label: a.label }))} className="w-full" />
            </label>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Segment</span>
                <Select
                  value={exSegId}
                  onChange={(e) => setExSegId(e.target.value)}
                  options={[
                    ...exAgentSegs.map((s) => ({ value: s.id, label: `Move: ${s.label} (${toHHMM(DAY_START + s.offsetMinutes)}–${toHHMM(DAY_START + s.offsetMinutes + s.durationMinutes)})` })),
                    { value: "new", label: "Add a new segment" },
                  ]}
                  className="w-full"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Type</span>
                <Select value={exSegType} onChange={(e) => setExSegType(e.target.value as BreakType)} options={[{ value: "break", label: "Break" }, { value: "lunch", label: "Lunch" }]} className="w-full" />
              </label>
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{exKind === "exception" ? "From" : "New start"}</span>
              <input
                type="time"
                value={exFrom}
                onChange={(e) => { setExFrom(e.target.value); setExError("") }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{exKind === "exception" ? "To" : "New end"}</span>
              <input
                type="time"
                value={exTo}
                onChange={(e) => { setExTo(e.target.value); setExError("") }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Reason</span>
            <Input value={exReason} onChange={(e) => { setExReason(e.target.value); setExError("") }} placeholder="e.g. Ad-hoc QA coaching requested by TL" />
          </label>
          <p className="text-xs text-muted-foreground">
            Goes to an Operations Manager or Business Admin to approve, then an RTA, Scheduler or Planner to apply before it counts.
          </p>
          {exError && <p className="text-sm text-destructive">{exError}</p>}
        </div>
      </Dialog>
    </>
  )
}
