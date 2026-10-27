import { useQuery } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, CalendarCheck, CheckCircle2, Coffee, Loader2, Pencil, Plus, ShieldAlert, Shuffle, Trash2, Upload, Utensils } from "lucide-react"
import { useMemo, useState } from "react"

import { KpiCard } from "@/components/kpi-card"
import { SettingsSyncBadge } from "@/components/settings-sync-badge"
import { WorkRuleAlign } from "@/components/work-rule-align"
import { WorkRuleImportDialog } from "@/components/work-rule-import-dialog"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fmtHM, toMins } from "@/lib/domain/channels"
import { addDays, fmtDay, localISODate, weekStart } from "@/lib/domain/horizon"
import { fmtDuration } from "@/lib/domain/labourLaw"
import {
  checkWorkRule,
  DEFAULT_WORK_COMPLIANCE,
  describeBreaks,
  describeWeekOff,
  offDaysOn,
  parseWorkRulePatternId,
  placeBreaks,
  WEEK_OFF_PRESETS,
  WEEKDAYS,
  WORK_CHECK_LABEL,
  type BreakStep,
  type WeekOffMode,
  type WorkCheck,
  type WorkCompliance,
  type WorkRule,
} from "@/lib/domain/workRules"
import { useScheduleSync } from "@/lib/scheduleSync"
import { cn } from "@/lib/utils"
import { fetchRangeRows, rangeCompliance } from "@/lib/workRuleApply"
import { useAuth } from "@/store/auth"
import { useWfm } from "@/store/wfm"


/** Seven day toggles; pressed = day off. */
export function WeekOffPicker({ value, onChange, disabled, label }: { value: number[]; onChange: (v: number[]) => void; disabled?: boolean; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex gap-0.5">
      {WEEKDAYS.map((d, i) => {
        const off = value.includes(i)
        return (
          <button
            key={d}
            type="button"
            disabled={disabled}
            aria-pressed={off}
            aria-label={`${d} off`}
            title={off ? `${d}: week off` : `${d}: working`}
            onClick={() => onChange(off ? value.filter((x) => x !== i) : [...value, i].sort())}
            className={cn(
              "h-7 w-9 rounded border text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              off ? "border-slate-400 bg-slate-400/25 text-foreground line-through decoration-1" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            )}
          >
            {d}
          </button>
        )
      })}
    </div>
  )
}

/** Week off: a quick preset (e.g. "Fixed Sat–Sun"), Fixed / Rotating, and the days. */
export function WeekOffEditor({
  days,
  mode,
  onChange,
  disabled,
  label,
  compact,
}: {
  days: number[]
  mode: WeekOffMode
  onChange: (days: number[], mode: WeekOffMode) => void
  disabled?: boolean
  label: string
  compact?: boolean
}) {
  const key = (d: number[]) => [...d].sort().join(",")
  const preset = WEEK_OFF_PRESETS.find((p) => p.mode === mode && key(p.days) === key(days))
  const today = localISODate()
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!compact && (
        <Select aria-label={`${label} preset`} className="h-7 text-[11px]" disabled={disabled} value={preset?.id ?? "custom"}
          onChange={(e) => { const p = WEEK_OFF_PRESETS.find((x) => x.id === e.target.value); if (p) onChange(p.days, p.mode) }}
          options={[...(preset ? [] : [{ value: "custom", label: "Custom" }]), ...WEEK_OFF_PRESETS.map((p) => ({ value: p.id, label: p.label }))]} />
      )}
      <Select aria-label={`${label} type`} className="h-7 text-[11px]" disabled={disabled} value={mode}
        onChange={(e) => onChange(days, e.target.value as WeekOffMode)}
        options={[{ value: "fixed", label: "Fixed" }, { value: "rotating", label: "Rotating" }]} />
      <WeekOffPicker label={label} disabled={disabled} value={days} onChange={(d) => onChange(d, mode)} />
      {mode === "rotating" && days.length > 0 && (
        <span className="basis-full text-[10px] text-muted-foreground">
          This week off {offDaysOn(days, mode, today).map((d) => WEEKDAYS[d]).join(", ")} · next week {offDaysOn(days, mode, addDays(today, 7)).map((d) => WEEKDAYS[d]).join(", ")}
        </span>
      )}
    </div>
  )
}

/** The rule's day drawn to scale: work stretches (red when longer than the
 *  hours-in-a-row limit), breaks and lunches. */
function RuleBar({ rule, start, maxRun }: { rule: Pick<WorkRule, "shiftMinutes" | "breaks">; start: number; maxRun: number | null }) {
  const placed = placeBreaks(rule)
  const pieces: { kind: "work" | "break" | "lunch"; from: number; to: number }[] = []
  let at = 0
  for (const b of placed) {
    pieces.push({ kind: "work", from: at, to: b.offsetMinutes })
    pieces.push({ kind: b.type, from: b.offsetMinutes, to: b.offsetMinutes + b.durationMinutes })
    at = b.offsetMinutes + b.durationMinutes
  }
  pieces.push({ kind: "work", from: at, to: rule.shiftMinutes })
  const len = Math.max(1, rule.shiftMinutes)
  return (
    <div>
      <div className="flex h-5 overflow-hidden rounded border" aria-hidden>
        {pieces.filter((p) => p.to > p.from).map((p, i) => {
          const tooLong = p.kind === "work" && maxRun != null && p.to - p.from > maxRun * 60
          return (
            <div
              key={i}
              title={`${p.kind === "work" ? "Work" : p.kind === "lunch" ? "Lunch" : "Break"} ${fmtHM(start + p.from)}–${fmtHM(start + p.to)} (${fmtDuration(p.to - p.from)})`}
              style={{ width: `${((p.to - p.from) / len) * 100}%` }}
              className={cn(
                "flex items-center justify-center overflow-hidden text-[9px] font-semibold",
                p.kind === "work" && (tooLong ? "bg-destructive/70 text-white" : "bg-primary/60 text-white"),
                p.kind === "break" && "bg-amber-400 text-amber-950",
                p.kind === "lunch" && "bg-orange-500 text-white",
              )}
            >
              {p.kind === "work" ? fmtDuration(p.to - p.from) : `${p.to - p.from}m`}
            </div>
          )
        })}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>{fmtHM(start)}</span>
        <span>{fmtHM(Math.min(24 * 60, start + rule.shiftMinutes))}</span>
      </div>
    </div>
  )
}

function IssueList({ issues }: { issues: { message: string }[] }) {
  if (!issues.length) {
    return <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> Compliant</p>
  }
  return (
    <ul className="space-y-0.5 text-xs text-destructive">
      {issues.map((i, k) => <li key={k} className="flex gap-1"><ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" /> {i.message}</li>)}
    </ul>
  )
}

type Draft = Omit<WorkRule, "id">
const blankRule = (): Draft => ({ name: "", shiftMinutes: 480, breaks: [{ type: "break", minutes: 15 }, { type: "lunch", minutes: 30 }, { type: "break", minutes: 15 }], weekOff: [5, 6], weekOffMode: "fixed", defaultStart: "09:00" })

function RuleEditor({ initial, onClose, onSave }: { initial: Draft; onClose: () => void; onSave: (d: Draft) => void }) {
  const compliance = useWfm((s) => s.workCompliance)
  const [d, setD] = useState<Draft>(initial)
  const [error, setError] = useState("")
  const issues = checkWorkRule(d, compliance)
  const setBreak = (i: number, patch: Partial<BreakStep>) => setD({ ...d, breaks: d.breaks.map((b, k) => (k === i ? { ...b, ...patch } : b)) })
  const moveBreak = (i: number, by: number) => {
    const next = [...d.breaks]
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    setD({ ...d, breaks: next })
  }
  const autoName = () => `${fmtDuration(d.shiftMinutes)} · ${describeBreaks(d.breaks)}`

  function submit() {
    if (d.shiftMinutes < 60 || d.shiftMinutes > 16 * 60) return setError("Shift length must be between 1 and 16 hours.")
    if (d.breaks.some((b) => b.minutes < 5)) return setError("Each break needs at least 5 minutes.")
    if (d.breaks.reduce((t, b) => t + b.minutes, 0) >= d.shiftMinutes) return setError("Breaks can't take up the whole shift.")
    onSave({ ...d, name: d.name.trim() || autoName() })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={initial.name ? "Edit work rule" : "New work rule"}
      description="Shift length, the breaks inside it (spread evenly through the shift) and the usual days off."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit}>{initial.name ? "Save changes" : "Create rule"}</Button>
        </>
      }
    >
      <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block sm:col-span-3">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Name</span>
            <Input value={d.name} placeholder={autoName()} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Shift length (hours, breaks included)</span>
            <Input type="number" min={1} max={16} step={0.25} aria-label="Shift length in hours" value={d.shiftMinutes / 60}
              onChange={(e) => { setD({ ...d, shiftMinutes: Math.round((Number(e.target.value) || 0) * 60) }); setError("") }} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Usual start</span>
            <Input type="time" aria-label="Usual start" value={d.defaultStart} onChange={(e) => setD({ ...d, defaultStart: e.target.value || "09:00" })} />
          </label>
          <div>
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Worked time</span>
            <p className="h-9 text-sm leading-9 tabular-nums">{fmtDuration(Math.max(0, d.shiftMinutes - d.breaks.reduce((t, b) => t + b.minutes, 0)))}</p>
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Break pattern (in the order they're taken)</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setD({ ...d, breaks: [...d.breaks, { type: "break", minutes: 15 }] })}><Plus className="h-3.5 w-3.5" /> Break</Button>
              <Button variant="outline" size="sm" onClick={() => setD({ ...d, breaks: [...d.breaks, { type: "lunch", minutes: 30 }] })}><Plus className="h-3.5 w-3.5" /> Lunch</Button>
            </div>
          </div>
          <div className="space-y-1.5">
            {d.breaks.map((b, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg border px-3 py-1.5">
                <span className={cn("inline-flex w-20 items-center gap-1 text-xs font-semibold", b.type === "lunch" ? "text-orange-500" : "text-amber-600")}>
                  {b.type === "lunch" ? <Utensils className="h-3.5 w-3.5" /> : <Coffee className="h-3.5 w-3.5" />} {b.type === "lunch" ? "Lunch" : "Break"}
                </span>
                <Select aria-label={`Break ${i + 1} type`} className="h-8 text-xs" value={b.type} onChange={(e) => setBreak(i, { type: e.target.value as BreakStep["type"] })}
                  options={[{ value: "break", label: "Break" }, { value: "lunch", label: "Lunch" }]} />
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Input type="number" min={5} step={5} aria-label={`Break ${i + 1} minutes`} className="h-8 w-16" value={b.minutes}
                    onChange={(e) => { setBreak(i, { minutes: Number(e.target.value) || 0 }); setError("") }} /> min
                </label>
                <span className="ml-auto flex gap-0.5">
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={i === 0} aria-label="Move earlier" onClick={() => moveBreak(i, -1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={i === d.breaks.length - 1} aria-label="Move later" onClick={() => moveBreak(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Remove break" onClick={() => setD({ ...d, breaks: d.breaks.filter((_, k) => k !== i) })}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                </span>
              </div>
            ))}
            {!d.breaks.length && <p className="text-sm text-muted-foreground">No breaks — add one above.</p>}
          </div>
        </div>

        <div>
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Preview</span>
          <RuleBar rule={d} start={toMins(d.defaultStart)} maxRun={compliance.maxContinuousWorkHours} />
          <div className="mt-2"><IssueList issues={issues} /></div>
        </div>

        <div>
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Usual days off (new agents on this rule get these)</span>
          <WeekOffEditor label="Rule days off" days={d.weekOff} mode={d.weekOffMode ?? "fixed"} onChange={(weekOff, weekOffMode) => setD({ ...d, weekOff, weekOffMode })} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------- tabs

function RulesTab() {
  const { workRules, agents, workCompliance, addWorkRule, updateWorkRule, removeWorkRule } = useWfm()
  const [editing, setEditing] = useState<WorkRule | "new" | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const usage = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of agents) {
      const ref = parseWorkRulePatternId(a.shiftPatternId)
      if (ref) m.set(ref.ruleId, (m.get(ref.ruleId) ?? 0) + 1)
    }
    return m
  }, [agents])

  return (
    <>
      <div className="mb-3 flex justify-end">
        <PermissionGate module="shiftPatterns">
          <Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> New work rule</Button>
        </PermissionGate>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {workRules.map((r) => {
          const issues = checkWorkRule(r, workCompliance)
          const n = usage.get(r.id) ?? 0
          return (
            <Card key={r.id} className={cn("glass", issues.length && "border-destructive/50")} data-testid={`rule-${r.id}`}>
              <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
                <div>
                  <CardTitle className="text-base">{r.name}</CardTitle>
                  <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                    {fmtDuration(r.shiftMinutes)} shift · {fmtDuration(r.shiftMinutes - r.breaks.reduce((t, b) => t + b.minutes, 0))} worked · week off: {describeWeekOff(r.weekOff, r.weekOffMode)}
                  </p>
                </div>
                <Badge variant="secondary">{n} agent{n === 1 ? "" : "s"}</Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap gap-1">
                  {r.breaks.map((b, i) => (
                    <span key={i} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", b.type === "lunch" ? "bg-orange-500/15 text-orange-600" : "bg-amber-400/20 text-amber-700 dark:text-amber-300")}>
                      {b.type === "lunch" ? <Utensils className="h-3 w-3" /> : <Coffee className="h-3 w-3" />} {b.type === "lunch" ? "Lunch" : "Break"} {b.minutes}m
                    </span>
                  ))}
                  {!r.breaks.length && <span className="text-xs text-muted-foreground">No breaks</span>}
                </div>
                <RuleBar rule={r} start={toMins(r.defaultStart)} maxRun={workCompliance.maxContinuousWorkHours} />
                <IssueList issues={issues} />
                <PermissionGate module="shiftPatterns">
                  <div className="flex justify-end gap-2 pt-1">
                    {confirmDelete === r.id ? (
                      <>
                        <span className="mr-auto self-center text-xs text-destructive">{n ? `${n} agent${n === 1 ? "" : "s"} will come off this rule.` : "Delete this rule?"}</span>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>Keep</Button>
                        <Button variant="destructive" size="sm" onClick={() => { removeWorkRule(r.id); setConfirmDelete(null) }}>Delete</Button>
                      </>
                    ) : (
                      <>
                        <Button variant="outline" size="sm" onClick={() => setEditing(r)}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                        <Button variant="ghost" size="sm" aria-label={`Delete ${r.name}`} onClick={() => setConfirmDelete(r.id)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                      </>
                    )}
                  </div>
                </PermissionGate>
              </CardContent>
            </Card>
          )
        })}
      </div>
      {editing && (
        <RuleEditor
          initial={editing === "new" ? blankRule() : { name: editing.name, shiftMinutes: editing.shiftMinutes, breaks: editing.breaks, weekOff: editing.weekOff, weekOffMode: editing.weekOffMode ?? "fixed", defaultStart: editing.defaultStart }}
          onClose={() => setEditing(null)}
          onSave={(d) => {
            if (editing === "new") addWorkRule(d)
            else updateWorkRule(editing.id, d)
            setEditing(null)
          }}
        />
      )}
    </>
  )
}

function AgentsTab({ canEdit, canPublish }: { canEdit: boolean; canPublish: boolean }) {
  const { agents, workRules, workCompliance, assignWorkRule, setWeekOff } = useWfm()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<{ ruleId: string; start: string; weekOff: number[]; weekOffMode: WeekOffMode }>({ ruleId: workRules[0]?.id ?? "", start: workRules[0]?.defaultStart ?? "09:00", weekOff: workRules[0]?.weekOff ?? [5, 6], weekOffMode: workRules[0]?.weekOffMode ?? "fixed" })
  const [teamFilter, setTeamFilter] = useState("all")
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const teams = [...new Set(agents.map((a) => a.team))].sort()
  const rows = agents.filter((a) => teamFilter === "all" || a.team === teamFilter)
  const ruleOf = (id: string) => workRules.find((r) => r.id === id)
  const allSel = rows.length > 0 && rows.every((a) => selected.has(a.id))
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const pickBulkRule = (ruleId: string) => {
    const r = ruleOf(ruleId)
    setBulk({ ruleId, start: r?.defaultStart ?? bulk.start, weekOff: r?.weekOff ?? bulk.weekOff, weekOffMode: r?.weekOffMode ?? "fixed" })
  }

  /** Two days off in a row, rotated across the selection so every day keeps people. */
  function stagger() {
    const ids = rows.filter((a) => selected.has(a.id)).map((a) => a.id)
    ids.forEach((id, i) => {
      const first = (5 + i) % 7
      setWeekOff([id], [first, (first + 1) % 7], "fixed")
    })
    setMsg({ ok: true, text: `Staggered 2 days off in a row across ${ids.length} agent${ids.length === 1 ? "" : "s"} (Sat–Sun, Sun–Mon, Mon–Tue, …).` })
  }

  return (
    <div className="space-y-4">
      {canEdit && <WorkRuleAlign selectedIds={[...selected]} canPublish={canPublish} />}
      {msg && (
        <p role="status" className={cn("rounded-lg border px-3 py-2 text-xs", msg.ok ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-destructive/40 text-destructive")}>
          {msg.ok ? "✓ " : "✕ "}{msg.text}
        </p>
      )}

      {canEdit && selected.size > 0 && (
        <div role="toolbar" aria-label="Bulk work rule" className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs backdrop-blur">
          <span className="font-semibold">{selected.size} selected</span>
          <Select aria-label="Rule for selected" className="h-8 text-xs" value={bulk.ruleId} onChange={(e) => pickBulkRule(e.target.value)}
            options={workRules.map((r) => ({ value: r.id, label: r.name }))} />
          <Input type="time" aria-label="Start for selected" className="h-8 w-28 text-xs" value={bulk.start} onChange={(e) => setBulk({ ...bulk, start: e.target.value || bulk.start })} />
          <WeekOffEditor label="Days off for selected" days={bulk.weekOff} mode={bulk.weekOffMode} onChange={(weekOff, weekOffMode) => setBulk({ ...bulk, weekOff, weekOffMode })} />
          <Button size="sm" className="h-8" disabled={!bulk.ruleId} onClick={() => { assignWorkRule([...selected], bulk); setMsg({ ok: true, text: `${selected.size} agent${selected.size === 1 ? "" : "s"} now on "${ruleOf(bulk.ruleId)?.name}" from ${bulk.start}, week off ${describeWeekOff(bulk.weekOff, bulk.weekOffMode)}.` }) }}>
            Assign to {selected.size}
          </Button>
          <Button size="sm" variant="outline" className="h-8" onClick={() => setWeekOff([...selected], bulk.weekOff, bulk.weekOffMode)}>Only set days off</Button>
          <Button size="sm" variant="outline" className="h-8" onClick={stagger} title="Give each selected agent two days off in a row, rotating so every weekday keeps people">
            <Shuffle className="h-3.5 w-3.5" /> Stagger days off
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => assignWorkRule([...selected], null)}>Remove rule</Button>
          <Button size="sm" variant="ghost" className="ml-auto h-8" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <Card className="glass">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle className="text-base">Agents — work rule, start time and week off</CardTitle>
          <Select aria-label="Team" className="h-8 text-xs" value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}
            options={[{ value: "all", label: "All teams" }, ...teams.map((t) => ({ value: t, label: t }))]} />
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-xs" aria-label="Agent work rules">
            <thead className="bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2">
                  {canEdit && <input type="checkbox" aria-label="Select all" className="accent-primary" checked={allSel}
                    onChange={() => setSelected(allSel ? new Set() : new Set(rows.map((a) => a.id)))} />}
                </th>
                <th className="px-3 py-2">Agent</th>
                <th className="px-3 py-2">Work rule</th>
                <th className="px-3 py-2">Start</th>
                <th className="px-3 py-2">Shift</th>
                <th className="px-3 py-2">Week off</th>
                <th className="px-3 py-2">Rule check</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const ref = parseWorkRulePatternId(a.shiftPatternId)
                const rule = ref ? ruleOf(ref.ruleId) : undefined
                const start = ref?.start ?? a.shift.split("–")[0]
                const issues = rule ? checkWorkRule(rule, workCompliance) : []
                const off = a.weekOff ?? []
                return (
                  <tr key={a.id} className={cn("border-t", selected.has(a.id) && "bg-primary/5", (issues.length || (a.weekOff !== undefined && off.length === 0)) && "bg-destructive/5")}>
                    <td className="px-3 py-1.5">
                      {canEdit && <input type="checkbox" aria-label={`Select ${a.name}`} className="accent-primary" checked={selected.has(a.id)} onChange={() => toggle(a.id)} />}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="font-medium">{a.name}</div>
                      <div className="text-[10px] text-muted-foreground">{a.team}</div>
                    </td>
                    <td className="px-3 py-1.5">
                      <Select aria-label={`${a.name} work rule`} className="h-8 max-w-[15rem] text-xs" disabled={!canEdit} value={rule?.id ?? ""}
                        onChange={(e) => {
                          const r = ruleOf(e.target.value)
                          assignWorkRule([a.id], r ? { ruleId: r.id, start: ref?.start ?? r.defaultStart, weekOff: a.weekOff ?? r.weekOff, weekOffMode: a.weekOff ? a.weekOffMode : r.weekOffMode } : null)
                        }}
                        options={[{ value: "", label: "— No rule (shift pattern)" }, ...workRules.map((r) => ({ value: r.id, label: r.name }))]} />
                    </td>
                    <td className="px-3 py-1.5">
                      <Input type="time" aria-label={`${a.name} start`} className="h-8 w-28 text-xs" disabled={!canEdit || !rule} value={start}
                        onChange={(e) => rule && e.target.value && assignWorkRule([a.id], { ruleId: rule.id, start: e.target.value, weekOff: off, weekOffMode: a.weekOffMode })} />
                    </td>
                    <td className="px-3 py-1.5 tabular-nums text-muted-foreground">
                      {rule ? `${start}–${fmtHM(Math.min(24 * 60, toMins(start) + rule.shiftMinutes))}` : a.shift}
                    </td>
                    <td className="px-3 py-1.5">
                      <WeekOffEditor label={`${a.name} days off`} disabled={!canEdit} days={off} mode={a.weekOffMode ?? "fixed"} onChange={(v, m) => setWeekOff([a.id], v, m)} />
                    </td>
                    <td className="px-3 py-1.5">
                      {rule ? <IssueList issues={issues} /> : <span className="text-muted-foreground">—</span>}
                      {a.weekOff === undefined || off.length ? null : <p className="text-xs text-destructive">No day off in the week</p>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}

const LIMITS: { key: keyof WorkCompliance; label: string; unit: string; step: number; min: number }[] = [
  { key: "breakRequiredAfterHours", label: "Shifts of this long or more need a break", unit: "h", step: 0.5, min: 0.5 },
  { key: "maxContinuousWorkHours", label: "Max work in a row without a break", unit: "h", step: 0.25, min: 0.5 },
  { key: "lunchRequiredAfterHours", label: "Lunch needed when working over", unit: "h", step: 0.5, min: 1 },
  { key: "maxConsecutiveWorkDays", label: "Max days worked in a row", unit: "days", step: 1, min: 1 },
  { key: "minDaysOffPerWeek", label: "Min days off a week (Mon–Sun)", unit: "days", step: 1, min: 1 },
  { key: "maxWeeklyHours", label: "Max hours worked a week", unit: "h", step: 1, min: 1 },
  { key: "minRestBetweenShiftsHours", label: "Min rest between shifts", unit: "h", step: 0.5, min: 1 },
]

function ComplianceTab({ canEdit }: { canEdit: boolean }) {
  const { workCompliance, setWorkCompliance, agents, shiftPatterns, dayStore, activityPlan } = useWfm()
  const status = useScheduleSync((s) => s.status)
  const online = status !== "idle" && status !== "offline"
  const today = localISODate()
  const monday = weekStart(today)
  const ranges = {
    this: { label: `This week · ${fmtDay(monday)} – ${fmtDay(addDays(monday, 6))}`, start: monday, end: addDays(monday, 6) },
    next: { label: `Next week · ${fmtDay(addDays(monday, 7))} – ${fmtDay(addDays(monday, 13))}`, start: addDays(monday, 7), end: addDays(monday, 13) },
    "4w": { label: `Next 4 weeks · ${fmtDay(addDays(monday, 7))} – ${fmtDay(addDays(monday, 34))}`, start: addDays(monday, 7), end: addDays(monday, 34) },
  }
  const [rangeId, setRangeId] = useState<keyof typeof ranges>("next")
  const range = ranges[rangeId]
  const [onlyIssues, setOnlyIssues] = useState(true)
  const [ruleFilter, setRuleFilter] = useState<WorkCheck | null>(null)
  const { data: saved = [], isFetching } = useQuery({
    queryKey: ["work-rule-compliance", range.start, range.end],
    queryFn: () => fetchRangeRows(range.start, range.end),
    enabled: online,
  })
  const report = useMemo(
    () => rangeCompliance(range.start, range.end, saved),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rangeCompliance reads these from the store
    [range.start, range.end, saved, workCompliance, agents, shiftPatterns, dayStore, activityPlan],
  )
  const counts = new Map<WorkCheck, number>()
  for (const r of report) for (const i of r.issues) counts.set(i.rule, (counts.get(i.rule) ?? 0) + 1)
  const shown = report
    .map((r) => ({ ...r, issues: ruleFilter ? r.issues.filter((i) => i.rule === ruleFilter) : r.issues }))
    .filter((r) => !onlyIssues || r.issues.length)
  const failing = report.filter((r) => r.issues.length).length

  const set = (key: keyof WorkCompliance, v: number | null) => setWorkCompliance({ ...workCompliance, [key]: v })

  return (
    <div className="space-y-4">
      <Card className="glass">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Compliance rules</CardTitle>
          <p className="text-xs text-muted-foreground">Checked on every schedule — on the Scheduling timeline (the offending stretch is outlined in red) and in the report below. Untick a rule to switch it off.</p>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {LIMITS.map((l) => {
            const v = workCompliance[l.key] as number | null
            return (
              <label key={l.key} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
                <input type="checkbox" className="accent-primary" disabled={!canEdit} checked={v != null} aria-label={`Use: ${l.label}`}
                  onChange={(e) => set(l.key, e.target.checked ? ((DEFAULT_WORK_COMPLIANCE[l.key] as number) ?? l.min) : null)} />
                <span className="flex-1">{l.label}</span>
                <Input type="number" className="h-7 w-20 text-xs" aria-label={l.label} disabled={!canEdit || v == null} min={l.min} step={l.step} value={v ?? ""}
                  onChange={(e) => set(l.key, Math.max(l.min, Number(e.target.value) || l.min))} />
                <span className="w-8 text-muted-foreground">{l.unit}</span>
              </label>
            )
          })}
          <label className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
            <span className="flex-1">Shortest lunch that counts</span>
            <Input type="number" className="h-7 w-20 text-xs" aria-label="Shortest lunch that counts" disabled={!canEdit} min={5} step={5} value={workCompliance.minLunchMinutes}
              onChange={(e) => setWorkCompliance({ ...workCompliance, minLunchMinutes: Math.max(5, Number(e.target.value) || 30) })} />
            <span className="w-8 text-muted-foreground">min</span>
          </label>
        </CardContent>
      </Card>

      <Card className="glass">
        <CardHeader className="flex-row flex-wrap items-center gap-2 space-y-0 pb-2">
          <CardTitle className="mr-auto text-base">Compliance report</CardTitle>
          {isFetching && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          <Select aria-label="Weeks to check" className="h-8 text-xs" value={rangeId} onChange={(e) => setRangeId(e.target.value as keyof typeof ranges)}
            options={Object.entries(ranges).map(([id, r]) => ({ value: id, label: r.label }))} />
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" className="accent-primary" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> Only agents with issues
          </label>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5 text-xs">
            <span className={cn("rounded-full border px-2 py-0.5", failing ? "border-destructive/50 text-destructive" : "border-emerald-500/50 text-emerald-600 dark:text-emerald-400")}>
              {failing ? `${failing} of ${report.length} agents break a rule` : `All ${report.length} agents compliant`}
            </span>
            {[...counts].map(([rule, n]) => (
              <button key={rule} type="button" aria-pressed={ruleFilter === rule} onClick={() => setRuleFilter(ruleFilter === rule ? null : rule)}
                className={cn("rounded-full border border-destructive/40 px-2 py-0.5 text-destructive", ruleFilter === rule && "bg-destructive/10")}>
                {WORK_CHECK_LABEL[rule]} · {n}
              </button>
            ))}
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs" aria-label="Compliance report">
              <thead className="bg-muted/40 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5">Agent</th>
                  <th className="px-3 py-1.5">Days off</th>
                  <th className="px-3 py-1.5">Hours worked</th>
                  <th className="px-3 py-1.5">Issues</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.agent.id} className={cn("border-t align-top", r.issues.length && "bg-destructive/5")}>
                    <td className="px-3 py-1.5 font-medium">{r.agent.name}<div className="text-[10px] font-normal text-muted-foreground">week off: {describeWeekOff(r.agent.weekOff, r.agent.weekOffMode)}</div></td>
                    <td className="px-3 py-1.5 tabular-nums">{r.daysOff}</td>
                    <td className="px-3 py-1.5 tabular-nums">{fmtDuration(r.workedMinutes)}</td>
                    <td className="px-3 py-1.5">
                      {r.issues.length ? (
                        <ul className="space-y-0.5 text-destructive">
                          {r.issues.slice(0, 6).map((i, k) => <li key={k}>{i.date && <b className="mr-1 tabular-nums">{fmtDay(i.date)}</b>}{i.message}</li>)}
                          {r.issues.length > 6 && <li className="text-muted-foreground">+{r.issues.length - 6} more</li>}
                        </ul>
                      ) : <IssueList issues={[]} />}
                    </td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No issues in this range.</td></tr>}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export function WorkRules() {
  const { agents, workRules, workCompliance, can } = useWfm()
  const canEdit = can("shiftPatterns", "edit")
  const user = useAuth((s) => s.user)
  const canPublish = !!user && (user.is_superuser || user.permission_codes.includes("schedule:publish"))
  const onRule = agents.filter((a) => parseWorkRulePatternId(a.shiftPatternId)).length
  const withOff = agents.filter((a) => a.weekOff?.length).length
  const badRules = workRules.filter((r) => checkWorkRule(r, workCompliance).length).length
  const [importOpen, setImportOpen] = useState(false)
  const [imported, setImported] = useState<string | null>(null)
  return (
    <>
      <PageHeader
        title="Work Rules"
        subtitle="Shift + break patterns, week offs and the compliance rules every schedule is checked against"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SettingsSyncBadge />
            <PermissionGate module="shiftPatterns">
              <Button variant="outline" onClick={() => setImportOpen(true)}><Upload className="h-4 w-4" /> Bulk import</Button>
            </PermissionGate>
          </div>
        }
      />
      <WorkRuleImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={setImported} />
      {imported && (
        <p role="status" className="mb-4 rounded-lg border border-emerald-500/40 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">✓ Imported {imported}</p>
      )}
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Work rules" value={workRules.length} hint="shift + break patterns" icon={Coffee} />
        <KpiCard label="Agents on a rule" value={onRule} hint={`of ${agents.length}`} tone={onRule === agents.length ? "good" : "warn"} icon={CalendarCheck} />
        <KpiCard label="Agents with week offs" value={withOff} hint={`of ${agents.length}`} tone={withOff === agents.length ? "good" : "warn"} icon={CalendarCheck} />
        <KpiCard label="Rules breaking compliance" value={badRules} hint={badRules ? "see red cards" : "all compliant"} tone={badRules ? "bad" : "good"} icon={ShieldAlert} />
      </div>
      <Tabs defaultValue="agents">
        <TabsList>
          <TabsTrigger value="agents">Agents & week offs</TabsTrigger>
          <TabsTrigger value="rules">Shift & break patterns</TabsTrigger>
          <TabsTrigger value="compliance">Compliance</TabsTrigger>
        </TabsList>
        <TabsContent value="agents"><AgentsTab canEdit={canEdit} canPublish={canPublish} /></TabsContent>
        <TabsContent value="rules"><RulesTab /></TabsContent>
        <TabsContent value="compliance"><ComplianceTab canEdit={canEdit} /></TabsContent>
      </Tabs>
    </>
  )
}
