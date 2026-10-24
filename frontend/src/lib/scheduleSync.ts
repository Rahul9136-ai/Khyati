// Keeps the Scheduling timeline (store: agents' shifts, breakOverrides,
// channelPlan, overtimePlan, activityPlan) in sync with the backend's
// day plans — GET/PUT /api/v1/scheduling/day-plans/{date}.
//
// * On start: server wins for agents it has; agents it doesn't have are
//   uploaded. Edits made while offline (tracked in a per-date localStorage
//   snapshot) are pushed if the server hasn't changed since — otherwise the
//   server copy is kept and the user is told.
// * After every local change: only the agents whose day changed are saved
//   (debounced), each with the version it was based on; a 409 means someone
//   else saved first → reload the server copy.
// * Polls for other users' changes while idle. Works offline: the app keeps
//   running on local state and retries.
import { create } from "zustand"

import { api, type ApiError } from "@/lib/api"
import { agentDay, dayToPatch, type AgentDay } from "@/lib/domain/channels"
import type { Agent } from "@/lib/domain/types"
import { useWfm, type AgentDayPatch } from "@/store/wfm"

export type SyncStatus = "idle" | "loading" | "saving" | "synced" | "offline" | "conflict" | "readonly"

interface SyncState {
  status: SyncStatus
  message: string | null
  lastSyncedAt: number | null
  planDate: string | null
}

export const useScheduleSync = create<SyncState>(() => ({ status: "idle", message: null, lastSyncedAt: null, planDate: null }))
const setSync = (patch: Partial<SyncState>) => useScheduleSync.setState(patch)

// ---- wire format (matches backend DayPlanIn / DayPlanOut) ----

export interface ServerDayPlan {
  agent_key: string
  agent_name: string
  team: string
  shift_start: number
  shift_end: number
  breaks: { id: string; type: "break" | "lunch"; label: string; start: number; end: number }[]
  channels: { id: string; channel: "phone" | "chat" | "email"; start: number; end: number }[]
  overtime: { id: string; channel: "phone" | "chat" | "email"; start: number; end: number }[]
  activities: { id: string; type: AgentDay["activities"][number]["type"]; start: number; end: number; note?: string | null }[]
  version?: number
}

/** An agent's current day as the backend stores it (deterministic key order,
 *  so JSON.stringify of two equal days is equal). */
export function toServerPlan(agent: Agent, day: AgentDay): ServerDayPlan {
  const byStart = <T extends { start: number }>(xs: T[]) => [...xs].sort((a, b) => a.start - b.start)
  return {
    agent_key: agent.id,
    agent_name: agent.name,
    team: agent.team,
    shift_start: day.shift[0],
    shift_end: day.shift[1],
    breaks: byStart(day.breaks).map((b) => ({ id: b.id, type: b.type, label: b.label, start: b.start, end: b.end })),
    channels: byStart(day.channels).map((c) => ({ id: c.id, channel: c.channel, start: c.start, end: c.end })),
    overtime: byStart(day.ot).map((o) => ({ id: o.id, channel: o.channel, start: o.start, end: o.end })),
    activities: byStart(day.activities).map((x) => ({ id: x.id, type: x.type, start: x.start, end: x.end, ...(x.note ? { note: x.note } : {}) })),
  }
}

/** Server row → the store patch applyServerDays expects. */
export function fromServerPlan(row: ServerDayPlan): AgentDayPatch {
  return dayToPatch({
    shift: [row.shift_start, row.shift_end],
    breaks: row.breaks.map((b) => ({ ...b, label: b.label || (b.type === "lunch" ? "Lunch" : "Break") })),
    channels: row.channels,
    ot: row.overtime,
    activities: row.activities.map(({ note, ...x }) => (note ? { ...x, note } : x)),
  })
}

function currentPlans(): Map<string, ServerDayPlan> {
  const s = useWfm.getState()
  return new Map(
    s.agents.map((a) => [a.id, toServerPlan(a, agentDay(a, s.shiftPatterns, s.breakOverrides, s.channelPlan, s.overtimePlan, s.activityPlan))]),
  )
}
const fingerprint = (p: ServerDayPlan) => JSON.stringify({ ...p, version: undefined })

// ---- per-date snapshot (what was last in sync), persisted for offline edits ----

interface Snapshot {
  versions: Record<string, number>
  synced: Record<string, string>
}
const snapKey = (d: string) => `ff.scheduleSync.${d}`
function loadSnapshot(d: string): Snapshot | null {
  try {
    const raw = localStorage.getItem(snapKey(d))
    return raw ? (JSON.parse(raw) as Snapshot) : null
  } catch {
    return null
  }
}
function saveSnapshot(d: string, s: Snapshot) {
  try {
    localStorage.setItem(snapKey(d), JSON.stringify(s))
  } catch {
    /* storage full / disabled — sync still works for this session */
  }
}

export const localISODate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

// ---- engine ----

export const SAVE_DEBOUNCE_MS = 800
export const POLL_MS = 60_000
const RETRY_MS = 30_000

let running: {
  date: string
  canWrite: boolean
  snap: Snapshot
  unsubscribe: () => void
  timer: ReturnType<typeof setTimeout> | null
  poll: ReturnType<typeof setInterval> | null
  saving: Promise<void> | null
  applyingRemote: boolean
  auditMark: string | null
} | null = null

const isNetwork = (e: unknown) => (e as ApiError)?.code === "network_error" || (e as ApiError)?.status === undefined

async function fetchPlans(date: string): Promise<ServerDayPlan[]> {
  const res = await api.get(`/scheduling/day-plans/${date}`)
  return res.data.data as ServerDayPlan[]
}

/** Load server rows into the store (server wins) and mark them in sync. */
function applyRemote(rows: ServerDayPlan[]) {
  if (!running) return
  const r = running
  r.applyingRemote = true
  try {
    useWfm.getState().applyServerDays(rows.map((row) => ({ agentId: row.agent_key, patch: fromServerPlan(row) })))
  } finally {
    r.applyingRemote = false
  }
  const now = currentPlans()
  for (const row of rows) {
    const local = now.get(row.agent_key)
    if (!local) continue
    r.snap.versions[row.agent_key] = row.version ?? 0
    r.snap.synced[row.agent_key] = fingerprint(local)
  }
  saveSnapshot(r.date, r.snap)
}

/** Audit text for what changed locally since the last push (newest first). */
function pendingDetail(): string {
  const log = useWfm.getState().auditLog
  if (!running) return ""
  const fresh = []
  for (const e of log) {
    if (e.id === running.auditMark) break
    if (e.category === "Schedule") fresh.push(`${e.action}: ${e.detail}`)
  }
  running.auditMark = log[0]?.id ?? running.auditMark
  return fresh.reverse().join(" | ").slice(0, 500)
}

async function push(plans: ServerDayPlan[], detail: string) {
  if (!running || !plans.length) return
  const r = running
  setSync({ status: "saving", message: null })
  try {
    const res = await api.put(`/scheduling/day-plans/${r.date}`, {
      items: plans.map((p) => ({ ...p, base_version: r.snap.versions[p.agent_key] })),
      detail,
    })
    if (running !== r) return
    for (const row of res.data.data as ServerDayPlan[]) r.snap.versions[row.agent_key] = row.version ?? 0
    for (const p of plans) r.snap.synced[p.agent_key] = fingerprint(p)
    saveSnapshot(r.date, r.snap)
    setSync({ status: "synced", message: null, lastSyncedAt: Date.now() })
  } catch (e) {
    if (running !== r) return
    const err = e as ApiError
    if (err.status === 409) {
      // Someone else saved first — take the server's copy.
      applyRemote(await fetchPlans(r.date).catch(() => []))
      setSync({ status: "conflict", message: "Some schedules were changed by someone else — reloaded the latest from the server." })
    } else if (isNetwork(e)) {
      setSync({ status: "offline", message: "Backend unreachable — changes are kept locally and will sync when it's back." })
      r.timer = setTimeout(() => void flush(), RETRY_MS)
    } else {
      setSync({ status: "offline", message: err.message ?? "Save failed — will retry." })
      r.timer = setTimeout(() => void flush(), RETRY_MS)
    }
  }
}

/** Save every agent whose day differs from what was last in sync. */
export async function flush(): Promise<void> {
  if (!running || !running.canWrite) return
  const r = running
  if (r.timer) clearTimeout(r.timer)
  r.timer = null
  if (r.saving) await r.saving
  const changed = [...currentPlans().values()].filter((p) => r.snap.synced[p.agent_key] !== fingerprint(p))
  if (!changed.length) {
    if (useScheduleSync.getState().status !== "offline") setSync({ status: "synced" })
    return
  }
  r.saving = push(changed, pendingDetail())
  await r.saving
  r.saving = null
}

/** Pull other users' changes when nothing local is pending. */
export async function pull(): Promise<void> {
  if (!running) return
  const r = running
  const local = currentPlans()
  const dirty = [...local.values()].some((p) => r.snap.synced[p.agent_key] !== fingerprint(p))
  if (dirty || r.saving) return
  try {
    const rows = await fetchPlans(r.date)
    const newer = rows.filter((row) => (row.version ?? 0) !== r.snap.versions[row.agent_key])
    if (newer.length) applyRemote(newer)
    setSync({ status: r.canWrite ? "synced" : "readonly", message: null, lastSyncedAt: Date.now() })
  } catch (e) {
    if (isNetwork(e)) setSync({ status: "offline", message: "Backend unreachable — showing local schedules." })
  }
}

export async function startScheduleSync(opts: { canWrite: boolean; date?: string }): Promise<void> {
  stopScheduleSync()
  const date = opts.date ?? localISODate()
  const prev = loadSnapshot(date)
  running = {
    date,
    canWrite: opts.canWrite,
    snap: { versions: {}, synced: {} },
    unsubscribe: () => {},
    timer: null,
    poll: null,
    saving: null,
    applyingRemote: false,
    auditMark: useWfm.getState().auditLog[0]?.id ?? null,
  }
  const r = running
  setSync({ status: "loading", message: null, planDate: date })

  let rows: ServerDayPlan[]
  try {
    rows = await fetchPlans(date)
  } catch (e) {
    if (running !== r) return
    setSync({ status: "offline", message: isNetwork(e) ? "Backend unreachable — working locally." : (e as ApiError).message })
    r.timer = setTimeout(() => void startScheduleSync(opts), RETRY_MS)
    return
  }
  if (running !== r) return

  // Reconcile: server wins, except offline edits on rows the server hasn't touched since.
  const server = new Map(rows.map((row) => [row.agent_key, row]))
  const local = currentPlans()
  const toPush: ServerDayPlan[] = []
  const toApply: ServerDayPlan[] = []
  let overridden = 0
  for (const [key, plan] of local) {
    const srv = server.get(key)
    if (!srv) {
      toPush.push(plan)
      continue
    }
    const offlineEdit = prev?.synced[key] !== undefined && prev.synced[key] !== fingerprint(plan)
    if (offlineEdit && prev?.versions[key] === srv.version) {
      r.snap.versions[key] = srv.version ?? 0
      toPush.push(plan)
    } else {
      if (offlineEdit) overridden++
      toApply.push(srv)
    }
  }
  applyRemote(toApply)

  r.unsubscribe = useWfm.subscribe((s, p) => {
    if (r.applyingRemote || running !== r) return
    if (
      s.agents === p.agents && s.breakOverrides === p.breakOverrides && s.channelPlan === p.channelPlan &&
      s.overtimePlan === p.overtimePlan && s.activityPlan === p.activityPlan && s.shiftPatterns === p.shiftPatterns
    ) return
    if (!r.canWrite) return
    if (r.timer) clearTimeout(r.timer)
    setSync({ status: "saving", message: null })
    r.timer = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
  })
  r.poll = setInterval(() => {
    if (typeof document === "undefined" || document.visibilityState === "visible") void pull()
  }, POLL_MS)

  if (r.canWrite && toPush.length) {
    await push(toPush, rows.length ? "Uploaded schedules missing on the server" : "Initial upload of the day's schedules")
  } else {
    setSync({ status: r.canWrite ? "synced" : "readonly", lastSyncedAt: Date.now() })
  }
  if (overridden && running === r) {
    setSync({ status: "conflict", message: `${overridden} schedule(s) edited offline were changed on the server meanwhile — kept the server version.` })
  }
}

export function stopScheduleSync() {
  if (!running) return
  running.unsubscribe()
  if (running.timer) clearTimeout(running.timer)
  if (running.poll) clearInterval(running.poll)
  running = null
  setSync({ status: "idle", message: null, planDate: null })
}
