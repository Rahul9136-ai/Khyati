import { useEffect, useMemo, useState } from "react"
import { ClipboardList, Star, UserCheck, UserPlus, Users } from "lucide-react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"

import { AgentSkillsDialog } from "@/components/agent-skills-dialog"
import { OnboardingDialog } from "@/components/employee-onboarding"
import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { defaultProfile, isTerminated, JOB_TITLES } from "@/lib/domain/employeeProfile"
import { fmtDay, localISODate } from "@/lib/domain/horizon"
import { TEAMS } from "@/lib/domain/seed"
import type { Agent } from "@/lib/domain/types"
import { useWfm } from "@/store/wfm"

const email = (name: string) => `${name.toLowerCase().replace(/[^a-z ]/g, "").replace(/ /g, ".")}@flowforce.io`
const TEAM_NAMES = Object.keys(TEAMS)

export function Employees() {
  const { agents, queues, employeeProfiles } = useWfm()
  const skillName = (id: string) => queues.find((q) => q.id === id)?.name ?? id
  const today = localISODate()
  const profileOf = (a: Agent) => employeeProfiles[a.id] ?? defaultProfile(a, today)
  const [q, setQ] = useState("")
  const [title, setTitle] = useState("")
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  // ?add=1 (the profile page's Create) opens the add-employee form.
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    if (params.get("add") !== "1") return
    setOpen(true)
    setParams((p) => {
      p.delete("add")
      return p
    }, { replace: true })
  }, [params, setParams])
  const [skillsAgent, setSkillsAgent] = useState<Agent | null>(null)

  const rows = useMemo(
    () =>
      agents.filter((a) => {
        const p = employeeProfiles[a.id] ?? defaultProfile(a, today)
        const text = q.toLowerCase()
        return (!title || p.jobTitle === title) && (a.name.toLowerCase().includes(text) || a.team.toLowerCase().includes(text) || p.jobTitle.toLowerCase().includes(text))
      }),
    [agents, q, title, employeeProfiles, today],
  )
  const teams = new Set(agents.map((a) => a.team)).size

  return (
    <>
      <PageHeader
        title="Employees"
        subtitle="Roster directory · skills · teams"
        actions={
          <>
            <ExportButton
              filename="employees"
              sheets={() => [
                {
                  name: "Employees",
                  rows: agents.map((a) => ({
                    "Agent ID": a.id, Name: a.name, "Job Title": profileOf(a).jobTitle, Email: email(a.name), Team: a.team, "Team Lead": a.tl, Shift: a.shift,
                    "Skills (priority order)": a.skills.map((s, i) => `${i + 1}. ${skillName(s)}`).join(", "),
                  })),
                },
              ]}
            />
            <Button variant="outline" asChild>
              <Link to="/hc-tracker"><ClipboardList className="h-4 w-4" /> HC tracker</Link>
            </Button>
            <PermissionGate module="employees">
              <Button onClick={() => setOpen(true)}>
                <UserPlus className="h-4 w-4" /> Add employee
              </Button>
            </PermissionGate>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Headcount" value={agents.filter((a) => !isTerminated(profileOf(a), today)).length} hint="active employees" icon={Users} />
        <KpiCard label="Teams" value={teams} hint={TEAM_NAMES.join(" · ")} icon={Users} />
        <KpiCard label="Multi-skilled" value={agents.filter((a) => a.skills.length > 1).length} hint="2+ skills" tone="good" icon={UserCheck} />
        <KpiCard label="Avg skills" value={(agents.reduce((s, a) => s + a.skills.length, 0) / agents.length).toFixed(1)} hint="per agent" icon={UserCheck} />
      </div>

      <Card className="glass">
        <CardContent className="pt-5">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Input placeholder="Search by name, team or job title…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
            <Select
              aria-label="Job title filter"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              options={[{ value: "", label: "All job titles" }, ...JOB_TITLES.map((t) => ({ value: t, label: t }))]}
            />
            <span className="ml-auto text-xs text-muted-foreground">
              Shift breaks come from <Link to="/shift-patterns" className="text-primary hover:underline">shift patterns</Link>.
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Job title</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>Team Lead</TableHead>
                <TableHead>Shift</TableHead>
                <TableHead>Skills (priority)</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => {
                const profile = profileOf(a)
                const gone = isTerminated(profile, today)
                return (
                <TableRow key={a.id}>
                  <TableCell className="text-left">
                    <Link to={`/employees/${a.id}`} title="Open profile" className="font-medium hover:text-primary hover:underline">{a.name}</Link>
                    <div className="text-xs text-muted-foreground">{email(a.name)}</div>
                  </TableCell>
                  <TableCell>{profile.jobTitle}</TableCell>
                  <TableCell>{a.team}</TableCell>
                  <TableCell>{a.tl}</TableCell>
                  <TableCell className="tabular-nums">{a.shift}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-1">
                      {a.skills.map((s, i) => (
                        <Badge key={s} variant={i === 0 ? "default" : "secondary"}>{i + 1}. {skillName(s)}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {gone ? (
                      <Badge variant="destructive">Terminated</Badge>
                    ) : profile.endDate ? (
                      <Badge variant="warning" title={`Last day ${fmtDay(profile.endDate)}`}>Leaving</Badge>
                    ) : (
                      <Badge variant="success">Active</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <PermissionGate module="skills" fallback={<span className="text-xs text-muted-foreground">—</span>}>
                      <Button variant="ghost" size="sm" onClick={() => setSkillsAgent(a)}>
                        <Star className="h-3.5 w-3.5" /> Skills
                      </Button>
                    </PermissionGate>
                  </TableCell>
                </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <OnboardingDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreated={(id, openProfile) => {
          setOpen(false)
          if (openProfile) navigate(`/employees/${id}`)
        }}
      />

      <AgentSkillsDialog agent={skillsAgent} open={!!skillsAgent} onClose={() => setSkillsAgent(null)} />
    </>
  )
}
