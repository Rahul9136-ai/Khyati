// Workbook → Dataset. Validates header names exactly (trim + case-insensitive)
// and rejects a sheet whose required columns are missing (build prompt §2).
import * as XLSX from "xlsx"

import { fmtDate, monthLabel, num, parseDate, parseMonth } from "./normalize"
import { type SheetDef, type SheetId, SHEETS, headerKey } from "./schema"

export type Cell = string | number | null
/** One source row. `__row` is the 1-based row number in the source sheet. */
export type Row = { __row: number } & Record<string, Cell>

export interface SheetData {
  id: SheetId
  columns: string[]
  rows: Row[]
  fileName: string
  sheetName: string
  loadedAt: string
  /** Forecast only: month columns in source order. */
  monthColumns?: string[]
}

export type Dataset = Partial<Record<SheetId, SheetData>>

export interface ParseIssue {
  sheet: SheetId | null
  sheetName?: string
  message: string
}

export interface ParseResult {
  sheets: SheetData[]
  errors: ParseIssue[]
  /** SheetDefs we looked for but didn't find in the workbook. */
  missing: SheetId[]
}

function findHeaderRow(aoa: unknown[][], def: SheetDef): number {
  const first = headerKey(def.columns[0].header ?? def.columns[0].name)
  const preferred = def.headerRow - 1
  if (aoa[preferred]?.some((h) => headerKey(h) === first)) return preferred
  for (let i = 0; i < Math.min(aoa.length, 6); i++)
    if (aoa[i]?.some((h) => headerKey(h) === first)) return i
  return preferred
}

function convert(v: unknown, type: string): Cell {
  if (v == null || v === "") return null
  switch (type) {
    case "number":
    case "pct": {
      const n = num(v)
      return n ?? (typeof v === "string" ? v.trim() : String(v))
    }
    case "date": {
      const d = parseDate(v)
      return d ? fmtDate(d) : String(v).trim()
    }
    case "month": {
      const m = parseMonth(v)
      return m ? monthLabel(m) : String(v).trim()
    }
    default:
      return typeof v === "string" ? v.trim() : String(v)
  }
}

/** Parse one worksheet against its definition. */
export function parseSheet(
  ws: XLSX.WorkSheet, def: SheetDef, fileName: string, sheetName: string,
): { data?: SheetData; errors: ParseIssue[] } {
  const errors: ParseIssue[] = []
  const ref = ws["!ref"]
  if (!ref) return { errors: [{ sheet: def.id, sheetName, message: `Sheet "${sheetName}" is empty.` }] }
  const range = XLSX.utils.decode_range(ref)
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true })
  const hIdx = findHeaderRow(aoa, def)
  const header = (aoa[hIdx] ?? []) as unknown[]

  // header key → list of column indexes (for repeated headers like SBU)
  const occ = new Map<string, number[]>()
  header.forEach((h, i) => {
    const k = headerKey(h)
    if (!k) return
    occ.set(k, [...(occ.get(k) ?? []), i])
  })

  const colIndex: Record<string, number> = {}
  const missingCols: string[] = []
  for (const c of def.columns) {
    const idx = occ.get(headerKey(c.header ?? c.name))?.[c.occurrence ?? 0]
    if (idx === undefined) {
      if (!c.optional) missingCols.push(c.occurrence ? `${c.header ?? c.name} (occurrence ${c.occurrence + 1})` : (c.header ?? c.name))
    } else colIndex[c.name] = idx
  }

  const monthColumns: { name: string; idx: number }[] = []
  if (def.monthColumns) {
    header.forEach((h, i) => {
      if (h != null && def.monthColumns!.prefix.test(String(h).trim())) {
        const name = String(h).trim()
        const mk = parseMonth(name.replace(def.monthColumns!.prefix, ""))
        if (!mk) errors.push({ sheet: def.id, sheetName, message: `Month column "${name}" can't be read as Mon'YY.` })
        monthColumns.push({ name, idx: i })
      }
    })
    if (!monthColumns.length) missingCols.push("Units _ Mon'YY (at least one month column)")
  }

  if (missingCols.length) {
    errors.push({
      sheet: def.id, sheetName,
      message: `"${sheetName}" was rejected — required column${missingCols.length > 1 ? "s" : ""} missing in header row ${hIdx + range.s.r + 1}: ${missingCols.join(", ")}.`,
    })
    return { errors }
  }

  const rows: Row[] = []
  for (let r = hIdx + 1; r < aoa.length; r++) {
    const src = aoa[r] as unknown[] | undefined
    if (!src || src.every((v) => v == null || v === "")) continue
    const row: Row = { __row: r + range.s.r + 1 }
    for (const c of def.columns) {
      const i = colIndex[c.name]
      row[c.name] = i === undefined ? null : convert(src[i], c.type)
    }
    for (const mc of monthColumns) row[mc.name] = convert(src[mc.idx], "number")
    rows.push(row)
  }

  return {
    errors,
    data: {
      id: def.id,
      columns: [...def.columns.filter((c) => colIndex[c.name] !== undefined).map((c) => c.name), ...monthColumns.map((m) => m.name)],
      rows,
      fileName,
      sheetName,
      loadedAt: new Date().toISOString(),
      monthColumns: def.monthColumns ? monthColumns.map((m) => m.name) : undefined,
    },
  }
}

function findWorksheet(wb: XLSX.WorkBook, def: SheetDef): string | undefined {
  const wanted = def.sheetNames.map((s) => s.trim().toLowerCase())
  return wb.SheetNames.find((n) => wanted.includes(n.trim().toLowerCase()))
}

/**
 * Parse a workbook. With `only`, just that input is read — from its named tab,
 * or from the first tab when the file has a single sheet.
 */
export function parseWorkbook(data: ArrayBuffer | Uint8Array, fileName: string, only?: SheetId): ParseResult {
  const wb = XLSX.read(data, { type: "array", cellDates: false, cellFormula: false })
  const defs = only ? SHEETS.filter((s) => s.id === only) : SHEETS
  const sheets: SheetData[] = []
  const errors: ParseIssue[] = []
  const missing: SheetId[] = []
  for (const def of defs) {
    let name = findWorksheet(wb, def)
    if (!name && only && wb.SheetNames.length === 1) name = wb.SheetNames[0]
    if (!name) {
      missing.push(def.id)
      continue
    }
    const res = parseSheet(wb.Sheets[name], def, fileName, name)
    errors.push(...res.errors)
    if (res.data) sheets.push(res.data)
  }
  return { sheets, errors, missing }
}
