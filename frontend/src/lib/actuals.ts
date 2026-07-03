// Actual-volume import for the Forecasting tab — Excel/CSV daily actuals that
// get appended after the last known day of history, then the models retrain
// and re-predict on the augmented series.
import * as XLSX from "xlsx"

import { addDays, ymd } from "@/lib/domain/dates"
import type { ActualRow } from "@/lib/domain/history"
import type { Queue } from "@/lib/domain/types"

// Tolerant column lookup (case/spacing/punctuation-insensitive).
function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of Object.keys(row)) {
    const norm = k.toLowerCase().replace(/[^a-z]/g, "")
    if (keys.includes(norm)) return row[k]
  }
  return undefined
}

// Normalise a date cell to "YYYY-MM-DD". Handles Excel serial dates, ISO
// strings, and most locale date strings the Date constructor can parse.
function toISODate(v: unknown): string | null {
  if (v == null || v === "") return null
  if (typeof v === "number") {
    // Excel serial date, days since 1899-12-30
    const epoch = Date.UTC(1899, 11, 30)
    const d = new Date(epoch + v * 86_400_000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
  }
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const parsed = new Date(s)
  return isNaN(parsed.getTime()) ? null : ymd(parsed)
}

export interface ParseActualsResult {
  rows: ActualRow[]
  errors: string[]
  skippedOtherQueue: number
}

// Parses an actuals file for one queue. Rows carrying a `Queue` column that
// names a *different* queue are silently skipped (lets one workbook be reused
// across queues without cross-contaminating each queue's history).
export async function parseActualsFile(file: File, queueId: string, queues: Queue[]): Promise<ParseActualsResult> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { cellDates: false })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" })

  const rows: ActualRow[] = []
  const errors: string[] = []
  let skippedOtherQueue = 0
  const seen = new Set<string>()

  raw.forEach((row, i) => {
    const queueCell = pick(row, ["queue", "lob", "skill"])
    if (queueCell) {
      const cell = String(queueCell).trim().toLowerCase()
      const match = queues.find((q) => q.id === cell || q.name.toLowerCase() === cell)
      if (match && match.id !== queueId) {
        skippedOtherQueue++
        return
      }
    }

    const date = toISODate(pick(row, ["date", "day", "actualdate"]))
    const volCell = pick(row, ["volume", "actualvolume", "contacts", "totalcontacts", "actual", "actualcontacts"])
    const vol = Number(volCell)

    if (!date) {
      errors.push(`Row ${i + 2}: invalid or missing date`)
      return
    }
    if (!Number.isFinite(vol) || vol < 0) {
      errors.push(`Row ${i + 2}: invalid volume`)
      return
    }
    if (seen.has(date)) {
      errors.push(`Row ${i + 2}: duplicate date ${date} in file (last value wins)`)
    }
    seen.add(date)
    rows.push({ date, volume: Math.round(vol) })
  })

  return { rows, errors, skippedOtherQueue }
}

// Download a blank template whose example dates start the day *after* the
// queue's current last known day — literal, visual guidance for "append after
// the last entry."
export function downloadActualsTemplate(queueName: string, nextDate: Date) {
  const sample = [0, 1, 2].map((i) => ({ Date: ymd(addDays(nextDate, i)), Volume: "", Queue: queueName }))
  const ws = XLSX.utils.json_to_sheet(sample)
  ws["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 16 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "Actuals")
  XLSX.writeFile(wb, `wfm-actuals-template-${queueName.toLowerCase().replace(/\s+/g, "-")}.xlsx`)
}
