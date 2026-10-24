import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Clock, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react"

import { ActivitySwatch, AddActivityDialog, EditActivityDialog, type AddActivityPreset } from "@/components/activity-dialogs"
import { AddOvertimeDialog, type AddOvertimePreset } from "@/components/add-overtime-dialog"
import { AuxContextMenu, type AuxMenuChoice } from "@/components/aux-context-menu"
import { ExportButton } from "@/components/export-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import type { AbsenceRisk } from "@/lib/domain/absenceRisk"
import {
  ACTIVITIES,
  ACTIVITY_BY_ID,
  agentDay,
  applyEdit,
  AUX_KIND_BY_ID,
  AUX_SNAP,
  CHANNEL_BY_ID,
  CHANNELS,
  channelsWorked,
  coverageFromTimelines,
  dayTimeline,
  dayToPatch,
  describeEdit,
  editBounds,
  editValue,
  effectiveChannelSegments,
  equivalentOp,
  moveDay,
  fmtHM,
  markAux,
  primaryChannel,
  SCHEDULE_SORTS,
  scheduleExportSheets,
  shiftBounds,
  sortSchedules,
  timelineWindow,
  toMins,
  unmarkActivitiesAt,
  validateAgentPlan,
  type ActivitySegment,
  type AgentDay,
  type Channel,
  type ChannelSegment,
  type Edge,
  type EditOp,
  type ScheduleSort,
  type TimelineSegment,
} from "@/lib/domain/channels"
import { AUX_BY_CODE, INTERVALS } from "@/lib/domain/seed"
import type { Agent, PlanRow, Queue } from "@/lib/domain/types"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

/** Fill for one timeline segment. OT is drawn as grid lines in its channel's colour. */
function segmentStyle(seg: TimelineSegment): React.CSSProperties {
  if (seg.kind === "ot") {
    const c = CHANNEL_BY_ID[seg.channel!].color
    return {
      backgroundColor: `${c}1f`,
      backgroundImage: `linear-gradient(${c} 1px, transparent 1px), linear-gradient(90deg, ${c} 1px, transparent 1px)`,
      backgroundSize: "6px 6px",
      boxShadow: `inset 0 0 0 1.5px ${c}`,
      color: c,
    }
  }
  if (seg.kind === "channel") return { background: CHANNEL_BY_ID[seg.channel!].color, color: "#fff" }
  if (seg.kind === "break") return { background: AUX_BY_CODE.AUX1.color, color: "#fff" }
  if (seg.kind === "lunch") return { background: AUX_BY_CODE.AUX2.color, color: "#fff" }
  return { background: "repeating-linear-gradient(45deg, #64748b33 0 4px, transparent 4px 8px)", boxShadow: "inset 0 0 0 1px #64748b88" }
}

const NAME_COL = "grid grid-cols-[210px_1fr]"

/** A move/resize in progress on one agent's timeline. */
interface ScheduleDrag {
  agent: Agent
  op: EditOp
  /** The agent's day when the drag began — every preview is applied to this. */
  before: AgentDay
  x0: number
  pxPerMin: number
  orig: number
  value: number
  /** Other selected schedules that get the same change (bulk drag). */
  followers: { agent: Agent; before: AgentDay; op: EditOp }[]
}

/** Each agent's day after a (possibly bulk) drag: the dragged one at `value`,
 *  followers shifted by the same delta, each clamped to its own bounds. */
function dragResults(drag: ScheduleDrag, value: number): { agent: Agent; before: AgentDay; after: AgentDay; op: EditOp }[] {
  const delta = value - drag.orig
  return [
    { agent: drag.agent, before: drag.before, op: drag.op, after: applyEdit(drag.before, drag.op, value) },
    ...drag.followers.map((f) => ({ ...f, after: applyEdit(f.before, f.op, editValue(f.before, f.op) + delta) })),
  ]
}

const sameOp = (a: EditOp | undefined, b: EditOp) => JSON.stringify(a) === JSON.stringify(b)

/** Short label for what's being dragged, shown above it: new times + length. */
function dragLabel(day: AgentDay, op: EditOp): { text: string; at: number } {
  const len = (m: number) => (m % 60 ? `${m}m` : `${m / 60}h`)
  if (op.kind === "shift-resize") {
    const [s, e] = day.shift
    return { text: `Shift ${fmtHM(s)}–${fmtHM(e)} (${len(e - s)})`, at: op.edge === "start" ? s : e }
  }
  if (op.kind === "activity-move" || op.kind === "activity-resize") {
    const act = day.activities.find((x) => x.id === op.segId)
    if (!act) return { text: "", at: 0 }
    return { text: `${ACTIVITY_BY_ID[act.type].label} ${fmtHM(act.start)}–${fmtHM(act.end)} (${len(act.end - act.start)})`, at: (act.start + act.end) / 2 }
  }
  const list = op.kind === "channel-resize" ? day.channels : op.kind === "ot-resize" ? day.ot : day.breaks
  const item = list.find((x) => x.id === op.segId)
  if (!item) return { text: "", at: 0 }
  const name =
    "channel" in item ? `${op.kind === "ot-resize" ? "OT " : ""}${CHANNEL_BY_ID[item.channel].label}` : item.label
  return { text: `${name} ${fmtHM(item.start)}–${fmtHM(item.end)} (${len(item.end - item.start)})`, at: (item.start + item.end) / 2 }
}

/** Grab zone on a block's edge — drag (or focus + ←/→) to resize. */
function EdgeHandle({
  edge,
  label,
  onPointerDown,
  onKeyDown,
}: {
  edge: Edge
  label: string
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onKeyDown: (e: React.KeyboardEvent) => void
}) {
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      title={`${label} — drag to resize`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "absolute inset-y-0 z-10 flex w-1.5 cursor-ew-resize touch-none items-center justify-center outline-none",
        "opacity-0 focus-visible:opacity-100 group-hover/seg:opacity-100",
        edge === "start" ? "left-0" : "right-0",
      )}
    >
      <span className="h-3/4 w-[3px] rounded-full bg-white shadow ring-1 ring-black/30" />
    </div>
  )
}

export function ContinuousSchedule({
  agents,
  queue,
  plan,
  onDuty,
  canEdit,
  riskById,
}: {
  agents: Agent[]
  queue: Queue
  /** Coverage plan for the selected queue (incl. OT heads). */
  plan: PlanRow[]
  onDuty: number[]
  canEdit: boolean
  /** AI absence-risk flags, shown beside the agent's name. */
  riskById?: Map<string, AbsenceRisk>
}) {
  const { shiftPatterns, breakOverrides, channelPlan, overtimePlan, activityPlan, queues, updateAgentDay, updateAgentDays } = useWfm()
  const [filter, setFilter] = useState<Channel | "all">("all")
  const [grouped, setGrouped] = useState(true)
  const [sort, setSort] = useState<ScheduleSort>("roster")
  // Header buttons: first click sorts ascending, next click flips direction.
  const toggleSort = (key: "name" | "start") => setSort((cur) => (cur === `${key}-asc` ? `${key}-desc` : `${key}-asc`))
  const [editing, setEditing] = useState<Agent | null>(null)
  const [otPreset, setOtPreset] = useState<AddOvertimePreset | null>(null)
  const [activityPreset, setActivityPreset] = useState<AddActivityPreset | null>(null)
  const [editingActivity, setEditingActivity] = useState<{ agent: Agent; activity: ActivitySegment } | null>(null)

  // Each agent's day in absolute minutes — what every move/resize edits.
  const days = useMemo(
    () => new Map(agents.map((a) => [a.id, agentDay(a, shiftPatterns, breakOverrides, channelPlan, overtimePlan, activityPlan)])),
    [agents, shiftPatterns, breakOverrides, channelPlan, overtimePlan, activityPlan],
  )

  // ---- Multi-select schedules (Ctrl/⌘ + click, Shift + click, checkboxes) ----
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const anchor = useRef<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // Only agents still on screen count (role / props can change the list).
  const selectedAgents = useMemo(() => agents.filter((a) => selected.has(a.id)), [agents, selected])

  // ---- Move / resize with the mouse ----
  const [drag, setDrag] = useState<ScheduleDrag | null>(null)
  // A drag that ends over the row must not also open the row's editor.
  const justDragged = useRef(false)
  // While dragging, every affected timeline (the dragged agent's, plus all
  // selected schedules in a bulk drag) re-flows live.
  const previewDays = useMemo(
    () => new Map(drag ? dragResults(drag, drag.value).map((r) => [r.agent.id, r.after]) : []),
    [drag],
  )

  /** Commit one or many edited days — a bulk change is one audit entry. */
  function commitDays(results: { agent: Agent; before: AgentDay; after: AgentDay }[], detail: string) {
    const changed = results.filter((r) => JSON.stringify(r.after) !== JSON.stringify(r.before))
    if (!changed.length) return
    if (changed.length === 1 && results.length === 1) {
      updateAgentDay(changed[0].agent.id, dayToPatch(changed[0].after), detail)
      return
    }
    updateAgentDays(
      changed.map((r) => ({ agentId: r.agent.id, patch: dayToPatch(r.after) })),
      `${changed.length} schedules · ${detail}`,
    )
  }

  function commitDrag(d: ScheduleDrag, value: number) {
    const results = dragResults(d, value)
    const [main] = results
    const what = describeEdit(main.before, main.after, d.op)
    commitDays(results, d.followers.length ? `${what} (from ${main.agent.name}, applied to all selected)` : what)
  }

  /** The same edit for every other selected schedule that has a matching block. */
  function followersFor(agent: Agent, op: EditOp): ScheduleDrag["followers"] {
    if (!selected.has(agent.id) || selected.size < 2) return []
    const before = days.get(agent.id)!
    return selectedAgents.flatMap((other) => {
      if (other.id === agent.id) return []
      const theirs = days.get(other.id)!
      const eq = equivalentOp(before, op, theirs)
      return eq ? [{ agent: other, before: theirs, op: eq }] : []
    })
  }

  /** Apply a whole-day transform to every selected schedule. */
  function bulkApply(fn: (day: AgentDay) => AgentDay, detail: string) {
    commitDays(
      selectedAgents.map((a) => {
        const before = days.get(a.id)!
        return { agent: a, before, after: fn(before) }
      }),
      detail,
    )
  }
  // ---- Right-click: mark any AUX on the targeted schedules ----
  const [menu, setMenu] = useState<{ x: number; y: number; at: number; targetIds: string[] } | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  function onRowContextMenu(e: React.MouseEvent<HTMLElement>, a: Agent, day: AgentDay) {
    if (!canEdit) return
    e.preventDefault()
    const track = e.currentTarget.querySelector("[data-track]")!.getBoundingClientRect()
    // Time under the cursor (snapped); right-clicking the name column means "from shift start".
    const raw = e.clientX >= track.left && track.width > 0 ? lo + ((e.clientX - track.left) / track.width) * span : day.shift[0]
    const at = Math.round(raw / AUX_SNAP) * AUX_SNAP
    // Right-click inside the selection targets all of it; elsewhere it selects just this row.
    let targetIds = rowOrder.filter((id) => selected.has(id))
    if (!selected.has(a.id)) {
      targetIds = [a.id]
      setSelected(new Set([a.id]))
      anchor.current = a.id
    }
    setNotice(null)
    setMenu({ x: e.clientX, y: e.clientY, at, targetIds })
  }

  const menuTargets = (m: NonNullable<typeof menu>) => m.targetIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a)

  function markFromMenu(choice: AuxMenuChoice) {
    if (!menu) return
    const k = AUX_KIND_BY_ID[choice.kind]
    const id = `mk${Date.now().toString(36)}` // shared id → bulk-drag can match it across agents later
    const results: { agent: Agent; before: AgentDay; after: AgentDay }[] = []
    const skipped: string[] = []
    for (const a of menuTargets(menu)) {
      const before = days.get(a.id)!
      const r = markAux(before, choice.kind, choice.start, choice.length, choice.fullShift, id)
      if (r.ok) results.push({ agent: a, before, after: r.day })
      else skipped.push(`${a.name}: ${r.reason}`)
    }
    const when = choice.fullShift ? "full shift" : `${fmtHM(choice.start)}–${fmtHM(choice.start + choice.length)}`
    if (results.length) commitDays(results, `Marked ${k.label} ${when}`)
    setNotice({
      ok: results.length > 0,
      text:
        `${k.label} ${when} marked for ${results.length} agent${results.length === 1 ? "" : "s"}` +
        (skipped.length ? ` · ${skipped.length} skipped — ${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? "; …" : ""}` : ""),
    })
    setMenu(null)
  }

  function removeFromMenu() {
    if (!menu) return
    const results = menuTargets(menu).map((a) => {
      const before = days.get(a.id)!
      return { agent: a, before, after: unmarkActivitiesAt(before, menu.at) }
    })
    const n = results.reduce((t, r) => t + r.before.activities.length - r.after.activities.length, 0)
    commitDays(results, `Removed ${n} activit${n === 1 ? "y" : "ies"} at ${fmtHM(menu.at)}`)
    setNotice({ ok: true, text: `Removed ${n} activit${n === 1 ? "y" : "ies"} at ${fmtHM(menu.at)}` })
    setMenu(null)
  }

  const moveSelected = (delta: number) =>
    bulkApply((d) => moveDay(d, delta), `moved ${Math.abs(delta)} min ${delta < 0 ? "earlier" : "later"}`)
  const resizeSelected = (edge: Edge, delta: number) =>
    bulkApply(
      (d) => applyEdit(d, { kind: "shift-resize", edge }, d.shift[edge === "start" ? 0 : 1] + delta),
      `shift ${edge} ${delta > 0 ? "+" : "−"}${Math.abs(delta)} min`,
    )

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const snapped = Math.round((drag.orig + (e.clientX - drag.x0) / drag.pxPerMin) / AUX_SNAP) * AUX_SNAP
      const [bLo, bHi] = editBounds(drag.before, drag.op)
      // Also keep it on the visible timeline; the window grows after each commit.
      const value = Math.min(bHi, hi, Math.max(bLo, lo, snapped))
      if (value !== drag.value) setDrag({ ...drag, value })
    }
    const up = () => {
      justDragged.current = drag.value !== drag.orig
      setTimeout(() => (justDragged.current = false), 0)
      commitDrag(drag, drag.value)
      setDrag(null)
    }
    const key = (e: KeyboardEvent) => e.key === "Escape" && setDrag(null)
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
    window.addEventListener("keydown", key)
    document.body.style.cursor = "grabbing"
    document.body.style.userSelect = "none"
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
      window.removeEventListener("keydown", key)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commitDrag only reads store actions (stable)
  }, [drag])

  function startDrag(e: React.PointerEvent<HTMLElement>, agent: Agent, op: EditOp) {
    // Ctrl/⌘/Shift + click is for selecting schedules, not dragging.
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return
    e.preventDefault()
    e.stopPropagation()
    const before = days.get(agent.id)!
    const track = e.currentTarget.closest("[data-track]")!.getBoundingClientRect()
    const orig = editValue(before, op)
    setDrag({ agent, op, before, x0: e.clientX, pxPerMin: track.width / span, orig, value: orig, followers: followersFor(agent, op) })
  }

  /** ←/→ moves the focused block or edge 5 min (Shift: 15 min) — on every
   *  selected schedule when this one is selected. Ctrl/⌘ + ←/→ is left to the
   *  whole-schedule bulk move below. */
  function nudge(e: React.KeyboardEvent, agent: Agent, op: EditOp) {
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    e.stopPropagation()
    const before = days.get(agent.id)!
    const step = (e.shiftKey ? 15 : AUX_SNAP) * (e.key === "ArrowLeft" ? -1 : 1)
    const orig = editValue(before, op)
    commitDrag({ agent, op, before, x0: 0, pxPerMin: 1, orig, value: orig, followers: followersFor(agent, op) }, orig + step)
  }

  // ---- Keyboard: Ctrl/⌘ + ←/→ moves selected schedules, Ctrl/⌘ + A selects all, Esc clears ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Key events may target window/document (no .closest) as well as elements.
      const t = e.target instanceof Element ? e.target : null
      // The AUX menu handles its own Esc (close it without losing the selection).
      if (drag || menu || t?.closest("input, textarea, select, [contenteditable=true]") || document.querySelector('[role="dialog"]')) return
      const mod = e.ctrlKey || e.metaKey
      if (e.key === "Escape" && selected.size) {
        setSelected(new Set())
        return
      }
      if (mod && e.key.toLowerCase() === "a" && (selected.size || containerRef.current?.contains(t))) {
        e.preventDefault()
        setSelected(new Set(rowOrder))
        return
      }
      if (mod && canEdit && selected.size && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault()
        moveSelected((e.shiftKey ? 15 : AUX_SNAP) * (e.key === "ArrowLeft" ? -1 : 1))
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  function onRowClickCapture(e: React.MouseEvent, id: string) {
    if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return
    // Selection gesture — don't open editors or start anything else.
    e.preventDefault()
    e.stopPropagation()
    const next = new Set(selected)
    if (e.shiftKey && anchor.current && rowOrder.includes(anchor.current)) {
      const [i, j] = [rowOrder.indexOf(anchor.current), rowOrder.indexOf(id)].sort((x, y) => x - y)
      rowOrder.slice(i, j + 1).forEach((x) => next.add(x))
    } else {
      if (next.has(id)) next.delete(id)
      else next.add(id)
      anchor.current = id
    }
    setSelected(next)
  }

  function toggleOne(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    anchor.current = id
    setSelected(next)
  }

  const handlers = (agent: Agent, op: EditOp) => ({
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => startDrag(e, agent, op),
    onKeyDown: (e: React.KeyboardEvent) => nudge(e, agent, op),
  })

  // Visible window: the operating day plus any shifts/OT, with an hour of
  // headroom each side when editing so shifts and OT can be stretched outward.
  const [lo, hi] = useMemo(() => {
    const [a, b] = timelineWindow(agents, overtimePlan)
    return canEdit ? [Math.max(0, a - 60), Math.min(24 * 60, b + 60)] : [a, b]
  }, [agents, overtimePlan, canEdit])
  const span = hi - lo
  const pct = (m: number) => ((m - lo) / span) * 100
  const hourPct = (60 / span) * 100
  const gridBg: React.CSSProperties = {
    backgroundImage: "linear-gradient(to right, hsl(var(--border)) 1px, transparent 1px), linear-gradient(to right, hsl(var(--border) / 0.45) 1px, transparent 1px)",
    backgroundSize: `${hourPct}% 100%, ${hourPct / 2}% 100%`,
  }

  const rows = useMemo(
    () =>
      sortSchedules(
        agents.filter((a) => filter === "all" || channelsWorked(a, channelPlan, overtimePlan).has(filter)),
        sort,
        // Sort on the saved schedule, not a live drag preview, so rows don't jump mid-drag.
        (a) => ({ name: a.name, start: days.get(a.id)!.shift[0] }),
      ).map((a) => {
        const day = previewDays.get(a.id) ?? days.get(a.id)!
        return {
          agent: a,
          day,
          primary: primaryChannel(a, channelPlan),
          segs: dayTimeline(day),
          otMins: day.ot.reduce((t, o) => t + o.end - o.start, 0),
        }
      }),
    [agents, filter, sort, channelPlan, overtimePlan, days, previewDays],
  )
  const groups = grouped
    ? CHANNELS.map((c) => ({ channel: c, rows: rows.filter((r) => r.primary === c.id) })).filter((g) => g.rows.length)
    : [{ channel: null, rows }]
  // Rows top-to-bottom as drawn — the order Shift+click ranges and Ctrl+A use.
  const rowOrder = groups.flatMap((g) => g.rows.map((r) => r.agent.id))

  // Channel HC follows a drag live (queue rows below update on commit).
  const coverage = useMemo(
    () => coverageFromTimelines(agents.map((a) => dayTimeline(previewDays.get(a.id) ?? days.get(a.id)!)), [lo, hi]),
    [agents, days, previewDays, lo, hi],
  )
  const totalOtHrs = rows.reduce((t, r) => t + r.otMins, 0) / 60
  const ivStart = INTERVALS.length ? toMins(INTERVALS[0].label) : lo

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Channel:</span>
        {(["all", ...CHANNELS.map((c) => c.id)] as const).map((id) => {
          const c = id === "all" ? null : CHANNEL_BY_ID[id]
          return (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              aria-pressed={filter === id}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                filter === id ? "border-primary/60 bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted/40",
              )}
            >
              {c && <i className="h-2 w-2 rounded-full" style={{ background: c.color }} />}
              {c ? c.label : "All channels"}
            </button>
          )
        })}
        <label className="ml-2 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} className="accent-primary" />
          Group by primary channel
        </label>
        <Select
          aria-label="Sort schedules"
          className="h-8 text-xs"
          value={sort}
          onChange={(e) => setSort(e.target.value as ScheduleSort)}
          options={SCHEDULE_SORTS.map((s) => ({ value: s.id, label: `Sort: ${s.label}` }))}
        />
        <div className="ml-auto flex items-center gap-2">
          {totalOtHrs > 0 && <Badge variant="secondary"><Clock className="mr-1 h-3 w-3" />{totalOtHrs.toFixed(1)}h OT</Badge>}
          {canEdit && (
            <>
              <Button variant="outline" onClick={() => setActivityPreset({})}>
                <Plus className="h-4 w-4" /> Add activity
              </Button>
              <Button variant="outline" onClick={() => setOtPreset({ channel: filter === "all" ? "phone" : filter })}>
                <Plus className="h-4 w-4" /> Add OT
              </Button>
            </>
          )}
          <ExportButton
            label="Export schedules"
            filename="schedules-all"
            sheets={() => scheduleExportSheets(agents, queues, shiftPatterns, breakOverrides, channelPlan, overtimePlan, activityPlan)}
          />
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
        {CHANNELS.map((c) => (
          <span key={c.id} className="flex items-center gap-1.5"><i className="h-3 w-5 rounded-sm" style={{ background: c.color }} /> {c.label}</span>
        ))}
        {CHANNELS.map((c) => (
          <span key={`ot-${c.id}`} className="flex items-center gap-1.5">
            <i className="h-3 w-5 rounded-sm" style={segmentStyle({ kind: "ot", channel: c.id, start: 0, end: 0, label: "" })} /> OT {c.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5"><i className="h-3 w-5 rounded-sm" style={{ background: AUX_BY_CODE.AUX1.color }} /> Break</span>
        <span className="flex items-center gap-1.5"><i className="h-3 w-5 rounded-sm" style={{ background: AUX_BY_CODE.AUX2.color }} /> Lunch</span>
        <span className="flex items-center gap-1.5"><i className="h-3 w-5 rounded-sm" style={segmentStyle({ kind: "unassigned", start: 0, end: 0, label: "" })} /> Unassigned</span>
        <span className="basis-full sm:basis-auto sm:border-l sm:pl-4">Activities (upper band):</span>
        {ACTIVITIES.map((t) => (
          <span key={t.id} className="flex items-center gap-1.5"><ActivitySwatch type={t.id} /> {t.label}</span>
        ))}
      </div>

      {selected.size > 0 && (
        <div
          role="toolbar"
          aria-label="Bulk schedule actions"
          className="sticky top-0 z-30 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs backdrop-blur"
        >
          <span className="font-semibold">{selected.size} schedule{selected.size > 1 ? "s" : ""} selected</span>
          {canEdit && (
            <>
              <span className="mx-1 h-4 w-px bg-border" />
              <span className="text-muted-foreground">Move all</span>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => moveSelected(-15)} title="Ctrl+Shift+← (Ctrl+← = 5 min)">← 15m</Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => moveSelected(15)} title="Ctrl+Shift+→ (Ctrl+→ = 5 min)">15m →</Button>
              <span className="mx-1 h-4 w-px bg-border" />
              <span className="text-muted-foreground">Start</span>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => resizeSelected("start", -15)}>−15m</Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => resizeSelected("start", 15)}>+15m</Button>
              <span className="text-muted-foreground">End</span>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => resizeSelected("end", -15)}>−15m</Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => resizeSelected("end", 15)}>+15m</Button>
              <span className="mx-1 h-4 w-px bg-border" />
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setActivityPreset({ agentIds: [...selected] })}>
                <Plus className="h-3 w-3" /> Activity
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setOtPreset({ agentIds: [...selected], channel: filter === "all" ? "phone" : filter })}
              >
                <Plus className="h-3 w-3" /> OT
              </Button>
            </>
          )}
          <ExportButton
            label="Export selected"
            variant="ghost"
            filename="schedules-selected"
            sheets={() => scheduleExportSheets(selectedAgents, queues, shiftPatterns, breakOverrides, channelPlan, overtimePlan, activityPlan)}
          />
          {selected.size < rowOrder.length && (
            <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={() => setSelected(new Set(rowOrder))}>
              Select all ({rowOrder.length})
            </Button>
          )}
          <Button size="sm" variant="ghost" className={cn("h-7 text-xs", selected.size >= rowOrder.length && "ml-auto")} onClick={() => setSelected(new Set())}>
            Clear (Esc)
          </Button>
          {canEdit && <span className="basis-full text-[11px] text-muted-foreground">Right-click a selected schedule to mark any AUX (break, lunch, meeting, training, LOA…) on all of them.</span>}
        </div>
      )}

      {notice && (
        <div
          role="status"
          className={cn(
            "mb-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
            notice.ok ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-destructive/40 text-destructive",
          )}
        >
          <span className="flex-1">{notice.ok ? "✓ " : "✕ "}{notice.text}</span>
          <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      <div className="overflow-x-auto" ref={containerRef}>
        <div className="min-w-[960px] text-xs">
          {/* Hour ruler */}
          <div className={cn(NAME_COL, "sticky top-0 z-20 border-b bg-card")}>
            <div className="sticky left-0 z-10 flex items-center gap-1 bg-card px-2 py-1.5 font-semibold text-muted-foreground">
              <input
                type="checkbox"
                className="mr-1 accent-primary"
                aria-label="Select all agents"
                title="Select all agents (Ctrl+A)"
                checked={rowOrder.length > 0 && rowOrder.every((id) => selected.has(id))}
                ref={(el) => {
                  if (el) el.indeterminate = selected.size > 0 && !rowOrder.every((id) => selected.has(id))
                }}
                onChange={(e) => setSelected(e.target.checked ? new Set(rowOrder) : new Set())}
              />
              {(["name", "start"] as const).map((key) => {
                const dir = sort === `${key}-asc` ? "asc" : sort === `${key}-desc` ? "desc" : null
                const Icon = dir === "asc" ? ArrowUp : dir === "desc" ? ArrowDown : ArrowUpDown
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleSort(key)}
                    aria-label={`Sort by ${key === "name" ? "agent name" : "start time"}${dir ? ` (${dir === "asc" ? "ascending" : "descending"})` : ""}`}
                    title={key === "name" ? "Sort by name — click again for Z → A" : "Sort by scheduled start — click again for latest first"}
                    className={cn("flex items-center gap-0.5 rounded px-1 hover:bg-muted/50 hover:text-foreground", dir && "text-foreground")}
                  >
                    {key === "name" ? "Agent" : "Start"}
                    <Icon className="h-3 w-3" />
                  </button>
                )
              })}
            </div>
            <div className="relative h-7">
              {Array.from({ length: span / 60 + 1 }, (_, i) => lo + i * 60).map((m) => (
                <span
                  key={m}
                  className="absolute top-1.5 -translate-x-1/2 tabular-nums text-[10px] text-muted-foreground first:translate-x-0 last:-translate-x-full"
                  style={{ left: `${pct(m)}%` }}
                >
                  {fmtHM(m)}
                </span>
              ))}
            </div>
          </div>

          {groups.map((g) => (
            <div key={g.channel?.id ?? "all"}>
              {g.channel && (
                <div className={cn(NAME_COL, "border-b bg-muted/30")}>
                  <div className="sticky left-0 z-10 flex items-center gap-2 bg-muted/30 px-2 py-1 font-semibold">
                    <i className="h-2.5 w-2.5 rounded-full" style={{ background: g.channel.color }} />
                    {g.channel.label} <span className="font-normal text-muted-foreground">· {g.rows.length} agent{g.rows.length > 1 ? "s" : ""}</span>
                  </div>
                  <div />
                </div>
              )}
              {g.rows.map(({ agent: a, day, segs, otMins }) => {
                const skilled = a.skills.includes(queue.id)
                const risk = riskById?.get(a.id)
                const myDrag = drag?.agent.id === a.id ? drag : null
                // The op being applied to this row — directly, or as a follower in a bulk drag.
                const myOp = myDrag?.op ?? drag?.followers.find((f) => f.agent.id === a.id)?.op
                const isSel = selected.has(a.id)
                return (
                  <div
                    key={a.id}
                    data-agent-row={a.id}
                    aria-selected={isSel}
                    className={cn(
                      NAME_COL,
                      "group border-b border-border/50",
                      canEdit && "hover:bg-muted/30",
                      isSel && "bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]",
                    )}
                    onClickCapture={(e) => onRowClickCapture(e, a.id)}
                    onContextMenu={canEdit ? (e) => onRowContextMenu(e, a, day) : undefined}
                  >
                    <div
                      className={cn(
                        "sticky left-0 z-10 flex items-center justify-between gap-1 px-2 py-1 group-hover:bg-muted/30",
                        isSel ? "bg-primary/10 backdrop-blur" : "bg-card",
                        canEdit && "cursor-pointer",
                      )}
                      onClick={canEdit ? () => setEditing(a) : undefined}
                      title={canEdit ? "Click to edit channel blocks & OT · Ctrl+click to select · Shift+click for a range" : "Ctrl+click to select"}
                    >
                      <input
                        type="checkbox"
                        className={cn("mr-1 shrink-0 accent-primary", !isSel && !selected.size && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
                        checked={isSel}
                        onChange={() => toggleOne(a.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select ${a.name}'s schedule`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1 font-medium">
                          <span className="truncate">{a.name}</span>
                          {risk && risk.level !== "low" && (
                            <span title={`AI absence risk: ${risk.riskPct}% — ${risk.reason}`}>
                              <AlertTriangle className={cn("h-3 w-3 shrink-0", risk.level === "high" ? "text-destructive" : "text-amber-500")} />
                            </span>
                          )}
                        </div>
                        <div className="tabular-nums text-[10px] text-muted-foreground">
                          {fmtHM(day.shift[0])}–{fmtHM(day.shift[1])}
                          {otMins > 0 && <span className="ml-1 font-semibold text-foreground">+{(otMins / 60).toFixed(otMins % 60 ? 2 : 0)}h OT</span>}
                          {!skilled && <span className="ml-1">· not on {queue.name}</span>}
                        </div>
                      </div>
                      {canEdit && <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />}
                    </div>
                    <div
                      data-track
                      className={cn("relative h-10", !skilled && "opacity-50")}
                      style={gridBg}
                      title={canEdit ? "Double-click to add OT for this agent" : undefined}
                      onDoubleClick={
                        canEdit
                          ? (e) => {
                              // Ignore double-clicks on draggable AUX / resize grips.
                              if (justDragged.current || (e.target as HTMLElement).closest('[role="slider"]')) return
                              // Before the shift → OT leading in; anywhere else → OT after it.
                              const r = e.currentTarget.getBoundingClientRect()
                              const at = lo + ((e.clientX - r.left) / r.width) * span
                              setOtPreset({ agentIds: [a.id], channel: primaryChannel(a, channelPlan), timing: at < day.shift[0] ? "before" : "after" })
                            }
                          : undefined
                      }
                    >
                      {/* Base layer: channel work, breaks, gaps, OT. */}
                      {segs.filter((s) => s.kind !== "activity").map((s) => {
                        const faded = filter !== "all" && s.channel !== filter && (s.kind === "channel" || s.kind === "ot")
                        const w = pct(s.end) - pct(s.start)
                        const isAux = s.kind === "break" || s.kind === "lunch"
                        const movable = canEdit && isAux && !!s.segId
                        // Which edges of this piece are resizable. A channel piece only
                        // gets a handle on its block's real edges (not where a break cuts
                        // it), and not on the shift's edges — those belong to the shift handles.
                        const block = s.kind === "channel" ? day.channels.find((c) => c.id === s.segId) : undefined
                        const edgeOp = (edge: Edge): EditOp | null => {
                          if (!canEdit || !s.segId) return null
                          if (isAux) return { kind: "aux-resize", segId: s.segId, edge }
                          if (s.kind === "ot") return { kind: "ot-resize", segId: s.segId, edge }
                          if (block && s[edge] === block[edge] && s[edge] !== day.shift[edge === "start" ? 0 : 1]) {
                            return { kind: "channel-resize", segId: s.segId, edge }
                          }
                          return null
                        }
                        const moveOp: EditOp | null = movable ? { kind: "aux-move", segId: s.segId! } : null
                        const active =
                          !!myOp && "segId" in myOp && myOp.segId === s.segId &&
                          myOp.kind.split("-")[0] === (isAux ? "aux" : s.kind)
                        return (
                          <div
                            // Stable key per block so an element isn't remounted mid-drag.
                            key={`${s.kind}-${s.segId ?? ""}-${s.kind === "channel" || s.kind === "unassigned" ? s.start : ""}`}
                            className={cn(
                              "group/seg absolute top-3 flex h-6 items-end overflow-hidden rounded-[3px] px-1 pb-0.5 text-[10px] font-medium",
                              faded && "opacity-25",
                              canEdit && s.segId && "hover:ring-2 hover:ring-white/70",
                              movable && "z-[5] cursor-grab touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              active && "z-20 shadow-lg ring-2 ring-white",
                            )}
                            style={{ left: `${pct(s.start)}%`, width: `${w}%`, ...segmentStyle(s) }}
                            title={
                              movable
                                ? `${s.label} · ${fmtHM(s.start)}–${fmtHM(s.end)} — drag to move, drag an edge to resize (or focus + ←/→)`
                                : `${a.name} · ${s.label} · ${fmtHM(s.start)}–${fmtHM(s.end)} (${s.end - s.start} min)${edgeOp("start") || edgeOp("end") ? " — drag an edge to resize" : ""}`
                            }
                            {...(moveOp && {
                              tabIndex: 0,
                              role: "slider",
                              "aria-label": `${s.label} for ${a.name}, starts ${fmtHM(s.start)}`,
                              "aria-valuenow": s.start,
                              ...handlers(a, moveOp),
                              onClick: (e: React.MouseEvent) => e.stopPropagation(),
                            })}
                          >
                            {w > 7 && s.kind === "channel" && <span className="truncate">{`${s.label} ${fmtHM(s.start)}–${fmtHM(s.end)}`}</span>}
                            {w > 4 && s.kind === "ot" && (
                              <span className="truncate rounded-sm bg-card/90 px-1 font-semibold">{`OT ${fmtHM(s.start)}–${fmtHM(s.end)}`}</span>
                            )}
                            {(["start", "end"] as const).map((edge) => {
                              const op = edgeOp(edge)
                              return op ? (
                                <EdgeHandle
                                  key={edge}
                                  edge={edge}
                                  label={`${edge === "start" ? "Start" : "End"} of ${s.label} for ${a.name} (${fmtHM(s[edge])})`}
                                  {...handlers(a, op)}
                                />
                              ) : null
                            })}
                          </div>
                        )
                      })}

                      {/* Activity layer: meetings, training, LOA, absence… overlap the upper part of the base schedule. */}
                      {segs.filter((s) => s.kind === "activity").map((s) => {
                        const t = ACTIVITY_BY_ID[s.activity!]
                        const w = pct(s.end) - pct(s.start)
                        const moveOp: EditOp | null = canEdit ? { kind: "activity-move", segId: s.segId! } : null
                        const active = !!myOp && "segId" in myOp && myOp.segId === s.segId && myOp.kind.startsWith("activity")
                        const times = `${fmtHM(s.start)}–${fmtHM(s.end)}`
                        return (
                          <div
                            key={`act-${s.segId}`}
                            className={cn(
                              "group/seg absolute top-0.5 z-[8] flex h-[18px] items-center overflow-hidden rounded-md px-1.5 text-[10px] font-semibold text-white shadow-md ring-1 ring-white/80",
                              canEdit && "cursor-grab touch-none outline-none hover:ring-2 focus-visible:ring-2 focus-visible:ring-ring",
                              active && "z-20 ring-2 ring-white",
                            )}
                            style={{ left: `${pct(s.start)}%`, width: `${w}%`, background: t.color }}
                            title={`${a.name} · ${s.label} · ${times} (${s.end - s.start} min)${canEdit ? " — click to edit, drag to move, drag an edge to resize" : ""}`}
                            {...(moveOp && {
                              tabIndex: 0,
                              role: "slider",
                              "aria-label": `${t.label} for ${a.name}, ${times}`,
                              "aria-valuenow": s.start,
                              ...handlers(a, moveOp),
                              onClick: (e: React.MouseEvent) => {
                                e.stopPropagation()
                                const act = day.activities.find((x) => x.id === s.segId)
                                if (!justDragged.current && act) setEditingActivity({ agent: a, activity: act })
                              },
                            })}
                          >
                            {w > 3 && <span className="truncate">{w > 9 ? `${s.label} ${times}` : t.short}</span>}
                            {canEdit &&
                              (["start", "end"] as const).map((edge) => (
                                <EdgeHandle
                                  key={edge}
                                  edge={edge}
                                  label={`${edge === "start" ? "Start" : "End"} of ${t.label} for ${a.name} (${fmtHM(s[edge])})`}
                                  {...handlers(a, { kind: "activity-resize", segId: s.segId!, edge })}
                                />
                              ))}
                          </div>
                        )
                      })}

                      {/* Shift edges: stretch or shrink the whole shift. */}
                      {canEdit &&
                        (["start", "end"] as const).map((edge) => {
                          const at = day.shift[edge === "start" ? 0 : 1]
                          const op: EditOp = { kind: "shift-resize", edge }
                          return (
                            <div
                              key={`shift-${edge}`}
                              role="slider"
                              tabIndex={0}
                              aria-label={`Shift ${edge} for ${a.name} (${fmtHM(at)})`}
                              title={`Shift ${edge} ${fmtHM(at)} — drag to ${edge === "start" ? "start earlier/later" : "finish earlier/later"}`}
                              {...handlers(a, op)}
                              onClick={(e) => e.stopPropagation()}
                              className={cn(
                                "absolute inset-y-0 z-[15] flex w-2.5 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center outline-none",
                                "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
                                myOp && sameOp(myOp, op) && "opacity-100",
                              )}
                              style={{ left: `${pct(at)}%` }}
                            >
                              <span className="h-full w-1 rounded-full bg-foreground shadow ring-1 ring-background" />
                            </div>
                          )
                        })}

                      {myDrag && (() => {
                        const { text, at } = dragLabel(day, myDrag.op)
                        const delta = myDrag.value - myDrag.orig
                        const bulk = myDrag.followers.length
                        return (
                          <div
                            className="pointer-events-none absolute -top-5 z-30 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-background shadow"
                            style={{ left: `${pct(at)}%` }}
                          >
                            {text}
                            {delta !== 0 && ` ${delta > 0 ? "+" : ""}${delta}m`}
                            {bulk > 0 && ` · +${bulk} selected`}
                          </div>
                        )
                      })()}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
          {!rows.length && <p className="px-2 py-6 text-center text-sm text-muted-foreground">No agents scheduled on this channel.</p>}

          {/* Channel heads (incl. OT), then queue coverage aligned to the same time axis */}
          <div className="mt-1 border-t-2">
            {CHANNELS.map((c) => (
              <FooterRow key={c.id} label={`${c.label} HC`} dot={c.color} gridBg={gridBg}>
                {coverage.map((s) => (
                  <Cell key={s.start} left={pct(s.start)} width={pct(s.start + 30) - pct(s.start)} className="text-muted-foreground">
                    {s[c.id] ? s[c.id].toFixed(s[c.id] % 1 ? 1 : 0) : ""}
                  </Cell>
                ))}
              </FooterRow>
            ))}
            <FooterRow label={`Actual HC · ${queue.name}`} gridBg={gridBg}>
              {plan.map((p, i) => (
                <Cell key={i} left={pct(ivStart + i * 30)} width={pct(ivStart + 30) - pct(ivStart)}>{p.scheduled}</Cell>
              ))}
            </FooterRow>
            <FooterRow label="On duty" gridBg={gridBg}>
              {onDuty.map((c, i) => (
                <Cell key={i} left={pct(ivStart + i * 30)} width={pct(ivStart + 30) - pct(ivStart)} className={c < plan[i].requiredGross ? "text-amber-500" : "text-muted-foreground"}>{c}</Cell>
              ))}
            </FooterRow>
            <FooterRow label="Required HC" gridBg={gridBg}>
              {plan.map((p, i) => (
                <Cell key={i} left={pct(ivStart + i * 30)} width={pct(ivStart + 30) - pct(ivStart)} className={p.variance < 0 ? "text-destructive" : "text-emerald-500"}>{p.requiredGross}</Cell>
              ))}
            </FooterRow>
            <FooterRow label="O/U" gridBg={gridBg}>
              {plan.map((p, i) => (
                <Cell
                  key={i}
                  left={pct(ivStart + i * 30)}
                  width={pct(ivStart + 30) - pct(ivStart)}
                  className={p.variance < 0 ? "text-destructive" : p.variance > 0 ? "text-emerald-500" : "text-muted-foreground"}
                >
                  {p.variance > 0 ? `+${p.variance}` : p.variance}
                </Cell>
              ))}
            </FooterRow>
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Continuous timeline at minute precision. Channel HC is minute-weighted heads per 30 min across all shown agents (incl. OT).
        Actual HC / On duty / Required / O/U are for {queue.name} and include OT worked by agents skilled for it.
        {canEdit &&
          ` Drag a break/lunch to move it; drag the edge of any break, lunch, Phone/Chat/Email or OT block to make it longer or shorter, and the dark bars at a shift's start/end to lengthen or shorten the shift (snaps to ${AUX_SNAP} min, Esc cancels, focus + ←/→ also works). Add OT on any channel with "Add OT" or by double-clicking an agent's row; add meetings, training, coaching, LOA, absence or other AUX with "Add activity" — they sit in the upper band, take the agent off the channel, and can be clicked to edit or dragged. Click an agent's name to re-align their channels. Bulk: Ctrl+click (⌘ on Mac) schedules to select them, Shift+click for a range, Ctrl+A for all — then Ctrl+←/→ moves every selected schedule (Shift for 15 min), and dragging a break, activity or shift edge in one selected row applies it to all.`}
      </p>

      {editing && <AgentScheduleEditor agent={editing} onClose={() => setEditing(null)} />}
      {menu && (
        <AuxContextMenu
          x={menu.x}
          y={menu.y}
          at={menu.at}
          targets={menu.targetIds.length}
          removable={menuTargets(menu).reduce((t, a) => t + days.get(a.id)!.activities.filter((x) => x.start <= menu.at && x.end > menu.at).length, 0)}
          onPick={markFromMenu}
          onRemove={removeFromMenu}
          onMore={(kind, start) => {
            setActivityPreset({ agentIds: menu.targetIds, type: kind as ActivitySegment["type"], start })
            setMenu(null)
          }}
          onClose={closeMenu}
        />
      )}
      {otPreset && <AddOvertimeDialog agents={agents} preset={otPreset} onClose={() => setOtPreset(null)} />}
      {activityPreset && <AddActivityDialog agents={agents} preset={activityPreset} onClose={() => setActivityPreset(null)} />}
      {editingActivity && (
        <EditActivityDialog agent={editingActivity.agent} activity={editingActivity.activity} onClose={() => setEditingActivity(null)} />
      )}
    </>
  )
}

function FooterRow({ label, dot, gridBg, children }: { label: string; dot?: string; gridBg: React.CSSProperties; children: React.ReactNode }) {
  return (
    <div className={cn(NAME_COL, "font-semibold")}>
      <div className="sticky left-0 z-10 flex items-center gap-1.5 bg-card px-2 py-1">
        {dot && <i className="h-2 w-2 rounded-full" style={{ background: dot }} />}
        <span className="truncate">{label}</span>
      </div>
      <div className="relative h-6" style={gridBg}>{children}</div>
    </div>
  )
}

function Cell({ left, width, className, children }: { left: number; width: number; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("absolute top-1 text-center tabular-nums", className)} style={{ left: `${left}%`, width: `${width}%` }}>
      {children}
    </span>
  )
}

const CHANNEL_OPTIONS = CHANNELS.map((c) => ({ value: c.id, label: c.label }))
let nextId = 0
const newId = () => `s${Date.now().toString(36)}${nextId++}`

/** Edit one agent's in-shift channel blocks and overtime blocks. */
function AgentScheduleEditor({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { channelPlan, overtimePlan, setAgentSchedule, resetAgentSchedule } = useWfm()
  const [s, e] = shiftBounds(agent)
  const [channels, setChannels] = useState<ChannelSegment[]>(() => effectiveChannelSegments(agent, channelPlan).map((c) => ({ ...c })))
  const [ot, setOt] = useState<ChannelSegment[]>(() => (overtimePlan[agent.id] ?? []).map((o) => ({ ...o })))
  const errors = validateAgentPlan(agent, channels, ot)

  const assigned = channels.reduce((t, c) => t + Math.max(0, Math.min(e, c.end) - Math.max(s, c.start)), 0)
  const gap = e - s - assigned

  const update = (list: ChannelSegment[], set: (l: ChannelSegment[]) => void, id: string, patch: Partial<ChannelSegment>) =>
    set(list.map((x) => (x.id === id ? { ...x, ...patch } : x)))

  function addChannelBlock() {
    // Split the last block in half so the new one starts inside the shift.
    const last = [...channels].sort((a, b) => a.start - b.start).at(-1)
    if (!last || last.end - last.start < 30) {
      setChannels([...channels, { id: newId(), channel: "chat", start: s, end: Math.min(e, s + 60) }])
      return
    }
    const mid = last.start + Math.round((last.end - last.start) / 2 / 15) * 15
    const next = CHANNELS.find((c) => c.id !== last.channel)!.id
    setChannels([...channels.map((c) => (c.id === last.id ? { ...c, end: mid } : c)), { id: newId(), channel: next, start: mid, end: last.end }])
  }

  function addOt(where: "after" | "before") {
    const channel = primaryChannel(agent, { [agent.id]: channels })
    const latest = Math.max(e, ...ot.map((o) => o.end))
    const earliest = Math.min(s, ...ot.map((o) => o.start))
    setOt([...ot, where === "after" ? { id: newId(), channel, start: latest, end: latest + 60 } : { id: newId(), channel, start: earliest - 60, end: earliest }])
  }

  function save() {
    if (errors.length) return
    setAgentSchedule(agent.id, [...channels].sort((a, b) => a.start - b.start), [...ot].sort((a, b) => a.start - b.start))
    onClose()
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Schedule — ${agent.name}`}
      description={`Contracted shift ${agent.shift} · ${agent.team} · breaks & lunch come from the shift pattern`}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => { resetAgentSchedule(agent.id); onClose() }}>
            <RotateCcw className="h-4 w-4" /> Reset to default
          </Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={errors.length > 0}>Save schedule</Button>
        </>
      }
    >
      <div className="space-y-5">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Channel alignment (in shift)</h3>
            <Button variant="outline" size="sm" onClick={addChannelBlock}><Plus className="h-3.5 w-3.5" /> Add channel block</Button>
          </div>
          <SegmentRows list={channels} onChange={(id, p) => update(channels, setChannels, id, p)} onRemove={(id) => setChannels(channels.filter((c) => c.id !== id))} />
          {gap > 0 && <p className="mt-1.5 text-xs text-amber-500">{gap} min of the shift has no channel — it will show as Unassigned.</p>}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Overtime</h3>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => addOt("before")}><Plus className="h-3.5 w-3.5" /> OT before shift</Button>
              <Button variant="outline" size="sm" onClick={() => addOt("after")}><Plus className="h-3.5 w-3.5" /> OT after shift</Button>
            </div>
          </div>
          {ot.length ? (
            <SegmentRows list={ot} ot onChange={(id, p) => update(ot, setOt, id, p)} onRemove={(id) => setOt(ot.filter((o) => o.id !== id))} />
          ) : (
            <p className="text-xs text-muted-foreground">No overtime. OT blocks sit before or after the contracted shift and are drawn as grid lines in their channel's colour.</p>
          )}
        </section>

        {errors.length > 0 && (
          <div className="rounded-lg border border-destructive/40 px-3 py-2 text-xs text-destructive">
            {errors.map((m) => <p key={m} className="flex items-center gap-1.5"><AlertTriangle className="h-3 w-3 shrink-0" /> {m}</p>)}
          </div>
        )}
      </div>
    </Dialog>
  )
}

function SegmentRows({
  list,
  ot,
  onChange,
  onRemove,
}: {
  list: ChannelSegment[]
  ot?: boolean
  onChange: (id: string, patch: Partial<ChannelSegment>) => void
  onRemove: (id: string) => void
}) {
  return (
    <div className="space-y-2">
      {list.map((seg) => (
        <div key={seg.id} className="flex flex-wrap items-center gap-2">
          <i
            className="h-6 w-6 shrink-0 rounded"
            style={ot ? segmentStyle({ kind: "ot", channel: seg.channel, start: 0, end: 0, label: "" }) : { background: CHANNEL_BY_ID[seg.channel].color }}
          />
          <Select
            options={CHANNEL_OPTIONS}
            value={seg.channel}
            onChange={(ev) => onChange(seg.id, { channel: ev.target.value as Channel })}
            aria-label="Channel"
          />
          <Input type="time" step={900} className="w-28" value={fmtHM(seg.start)} onChange={(ev) => ev.target.value && onChange(seg.id, { start: toMins(ev.target.value) })} aria-label="Start" />
          <span className="text-muted-foreground">–</span>
          <Input type="time" step={900} className="w-28" value={fmtHM(seg.end)} onChange={(ev) => ev.target.value && onChange(seg.id, { end: toMins(ev.target.value) })} aria-label="End" />
          <span className="w-14 text-xs tabular-nums text-muted-foreground">{seg.end > seg.start ? `${seg.end - seg.start} min` : ""}</span>
          <Button variant="ghost" size="sm" onClick={() => onRemove(seg.id)} aria-label="Remove block"><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ))}
    </div>
  )
}
