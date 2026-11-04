import { useMemo, useState } from "react"
import { SquareUser, UserPlus } from "lucide-react"

import { SkillPriorityEditor } from "@/components/skill-priority-editor"
import { Button } from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import {
  defaultProfile,
  EMPLOYEE_TYPES,
  JOB_TITLES,
  lastFirst,
  leaderNames,
  type EmployeeType,
  type JobTitle,
} from "@/lib/domain/employeeProfile"
import { localISODate } from "@/lib/domain/horizon"
import { TEAMS } from "@/lib/domain/seed"
import { useWfm } from "@/store/wfm"

const TEAM_NAMES = Object.keys(TEAMS)

/** Onboard a new employee: who they are and what they work (roster), plus the
 *  administrative details — join / end date, type, number, reporting line,
 *  organisation and wage — which become their profile. */
export function OnboardingDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string, openProfile: boolean) => void }) {
  const { agents, shiftPatterns, queues, employeeProfiles, addAgent, saveEmployeeProfile } = useWfm()
  const today = localISODate()
  const blank = () => ({
    name: "",
    jobTitle: "Agent" as JobTitle,
    team: TEAM_NAMES[0],
    shiftPatternId: shiftPatterns[0]?.id ?? "",
    skills: [queues[0].id],
    startDate: today,
    endDate: "",
    employeeType: "Full-time" as EmployeeType,
    employeeNumber: "",
    isSupervisor: false,
    isTeamLead: false,
    supervisor: TEAMS[TEAM_NAMES[0]].tl,
    teamLead: TEAMS[TEAM_NAMES[0]].tl,
    organization: TEAM_NAMES[0],
    wage: "",
  })
  const [f, setF] = useState(blank)
  const [error, setError] = useState("")
  const set = (p: Partial<ReturnType<typeof blank>>) => {
    setF({ ...f, ...p })
    setError("")
  }
  const leaders = useMemo(
    () => leaderNames(agents, employeeProfiles, Object.values(TEAMS).map((t) => t.tl), [f.supervisor, f.teamLead]),
    [agents, employeeProfiles, f.supervisor, f.teamLead],
  )
  const leaderOptions = [{ value: "", label: "—" }, ...leaders.map((n) => ({ value: n, label: lastFirst(n) }))]

  function close() {
    setF(blank())
    setError("")
    onClose()
  }

  function submit(openProfile: boolean) {
    if (!f.name.trim()) return setError("Full name is required.")
    if (!f.skills.length) return setError("Select at least one skill.")
    if (!f.startDate) return setError("Join date is required.")
    if (f.endDate && f.endDate < f.startDate) return setError("End date can't be before the join date.")
    if (f.wage && !(Number(f.wage) >= 0)) return setError("Wage amount must be a number.")
    const id = addAgent({ name: f.name, team: f.team, shiftPatternId: f.shiftPatternId, skills: f.skills })
    const agent = useWfm.getState().agents.find((a) => a.id === id)!
    const base = defaultProfile(agent, today)
    const from = f.startDate
    saveEmployeeProfile(id, {
      ...base,
      jobTitle: f.jobTitle,
      startDate: from,
      endDate: f.endDate || null,
      employeeType: f.employeeType,
      employeeNumber: f.employeeNumber.trim(),
      isSupervisor: f.isSupervisor,
      isTeamLead: f.isTeamLead,
      supervisor: f.supervisor,
      teamLead: f.teamLead,
      wage: [{ value: f.wage ? Number(f.wage) : 0, from, to: null }],
      qualityScore: [{ value: 0, from, to: null }],
      rank: [{ value: 1, from, to: null }],
      organization: [{ value: f.organization.trim() || f.team, from, to: null }],
    }, { onboarding: true })
    setF(blank())
    onCreated(id, openProfile)
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Onboard employee"
      description="New hires flow straight into scheduling coverage and the real-time board. Everything here can be changed later on their profile."
      className="max-h-[92vh] max-w-2xl overflow-y-auto"
      footer={
        <>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button variant="outline" onClick={() => submit(true)}><SquareUser className="h-4 w-4" /> Add & open profile</Button>
          <Button onClick={() => submit(false)}><UserPlus className="h-4 w-4" /> Add employee</Button>
        </>
      }
    >
      <div className="space-y-5">
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Employee</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name *">
              <Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Jordan Blake" autoFocus />
            </Field>
            <Field label="Job title">
              <Select aria-label="Job title" value={f.jobTitle} onChange={(e) => set({ jobTitle: e.target.value as JobTitle })} options={JOB_TITLES.map((t) => ({ value: t, label: t }))} className="w-full" />
            </Field>
            <Field label="Team">
              <Select
                aria-label="Team"
                value={f.team}
                onChange={(e) => {
                  const team = e.target.value
                  const was = TEAMS[f.team]?.tl
                  // The reporting line follows the team unless someone already changed it.
                  set({
                    team,
                    teamLead: f.teamLead === was ? TEAMS[team].tl : f.teamLead,
                    supervisor: f.supervisor === was ? TEAMS[team].tl : f.supervisor,
                    organization: f.organization === f.team ? team : f.organization,
                  })
                }}
                options={TEAM_NAMES.map((t) => ({ value: t, label: t }))}
                className="w-full"
              />
            </Field>
            <Field label="Shift pattern">
              <Select
                aria-label="Shift pattern"
                value={f.shiftPatternId}
                onChange={(e) => set({ shiftPatternId: e.target.value })}
                options={shiftPatterns.map((p) => ({ value: p.id, label: `${p.name} (${p.start}–${p.end})` }))}
                className="w-full"
              />
            </Field>
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Skills — order sets priority</span>
            <SkillPriorityEditor skills={f.skills} onChange={(skills) => set({ skills })} />
          </div>
        </section>

        <section className="space-y-3 border-t pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Administrative details</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Join date *">
              <Input type="date" aria-label="Join date" value={f.startDate} onChange={(e) => set({ startDate: e.target.value })} />
            </Field>
            <Field label="End date (optional)">
              <Input type="date" aria-label="End date" min={f.startDate || undefined} value={f.endDate} onChange={(e) => set({ endDate: e.target.value })} />
            </Field>
            <Field label="Employee type">
              <Select aria-label="Employee type" value={f.employeeType} onChange={(e) => set({ employeeType: e.target.value as EmployeeType })} options={EMPLOYEE_TYPES.map((t) => ({ value: t, label: t }))} className="w-full" />
            </Field>
            <Field label="Employee number">
              <Input aria-label="Employee number" value={f.employeeNumber} onChange={(e) => set({ employeeNumber: e.target.value })} placeholder="e.g. 67965" />
            </Field>
            <Field label="Supervisor">
              <Select aria-label="Supervisor" value={f.supervisor} onChange={(e) => set({ supervisor: e.target.value })} options={leaderOptions} className="w-full" />
            </Field>
            <Field label="Team lead">
              <Select aria-label="Team lead" value={f.teamLead} onChange={(e) => set({ teamLead: e.target.value })} options={leaderOptions} className="w-full" />
            </Field>
            <Field label="Organization">
              <Input aria-label="Organization" value={f.organization} onChange={(e) => set({ organization: e.target.value })} placeholder="e.g. Travel Helpdesk - IND" />
            </Field>
            <Field label="Wage amount">
              <Input aria-label="Wage amount" type="number" min={0} step="0.01" value={f.wage} onChange={(e) => set({ wage: e.target.value })} placeholder="0.00" />
            </Field>
          </div>
          <div className="flex flex-wrap gap-5 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={f.isSupervisor} onChange={(e) => set({ isSupervisor: e.target.checked })} /> Is supervisor
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={f.isTeamLead} onChange={(e) => set({ isTeamLead: e.target.checked })} /> Is team lead
            </label>
          </div>
        </section>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}
