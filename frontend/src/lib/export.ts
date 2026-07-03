// Export helpers — CSV (zero-dep) and Excel .xlsx (SheetJS), used across every
// KPI / metrics screen and the central Report export centre.
import * as XLSX from "xlsx"

export type Row = Record<string, string | number | null | undefined>
export interface Sheet {
  name: string // becomes the worksheet tab (<= 31 chars for Excel)
  rows: Row[]
}

const stamp = () => new Date().toISOString().slice(0, 10)
export const exportName = (base: string) => `${base}-${stamp()}`

// ---- CSV ----
function toCSV(rows: Row[]): string {
  if (!rows.length) return ""
  const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s }, new Set<string>()))
  const esc = (v: unknown) => {
    const str = v == null ? "" : String(v)
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
  }
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n")
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function downloadCSV(base: string, sheets: Sheet[]) {
  const body = sheets
    .filter((s) => s.rows.length)
    .map((s) => `=== ${s.name} ===\n${toCSV(s.rows)}`)
    .join("\n\n")
  download(new Blob([body || "No data"], { type: "text/csv;charset=utf-8" }), `${exportName(base)}.csv`)
}

// ---- Excel (single or multi-sheet workbook) ----
export function downloadXLSX(base: string, sheets: Sheet[]) {
  const wb = XLSX.utils.book_new()
  sheets
    .filter((s) => s.rows.length)
    .forEach((s) => {
      const ws = XLSX.utils.json_to_sheet(s.rows)
      // auto-size columns to their widest value
      const cols = Object.keys(s.rows[0])
      ws["!cols"] = cols.map((c) => ({
        wch: Math.min(40, Math.max(c.length, ...s.rows.map((r) => String(r[c] ?? "").length)) + 2),
      }))
      XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31))
    })
  if (!wb.SheetNames.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["No data"]]), "Export")
  XLSX.writeFile(wb, `${exportName(base)}.xlsx`)
}

// Turn a KPI object map into two-column {Metric, Value} rows.
export function kpiRows(kpis: Record<string, string | number>): Row[] {
  return Object.entries(kpis).map(([Metric, Value]) => ({ Metric, Value }))
}
