// Keeps the Capacity Planning tab in sync with the server (/api/v1/capacity),
// so every browser and every connected tool (CRM, HR system…) works on the same
// sheets, switches and results.
//
// * Opening the tab while signed in loads the server's copy. If the server has
//   nothing yet and this browser does, this browser's copy is uploaded.
// * Changes are saved as they're made: a workbook import replaces those sheets,
//   a cell edit sends just that cell (batched), a switch change saves the
//   switches. Each save carries the version it was based on — if someone else
//   saved first (409) their copy is loaded and you're told.
// * While the tab is open it keeps a live connection to the server
//   (GET /capacity/stream): a change saved anywhere (another user, a CRM through
//   the API) is pushed here within a second and the changed sheets are reloaded.
//   If the live connection drops it reconnects, and meanwhile the server is
//   checked every 20 s.
// * No server / offline: everything keeps working from this browser's copy and
//   is uploaded when the server is back.
import { create } from "zustand"

import { api, type ApiError, tokenStore } from "@/lib/api"

import type { CapacityConfig } from "./config"
import type { Cell, Dataset, Row, SheetData } from "./parse"
import { SHEETS, type SheetId } from "./schema"
import { useCapacity } from "./store"

export type SyncStatus = "local" | "loading" | "saving" | "synced" | "offline" | "conflict" | "readonly"

/** One entry of the shared plan's change log (GET /capacity/activity). */
export interface Activity {
  id: string
  at: string
  by: string
  source: "app" | "api"
  apiKey: string | null
  action: string
  verb: string
  sheet: string | null
  label: string | null
  version: number | null
  summary: string
}

export const useCapacitySync = create<{
  status: SyncStatus
  message: string | null
  lastSyncedAt: number | null
  resultsVersion: string | null
  /** the live connection is open: changes arrive as they happen */
  live: boolean
  activity: Activity[]
}>(() => ({ status: "local", message: null, lastSyncedAt: null, resultsVersion: null, live: false, activity: [] }))

const setStatus = (status: SyncStatus, message: string | null = null) =>
  useCapacitySync.setState({ status, message, ...(status === "synced" ? { lastSyncedAt: Date.now() } : {}) })

const POLL_MS = 20_000
/** While live, still check this often in case an event was missed. */
const LIVE_POLL_MS = 120_000
const RETRY_MS = [1_000, 3_000, 10_000, 30_000]
const DEBOUNCE_MS = 600
const BIG = { timeout: 120_000 }
const isNetwork = (e: unknown) => !(e as ApiError)?.status
const errMsg = (e: unknown) => (e as ApiError)?.message ?? String(e)

interface ServerSheet {
  id: SheetId
  version: number
  updatedAt: string
  updatedBy: string
  fileName: string
  sheetName: string
  columns: string[]
  monthColumns: string[] | null
  rows?: Row[]
}
interface ServerState {
  sheets: Record<SheetId, { version: number } | null>
  config: { version: number } | null
  resultsVersion: string
}

const data = <T>(p: Promise<{ data: { data: T } }>) => p.then((r) => r.data.data)

/** Calls the store makes after a local change (no-ops when sync isn't running). */
interface Ctx {
  canWrite: boolean
  versions: Partial<Record<SheetId | "config", number>>
  /** sheet → row → column → value, waiting to be sent */
  cells: Map<SheetId, Map<number, Record<string, Cell>>>
  /** sheets to upload whole (imports; edits made offline) */
  dirty: Set<SheetId>
  configDirty: boolean
  clear: boolean
  timer?: ReturnType<typeof setTimeout>
  poll?: ReturnType<typeof setInterval>
  lastPoll: number
  /** a check was asked for while saving: run it afterwards */
  pollAgain: boolean
  stream?: AbortController
  flushing: boolean
  stopped: boolean
}
let ctx: Ctx | null = null

export const isSyncing = () => !!ctx && !ctx.stopped

function toLocal(s: ServerSheet): SheetData {
  return {
    id: s.id, columns: s.columns, rows: s.rows ?? [], fileName: s.fileName, sheetName: s.sheetName,
    loadedAt: s.updatedAt, monthColumns: s.monthColumns ?? undefined,
  }
}
const toServer = (s: SheetData) => ({ rows: s.rows, monthColumns: s.monthColumns ?? null, fileName: s.fileName, sheetName: s.sheetName })

/** Replace local sheets with the server's copies (drops edit markers for sheets that changed). */
function applyServerSheets(sheets: ServerSheet[], removed: SheetId[] = []) {
  const st = useCapacity.getState()
  const dataset: Dataset = { ...st.dataset }
  let edits = st.edits
  for (const s of sheets) {
    dataset[s.id] = toLocal(s)
    if (ctx) ctx.versions[s.id] = s.version
  }
  for (const id of removed) {
    delete dataset[id]
    if (ctx) delete ctx.versions[id]
  }
  const touched = new Set<string>([...sheets.map((s) => s.id), ...removed])
  edits = Object.fromEntries(Object.entries(edits).filter(([k]) => !touched.has(k.split(":")[0])))
  useCapacity.getState().replaceFromServer(dataset, edits)
}

async function pullSheets(ids: SheetId[]) {
  const sheets = await Promise.all(ids.map((id) => data<ServerSheet>(api.get(`/capacity/sheets/${id}`, BIG))))
  applyServerSheets(sheets)
}

async function pullConfig() {
  const c = await data<{ config: CapacityConfig; version: number }>(api.get("/capacity/config"))
  if (ctx) ctx.versions.config = c.version
  useCapacity.getState().replaceConfigFromServer(c.config)
}

/** Start syncing (call when the tab opens while signed in). */
export async function startCapacitySync(canWrite: boolean) {
  stopCapacitySync()
  const me: Ctx = { canWrite, versions: {}, cells: new Map(), dirty: new Set(), configDirty: false, clear: false, flushing: false, stopped: false, lastPoll: Date.now(), pollAgain: false }
  ctx = me
  setStatus("loading")
  try {
    const state = await data<ServerState>(api.get("/capacity/state"))
    if (me.stopped) return
    const onServer = SHEETS.filter((s) => state.sheets[s.id]).map((s) => s.id)
    const local = useCapacity.getState().dataset
    const localIds = SHEETS.filter((s) => local[s.id]).map((s) => s.id)
    if (!onServer.length && localIds.length && canWrite) {
      // first time on this server: upload this browser's workbook
      localIds.forEach((id) => me.dirty.add(id))
      me.configDirty = !state.config // the server has no switches yet → this browser's
      await flush()
    } else {
      if (onServer.length) {
        const all = await data<ServerSheet[]>(api.get("/capacity/sheets", { ...BIG, params: { include_rows: true } }))
        if (me.stopped) return
        applyServerSheets(all, localIds.filter((id) => !onServer.includes(id)))
      }
      if (state.config) await pullConfig()
      else if (canWrite) { me.configDirty = true; await flush() }
    }
    useCapacitySync.setState({ resultsVersion: state.resultsVersion })
    setStatus(canWrite ? "synced" : "readonly", canWrite ? null : "You can view the shared plan; changes need edit access.")
  } catch (e) {
    setStatus("offline", isNetwork(e) ? "Server unreachable — working from this browser's copy; changes upload when it's back." : errMsg(e))
  }
  if (me.stopped) return
  me.poll = setInterval(() => {
    if (!useCapacitySync.getState().live || Date.now() - me.lastPoll >= LIVE_POLL_MS) void poll()
  }, POLL_MS)
  void runStream(me)
}

/** Opens the server's live event stream and yields its text. Swapped out in tests. */
export const streamTransport = {
  async *open(url: string, token: string, signal: AbortSignal): AsyncGenerator<string> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" }, signal, cache: "no-store" })
    if (!res.ok || !res.body) throw Object.assign(new Error(`stream: HTTP ${res.status}`), { status: res.status })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      yield dec.decode(value, { stream: true })
    }
  },
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Keep the live connection open (reconnecting with backoff) until sync stops. */
async function runStream(me: Ctx) {
  let attempt = 0
  while (!me.stopped) {
    const token = tokenStore.access
    if (!token || typeof TextDecoder === "undefined") return // polling only
    const ac = new AbortController()
    me.stream = ac
    try {
      let buf = ""
      for await (const chunk of streamTransport.open(`${api.defaults.baseURL}/capacity/stream`, token, ac.signal)) {
        if (me.stopped) break
        buf += chunk.replace(/\r\n/g, "\n")
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          if (onStreamEvent(me, block)) attempt = 0
        }
      }
    } catch (e) {
      // an expired login: any API call refreshes it, then reconnect
      if (!me.stopped && (e as ApiError)?.status === 401) await api.get("/capacity/state").catch(() => undefined)
    }
    if (me.stopped) return
    useCapacitySync.setState({ live: false })
    await sleep(RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)])
  }
}

/** Handle one SSE block; true for a real event (not a keep-alive). */
function onStreamEvent(me: Ctx | null, block: string): boolean {
  let name = "message"
  let body = ""
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim()
    else if (line.startsWith("data:")) body += line.slice(5).trim()
  }
  if ((name !== "hello" && name !== "change") || !body || !me || me.stopped) return false
  const msg = JSON.parse(body) as { resultsVersion: string; activity?: Activity[] }
  useCapacitySync.setState({ live: true, ...(msg.activity ? { activity: msg.activity } : {}) })
  if (msg.resultsVersion !== useCapacitySync.getState().resultsVersion) void poll()
  return true
}

export function stopCapacitySync() {
  if (!ctx) return
  ctx.stopped = true
  if (ctx.timer) clearTimeout(ctx.timer)
  if (ctx.poll) clearInterval(ctx.poll)
  ctx.stream?.abort()
  ctx = null
  useCapacitySync.setState({ live: false })
  setStatus("local")
}

/** Check for changes made elsewhere; upload anything left from offline. */
export async function poll() {
  const me = ctx
  if (!me) return
  if (me.flushing) { me.pollAgain = true; return }
  me.lastPoll = Date.now()
  try {
    if (me.dirty.size || me.cells.size || me.configDirty || me.clear) await flush()
    const state = await data<ServerState>(api.get("/capacity/state"))
    if (me.stopped) return
    const changed = SHEETS.map((s) => s.id).filter((id) => (state.sheets[id]?.version ?? 0) !== (me.versions[id] ?? 0)
      && !me.dirty.has(id) && !me.cells.has(id))
    const removed = changed.filter((id) => !state.sheets[id])
    const updated = changed.filter((id) => state.sheets[id])
    if (updated.length) await pullSheets(updated)
    if (removed.length) applyServerSheets([], removed)
    const cfgChanged = (state.config?.version ?? 0) !== (me.versions.config ?? 0) && !me.configDirty
    if (cfgChanged && state.config) await pullConfig()
    useCapacitySync.setState({ resultsVersion: state.resultsVersion })
    if (changed.length || cfgChanged) {
      const top = useCapacitySync.getState().activity[0]
      const who = top ? ` (latest: ${top.source === "api" ? `${top.apiKey ?? "API"} via API` : top.by})` : ""
      setStatus("synced", `Updated from the server: ${[...changed.map((id) => SHEETS.find((s) => s.id === id)!.label), ...(cfgChanged ? ["Switches"] : [])].join(", ")}${who}`)
    }
    else if (useCapacitySync.getState().status === "offline") setStatus(me.canWrite ? "synced" : "readonly")
  } catch (e) {
    setStatus("offline", isNetwork(e) ? "Server unreachable — working from this browser's copy; changes upload when it's back." : errMsg(e))
  }
}

function schedule() {
  if (!ctx || !ctx.canWrite) return
  if (ctx.timer) clearTimeout(ctx.timer)
  ctx.timer = setTimeout(() => void flush(), DEBOUNCE_MS)
}

/** Send everything waiting. */
export async function flush() {
  const me = ctx
  if (!me || me.flushing || !me.canWrite) return
  me.flushing = true
  setStatus("saving")
  try {
    if (me.clear) {
      await api.delete("/capacity/sheets")
      me.clear = false
      for (const id of SHEETS.map((s) => s.id)) delete me.versions[id]
    }
    const ds = useCapacity.getState().dataset
    // whole sheets (imports / offline edits) — one request
    const whole = [...me.dirty].filter((id) => ds[id])
    if (whole.length) {
      const body = { sheets: Object.fromEntries(whole.map((id) => [id, { ...toServer(ds[id]!), base_version: me.versions[id] ?? 0 }])) }
      try {
        const out = await data<ServerSheet[]>(api.put("/capacity/workbook", body, BIG))
        out.forEach((s) => { me.versions[s.id] = s.version })
      } catch (e) {
        if ((e as ApiError).status !== 409) throw e
        // someone else changed one of them: theirs wins for those sheets
        await pullSheets(whole)
        whole.forEach((id) => me.dirty.delete(id))
        setStatus("conflict", "Someone else changed these sheets first — their version is loaded. Re-import if yours should win.")
        return
      }
      whole.forEach((id) => { me.dirty.delete(id); me.cells.delete(id) })
    }
    // single cells
    for (const [sheet, rows] of [...me.cells]) {
      me.cells.delete(sheet)
      const upsert = [...rows].map(([row, values]) => ({ row, values }))
      try {
        const out = await data<{ version: number }>(api.patch(`/capacity/sheets/${sheet}/rows`, { upsert, base_version: me.versions[sheet] ?? 0 }))
        me.versions[sheet] = out.version
      } catch (e) {
        if ((e as ApiError).status === 409 || (e as ApiError).status === 404) {
          await pullSheets([sheet])
          setStatus("conflict", `${SHEETS.find((s) => s.id === sheet)!.label} was changed by someone else — their version is loaded; your last edit there wasn't saved.`)
          return
        }
        // keep it for the next try
        const again = me.cells.get(sheet) ?? new Map()
        for (const [row, values] of rows) again.set(row, { ...values, ...(again.get(row) ?? {}) })
        me.cells.set(sheet, again)
        throw e
      }
    }
    if (me.configDirty) {
      try {
        const out = await data<{ version: number }>(api.put("/capacity/config", { config: useCapacity.getState().config, base_version: me.versions.config ?? 0 }))
        me.versions.config = out.version
        me.configDirty = false
      } catch (e) {
        if ((e as ApiError).status !== 409) throw e
        me.configDirty = false
        await pullConfig()
        setStatus("conflict", "Someone else changed the switches first — their settings are loaded.")
        return
      }
    }
    const st = await data<ServerState>(api.get("/capacity/state"))
    useCapacitySync.setState({ resultsVersion: st.resultsVersion })
    setStatus("synced")
  } catch (e) {
    setStatus("offline", isNetwork(e) ? "Server unreachable — your changes are kept in this browser and upload when it's back." : errMsg(e))
  } finally {
    me.flushing = false
    if (me.pollAgain && !me.stopped) {
      me.pollAgain = false
      void poll()
    }
  }
}

// ---- hooks the store calls after local changes
export function syncSheetsReplaced(ids: SheetId[]) {
  if (!ctx || !ctx.canWrite) return
  ids.forEach((id) => { ctx!.dirty.add(id); ctx!.cells.delete(id) })
  schedule()
}
export function syncCellEdited(sheet: SheetId, row: number, column: string, value: Cell) {
  if (!ctx || !ctx.canWrite) return
  if (ctx.dirty.has(sheet)) return schedule() // the whole sheet goes anyway
  const rows = ctx.cells.get(sheet) ?? new Map<number, Record<string, Cell>>()
  rows.set(row, { ...(rows.get(row) ?? {}), [column]: value })
  ctx.cells.set(sheet, rows)
  schedule()
}
export function syncConfigChanged() {
  if (!ctx || !ctx.canWrite) return
  ctx.configDirty = true
  schedule()
}
export function syncCleared() {
  if (!ctx || !ctx.canWrite) return
  ctx.clear = true
  ctx.dirty.clear()
  ctx.cells.clear()
  schedule()
}
