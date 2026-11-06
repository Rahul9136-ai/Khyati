// Capacity Planning store: the imported workbook, cell edits and the §7 switches.
// Persisted in this browser's IndexedDB so a reload keeps the data.
import { create } from "zustand"

import { type CapacityConfig, DEFAULT_CONFIG } from "./config"
import { type Cell, type Dataset, type ParseIssue, type SheetData, parseWorkbook } from "./parse"
import { SHEET_BY_ID, type SheetId } from "./schema"
import { syncCellEdited, syncCleared, syncConfigChanged, syncSheetsReplaced } from "./sync"

const DB_NAME = "aforce-capacity"
const STORE = "kv"

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null)
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb()
  if (!db) return undefined
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

export interface ImportReport {
  fileName: string
  at: string
  loaded: { id: SheetId; rows: number; expected: number }[]
  errors: ParseIssue[]
  missing: SheetId[]
}

interface Persisted {
  dataset: Dataset
  config: CapacityConfig
  edits: Record<string, Cell>
  lastImport: ImportReport | null
}

interface CapacityState extends Persisted {
  hydrated: boolean
  busy: boolean
  hydrate: () => Promise<void>
  importFile: (file: File, only?: SheetId) => Promise<ImportReport>
  editCell: (sheet: SheetId, srcRow: number, column: string, value: Cell) => void
  setConfig: (patch: Partial<CapacityConfig>) => void
  resetConfig: () => void
  clearData: () => void
  /** Sync: the server's copy replaces these sheets (no upload back). */
  replaceFromServer: (dataset: Dataset, edits: Record<string, Cell>) => void
  replaceConfigFromServer: (config: CapacityConfig) => void
}

/** Key for an edited cell. The original value is kept so the UI can show it. */
export const editKey = (sheet: SheetId, srcRow: number, column: string) => `${sheet}:${srcRow}:${column}`

let saveTimer: ReturnType<typeof setTimeout> | null = null
function persist(s: Persisted) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void idbSet("state", { dataset: s.dataset, config: s.config, edits: s.edits, lastImport: s.lastImport })
  }, 300)
}

export const useCapacity = create<CapacityState>((set, get) => ({
  dataset: {},
  config: DEFAULT_CONFIG,
  edits: {},
  lastImport: null,
  hydrated: false,
  busy: false,

  hydrate: async () => {
    if (get().hydrated) return
    const saved = await idbGet<Persisted>("state")
    if (saved) set({ ...saved, config: { ...DEFAULT_CONFIG, ...saved.config }, hydrated: true })
    else set({ hydrated: true })
  },

  importFile: async (file, only) => {
    set({ busy: true })
    try {
      const buf = await file.arrayBuffer()
      const res = parseWorkbook(buf, file.name, only)
      const dataset: Dataset = { ...get().dataset }
      let edits = get().edits
      for (const sh of res.sheets) {
        dataset[sh.id] = sh
        // a re-import replaces that sheet, so its edits no longer apply
        edits = Object.fromEntries(Object.entries(edits).filter(([k]) => !k.startsWith(`${sh.id}:`)))
      }
      const report: ImportReport = {
        fileName: file.name, at: new Date().toISOString(),
        loaded: res.sheets.map((s: SheetData) => ({ id: s.id, rows: s.rows.length, expected: SHEET_BY_ID[s.id].expectedRows })),
        errors: res.errors, missing: res.missing,
      }
      set({ dataset, edits, lastImport: report })
      persist(get())
      syncSheetsReplaced(res.sheets.map((s) => s.id))
      return report
    } finally {
      set({ busy: false })
    }
  },

  editCell: (sheet, srcRow, column, value) => {
    const sd = get().dataset[sheet]
    if (!sd) return
    const idx = sd.rows.findIndex((r) => r.__row === srcRow)
    if (idx < 0) return
    const before = sd.rows[idx][column] ?? null
    const k = editKey(sheet, srcRow, column)
    const edits = { ...get().edits }
    if (!(k in edits)) edits[k] = before // keep the original value
    else if (edits[k] === value) delete edits[k] // edited back to the original
    const rows = sd.rows.slice()
    rows[idx] = { ...rows[idx], [column]: value }
    set({ dataset: { ...get().dataset, [sheet]: { ...sd, rows } }, edits })
    persist(get())
    syncCellEdited(sheet, srcRow, column, value)
  },

  setConfig: (patch) => {
    set({ config: { ...get().config, ...patch } })
    persist(get())
    syncConfigChanged()
  },
  resetConfig: () => {
    set({ config: DEFAULT_CONFIG })
    persist(get())
    syncConfigChanged()
  },
  clearData: () => {
    set({ dataset: {}, edits: {}, lastImport: null })
    persist(get())
    syncCleared()
  },
  replaceFromServer: (dataset, edits) => {
    set({ dataset, edits })
    persist(get())
  },
  replaceConfigFromServer: (config) => {
    set({ config: { ...DEFAULT_CONFIG, ...config } })
    persist(get())
  },
}))
