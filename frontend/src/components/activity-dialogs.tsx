import { useMemo, useRef, useState } from "react"
import { CheckCircle2, FileDown, Trash2, Upload, XCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { downloadActivityTemplate, readActivityFile, resolveActivityRows, type ActivityImportRow } from "@/lib/activityImport"
import {
  ACTIVITIES,
  ACTIVITY_BY_ID,
  CHANNELS,
  channelsWorked,
  fmtHM,
  proposeActivity,
  shiftBounds,
  staggeredWindow,
  toMins,
  type ActivityProposal,
  type ActivitySegment,
  type ActivityType,
  type Channel,
} from "@/lib/domain/channels"
import type { Agent } from "@/lib/domain/types"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

export interface AddActivityPreset {
  agentIds?: string[]
  type?: ActivityType
  start?: number
}

let nextId = 0
const newId = () => `act${Date.now().toString(36)}${nextId++}`

const chip = (on: boolean) =>
  cn(
    "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
    on ? "border-primary/60 bg-primary/10 font-semibold text-foreground" : "text-muted-foreground hover:bg-muted/40",
  )

const ANY = "__any"
const uniq = (xs: string[]) => [...new Set(xs)].sort()

/** Swatch matching how an activity is drawn in the schedule's upper band. */
export function ActivitySwatch({ type, className }: { type: ActivityType; className?: string }) {
  return <i className={cn("inline-block h-2.5 w-4 rounded-full ring-1 ring-white/70", className)} style={{ background: ACTIVITY_BY_ID[type].color }} />
}

/** Add meetings / training / coaching / LOA / absence / other AUX in bulk:
 *  pick agents by team, TL, shift, channel or skill (optionally staggered in
 *  waves), or upload a spreadsheet — previewing every agent before saving. */
export function AddActivityDialog({ agents, preset, onClose }: { agents: Agent[]; preset?: AddActivityPreset; onClose: () => void }) {
  const { activityPlan, channelPlan, overtimePlan, queues, addActivities } = useWfm()
  const [mode, setMode] = useState<"pick" | "upload">("pick")

  // ---- What & when ----
  const initialType = preset?.type ?? "meeting"
  const [type, setType] = useState<ActivityType>(initialType)
  const [fullShift, setFullShift] = useState(!!ACTIVITY_BY_ID[initialType].fullShift)
  const startDefault = preset?.start ?? toMins("10:00")
  const [times, setTimes] = useState({ start: fmtHM(startDefault), end: fmtHM(startDefault + 30) })
  const [note, setNote] = useState("")
  const [stagger, setStagger] = useState({ on: false, groupSize: 5, every: 30 })

  function pickType(t: ActivityType) {
    setType(t)
    // LOA / absence default to the whole shift; others to a time window.
    setFullShift(!!ACTIVITY_BY_ID[t].fullShift)
  }

  // ---- Who: quick filters → select all matching ----
  const [filters, setFilters] = useState({ team: ANY, tl: ANY, shift: ANY, channel: ANY, skill: ANY })
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preset?.agentIds ?? []))
  const options = useMemo(
    () => ({
      team: uniq(agents.map((a) => a.team)),
      tl: uniq(agents.map((a) => a.tl)),
      shift: uniq(agents.map((a) => a.shift)),
    }),
    [agents],
  )
  const listed = useMemo(
    () =>
      agents.filter(
        (a) =>
          (filters.team === ANY || a.team === filters.team) &&
          (filters.tl === ANY || a.tl === filters.tl) &&
          (filters.shift === ANY || a.shift === filters.shift) &&
          (filters.skill === ANY || a.skills.includes(filters.skill)) &&
          (filters.channel === ANY || channelsWorked(a, channelPlan, overtimePlan).has(filters.channel as Channel)) &&
          (!query || `${a.name} ${a.id}`.toLowerCase().includes(query.toLowerCase())),
      ),
    [agents, filters, query, channelPlan, overtimePlan],
  )

  // Each selected agent's window — staggered in waves by selection (roster) order.
  const length = Math.max(0, toMins(times.end) - toMins(times.start))
  const selectedOrder = useMemo(() => agents.filter((a) => selected.has(a.id)).map((a) => a.id), [agents, selected])
  const proposals = useMemo(() => {
    const map = new Map<string, ActivityProposal>()
    for (const a of agents) {
      const i = selectedOrder.indexOf(a.id)
      const [start, end] =
        !fullShift && stagger.on && i >= 0
          ? staggeredWindow(i, toMins(times.start), length, stagger.groupSize, stagger.every)
          : [toMins(times.start), toMins(times.end)]
      map.set(a.id, proposeActivity(a, activityPlan[a.id] ?? [], { type, fullShift, start, end, note: note.trim() || undefined }))
    }
    return map
  }, [agents, selectedOrder, activityPlan, type, fullShift, times, note, stagger, length])

  const ready = selectedOrder.flatMap((id) => {
    const p = proposals.get(id)
    return p?.ok ? [{ agentId: id, segment: { ...p.segment, id: newId() } }] : []
  })
  const blocked = selectedOrder.length - ready.length
  const waves = !fullShift && stagger.on ? Math.ceil(selectedOrder.length / Math.max(1, stagger.groupSize)) : 1

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // ---- Upload ----
  const fileRef = useRef<HTMLInputElement>(null)
  const [upload, setUpload] = useState<{ file: string; rows: ActivityImportRow[] } | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    try {
      setUploadError(null)
      setUpload({ file: file.name, rows: resolveActivityRows(await readActivityFile(file), agents, activityPlan) })
    } catch (err) {
      setUpload(null)
      setUploadError(`Could not read ${file.name}: ${(err as Error).message}`)
    }
  }
  const uploadReady = (upload?.rows ?? []).filter((r) => r.ok)

  function save() {
    if (mode === "upload") {
      if (!uploadReady.length) return
      const byType = ACTIVITIES.map((t) => [t.label, uploadReady.filter((r) => r.type === t.id).length] as const).filter(([, n]) => n)
      addActivities(
        uploadReady.map((r) => ({ agentId: r.agent!.id, segment: { ...r.segment!, id: newId() } })),
        `Bulk upload ${upload!.file} · ${uploadReady.length} activit${uploadReady.length > 1 ? "ies" : "y"} (${byType.map(([l, n]) => `${n} ${l}`).join(", ")})`,
      )
      onClose()
      return
    }
    if (!ready.length) return
    const names = ready.map((r) => agents.find((a) => a.id === r.agentId)?.name ?? r.agentId)
    const when = fullShift ? "full shift" : `${times.start}–${times.end}${waves > 1 ? ` in ${waves} waves of ${stagger.groupSize} every ${stagger.every}m` : ""}`
    addActivities(
      ready,
      `${ACTIVITY_BY_ID[type].label}${note.trim() ? ` (${note.trim()})` : ""} · ${when} · ${ready.length} agent(s): ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` +${names.length - 5}` : ""}`,
    )
    onClose()
  }

  const count = mode === "upload" ? uploadReady.length : ready.length
  const filterSelect = (key: keyof typeof filters, label: string, opts: { value: string; label: string }[]) => (
    <Select
      aria-label={label}
      className="h-8 text-xs"
      value={filters[key]}
      onChange={(e) => setFilters({ ...filters, [key]: e.target.value })}
      options={[{ value: ANY, label: `${label}: any` }, ...opts]}
    />
  )

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add activity"
      description="Add meetings, training, coaching, LOA, absence or other AUX for one or many agents in one go. They overlay the upper part of the schedule and take the agent off the channel."
      className="max-w-4xl"
      footer={
        <>
          {mode === "pick" && blocked > 0 && (
            <span className="mr-auto self-center text-xs text-amber-500">{blocked} selected agent(s) can't take this — see reasons below.</span>
          )}
          {mode === "upload" && upload && upload.rows.length > uploadReady.length && (
            <span className="mr-auto self-center text-xs text-amber-500">{upload.rows.length - uploadReady.length} row(s) have problems and will be skipped.</span>
          )}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!count}>
            {mode === "upload"
              ? `Add ${count} activit${count === 1 ? "y" : "ies"} from file`
              : `Add ${ACTIVITY_BY_ID[type].label}${count ? ` · ${count} agent${count > 1 ? "s" : ""}` : ""}`}
          </Button>
        </>
      }
    >
      <div className="mb-4 flex gap-2 border-b pb-3">
        <button type="button" aria-pressed={mode === "pick"} className={chip(mode === "pick")} onClick={() => setMode("pick")}>Pick agents</button>
        <button type="button" aria-pressed={mode === "upload"} className={chip(mode === "upload")} onClick={() => setMode("upload")}>
          <Upload className="h-3 w-3" /> Upload file (bulk)
        </button>
      </div>

      {mode === "pick" ? (
        <div className="space-y-4">
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase text-muted-foreground">Activity</h3>
            <div className="flex flex-wrap gap-2">
              {ACTIVITIES.map((t) => (
                <button key={t.id} type="button" aria-pressed={type === t.id} className={chip(type === t.id)} onClick={() => pickType(t.id)}>
                  <ActivitySwatch type={t.id} /> {t.label}
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase text-muted-foreground">When</h3>
              <div className="flex gap-2">
                <button type="button" aria-pressed={fullShift} className={chip(fullShift)} onClick={() => setFullShift(true)}>Full shift</button>
                <button type="button" aria-pressed={!fullShift} className={chip(!fullShift)} onClick={() => setFullShift(false)}>Set times</button>
              </div>
            </div>
            {!fullShift && (
              <div className="flex items-center gap-2">
                <Input type="time" step={300} className="w-28" aria-label="Activity start" value={times.start} onChange={(e) => e.target.value && setTimes({ ...times, start: e.target.value })} />
                <span className="text-muted-foreground">–</span>
                <Input type="time" step={300} className="w-28" aria-label="Activity end" value={times.end} onChange={(e) => e.target.value && setTimes({ ...times, end: e.target.value })} />
              </div>
            )}
            <Input className="min-w-[12rem] flex-1" placeholder="Note (optional) — e.g. Q3 product update" aria-label="Activity note" value={note} onChange={(e) => setNote(e.target.value)} />
          </section>

          {!fullShift && (
            <section className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs">
              <label className="flex cursor-pointer items-center gap-1.5 font-medium">
                <input type="checkbox" className="accent-primary" checked={stagger.on} onChange={(e) => setStagger({ ...stagger, on: e.target.checked })} aria-label="Stagger in waves" />
                Stagger in waves
              </label>
              <span className={cn("flex items-center gap-1.5", !stagger.on && "opacity-50")}>
                groups of
                <Input type="number" min={1} className="h-7 w-16 text-xs" aria-label="Agents per wave" disabled={!stagger.on} value={stagger.groupSize}
                  onChange={(e) => setStagger({ ...stagger, groupSize: Math.max(1, Number(e.target.value) || 1) })} />
                every
                <Input type="number" min={5} step={5} className="h-7 w-16 text-xs" aria-label="Minutes between waves" disabled={!stagger.on} value={stagger.every}
                  onChange={(e) => setStagger({ ...stagger, every: Math.max(5, Number(e.target.value) || 5) })} />
                min
              </span>
              <span className="ml-auto text-muted-foreground">
                {stagger.on && selectedOrder.length ? `${waves} wave${waves > 1 ? "s" : ""} · last starts ${fmtHM(staggeredWindow(selectedOrder.length - 1, toMins(times.start), length, stagger.groupSize, stagger.every)[0])}` : "Keeps the floor covered — not everyone off at once."}
              </span>
            </section>
          )}

          <section>
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">Agents</h3>
              {filterSelect("team", "Team", options.team.map((t) => ({ value: t, label: t })))}
              {filterSelect("tl", "Team Lead", options.tl.map((t) => ({ value: t, label: t })))}
              {filterSelect("shift", "Shift", options.shift.map((t) => ({ value: t, label: t })))}
              {filterSelect("channel", "Channel", CHANNELS.map((c) => ({ value: c.id, label: c.label })))}
              {filterSelect("skill", "Skill", queues.map((q) => ({ value: q.id, label: q.name })))}
              <Input className="h-8 w-40" placeholder="Search name / ID" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search agents" />
            </div>
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">{listed.length} matching</span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setSelected(new Set([...selected, ...listed.filter((a) => proposals.get(a.id)?.ok).map((a) => a.id)]))}
              >
                Select all matching ({listed.filter((a) => proposals.get(a.id)?.ok).length})
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelected(new Set([...selected].filter((id) => !listed.some((a) => a.id === id))))}>
                Unselect matching
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelected(new Set())}>Clear all</Button>
              <span className="ml-auto font-medium">{selected.size} selected</span>
            </div>
            <div className="max-h-72 overflow-y-auto rounded-lg border">
              {listed.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">No agents match these filters.</p>}
              {listed.map((a) => {
                const p = proposals.get(a.id)!
                const on = selected.has(a.id)
                return (
                  <label key={a.id} className={cn("flex cursor-pointer items-center gap-3 border-b px-3 py-1.5 text-sm last:border-b-0 hover:bg-muted/30", on && "bg-primary/5")}>
                    <input type="checkbox" className="accent-primary" checked={on} onChange={() => toggle(a.id)} aria-label={`Select ${a.name}`} />
                    <span className="w-36 truncate font-medium">{a.name}</span>
                    <span className="w-20 truncate text-xs text-muted-foreground">{a.team}</span>
                    <span className="w-24 tabular-nums text-xs text-muted-foreground">{a.shift}</span>
                    <span className={cn("ml-auto flex items-center gap-1 text-xs tabular-nums", p.ok ? (on ? "text-emerald-500" : "text-muted-foreground") : "text-destructive")}>
                      {p.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                      {p.ok ? `${fmtHM(p.segment.start)}–${fmtHM(p.segment.end)}` : p.reason}
                    </span>
                  </label>
                )
              })}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{ready.length} will get this activity. It counts against on-duty heads & SL.</p>
          </section>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            One row per activity: <b className="text-foreground">Agent ID or name · Activity · Start · End</b> (or <b className="text-foreground">Full Shift = Y</b>) · optional Note.
            Activity accepts {ACTIVITIES.map((a) => a.label).join(", ")} or their codes ({ACTIVITIES.map((a) => a.short).join(", ")}). Copy a row to give someone several activities.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => downloadActivityTemplate(agents)}><FileDown className="h-4 w-4" /> Download template</Button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" aria-label="Activity file" onChange={onFile} />
            <Button onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" /> Upload filled file</Button>
          </div>
          {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
          {upload && (
            <>
              <p className="text-xs text-muted-foreground">
                {upload.file}: <b className="text-emerald-500">{uploadReady.length} ready</b>
                {upload.rows.length > uploadReady.length && <>, <b className="text-destructive">{upload.rows.length - uploadReady.length} with problems</b></>}
              </p>
              <div className="max-h-72 overflow-y-auto rounded-lg border">
                {upload.rows.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">No rows with an Activity filled in.</p>}
                {upload.rows.map((r) => (
                  <div key={r.row} className="flex items-center gap-3 border-b px-3 py-1.5 text-sm last:border-b-0">
                    <span className="w-12 text-xs tabular-nums text-muted-foreground">Row {r.row}</span>
                    <span className="w-36 truncate font-medium">{r.agent?.name ?? r.agentCell}</span>
                    <span className="flex w-24 items-center gap-1.5 text-xs">{r.type && <><ActivitySwatch type={r.type} /> {ACTIVITY_BY_ID[r.type].label}</>}</span>
                    <span className={cn("ml-auto flex items-center gap-1 text-xs tabular-nums", r.ok ? "text-emerald-500" : "text-destructive")}>
                      {r.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                      {r.ok ? `${fmtHM(r.segment!.start)}–${fmtHM(r.segment!.end)}${r.segment!.note ? ` · ${r.segment!.note}` : ""}` : r.reason}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Dialog>
  )
}

/** Edit or delete one activity (opened by clicking it on the schedule). */
export function EditActivityDialog({ agent, activity, onClose }: { agent: Agent; activity: ActivitySegment; onClose: () => void }) {
  const { activityPlan, updateActivity, removeActivity } = useWfm()
  const [type, setType] = useState<ActivityType>(activity.type)
  const [times, setTimes] = useState({ start: fmtHM(activity.start), end: fmtHM(activity.end) })
  const [note, setNote] = useState(activity.note ?? "")
  const [s, e] = shiftBounds(agent)

  const others = (activityPlan[agent.id] ?? []).filter((x) => x.id !== activity.id)
  const p = proposeActivity(agent, others, { type, fullShift: false, start: toMins(times.start), end: toMins(times.end), note: note.trim() || undefined })

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${ACTIVITY_BY_ID[activity.type].label} — ${agent.name}`}
      description={`Shift ${fmtHM(s)}–${fmtHM(e)}`}
      footer={
        <>
          <Button variant="ghost" className="mr-auto text-destructive" onClick={() => { removeActivity(agent.id, activity.id); onClose() }}>
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!p.ok} onClick={() => { if (p.ok) { updateActivity(agent.id, { ...p.segment, id: activity.id }); onClose() } }}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {ACTIVITIES.map((t) => (
            <button key={t.id} type="button" aria-pressed={type === t.id} className={chip(type === t.id)} onClick={() => setType(t.id)}>
              <ActivitySwatch type={t.id} /> {t.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="time" step={300} className="w-28" aria-label="Activity start" value={times.start} onChange={(ev) => ev.target.value && setTimes({ ...times, start: ev.target.value })} />
          <span className="text-muted-foreground">–</span>
          <Input type="time" step={300} className="w-28" aria-label="Activity end" value={times.end} onChange={(ev) => ev.target.value && setTimes({ ...times, end: ev.target.value })} />
          <Button variant="ghost" size="sm" onClick={() => setTimes({ start: fmtHM(s), end: fmtHM(e) })}>Full shift</Button>
        </div>
        <Input placeholder="Note (optional)" aria-label="Activity note" value={note} onChange={(ev) => setNote(ev.target.value)} />
        {!p.ok && <p className="text-xs text-destructive">{p.reason}</p>}
      </div>
    </Dialog>
  )
}
