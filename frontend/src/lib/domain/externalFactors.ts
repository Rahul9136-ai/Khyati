// External factors — known events (marketing campaigns, holidays, weather,
// planned outages) that a pure statistical/ML model can't anticipate on its
// own. Overlaying them as a volume multiplier on the date-range forecast
// closes exactly the gap a time-series model misses: step changes tied to a
// specific calendar date rather than a repeating pattern.
import * as XLSX from "xlsx"

import { ymd } from "./dates"
import type { Queue } from "./types"

export const FACTOR_CATEGORIES = ["Marketing", "Holiday", "Weather", "Outage", "Other"] as const
export type FactorCategory = (typeof FACTOR_CATEGORIES)[number]

export interface ExternalFactor {
  id: string
  name: string
  category: FactorCategory
  /** A real queue id, or "all" to apply across every queue. */
  queueId: string
  from: string // YYYY-MM-DD
  to: string
  /** +25 = 25% more volume, -40 = 40% less, over the date range. */
  impactPct: number
  note?: string
  createdAt: number
}

const inRange = (date: string, from: string, to: string) => date >= from && date <= to

/** Combined multiplier for one calendar date + queue. Multiple overlapping
 *  factors compound multiplicatively (two +20% promos ≠ +40%, matches how
 *  independent uplifts actually stack). */
export function factorMultiplier(factors: ExternalFactor[], queueId: string, date: string): number {
  return factors.reduce((mult, f) => {
    if (f.queueId !== "all" && f.queueId !== queueId) return mult
    if (!inRange(date, f.from, f.to)) return mult
    return mult * (1 + f.impactPct / 100)
  }, 1)
}

export function activeFactorsFor(factors: ExternalFactor[], queueId: string, date: string): ExternalFactor[] {
  return factors.filter((f) => (f.queueId === "all" || f.queueId === queueId) && inRange(date, f.from, f.to))
}

// ---- import/export ----

function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of Object.keys(row)) {
    const norm = k.toLowerCase().replace(/[^a-z]/g, "")
    if (keys.includes(norm)) return row[k]
  }
  return undefined
}

function toISODate(v: unknown): string | null {
  if (v == null || v === "") return null
  if (typeof v === "number") {
    const epoch = Date.UTC(1899, 11, 30)
    const d = new Date(epoch + v * 86_400_000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
  }
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const parsed = new Date(s)
  return isNaN(parsed.getTime()) ? null : ymd(parsed)
}

export type NewFactor = Omit<ExternalFactor, "id" | "createdAt">

export interface ParseFactorsResult {
  rows: NewFactor[]
  errors: string[]
}

export async function parseFactorsFile(file: File, queues: Queue[]): Promise<ParseFactorsResult> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { cellDates: false })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" })

  const rows: NewFactor[] = []
  const errors: string[] = []

  raw.forEach((row, i) => {
    const name = String(pick(row, ["name", "factor", "event"]) ?? "").trim()
    const catCell = String(pick(row, ["category", "type"]) ?? "Other").trim()
    const category = (FACTOR_CATEGORIES.find((c) => c.toLowerCase() === catCell.toLowerCase()) ?? "Other") as FactorCategory
    const queueCell = String(pick(row, ["queue", "lob", "skill"]) ?? "all").trim().toLowerCase()
    const queueMatch = queues.find((q) => q.id === queueCell || q.name.toLowerCase() === queueCell)
    const queueId = queueCell === "all" || queueCell === "" ? "all" : (queueMatch?.id ?? null)
    const from = toISODate(pick(row, ["from", "start", "startdate"]))
    const toRaw = toISODate(pick(row, ["to", "end", "enddate"]))
    const impactRaw = pick(row, ["impact", "impactpct", "impactpercent", "volumeimpact"])
    const impactPct = Number(String(impactRaw).replace("%", ""))
    const note = String(pick(row, ["note", "notes", "description"]) ?? "").trim() || undefined

    if (!name) return void errors.push(`Row ${i + 2}: missing name`)
    if (!from) return void errors.push(`Row ${i + 2}: invalid or missing "From" date`)
    if (queueId == null) return void errors.push(`Row ${i + 2}: unknown queue "${queueCell}"`)
    if (!Number.isFinite(impactPct) || impactPct <= -100) return void errors.push(`Row ${i + 2}: invalid impact %`)

    const to = toRaw && toRaw >= from ? toRaw : from
    rows.push({ name, category, queueId, from, to, impactPct, note })
  })

  return { rows, errors }
}

export function downloadFactorsTemplate() {
  const sample = [
    { Name: "Black Friday campaign", Category: "Marketing", Queue: "all", From: "2026-11-27", To: "2026-11-30", "Impact %": 40, Note: "Site-wide promo" },
    { Name: "Public holiday", Category: "Holiday", Queue: "all", From: "2026-12-25", To: "2026-12-25", "Impact %": -60, Note: "Office closed" },
  ]
  const ws = XLSX.utils.json_to_sheet(sample)
  ws["!cols"] = [{ wch: 24 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 26 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "External Factors")
  XLSX.writeFile(wb, "wfm-external-factors-template.xlsx")
}
