// Saves everything people add in the app on the server (GET/PUT
// /api/v1/workspace/data/{key}), so it stays until someone removes it — after
// a reload, on another browser or device, and for everyone in the organisation:
// employees, skills/queues, forecasts and imported actuals, PTO, swaps,
// scenarios, exceptions, messages, users and roles, automation settings and
// the change logs. (Schedules, work rules and Capacity Planning have their own
// syncs: scheduleSync, settingsSync, capacity/sync.)
//
// * On sign-in: the server's copy wins, except where this browser changed an
//   area offline since it last synced and the server hasn't moved on — then
//   the local change is uploaded. An area never saved on the server yet is
//   uploaded from this browser.
// * After every change: the changed areas are saved (debounced), each with the
//   version it was based on. If someone else saved first (409): change logs and
//   messages are merged (nothing is lost); anything else takes their copy and
//   you're told.
// * Checks for other people's changes every 15 s (versions only; changed areas
//   are then loaded).
// * Offline: everything keeps working in this browser and is saved when the
//   server is back.
import { create } from "zustand"

import { api, type ApiError } from "@/lib/api"
import { useWfm } from "@/store/wfm"

export const WORKSPACE_KEYS = [
  "agents", "employeeProfiles", "formerEmployees", "employeeChanges", "dataSources", "users", "permissions",
  "queues", "forecasts", "forecastMethod", "importedActuals", "externalFactors", "shrinkage", "scenarios",
  "ptoRequests", "swaps", "exceptions", "skillChangeRecommendations", "messages", "auditLog",
  "thresholds", "ruleState", "pipelineAutoRun",
] as const
export type WorkspaceKey = (typeof WORKSPACE_KEYS)[number]

/** Lists that only grow (logs, messages): on a clash both sides' entries are kept. */
const MERGE: ReadonlySet<WorkspaceKey> = new Set(["auditLog", "employeeChanges", "messages"])

const LABEL: Partial<Record<WorkspaceKey, string>> = {
  agents: "the roster", employeeProfiles: "employee profiles", formerEmployees: "former employees", users: "users",
  permissions: "role permissions", queues: "skills / queues", forecasts: "forecasts", importedActuals: "imported actuals",
  externalFactors: "forecast events", scenarios: "scenarios", ptoRequests: "PTO requests", swaps: "shift swaps",
  exceptions: "adherence exceptions", thresholds: "automation thresholds", ruleState: "automation rules",
}
const label = (k: WorkspaceKey) => LABEL[k] ?? k

const SNAPSHOT_KEY = "wfm-workspace-sync"
const DEBOUNCE_MS = 700
const POLL_MS = 15_000

export type WorkspaceSyncStatus = "idle" | "loading" | "saving" | "saved" | "offline" | "conflict"

export const useWorkspaceSync = create<{ status: WorkspaceSyncStatus; message: string | null; lastSavedAt: number | null }>(() => ({
  status: "idle",
  message: null,
  lastSavedAt: null,
}))
const setStatus = (status: WorkspaceSyncStatus, message: string | null = null) =>
  useWorkspaceSync.setState({ status, message, ...(status === "saved" ? { lastSavedAt: Date.now() } : {}) })

interface Area {
  key: WorkspaceKey
  version: number
  value?: unknown
}

const fp = (v: unknown) => JSON.stringify(v ?? null)
const local = (k: WorkspaceKey): unknown => (useWfm.getState() as unknown as Record<string, unknown>)[k]
const isNetwork = (e: unknown) => !(e as ApiError)?.status

/** Last state in sync with the server, per area (persisted so offline edits upload later). */
type Snapshot = Partial<Record<WorkspaceKey, { version: number; fp: string }>>
function loadSnapshot(): Snapshot {
  try {
    return JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "{}") as Snapshot
  } catch {
    return {}
  }
}
function saveSnapshot(s: Snapshot) {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(s))
  } catch {
    /* private mode: sync still works for this session */
  }
}

interface Running {
  snap: Snapshot
  /** areas this user may change (from the server) */
  writable: Set<WorkspaceKey>
  timer?: ReturnType<typeof setTimeout>
  poll?: ReturnType<typeof setInterval>
  busy: boolean
  again: boolean
  unsubscribe: () => void
}
let running: Running | null = null

const sameShape = (a: unknown, b: unknown) =>
  b === undefined || a === null || Array.isArray(a) === Array.isArray(b) && typeof a === typeof b

/** Load server copies into the app (no audit entries: the change happened elsewhere). */
function apply(areas: Area[]) {
  const r = running
  if (!r) return
  const patch: Record<string, unknown> = {}
  for (const a of areas) if (a.value !== undefined && sameShape(a.value, local(a.key))) patch[a.key] = a.value
  if (Object.keys(patch).length) useWfm.setState(patch as never)
  for (const a of areas) r.snap[a.key] = { version: a.version, fp: fp(local(a.key)) }
  saveSnapshot(r.snap)
}

const timeOf = (x: unknown) => {
  const o = x as { ts?: number; at?: number }
  return typeof o?.ts === "number" ? o.ts : typeof o?.at === "number" ? o.at : 0
}

/** Both sides' entries, once each (this browser's copy of an entry wins), in this browser's order. */
export function mergeById(server: unknown, mine: unknown): unknown {
  if (!Array.isArray(server) || !Array.isArray(mine)) return mine
  const id = (x: unknown) => (x as { id?: string })?.id
  const ours = new Map(mine.map((x) => [id(x), x]))
  const all = [...mine, ...server.filter((x) => !ours.has(id(x)))]
  const newestFirst = mine.length < 2 || timeOf(mine[0]) >= timeOf(mine[mine.length - 1])
  return all.sort((a, b) => (newestFirst ? timeOf(b) - timeOf(a) : timeOf(a) - timeOf(b)))
}

async function saveOne(r: Running, key: WorkspaceKey): Promise<"ok" | "conflict" | "error"> {
  let value = local(key)
  let base = r.snap[key]?.version ?? 0
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = (await api.put(`/workspace/data/${key}`, { value, base_version: base })).data.data as Area
      r.snap[key] = { version: row.version, fp: fp(value) }
      saveSnapshot(r.snap)
      return "ok"
    } catch (e) {
      const err = e as ApiError
      if (err.status === 403) {
        r.writable.delete(key) // not allowed: keep it in this browser, stop trying
        return "ok"
      }
      if (err.status !== 409) throw e
      const d = (err.details ?? {}) as { version?: number; value?: unknown }
      if (MERGE.has(key)) {
        value = mergeById(d.value, local(key))
        useWfm.setState({ [key]: value } as never)
        base = d.version ?? 0
        continue // save both sides' entries on top of theirs
      }
      apply([{ key, version: d.version ?? 0, value: d.value ?? undefined }])
      return "conflict"
    }
  }
  return "error"
}

async function push() {
  const r = running
  if (!r) return
  if (r.busy) { r.again = true; return }
  const todo = WORKSPACE_KEYS.filter((k) => r.writable.has(k) && fp(local(k)) !== r.snap[k]?.fp)
  if (!todo.length) return
  r.busy = true
  setStatus("saving")
  const clashes: WorkspaceKey[] = []
  try {
    for (const key of todo) {
      if ((await saveOne(r, key)) === "conflict") clashes.push(key)
    }
    if (clashes.length)
      setStatus("conflict", `Someone else changed ${clashes.map(label).join(", ")} at the same time; their version is loaded. Make your change again.`)
    else setStatus("saved")
  } catch (e) {
    setStatus("offline", isNetwork(e) ? "Server unreachable: your changes are kept in this browser and saved when it's back." : (e as ApiError).message)
  } finally {
    r.busy = false
    if (r.again && running === r) { r.again = false; void push() }
  }
}

/** Load other people's changes; upload this browser's changes the server hasn't seen. */
async function pull(initial: boolean) {
  const r = running
  if (!r || r.busy) return
  try {
    const data = (await api.get("/workspace/data", { params: { values: initial } })).data.data as {
      areas: Area[]
      keys: Record<string, boolean>
    }
    if (running !== r) return
    r.writable = new Set(WORKSPACE_KEYS.filter((k) => data.keys[k]))
    const byKey = new Map(data.areas.filter((a) => (WORKSPACE_KEYS as readonly string[]).includes(a.key)).map((a) => [a.key, a]))
    const take: WorkspaceKey[] = []
    let upload = false
    for (const key of WORKSPACE_KEYS) {
      const srv = byKey.get(key)
      const snap = r.snap[key]
      const changedHere = fp(local(key)) !== snap?.fp
      if (!srv) upload ||= r.writable.has(key) // never saved yet: this browser's copy becomes the shared one
      else if (snap && srv.version === snap.version) upload ||= changedHere && r.writable.has(key)
      else if (initial || !changedHere || !r.writable.has(key)) take.push(key)
      else upload = true // both changed: the save gets a 409 and resolves it
    }
    if (take.length) {
      const areas = initial
        ? take.map((k) => byKey.get(k)!)
        : await Promise.all(take.map(async (k) => (await api.get(`/workspace/data/${k}`)).data.data as Area))
      if (running !== r) return
      apply(areas)
    }
    if (upload) await push()
    else if (useWorkspaceSync.getState().status !== "conflict" || initial) setStatus("saved")
  } catch (e) {
    setStatus("offline", isNetwork(e) ? "Server unreachable: working in this browser; changes are saved when it's back." : (e as ApiError).message)
  }
}

export async function startWorkspaceSync(): Promise<void> {
  stopWorkspaceSync()
  const unsubscribe = useWfm.subscribe((s, p) => {
    const r = running
    if (!r) return
    const st = s as unknown as Record<string, unknown>
    const pr = p as unknown as Record<string, unknown>
    if (!WORKSPACE_KEYS.some((k) => st[k] !== pr[k])) return
    // show "Saving…" straight away, not "All changes saved" while the save is pending
    if (useWorkspaceSync.getState().status === "saved" && WORKSPACE_KEYS.some((k) => r.writable.has(k) && fp(st[k]) !== r.snap[k]?.fp))
      setStatus("saving")
    if (r.timer) clearTimeout(r.timer)
    r.timer = setTimeout(() => void push(), DEBOUNCE_MS)
  })
  const r: Running = { snap: loadSnapshot(), writable: new Set(), busy: false, again: false, unsubscribe }
  running = r
  setStatus("loading")
  await pull(true)
  if (running === r) r.poll = setInterval(() => void pull(false), POLL_MS)
}

export function stopWorkspaceSync() {
  const r = running
  if (!r) return
  r.unsubscribe()
  if (r.timer) clearTimeout(r.timer)
  if (r.poll) clearInterval(r.poll)
  running = null
  setStatus("idle")
}

/** Save pending changes now (tests; before signing out). */
export async function flushWorkspace(): Promise<void> {
  if (running?.timer) clearTimeout(running.timer)
  await push()
}

/** Check the server for other people's changes now (tests). */
export const pollWorkspace = () => pull(false)
