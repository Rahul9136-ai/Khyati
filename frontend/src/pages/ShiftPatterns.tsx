import { useMemo, useState } from "react"
import { Clock, Coffee, Pencil, Plus, Trash2, Utensils } from "lucide-react"

import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { BreakSegment, BreakType, ShiftPattern } from "@/lib/domain/shiftPatterns"
import { useWfm } from "@/store/wfm"

const uid = () => Math.random().toString(36).slice(2, 8)
const blankSegment = (type: BreakType): BreakSegment => ({
  id: uid(),
  type,
  label: type === "lunch" ? "Lunch" : "Break",
  offsetMinutes: type === "lunch" ? 240 : 120,
  durationMinutes: type === "lunch" ? 30 : 15,
})

function shiftHours(p: ShiftPattern): number {
  const [sh, sm] = p.start.split(":").map(Number)
  const [eh, em] = p.end.split(":").map(Number)
  return (eh * 60 + em - (sh * 60 + sm)) / 60
}

export function ShiftPatterns() {
  const { shiftPatterns, addShiftPattern, updateShiftPattern, removeShiftPattern, agents } = useWfm()
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const [name, setName] = useState("")
  const [start, setStart] = useState("07:00")
  const [end, setEnd] = useState("15:30")
  const [breaks, setBreaks] = useState<BreakSegment[]>([])
  const [error, setError] = useState("")

  const usageCount = useMemo(() => {
    const map = new Map<string, number>()
    agents.forEach((a) => {
      if (a.shiftPatternId) map.set(a.shiftPatternId, (map.get(a.shiftPatternId) ?? 0) + 1)
    })
    return map
  }, [agents])

  function openNew() {
    setEditingId(null)
    setName("")
    setStart("07:00")
    setEnd("15:30")
    setBreaks([blankSegment("break"), blankSegment("lunch")])
    setError("")
    setOpen(true)
  }

  function openEdit(p: ShiftPattern) {
    setEditingId(p.id)
    setName(p.name)
    setStart(p.start)
    setEnd(p.end)
    setBreaks(p.breaks.map((b) => ({ ...b })))
    setError("")
    setOpen(true)
  }

  function updateSeg(id: string, patch: Partial<BreakSegment>) {
    setBreaks((bs) => bs.map((b) => (b.id === id ? { ...b, ...patch } : b)))
  }
  const removeSeg = (id: string) => setBreaks((bs) => bs.filter((b) => b.id !== id))
  const addSeg = (type: BreakType) => setBreaks((bs) => [...bs, blankSegment(type)])

  function submit() {
    if (!name.trim()) return setError("Name is required.")
    if (start >= end) return setError("End time must be after start time.")
    const payload = { name: name.trim(), start, end, breaks }
    if (editingId) updateShiftPattern(editingId, payload)
    else addShiftPattern(payload)
    setOpen(false)
  }

  function onDelete(p: ShiftPattern) {
    const n = usageCount.get(p.id) ?? 0
    if (n > 0 && !confirm(`${n} agent(s) use "${p.name}". Delete anyway? Their shift times are unaffected; break markers will fall back to a default pattern.`)) return
    removeShiftPattern(p.id)
  }

  return (
    <>
      <PageHeader
        title="Shift Patterns"
        subtitle="Global shift & break templates — reused across the roster"
        actions={
          <PermissionGate module="shiftPatterns">
            <Button onClick={openNew}><Plus className="h-4 w-4" /> New pattern</Button>
          </PermissionGate>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Patterns" value={shiftPatterns.length} hint="global templates" icon={Clock} />
        <KpiCard label="Agents covered" value={agents.filter((a) => a.shiftPatternId).length} hint={`of ${agents.length}`} tone="good" icon={Coffee} />
        <KpiCard label="Avg breaks/shift" value={(shiftPatterns.reduce((s, p) => s + p.breaks.length, 0) / Math.max(1, shiftPatterns.length)).toFixed(1)} hint="per pattern" icon={Utensils} />
        <KpiCard label="Avg shift length" value={`${(shiftPatterns.reduce((s, p) => s + shiftHours(p), 0) / Math.max(1, shiftPatterns.length)).toFixed(1)}h`} hint="hours" icon={Clock} />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {shiftPatterns.map((p) => (
          <Card key={p.id} className="glass">
            <CardHeader className="flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle>{p.name}</CardTitle>
                <p className="mt-1 text-sm tabular-nums text-muted-foreground">{p.start} – {p.end} · {shiftHours(p).toFixed(1)}h</p>
              </div>
              <Badge variant="secondary">{usageCount.get(p.id) ?? 0} agents</Badge>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1.5">
                {p.breaks.length === 0 && <span className="text-xs text-muted-foreground">No breaks defined.</span>}
                {p.breaks.map((b) => (
                  <span
                    key={b.id}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${b.type === "lunch" ? "bg-amber-500/15 text-amber-500" : "bg-muted text-muted-foreground"}`}
                  >
                    {b.type === "lunch" ? <Utensils className="h-3 w-3" /> : <Coffee className="h-3 w-3" />}
                    {b.label} · +{(b.offsetMinutes / 60).toFixed(1)}h · {b.durationMinutes}m
                  </span>
                ))}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <PermissionGate module="shiftPatterns">
                  <Button variant="outline" size="sm" onClick={() => openEdit(p)}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                  <Button variant="ghost" size="sm" onClick={() => onDelete(p)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                </PermissionGate>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={editingId ? "Edit shift pattern" : "New shift pattern"}
        description="Used globally — every agent assigned to this pattern shares the same shift time and break/lunch layout."
        className="max-w-2xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit}>{editingId ? "Save changes" : "Create pattern"}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <label className="col-span-3 block sm:col-span-1">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Name</span>
              <Input value={name} onChange={(e) => { setName(e.target.value); setError("") }} placeholder="e.g. Early" autoFocus />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Start</span>
              <Input type="time" value={start} onChange={(e) => { setStart(e.target.value); setError("") }} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">End</span>
              <Input type="time" value={end} onChange={(e) => { setEnd(e.target.value); setError("") }} />
            </label>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Break & lunch segments</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => addSeg("break")}><Plus className="h-3.5 w-3.5" /> Break</Button>
                <Button variant="outline" size="sm" onClick={() => addSeg("lunch")}><Plus className="h-3.5 w-3.5" /> Lunch</Button>
              </div>
            </div>
            <div className="space-y-2">
              {breaks.map((b) => (
                <div key={b.id} className="grid grid-cols-12 items-center gap-2 rounded-lg border px-3 py-2">
                  <span className={`col-span-2 inline-flex items-center gap-1 text-xs font-semibold ${b.type === "lunch" ? "text-amber-500" : "text-muted-foreground"}`}>
                    {b.type === "lunch" ? <Utensils className="h-3.5 w-3.5" /> : <Coffee className="h-3.5 w-3.5" />}
                    {b.type === "lunch" ? "Lunch" : "Break"}
                  </span>
                  <Input className="col-span-4" value={b.label} onChange={(e) => updateSeg(b.id, { label: e.target.value })} placeholder="Label" />
                  <label className="col-span-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                    +<Input type="number" min={0} step={15} value={b.offsetMinutes} onChange={(e) => updateSeg(b.id, { offsetMinutes: +e.target.value })} className="w-16" />min
                  </label>
                  <label className="col-span-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Input type="number" min={15} step={15} value={b.durationMinutes} onChange={(e) => updateSeg(b.id, { durationMinutes: +e.target.value })} className="w-14" />min
                  </label>
                  <button type="button" onClick={() => removeSeg(b.id)} className="col-span-1 justify-self-end rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive" aria-label="Remove segment">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {breaks.length === 0 && <p className="text-sm text-muted-foreground">No break segments — add one above.</p>}
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </Dialog>
    </>
  )
}
