import { useMemo, useState } from "react"
import { Star, UserCheck, UserPlus, Users } from "lucide-react"
import { Link } from "react-router-dom"

import { AgentSkillsDialog } from "@/components/agent-skills-dialog"
import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { SkillPriorityEditor } from "@/components/skill-priority-editor"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TEAMS } from "@/lib/domain/seed"
import type { Agent } from "@/lib/domain/types"
import { useWfm } from "@/store/wfm"

const email = (name: string) => `${name.toLowerCase().replace(/[^a-z ]/g, "").replace(/ /g, ".")}@flowforce.io`
const TEAM_NAMES = Object.keys(TEAMS)

export function Employees() {
  const { agents, addAgent, shiftPatterns, queues } = useWfm()
  const skillName = (id: string) => queues.find((q) => q.id === id)?.name ?? id
  const [q, setQ] = useState("")
  const [open, setOpen] = useState(false)
  const [skillsAgent, setSkillsAgent] = useState<Agent | null>(null)

  // add-employee form state
  const [name, setName] = useState("")
  const [team, setTeam] = useState(TEAM_NAMES[0])
  const [shiftPatternId, setShiftPatternId] = useState(shiftPatterns[0]?.id ?? "")
  const [skills, setSkills] = useState<string[]>([queues[0].id])
  const [error, setError] = useState("")

  const rows = useMemo(
    () => agents.filter((a) => a.name.toLowerCase().includes(q.toLowerCase()) || a.team.toLowerCase().includes(q.toLowerCase())),
    [agents, q],
  )
  const teams = new Set(agents.map((a) => a.team)).size

  function reset() {
    setName("")
    setTeam(TEAM_NAMES[0])
    setShiftPatternId(shiftPatterns[0]?.id ?? "")
    setSkills([queues[0].id])
    setError("")
  }

  function submit() {
    if (!name.trim()) return setError("Name is required.")
    if (skills.length === 0) return setError("Select at least one skill.")
    addAgent({ name, team, shiftPatternId, skills })
    reset()
    setOpen(false)
  }

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
                    "Agent ID": a.id, Name: a.name, Email: email(a.name), Team: a.team, "Team Lead": a.tl, Shift: a.shift,
                    "Skills (priority order)": a.skills.map((s, i) => `${i + 1}. ${skillName(s)}`).join(", "),
                  })),
                },
              ]}
            />
            <PermissionGate module="employees">
              <Button onClick={() => { reset(); setOpen(true) }}>
                <UserPlus className="h-4 w-4" /> Add employee
              </Button>
            </PermissionGate>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Headcount" value={agents.length} hint="active agents" icon={Users} />
        <KpiCard label="Teams" value={teams} hint={TEAM_NAMES.join(" · ")} icon={Users} />
        <KpiCard label="Multi-skilled" value={agents.filter((a) => a.skills.length > 1).length} hint="2+ skills" tone="good" icon={UserCheck} />
        <KpiCard label="Avg skills" value={(agents.reduce((s, a) => s + a.skills.length, 0) / agents.length).toFixed(1)} hint="per agent" icon={UserCheck} />
      </div>

      <Card className="glass">
        <CardContent className="pt-5">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Input placeholder="Search by name or team…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
            <span className="ml-auto text-xs text-muted-foreground">
              Shift breaks come from <Link to="/shift-patterns" className="text-primary hover:underline">shift patterns</Link>.
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>Team Lead</TableHead>
                <TableHead>Shift</TableHead>
                <TableHead>Skills (priority)</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="text-left">
                    <div className="font-medium">{a.name}</div>
                    <div className="text-xs text-muted-foreground">{email(a.name)}</div>
                  </TableCell>
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
                    <Badge variant="success">Active</Badge>
                  </TableCell>
                  <TableCell>
                    <PermissionGate module="skills" fallback={<span className="text-xs text-muted-foreground">—</span>}>
                      <Button variant="ghost" size="sm" onClick={() => setSkillsAgent(a)}>
                        <Star className="h-3.5 w-3.5" /> Skills
                      </Button>
                    </PermissionGate>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add employee"
        description="New hires flow straight into scheduling coverage and the real-time board."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit}><UserPlus className="h-4 w-4" /> Add employee</Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Full name</span>
            <Input value={name} onChange={(e) => { setName(e.target.value); setError("") }} placeholder="e.g. Jordan Blake" autoFocus />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Team</span>
              <Select value={team} onChange={(e) => setTeam(e.target.value)} options={TEAM_NAMES.map((t) => ({ value: t, label: t }))} className="w-full" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Shift pattern</span>
              <Select
                value={shiftPatternId}
                onChange={(e) => setShiftPatternId(e.target.value)}
                options={shiftPatterns.map((p) => ({ value: p.id, label: `${p.name} (${p.start}–${p.end})` }))}
                className="w-full"
              />
            </label>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Skills — order sets priority</span>
            <SkillPriorityEditor skills={skills} onChange={(s) => { setSkills(s); setError("") }} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </Dialog>

      <AgentSkillsDialog agent={skillsAgent} open={!!skillsAgent} onClose={() => setSkillsAgent(null)} />
    </>
  )
}
