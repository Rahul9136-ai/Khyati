import { useMemo, useState } from "react"
import { CalendarClock, Clock3, PlaneTakeoff, Plus, ShieldCheck, Star } from "lucide-react"
import { Link } from "react-router-dom"

import { KpiCard } from "@/components/kpi-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { DAY_END, DAY_START, fmtMin, type RequestKind } from "@/lib/domain/adherence"
import { effectiveSegments } from "@/lib/domain/breaks"
import { agentAdherencePct, AUX, AUX_BY_CODE } from "@/lib/domain/seed"
import { fmtPct } from "@/lib/domain/planning"
import type { BreakType } from "@/lib/domain/shiftPatterns"
import { useWfm } from "@/store/wfm"

const EXCEPTION_CODES = AUX.filter((a) => a.cat === "shrink")

const toMins = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}
const fmtClock = (mins: number) => {
  const h = Math.floor(mins / 60) % 24
  const m = mins % 60
  const period = h >= 12 ? "PM" : "AM"
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, "0")} ${period}`
}
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`

/** Self-service landing view for the Agent designation: only their own
 *  shift/breaks, adherence, and leave — never the wider roster or queue ops. */
export function AgentWorkspace({ agentId }: { agentId: string }) {
  const { agents, queues, rta, shiftPatterns, breakOverrides, ptoRequests, exceptions, addException, currentUser } = useWfm()
  const agent = agents.find((a) => a.id === agentId)
  const rtaEntry = rta.find((r) => r.id === agentId)

  const segments = useMemo(
    () => (agent ? effectiveSegments(agent, shiftPatterns, breakOverrides) : []),
    [agent, shiftPatterns, breakOverrides],
  )
  const adherence = rtaEntry ? agentAdherencePct(rtaEntry) : null

  const myPto = useMemo(
    () => ptoRequests.filter((r) => r.agentId === agentId).sort((a, b) => b.from.localeCompare(a.from)),
    [ptoRequests, agentId],
  )
  const pendingCount = myPto.filter((r) => r.status === "Pending").length
  const nextApproved = myPto.find((r) => (r.status === "Approved" || r.status === "Auto-Approved") && r.to >= new Date().toISOString().slice(0, 10))

  const myRequests = useMemo(
    () => exceptions.filter((e) => e.agentId === agentId),
    [exceptions, agentId],
  )

  const [reqOpen, setReqOpen] = useState(false)
  const [reqKind, setReqKind] = useState<RequestKind>("exception")
  const [reqCode, setReqCode] = useState(EXCEPTION_CODES[0]?.code ?? "AUX3")
  const [reqSegId, setReqSegId] = useState("new")
  const [reqSegType, setReqSegType] = useState<BreakType>("break")
  const [reqFrom, setReqFrom] = useState(toHHMM(DAY_START + 240))
  const [reqTo, setReqTo] = useState(toHHMM(DAY_START + 260))
  const [reqReason, setReqReason] = useState("")
  const [reqError, setReqError] = useState("")

  function resetReqForm() {
    setReqKind("exception")
    setReqCode(EXCEPTION_CODES[0]?.code ?? "AUX3")
    setReqSegId("new")
    setReqSegType("break")
    setReqFrom(toHHMM(DAY_START + 240))
    setReqTo(toHHMM(DAY_START + 260))
    setReqReason("")
    setReqError("")
  }

  function submitRequest() {
    const startMin = toMins(reqFrom)
    const endMin = toMins(reqTo)
    if (endMin <= startMin) return setReqError("End time must be after the start time.")
    if (startMin < DAY_START || endMin > DAY_END) return setReqError(`Window must fall within ${fmtMin(DAY_START)}–${fmtMin(DAY_END)}.`)
    if (!reqReason.trim()) return setReqError("A reason is required — it's what the approver reviews.")
    if (reqKind === "exception") {
      addException({ kind: "exception", agentId, code: reqCode, startMin, endMin, reason: reqReason.trim(), requestedBy: currentUser })
    } else {
      addException({ kind: "breakChange", agentId, code: reqSegType === "lunch" ? "AUX2" : "AUX1", segId: reqSegId, segType: reqSegType, startMin, endMin, reason: reqReason.trim(), requestedBy: currentUser })
    }
    resetReqForm()
    setReqOpen(false)
  }

  if (!agent) {
    return (
      <Card className="glass">
        <CardContent className="py-10 text-center text-muted-foreground">No agent record selected.</CardContent>
      </Card>
    )
  }

  const [shiftStart, shiftEnd] = agent.shift.split("–")
  const primarySkillId = agent.skills[0]
  const primarySkill = queues.find((q) => q.id === primarySkillId)

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Hi, {agent.name.split(" ")[0]}</h1>
          <p className="text-sm text-muted-foreground">
            {agent.team} · reports to {agent.tl} · self-service workspace
          </p>
        </div>
        <div className="flex gap-1.5">
          {agent.skills.map((s, i) => {
            const q = queues.find((x) => x.id === s)
            return (
              <Badge key={s} variant={i === 0 ? "success" : "secondary"}>
                {q?.name ?? s}
              </Badge>
            )
          })}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Today's shift" value={agent.shift} hint={primarySkill?.name ?? "unassigned"} icon={Clock3} />
        <KpiCard
          label="Adherence today"
          value={adherence != null ? fmtPct(adherence) : "—"}
          hint={rtaEntry ? "vs schedule" : "no live data"}
          tone={adherence == null ? undefined : adherence >= 0.95 ? "good" : adherence >= 0.9 ? "warn" : "bad"}
          icon={ShieldCheck}
        />
        <KpiCard label="Pending leave" value={pendingCount} hint="awaiting approval" tone={pendingCount ? "warn" : "good"} icon={CalendarClock} />
        <KpiCard label="Next approved leave" value={nextApproved ? nextApproved.from : "—"} hint={nextApproved ? nextApproved.type : "none scheduled"} icon={PlaneTakeoff} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="glass">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Clock3 className="h-4 w-4" /> Today's schedule</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between rounded-lg border bg-background/40 px-3 py-2 text-sm">
              <span className="font-medium">On queue</span>
              <span className="tabular-nums text-muted-foreground">{fmtClock(toMins(shiftStart))} – {fmtClock(toMins(shiftEnd))}</span>
            </div>
            {segments.map((seg) => {
              const at = toMins(shiftStart) + seg.offsetMinutes
              return (
                <div key={seg.id} className="flex items-center justify-between rounded-lg border bg-background/40 px-3 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${seg.type === "lunch" ? "bg-amber-500" : "bg-primary"}`} />
                    {seg.label}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {fmtClock(at)} – {fmtClock(at + seg.durationMinutes)}
                  </span>
                </div>
              )
            })}
            {segments.length === 0 && <p className="text-sm text-muted-foreground">No break pattern on file for this shift.</p>}
          </CardContent>
        </Card>

        <Card className="glass">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><PlaneTakeoff className="h-4 w-4" /> Your leave requests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {myPto.slice(0, 5).map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-lg border bg-background/40 px-3 py-2 text-sm">
                <span>
                  {r.type} <span className="text-muted-foreground">· {r.from} → {r.to}</span>
                </span>
                <Badge variant={r.status === "Denied" ? "destructive" : r.status === "Pending" ? "warning" : "success"}>{r.status}</Badge>
              </div>
            ))}
            {myPto.length === 0 && <p className="text-sm text-muted-foreground">No leave requests on file yet.</p>}
            <Button asChild variant="outline" className="mt-2 w-full">
              <Link to="/pto"><PlaneTakeoff className="h-4 w-4" /> Request time off</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="glass mt-4">
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Your adherence & shrinkage requests</CardTitle>
            <p className="text-xs text-muted-foreground">
              Goes to an Operations Manager or Business Admin to approve, then an RTA, Scheduler or Planner to apply.
            </p>
          </div>
          <Button size="sm" onClick={() => { resetReqForm(); setReqOpen(true) }}>
            <Plus className="h-4 w-4" /> Raise a request
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {myRequests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests raised yet.</p>
          ) : (
            myRequests.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border bg-background/40 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  {r.kind === "breakChange" ? "Break/shrinkage change" : AUX_BY_CODE[r.code]?.label}
                  <span className="text-muted-foreground"> · {fmtMin(r.startMin)}–{fmtMin(r.endMin)}</span>
                </span>
                <Badge variant={r.status === "Denied" ? "destructive" : r.status === "Applied" ? "success" : "warning"}>{r.status.toLowerCase()}</Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="glass mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Star className="h-4 w-4" /> Your skills</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 text-sm text-muted-foreground">
          {agent.skills.map((s, i) => {
            const q = queues.find((x) => x.id === s)
            return (
              <span key={s} className="rounded-full border px-3 py-1">
                {i + 1}. {q?.name ?? s}
              </span>
            )
          })}
        </CardContent>
      </Card>

      <Dialog
        open={reqOpen}
        onClose={() => setReqOpen(false)}
        title="Raise a request"
        description="An adherence exception credits off-schedule time once applied; a break/shrinkage change moves or adds a break/lunch segment once applied."
        footer={
          <>
            <Button variant="outline" onClick={() => setReqOpen(false)}>Cancel</Button>
            <Button onClick={submitRequest}><Plus className="h-4 w-4" /> Raise request</Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Request type</span>
            <Select
              value={reqKind}
              onChange={(e) => setReqKind(e.target.value as RequestKind)}
              options={[
                { value: "exception", label: "Adherence exception (justified off-schedule activity)" },
                { value: "breakChange", label: "Break / in-office shrinkage change" },
              ]}
              className="w-full"
            />
          </label>
          {reqKind === "exception" ? (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Activity</span>
              <Select value={reqCode} onChange={(e) => setReqCode(e.target.value)} options={EXCEPTION_CODES.map((a) => ({ value: a.code, label: a.label }))} className="w-full" />
            </label>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Segment</span>
                <Select
                  value={reqSegId}
                  onChange={(e) => setReqSegId(e.target.value)}
                  options={[
                    ...segments.map((s) => ({ value: s.id, label: `Move: ${s.label} (${toHHMM(toMins(shiftStart) + s.offsetMinutes)}–${toHHMM(toMins(shiftStart) + s.offsetMinutes + s.durationMinutes)})` })),
                    { value: "new", label: "Add a new segment" },
                  ]}
                  className="w-full"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Type</span>
                <Select value={reqSegType} onChange={(e) => setReqSegType(e.target.value as BreakType)} options={[{ value: "break", label: "Break" }, { value: "lunch", label: "Lunch" }]} className="w-full" />
              </label>
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{reqKind === "exception" ? "From" : "New start"}</span>
              <input
                type="time"
                value={reqFrom}
                onChange={(e) => { setReqFrom(e.target.value); setReqError("") }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{reqKind === "exception" ? "To" : "New end"}</span>
              <input
                type="time"
                value={reqTo}
                onChange={(e) => { setReqTo(e.target.value); setReqError("") }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Reason</span>
            <Input value={reqReason} onChange={(e) => { setReqReason(e.target.value); setReqError("") }} placeholder="e.g. Ad-hoc QA coaching requested by TL" />
          </label>
          {reqError && <p className="text-sm text-destructive">{reqError}</p>}
        </div>
      </Dialog>
    </>
  )
}
