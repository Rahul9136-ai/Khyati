import { useEffect, useMemo, useRef, useState } from "react"
import {
  Activity, ArrowLeft, CalendarClock, ChevronDown, ChevronRight, ClipboardCheck, Eye, EyeOff, History, MonitorPlay,
  Pencil, Phone, Plus, RotateCcw, Save, Trash2, Upload, UserMinus, UserPlus, X, type LucideIcon,
} from "lucide-react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { ExportButton } from "@/components/export-button"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import {
  DATA_SOURCE_KINDS,
  defaultProfile,
  EMPLOYEE_TYPES,
  EMPTY_LINK,
  isTerminated,
  JOB_TITLES,
  lastFirst,
  leaderNames,
  maskTaxId,
  profileSheets,
  setEffective,
  valueAsOf,
  type DataSourceKind,
  type Dated,
  type EmployeeProfile as Profile,
  type EmployeeType,
  type JobTitle,
} from "@/lib/domain/employeeProfile"
import { localISODate, parseISODate } from "@/lib/domain/horizon"
import { TEAMS } from "@/lib/domain/seed"
import { parseProfileFile } from "@/lib/profileImport"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

/** "19 Oct 2025" — employment dates need the year. */
const fmtDay = (iso: string) => parseISODate(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })

const KIND_ICON: Record<DataSourceKind, LucideIcon> = {
  phone: Phone,
  screen: MonitorPlay,
  wfm: CalendarClock,
  adherence: Activity,
  quality: ClipboardCheck,
}

/** The HR / administrative record behind one roster agent (/employees/:id). */
export function EmployeeProfile() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const { agents, formerEmployees, employeeProfiles, employeeChanges, saveEmployeeProfile, deleteEmployee, dataSources, addDataSource } = useWfm()
  const canEdit = useWfm((s) => s.can("employees", "edit"))
  const today = localISODate()
  // Former employees (past their last working day) still have a profile.
  const agent = agents.find((a) => a.id === id) ?? formerEmployees[id]
  const saved = useMemo(
    () => (agent ? employeeProfiles[agent.id] ?? defaultProfile(agent, today) : null),
    [agent, employeeProfiles, today],
  )
  const [draft, setDraft] = useState<Profile | null>(saved)
  useEffect(() => setDraft(saved), [saved])
  const [asOf, setAsOf] = useState(today)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [showAddress, setShowAddress] = useState(false)
  const [showUdf, setShowUdf] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [terminating, setTerminating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // People who can be picked as supervisor / team lead: every team's lead plus
  // anyone whose profile is flagged as one.
  const leaders = useMemo(
    () => leaderNames(agents, employeeProfiles, Object.values(TEAMS).map((t) => t.tl), [draft?.supervisor ?? "", draft?.teamLead ?? ""]),
    [agents, employeeProfiles, draft?.supervisor, draft?.teamLead],
  )
  const organizations = useMemo(() => {
    const names = new Set<string>(agents.map((a) => a.team))
    for (const p of Object.values(employeeProfiles)) for (const o of p.organization) names.add(o.value)
    return [...names].sort()
  }, [agents, employeeProfiles])

  if (!agent || !saved || !draft) {
    return (
      <Card className="glass">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          That employee isn't on the roster. <Link to="/employees" className="text-primary hover:underline">Back to Employees</Link>
        </CardContent>
      </Card>
    )
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const ro = !canEdit
  const patch = (p: Partial<Profile>) => {
    setDraft({ ...draft, ...p })
    setMsg(null)
  }
  const terminated = isTerminated(saved, today)
  const history = employeeChanges.filter((c) => c.agentId === agent.id)
  const status = terminated
    ? { label: `Exited · last day ${fmtDay(saved.endDate!)}`, variant: "destructive" as const }
    : saved.startDate > today
      ? { label: `Joins ${fmtDay(saved.startDate)}`, variant: "warning" as const }
      : saved.endDate
        ? { label: `Notice period · last day ${fmtDay(saved.endDate)}`, variant: "warning" as const }
        : { label: "Active", variant: "success" as const }

  /** What saving this end date does to the roster, in words. */
  const exitNote = (p: Profile) =>
    !p.endDate
      ? ""
      : p.endDate < today
        ? ` ${agent!.name} is off the roster, schedules and the real-time board from today.`
        : ` ${agent!.name} comes off the roster, schedules and the real-time board after ${fmtDay(p.endDate)}.`

  function save() {
    if (draft!.endDate && draft!.endDate < draft!.startDate) return setMsg({ ok: false, text: "End date can't be before the start date." })
    const rehired = terminated && !isTerminated(draft!, today)
    saveEmployeeProfile(agent!.id, draft!)
    setMsg({ ok: true, text: `Profile saved.${rehired ? ` ${agent!.name} is back on the roster.` : saved!.endDate !== draft!.endDate ? exitNote(draft!) : ""}` })
  }

  async function onImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    try {
      const res = await parseProfileFile(file, draft!, dataSources, asOf)
      setDraft(res.profile)
      setMsg({
        ok: !res.errors.length,
        text: `${res.changed.length ? `Imported ${res.changed.length} field${res.changed.length === 1 ? "" : "s"} from ${file.name} — review and Save.` : `Nothing to change in ${file.name}.`}${res.errors.length ? ` ${res.errors.slice(0, 3).join(" ")}` : ""}`,
      })
    } catch (err) {
      setMsg({ ok: false, text: `Could not read ${file.name}: ${(err as Error).message}` })
    }
  }

  return (
    <>
      <PageHeader
        title={`Profile: ${lastFirst(agent.name)}`}
        subtitle={`${draft.jobTitle} · ${agent.team} team · ${agent.id}`}
        actions={
          <>
            <Badge variant={status.variant}>{status.label}</Badge>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              As of
              <Input type="date" aria-label="As of" className="h-9 w-[150px]" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} />
            </label>
            <Button variant="outline" asChild>
              <Link to="/employees"><ArrowLeft className="h-4 w-4" /> Employees</Link>
            </Button>
          </>
        }
      />

      <div className="space-y-4 pb-24">
        <Section title="Home Address" open={showAddress} onToggle={() => setShowAddress(!showAddress)}>
          <div className="grid gap-3 sm:grid-cols-2">
            {([
              ["line1", "Address line 1"], ["line2", "Address line 2"], ["city", "City"],
              ["state", "State / province"], ["postalCode", "Postal code"], ["country", "Country"],
            ] as const).map(([k, label]) => (
              <Field key={k} label={label}>
                <Input value={draft.address[k]} disabled={ro} onChange={(e) => patch({ address: { ...draft.address, [k]: e.target.value } })} />
              </Field>
            ))}
          </div>
        </Section>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <Card className="glass">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2"><ChevronDown className="h-4 w-4 text-primary" /> Administrative Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5">
              <Row label="Job title">
                <Select
                  aria-label="Job title"
                  value={draft.jobTitle}
                  disabled={ro}
                  onChange={(e) => patch({ jobTitle: e.target.value as JobTitle })}
                  options={JOB_TITLES.map((t) => ({ value: t, label: t }))}
                  className="w-full"
                />
              </Row>
              <Row label="Start date">
                <Input type="date" aria-label="Start date" value={draft.startDate} disabled={ro} onChange={(e) => e.target.value && patch({ startDate: e.target.value })} />
              </Row>
              <Row label="End date">
                <Input type="date" aria-label="End date" value={draft.endDate ?? ""} disabled={ro} onChange={(e) => patch({ endDate: e.target.value || null })} />
              </Row>
              <Row label="Is supervisor">
                <input type="checkbox" aria-label="Is supervisor" className="h-4 w-4 accent-primary" checked={draft.isSupervisor} disabled={ro} onChange={(e) => patch({ isSupervisor: e.target.checked })} />
              </Row>
              <Row label="Is team lead">
                <input type="checkbox" aria-label="Is team lead" className="h-4 w-4 accent-primary" checked={draft.isTeamLead} disabled={ro} onChange={(e) => patch({ isTeamLead: e.target.checked })} />
              </Row>
              <Row label="Employee type">
                <Select
                  aria-label="Employee type"
                  value={draft.employeeType}
                  disabled={ro}
                  onChange={(e) => patch({ employeeType: e.target.value as EmployeeType })}
                  options={EMPLOYEE_TYPES.map((t) => ({ value: t, label: t }))}
                  className="w-full"
                />
              </Row>
              <Row label="Employee number">
                <Input aria-label="Employee number" value={draft.employeeNumber} disabled={ro} onChange={(e) => patch({ employeeNumber: e.target.value })} />
              </Row>
              <Row label="Tax ID (SSN)">
                <TaxIdField value={draft.taxId} readOnly={ro} onChange={(taxId) => patch({ taxId })} />
              </Row>
              <DatedRow label="Wage amount" history={draft.wage} asOf={asOf} readOnly={ro} type="number" format={(v) => Number(v).toFixed(2)} onChange={(wage) => patch({ wage: wage as Dated<number>[] })} />
              <DatedRow label="Quality score" history={draft.qualityScore} asOf={asOf} readOnly={ro} type="number" onChange={(qualityScore) => patch({ qualityScore: qualityScore as Dated<number>[] })} />
              <DatedRow label="Rank" history={draft.rank} asOf={asOf} readOnly={ro} type="number" onChange={(rank) => patch({ rank: rank as Dated<number>[] })} />
              <DatedRow label="Organization" history={draft.organization} asOf={asOf} readOnly={ro} type="text" suggestions={organizations} onChange={(organization) => patch({ organization: organization as Dated<string>[] })} />
              <Row label="Supervisor">
                <Select aria-label="Supervisor" value={draft.supervisor} disabled={ro} onChange={(e) => patch({ supervisor: e.target.value })} options={[{ value: "", label: "—" }, ...leaders.map((n) => ({ value: n, label: lastFirst(n) }))]} className="w-full" />
              </Row>
              <Row label="Team lead">
                <Select aria-label="Team lead" value={draft.teamLead} disabled={ro} onChange={(e) => patch({ teamLead: e.target.value })} options={[{ value: "", label: "—" }, ...leaders.map((n) => ({ value: n, label: lastFirst(n) }))]} className="w-full" />
              </Row>
            </CardContent>
          </Card>

          <Card className="glass">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2"><ChevronDown className="h-4 w-4 text-primary" /> Data Sources</CardTitle>
              <p className="text-xs text-muted-foreground">This employee's ID in each connected system — how their calls, screens, adherence and quality data are matched to them.</p>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[460px] text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="w-8 px-2 py-2" />
                      <th className="px-2 py-2 font-semibold">Data source</th>
                      <th className="px-2 py-2 font-semibold">Employee ID</th>
                      <th className="px-2 py-2 font-semibold">Extension</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dataSources.map((src) => {
                      const Icon = KIND_ICON[src.kind]
                      const link = { ...EMPTY_LINK, ...draft.sources[src.id] }
                      const setLink = (l: Partial<typeof link>) => patch({ sources: { ...draft.sources, [src.id]: { ...link, ...l } } })
                      return (
                        <tr key={src.id} className="border-b last:border-0">
                          <td className="px-2 py-1.5 text-primary" title={DATA_SOURCE_KINDS.find((k) => k.value === src.kind)?.label}>
                            <Icon className="h-4 w-4" />
                          </td>
                          <td className="px-2 py-1.5 font-medium">{src.name}</td>
                          <td className="px-2 py-1.5">
                            {src.kind === "quality" ? (
                              <input type="checkbox" aria-label={`${src.name} enrolled`} className="h-4 w-4 accent-primary" checked={link.enabled} disabled={ro} onChange={(e) => setLink({ enabled: e.target.checked })} />
                            ) : (
                              <Input aria-label={`${src.name} employee ID`} className="h-8" value={link.employeeId} disabled={ro} onChange={(e) => setLink({ employeeId: e.target.value })} />
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            {src.kind === "phone" ? (
                              <Input aria-label={`${src.name} extension`} className="h-8" value={link.extension} disabled={ro} onChange={(e) => setLink({ extension: e.target.value })} />
                            ) : (
                              <div className="h-8 rounded-md bg-muted/40" />
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {canEdit && <AddDataSource onAdd={addDataSource} />}
            </CardContent>
          </Card>
        </div>

        {terminated && (
          <div role="note" className="rounded-lg border border-destructive/40 px-4 py-2.5 text-sm text-destructive">
            {agent.name} left after {fmtDay(saved.endDate!)} and is off the roster, schedules and the real-time board.
            <span className="text-muted-foreground"> Clear or move the end date and save to bring them back.</span>
          </div>
        )}

        <Section title="User Defined Fields" open={showUdf} onToggle={() => setShowUdf(!showUdf)} count={draft.userFields.length}>
          <div className="space-y-2">
            {draft.userFields.map((f, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input aria-label="Field name" placeholder="Field" className="max-w-[220px]" value={f.label} disabled={ro}
                  onChange={(e) => patch({ userFields: draft.userFields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                <Input aria-label="Field value" placeholder="Value" value={f.value} disabled={ro}
                  onChange={(e) => patch({ userFields: draft.userFields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                {canEdit && (
                  <Button variant="ghost" size="sm" aria-label="Remove field" onClick={() => patch({ userFields: draft.userFields.filter((_, j) => j !== i) })}>
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            {!draft.userFields.length && <p className="text-sm text-muted-foreground">No user defined fields yet.</p>}
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => patch({ userFields: [...draft.userFields, { label: "", value: "" }] })}>
                <Plus className="h-4 w-4" /> Add field
              </Button>
            )}
          </div>
        </Section>

        <Section title="Change history" open={showLog} onToggle={() => setShowLog(!showLog)} count={history.length}>
          {history.length ? (
            <ul className="space-y-1.5 text-sm" aria-label="Change history">
              {history.map((c) => (
                <li key={c.id} className="flex flex-wrap gap-x-3 border-b pb-1.5 last:border-0">
                  <span className="tabular-nums text-muted-foreground">{new Date(c.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span>
                  <Badge variant={c.action === "Exited" || c.action === "Deleted" ? "destructive" : c.action === "Updated" ? "secondary" : "success"}>{c.action}</Badge>
                  <span className="flex-1">{c.detail}</span>
                  <span className="text-muted-foreground">by {c.by}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
          )}
        </Section>

        {msg && (
          <div role="status" className={cn("rounded-lg border px-4 py-2.5 text-sm", msg.ok ? "border-emerald-500/40 text-emerald-500" : "border-destructive/40 text-destructive")}>
            {msg.ok ? "✓ " : "✕ "}{msg.text}
          </div>
        )}
      </div>

      {/* Actions, always in reach at the bottom of the screen. */}
      <div className="glass sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 shadow-lg">
        {dirty && <Badge variant="warning">Unsaved changes</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onImport} />
          <Button variant="outline" size="sm" disabled={ro} onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" /> Import</Button>
          <ExportButton filename={`profile-${agent.id}`} sheets={() => profileSheets(agent, draft, dataSources, asOf)} />
          <Button variant="outline" size="sm" disabled={ro} onClick={() => navigate("/employees?add=1")}><UserPlus className="h-4 w-4" /> Create</Button>
          <Button variant="outline" size="sm" disabled={ro || terminated} onClick={() => setTerminating(true)}><UserMinus className="h-4 w-4" /> Terminate</Button>
          <Button variant="outline" size="sm" disabled={ro || !terminated} title={terminated ? undefined : "Available after their last working day"} onClick={() => setDeleting(true)}><Trash2 className="h-4 w-4" /> Delete</Button>
          <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => { setDraft(saved); setMsg(null) }}><RotateCcw className="h-4 w-4" /> Revert</Button>
          <Button size="sm" disabled={ro || !dirty} onClick={save}><Save className="h-4 w-4" /> Save</Button>
        </div>
      </div>

      {terminating && (
        <TerminateDialog
          name={agent.name}
          defaultDate={asOf}
          minDate={draft.startDate}
          onClose={() => setTerminating(false)}
          onConfirm={(endDate) => {
            const next = { ...draft, endDate }
            setDraft(next)
            saveEmployeeProfile(agent.id, next)
            setTerminating(false)
            setMsg({ ok: true, text: `Last working day set to ${fmtDay(endDate)}.${exitNote(next)}` })
          }}
        />
      )}
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${agent.name}?`}
        description="Removes their record altogether, including from the HC tracker. The change log keeps a note. This can't be undone."
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleting(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { deleteEmployee(agent.id); navigate("/employees") }}><Trash2 className="h-4 w-4" /> Delete</Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">Their profile and data-source IDs are deleted too. The audit trail keeps a record.</p>
      </Dialog>
    </>
  )
}

function Section({ title, open, onToggle, count, children }: { title: string; open: boolean; onToggle: () => void; count?: number; children: React.ReactNode }) {
  return (
    <Card className="glass">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-2 px-6 py-4 text-left font-semibold">
        {open ? <ChevronDown className="h-4 w-4 text-primary" /> : <ChevronRight className="h-4 w-4 text-primary" />}
        {title}
        {!!count && <Badge variant="secondary">{count}</Badge>}
      </button>
      {open && <CardContent className="pt-0">{children}</CardContent>}
    </Card>
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_minmax(0,1fr)] items-center gap-3 sm:grid-cols-[150px_minmax(0,1fr)]">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div>{children}</div>
    </div>
  )
}

function TaxIdField({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (v: string) => void }) {
  const [reveal, setReveal] = useState(false)
  if (readOnly || !reveal) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex h-9 flex-1 items-center rounded-md border bg-muted/30 px-3 font-mono text-sm tabular-nums text-muted-foreground" aria-label="Tax ID (SSN)">
          {maskTaxId(value) || "—"}
        </div>
        {!readOnly && (
          <Button variant="ghost" size="sm" aria-label="Show tax ID" onClick={() => setReveal(true)}><Eye className="h-4 w-4" /></Button>
        )}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <Input aria-label="Tax ID (SSN)" autoComplete="off" className="font-mono" value={value} placeholder="123-45-6789" onChange={(e) => onChange(e.target.value)} />
      <Button variant="ghost" size="sm" aria-label="Hide tax ID" onClick={() => setReveal(false)}><EyeOff className="h-4 w-4" /></Button>
    </div>
  )
}

/** An effective-dated value: the one in effect on "as of" with its dates; the
 *  pencil sets a new value from a date, the clock shows the history. */
function DatedRow({
  label, history, asOf, readOnly, type, format = String, suggestions, onChange,
}: {
  label: string
  history: Dated<number | string>[]
  asOf: string
  readOnly: boolean
  type: "number" | "text"
  format?: (v: number | string) => string
  suggestions?: string[]
  onChange: (h: Dated<number | string>[]) => void
}) {
  const current = valueAsOf(history, asOf)
  const [editing, setEditing] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [value, setValue] = useState("")
  const [from, setFrom] = useState(asOf)
  const listId = `dl-${label.replace(/\W/g, "")}`
  const start = () => {
    setValue(current ? String(current.value) : "")
    setFrom(asOf)
    setEditing(true)
  }
  const valid = value.trim() !== "" && (type === "text" || Number.isFinite(Number(value))) && !!from
  return (
    <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-3 sm:grid-cols-[150px_minmax(0,1fr)]">
      <span className="pt-2 text-sm text-muted-foreground">{label}</span>
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <div className="flex h-9 flex-1 items-center rounded-md border bg-muted/30 px-3 text-sm tabular-nums" aria-label={label}>
            {current ? format(current.value) : "—"}
          </div>
          {!readOnly && (
            <Button variant="ghost" size="sm" aria-label={`Change ${label.toLowerCase()}`} onClick={start}><Pencil className="h-4 w-4" /></Button>
          )}
          <Button variant="ghost" size="sm" aria-label={`${label} history`} aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}>
            <History className="h-4 w-4" />
          </Button>
        </div>
        {current && (
          <p className="text-xs text-muted-foreground">
            {fmtDay(current.from)} – {current.to ? fmtDay(current.to) : "ongoing"}
          </p>
        )}
        {editing && (
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-primary/40 bg-primary/5 p-2">
            <Field label="New value">
              <Input aria-label={`New ${label.toLowerCase()}`} type={type} step={type === "number" ? "any" : undefined} list={suggestions ? listId : undefined} className="h-8 w-[170px]" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
            </Field>
            {suggestions && <datalist id={listId}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>}
            <Field label="Effective from">
              <Input aria-label={`${label} effective from`} type="date" className="h-8 w-[150px]" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Button
              size="sm"
              disabled={!valid}
              onClick={() => {
                onChange(setEffective(history, type === "number" ? Number(value) : value.trim(), from))
                setEditing(false)
              }}
            >
              Apply
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        )}
        {showHistory && (
          <ul className="space-y-0.5 rounded-lg border p-2 text-xs" aria-label={`${label} history list`}>
            {[...history].sort((a, b) => b.from.localeCompare(a.from)).map((h) => (
              <li key={h.from} className={cn("flex justify-between gap-3 tabular-nums", h === current && "font-semibold text-foreground")}>
                <span>{format(h.value)}</span>
                <span className="text-muted-foreground">{fmtDay(h.from)} – {h.to ? fmtDay(h.to) : "ongoing"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function AddDataSource({ onAdd }: { onAdd: (name: string, kind: DataSourceKind) => void }) {
  const [name, setName] = useState("")
  const [kind, setKind] = useState<DataSourceKind>("phone")
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Input aria-label="New data source" placeholder="Add a data source…" className="h-8 max-w-[220px]" value={name} onChange={(e) => setName(e.target.value)} />
      <Select aria-label="Data source type" value={kind} onChange={(e) => setKind(e.target.value as DataSourceKind)} options={DATA_SOURCE_KINDS} className="h-8" />
      <Button size="sm" variant="outline" disabled={!name.trim()} onClick={() => { onAdd(name, kind); setName("") }}><Plus className="h-4 w-4" /> Add</Button>
    </div>
  )
}

function TerminateDialog({ name, defaultDate, minDate, onClose, onConfirm }: { name: string; defaultDate: string; minDate: string; onClose: () => void; onConfirm: (d: string) => void }) {
  const [date, setDate] = useState(defaultDate < minDate ? minDate : defaultDate)
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Terminate ${name}`}
      description="Sets their last working day. The day after, they come off the campaign: the roster, schedules and the real-time board. The HC tracker keeps their record."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={!date || date < minDate} onClick={() => onConfirm(date)}><UserMinus className="h-4 w-4" /> Terminate</Button>
        </>
      }
    >
      <Field label="Last working day">
        <Input type="date" aria-label="Last working day" min={minDate} value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
    </Dialog>
  )
}
