// Keeps scheduling configuration in sync with the server, so a change made in
// one browser — or by a connected tool through the API — shows up everywhere:
//   work_rules · work_compliance · shift_patterns · agent_rules
// (GET/PUT /api/v1/scheduling/settings/{key}).
//
// * On sign-in: the server's copy wins, except where this browser changed a
//   setting offline since it last synced and the server hasn't moved on —
//   then the local change is uploaded. Nothing saved on the server yet → this
//   browser's copy is uploaded.
// * After every change: the changed settings are saved (debounced), each with
//   the version it was based on; a 409 means someone else saved first → their
//   copy is loaded and you're told.
// * Polls for other people's changes while signed in.
import { create } from "zustand"

import { api, type ApiError } from "@/lib/api"
import { parseWorkRulePatternId } from "@/lib/domain/workRules"
import { useWfm, type ServerSettings } from "@/store/wfm"

type Key = "work_rules" | "work_compliance" | "shift_patterns" | "agent_rules"
const KEYS: Key[] = ["work_rules", "work_compliance", "shift_patterns", "agent_rules"]
const FIELD: Record<Key, keyof ServerSettings> = {
  work_rules: "workRules",
  work_compliance: "workCompliance",
  shift_patterns: "shiftPatterns",
  agent_rules: "agentRules",
}
const SNAPSHOT_KEY = "wfm-settings-sync"
const DEBOUNCE_MS = 800
const POLL_MS = 20_000

export type SettingsSyncStatus = "idle" | "loading" | "saving" | "synced" | "offline" | "conflict" | "readonly"

export const useSettingsSync = create<{ status: SettingsSyncStatus; message: string | null; lastSyncedAt: number | null }>(() => ({
  status: "idle",
  message: null,
  lastSyncedAt: null,
}))
const setStatus = (status: SettingsSyncStatus, message: string | null = null) =>
  useSettingsSync.setState({ status, message, ...(status === "synced" ? { lastSyncedAt: Date.now() } : {}) })

interface ServerRow {
  key: Key
  value: unknown
  version: number
}

/** This browser's settings in the server's shape. */
export function localSettings(): Record<Key, unknown> {
  const s = useWfm.getState()
  return {
    work_rules: s.workRules,
    work_compliance: s.workCompliance,
    shift_patterns: s.shiftPatterns.filter((p) => !parseWorkRulePatternId(p.id)),
    agent_rules: Object.fromEntries(
      s.agents.map((a) => [a.id, { shiftPatternId: a.shiftPatternId ?? null, weekOff: a.weekOff ?? null, weekOffMode: a.weekOffMode ?? null }]),
    ),
  }
}

const fp = (v: unknown) => JSON.stringify(v)

/** Last state in sync with the server, per key (persisted so offline edits upload later). */
type Snapshot = Partial<Record<Key, { version: number; fp: string }>>
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
    /* private mode etc. — sync still works for this session */
  }
}

let running: { canWrite: boolean; snap: Snapshot; timer?: ReturnType<typeof setTimeout>; poll?: ReturnType<typeof setInterval>; unsubscribe: () => void } | null = null

const isNetwork = (e: unknown) => !(e as ApiError)?.status

function applyServer(rows: ServerRow[]) {
  if (!running || !rows.length) return
  useWfm.getState().applyServerSettings(Object.fromEntries(rows.map((r) => [FIELD[r.key], r.value])) as Partial<ServerSettings>)
  // Record what we now hold, *after* applying (the store normalises a little).
  const local = localSettings()
  for (const r of rows) running.snap[r.key] = { version: r.version, fp: fp(local[r.key]) }
  saveSnapshot(running.snap)
}

async function push(keys: Key[]) {
  const r = running
  if (!r || !r.canWrite) return
  const local = localSettings()
  const todo = keys.filter((k) => fp(local[k]) !== r.snap[k]?.fp)
  if (!todo.length) return
  setStatus("saving")
  for (const key of todo) {
    try {
      const res = await api.put(`/scheduling/settings/${key}`, { value: local[key], base_version: r.snap[key]?.version ?? 0 })
      const row = res.data.data as ServerRow
      r.snap[key] = { version: row.version, fp: fp(local[key]) }
      saveSnapshot(r.snap)
    } catch (e) {
      const err = e as ApiError
      if (err.status === 409) {
        const details = (err.details ?? {}) as { version?: number; value?: unknown }
        if (details.value != null) applyServer([{ key, value: details.value, version: details.version ?? 0 }])
        setStatus("conflict", "Someone else changed the work rules at the same time — their version is loaded. Make your change again.")
        return
      }
      setStatus("offline", isNetwork(e) ? "Server unreachable — changes are kept in this browser and saved when it's back." : err.message)
      return
    }
  }
  setStatus("synced")
}

async function pull(initial: boolean) {
  const r = running
  if (!r) return
  try {
    const rows = (await api.get("/scheduling/settings")).data.data as ServerRow[]
    if (running !== r) return
    const local = localSettings()
    const byKey = new Map(rows.filter((x) => KEYS.includes(x.key)).map((x) => [x.key, x]))
    const take: ServerRow[] = []
    const upload: Key[] = []
    for (const key of KEYS) {
      const srv = byKey.get(key)
      const snap = r.snap[key]
      const changedHere = fp(local[key]) !== snap?.fp
      if (!srv) {
        if (r.canWrite) upload.push(key) // never saved on the server: this browser's copy becomes the shared one
      } else if (snap && srv.version === snap.version) {
        if (changedHere && r.canWrite) upload.push(key) // edited offline, server unchanged → upload
      } else if (initial || !changedHere || !r.canWrite) {
        take.push(srv) // server moved on (or first sync) → load it
      }
    }
    applyServer(take)
    if (upload.length) await push(upload)
    else setStatus(r.canWrite ? "synced" : "readonly")
  } catch (e) {
    setStatus("offline", isNetwork(e) ? "Server unreachable — work rules are kept in this browser for now." : (e as ApiError).message)
  }
}

export async function startSettingsSync(opts: { canWrite: boolean }): Promise<void> {
  stopSettingsSync()
  const snap = loadSnapshot()
  const unsubscribe = useWfm.subscribe((s, p) => {
    const r = running
    if (!r || !r.canWrite) return
    if (s.workRules === p.workRules && s.workCompliance === p.workCompliance && s.shiftPatterns === p.shiftPatterns && s.agents === p.agents) return
    if (r.timer) clearTimeout(r.timer)
    r.timer = setTimeout(() => void push(KEYS), DEBOUNCE_MS)
  })
  running = { canWrite: opts.canWrite, snap, unsubscribe }
  setStatus("loading")
  await pull(true)
  if (running) running.poll = setInterval(() => void pull(false), POLL_MS)
}

export function stopSettingsSync() {
  if (!running) return
  running.unsubscribe()
  if (running.timer) clearTimeout(running.timer)
  if (running.poll) clearInterval(running.poll)
  running = null
  setStatus("idle")
}

/** Save pending changes now (e.g. before a test asserts). */
export async function flushSettings(): Promise<void> {
  if (running?.timer) clearTimeout(running.timer)
  await push(KEYS)
}
