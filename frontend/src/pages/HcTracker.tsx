import { Fragment, useMemo, useState } from "react"
import { ChevronDown, ChevronRight, UserCheck, UserMinus, UserPlus, Users } from "lucide-react"
import { Link } from "react-router-dom"

import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { defaultProfile, hcStatus, valueAsOf, type EmployeeChange, type HcStatus } from "@/lib/domain/employeeProfile"
import { localISODate, parseISODate } from "@/lib/domain/horizon"
import type { Agent } from "@/lib/domain/types"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

const STATUSES: HcStatus[] = ["Active", "Notice period", "Joining", "Exited"]
const STATUS_VARIANT: Record<HcStatus, "success" | "warning" | "secondary" | "destructive"> = {
  Active: "success",
  "Notice period": "warning",
  Joining: "secondary",
  Exited: "destructive",
}

const fmtDate = (iso: string | null) =>
  iso ? parseISODate(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—"
const fmtWhen = (ms: number) => new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })

/** "1y 4m" / "3m" / "12d" between join and last working day (or today). */
function tenure(from: string, to: string): string {
  const days = Math.max(0, Math.round((parseISODate(to).getTime() - parseISODate(from).getTime()) / 86_400_000))
  if (days < 31) return `${days}d`
  const months = Math.floor(days / 30.44)
  return months >= 12 ? `${Math.floor(months / 12)}y ${months % 12}m` : `${months}m`
}

export interface HcRow {
  agent: Agent
  status: HcStatus
  jobTitle: string
  employeeNumber: string
  campaign: string
  skills: string
  team: string
  supervisor: string
  teamLead: string
  joinDate: string
  lastWorkingDay: string | null
  tenure: string
  lastChange: EmployeeChange | undefined
}

/** Headcount tracker: every past and present employee with their status,
 *  process / campaign, join date and last working day, reporting line and
 *  who last changed their record — plus the full change log. */
export function HcTracker() {
  const { agents, formerEmployees, employeeProfiles, employeeChanges, queues } = useWfm()
  const today = localISODate()
  const [q, setQ] = useState("")
  const [status, setStatus] = useState<"" | HcStatus>("")
  const [campaign, setCampaign] = useState("")
  const [open, setOpen] = useState<string | null>(null)
  const [logAction, setLogAction] = useState("")

  const rows = useMemo<HcRow[]>(() => {
    const skillName = (id: string) => queues.find((x) => x.id === id)?.name ?? id
    const latest = new Map<string, EmployeeChange>()
    for (const c of employeeChanges) if (!latest.has(c.agentId)) latest.set(c.agentId, c)
    return [...agents, ...Object.values(formerEmployees)].map((a) => {
      const p = employeeProfiles[a.id] ?? defaultProfile(a, today)
      const st = hcStatus(p, today)
      return {
        agent: a,
        status: st,
        jobTitle: p.jobTitle,
        employeeNumber: p.employeeNumber,
        // The campaign they were on at their last working day, or today.
        campaign: valueAsOf(p.organization, p.endDate && p.endDate < today ? p.endDate : today)?.value ?? a.team,
        skills: a.skills.map(skillName).join(", "),
        team: a.team,
        supervisor: p.supervisor,
        teamLead: p.teamLead,
        joinDate: p.startDate,
        lastWorkingDay: p.endDate,
        tenure: tenure(p.startDate, p.endDate && p.endDate < today ? p.endDate : today),
        lastChange: latest.get(a.id),
      }
    }).sort((x, y) => STATUSES.indexOf(x.status) - STATUSES.indexOf(y.status) || x.agent.name.localeCompare(y.agent.name))
  }, [agents, formerEmployees, employeeProfiles, employeeChanges, queues, today])

  const campaigns = useMemo(() => [...new Set(rows.map((r) => r.campaign))].sort(), [rows])
  const shown = rows.filter((r) => {
    const text = q.toLowerCase()
    return (!status || r.status === status) && (!campaign || r.campaign === campaign) &&
      (!text || [r.agent.name, r.agent.id, r.employeeNumber, r.jobTitle, r.supervisor, r.teamLead, r.campaign, r.skills].some((v) => v.toLowerCase().includes(text)))
  })

  const month = today.slice(0, 7)
  const count = (s: HcStatus) => rows.filter((r) => r.status === s).length
  const joiners = rows.filter((r) => r.joinDate.startsWith(month)).length
  const exits = rows.filter((r) => r.lastWorkingDay?.startsWith(month) && r.lastWorkingDay < today).length
  const headcount = count("Active") + count("Notice period")
  const attrition = headcount + exits ? exits / (headcount + exits) : 0
  const log = employeeChanges.filter((c) => !logAction || c.action === logAction)

  const sheetRow = (r: HcRow) => ({
    "Agent ID": r.agent.id, Name: r.agent.name, "Employee number": r.employeeNumber, "Job title": r.jobTitle, Status: r.status,
    "Process / campaign": r.campaign, Skills: r.skills, Team: r.team, Supervisor: r.supervisor, "Team lead": r.teamLead,
    "Join date": r.joinDate, "Last working day": r.lastWorkingDay ?? "", Tenure: r.tenure,
    "Last change": r.lastChange ? `${r.lastChange.action}: ${r.lastChange.detail}` : "", "Changed by": r.lastChange?.by ?? "",
    "Changed at": r.lastChange ? fmtWhen(r.lastChange.at) : "",
  })

  return (
    <>
      <PageHeader
        title="HC Tracker"
        subtitle="Every past and present employee · status · campaign · last working day · who changed what"
        actions={
          <ExportButton
            filename="hc-tracker"
            sheets={() => [
              { name: "HC tracker", rows: shown.map(sheetRow) },
              { name: "Change log", rows: employeeChanges.map((c) => ({ When: fmtWhen(c.at), "Agent ID": c.agentId, Employee: c.name, Action: c.action, Detail: c.detail, "Changed by": c.by })) },
            ]}
          />
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <KpiCard label="Headcount" value={headcount} hint={`${count("Active")} active · ${count("Notice period")} on notice`} icon={Users} />
        <KpiCard label="Joiners" value={joiners} hint="joined this month" tone="good" icon={UserPlus} />
        <KpiCard label="Exits" value={exits} hint="left this month" tone={exits ? "warn" : "neutral"} icon={UserMinus} />
        <KpiCard label="Attrition" value={`${(attrition * 100).toFixed(1)}%`} hint="exits ÷ headcount this month" tone={attrition > 0.05 ? "bad" : attrition ? "warn" : "good"} icon={UserMinus} />
        <KpiCard label="Former employees" value={count("Exited")} hint={`${count("Joining")} joining soon`} icon={UserCheck} />
      </div>

      <Card className="glass mb-4">
        <CardContent className="pt-5">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Input placeholder="Search name, ID, supervisor, campaign…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
            <Select aria-label="Status filter" value={status} onChange={(e) => setStatus(e.target.value as "" | HcStatus)} options={[{ value: "", label: "All statuses" }, ...STATUSES.map((s) => ({ value: s, label: s }))]} />
            <Select aria-label="Campaign filter" value={campaign} onChange={(e) => setCampaign(e.target.value)} options={[{ value: "", label: "All campaigns" }, ...campaigns.map((c) => ({ value: c, label: c }))]} />
            <span className="ml-auto text-xs text-muted-foreground">{shown.length} of {rows.length} employees</span>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-6" />
                  <TableHead>Employee</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Job title</TableHead>
                  <TableHead>Process / campaign</TableHead>
                  <TableHead>Supervisor</TableHead>
                  <TableHead>Team lead</TableHead>
                  <TableHead>Join date</TableHead>
                  <TableHead>Last working day</TableHead>
                  <TableHead>Tenure</TableHead>
                  <TableHead>Last change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => {
                  const expanded = open === r.agent.id
                  const mine = employeeChanges.filter((c) => c.agentId === r.agent.id)
                  return (
                    <Fragment key={r.agent.id}>
                      <TableRow className={cn(r.status === "Exited" && "opacity-80")}>
                        <TableCell>
                          <button type="button" aria-label={`${expanded ? "Hide" : "Show"} ${r.agent.name}'s changes`} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.agent.id)} className="text-muted-foreground hover:text-foreground">
                            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                        </TableCell>
                        <TableCell className="text-left">
                          <Link to={`/employees/${r.agent.id}`} className="font-medium hover:text-primary hover:underline">{r.agent.name}</Link>
                          <div className="text-xs text-muted-foreground">{r.agent.id}{r.employeeNumber ? ` · #${r.employeeNumber}` : ""}</div>
                        </TableCell>
                        <TableCell><Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge></TableCell>
                        <TableCell>{r.jobTitle}</TableCell>
                        <TableCell className="text-left">
                          <div>{r.campaign}</div>
                          <div className="text-xs text-muted-foreground">{r.skills}</div>
                        </TableCell>
                        <TableCell>{r.supervisor || "—"}</TableCell>
                        <TableCell>{r.teamLead || "—"}</TableCell>
                        <TableCell className="tabular-nums">{fmtDate(r.joinDate)}</TableCell>
                        <TableCell className={cn("tabular-nums", r.status === "Notice period" && "text-amber-500")}>{fmtDate(r.lastWorkingDay)}</TableCell>
                        <TableCell className="tabular-nums">{r.tenure}</TableCell>
                        <TableCell className="text-left text-xs">
                          {r.lastChange ? (
                            <>
                              <div>{r.lastChange.action} · {fmtWhen(r.lastChange.at)}</div>
                              <div className="text-muted-foreground">by {r.lastChange.by}</div>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow>
                          <TableCell colSpan={11} className="bg-muted/30 text-left">
                            {mine.length ? (
                              <ul className="space-y-1 text-xs" aria-label={`${r.agent.name} changes`}>
                                {mine.map((c) => (
                                  <li key={c.id} className="flex flex-wrap gap-x-3">
                                    <span className="tabular-nums text-muted-foreground">{fmtWhen(c.at)}</span>
                                    <b>{c.action}</b>
                                    <span className="flex-1">{c.detail}</span>
                                    <span className="text-muted-foreground">by {c.by}</span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="text-xs text-muted-foreground">No changes recorded for {r.agent.name} yet.</p>
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="glass">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Change log</CardTitle>
          <Select aria-label="Change type filter" value={logAction} onChange={(e) => setLogAction(e.target.value)}
            options={[{ value: "", label: "All changes" }, ...["Onboarded", "Updated", "Exited", "Rehired", "Deleted"].map((a) => ({ value: a, label: a }))]} />
        </CardHeader>
        <CardContent>
          {log.length ? (
            <div className="max-h-[420px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Employee</TableHead>
                    <TableHead>Change</TableHead>
                    <TableHead>Detail</TableHead>
                    <TableHead>Changed by</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {log.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="whitespace-nowrap tabular-nums">{fmtWhen(c.at)}</TableCell>
                      <TableCell>{c.name}</TableCell>
                      <TableCell><Badge variant={c.action === "Exited" || c.action === "Deleted" ? "destructive" : c.action === "Updated" ? "secondary" : "success"}>{c.action}</Badge></TableCell>
                      <TableCell className="text-left text-xs">{c.detail}</TableCell>
                      <TableCell>{c.by}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No employee changes recorded yet — onboarding someone or saving a profile adds an entry here.</p>
          )}
        </CardContent>
      </Card>
    </>
  )
}
