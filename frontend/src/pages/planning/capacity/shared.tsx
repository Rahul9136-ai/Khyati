import { ChevronLeft, ChevronRight, Filter, Pencil, X } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { ExportButton } from "@/components/export-button"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { monthLabel } from "@/lib/capacity/normalize"
import type { Cell } from "@/lib/capacity/parse"
import type { Row as ExportRow } from "@/lib/export"
import { cn } from "@/lib/utils"

import { EMPTY_FILTERS, type Filters, type Fmt, fmt, useCap } from "./ctx"

export function FilterBar({ showMonth = true }: { showMonth?: boolean }) {
  const { result, filters, setFilters } = useCap()
  const opts = useMemo(() => {
    const c = new Set<string>(), s = new Set<string>(), l = new Set<string>()
    for (const r of result.rows) {
      c.add(r.customer); s.add(r.serviceLine); l.add(r.location)
    }
    const sort = (x: Set<string>) => [...x].filter(Boolean).sort((a, b) => a.localeCompare(b))
    return { c: sort(c), s: sort(s), l: sort(l) }
  }, [result.rows])
  const any = filters.customer || filters.serviceLine || filters.location || filters.month
  const sel = (label: string, value: string, options: string[], key: keyof Filters, labelOf = (x: string) => x) => (
    <label className="flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Select value={value} onChange={(e) => setFilters({ ...filters, [key]: e.target.value })}
        className="h-8 max-w-[14rem] text-xs"
        options={[{ value: "", label: "All" }, ...options.map((o) => ({ value: o, label: labelOf(o) }))]} />
    </label>
  )
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Filter className="h-3.5 w-3.5 text-muted-foreground" />
      {sel("Customer", filters.customer, opts.c, "customer")}
      {sel("Service Line", filters.serviceLine, opts.s, "serviceLine")}
      {sel("Location", filters.location, opts.l, "location")}
      {showMonth && sel("Month", filters.month, result.months, "month", monthLabel)}
      {any && (
        <Button size="sm" variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)}>
          <X className="h-3.5 w-3.5" /> Clear
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- grid
export interface GridCol<T> {
  key: string
  label: string
  get: (r: T) => Cell | number | null | undefined
  fmt?: Fmt
  /** "sum" of the filtered rows, or a custom total (e.g. a ratio of sums). */
  total?: "sum" | ((rows: T[]) => number | null)
  cellClass?: (r: T) => string
  title?: string
  /** Inline edit (double-click). Numbers are parsed by the caller. */
  editable?: boolean
  sticky?: boolean
  width?: string
}

export function DataGrid<T>({
  rows, cols, exportName, exportSheet, rowKey, pageSize = 50, onEdit, isEdited, toolbar, empty,
}: {
  rows: T[]
  cols: GridCol<T>[]
  exportName: string
  exportSheet: string
  rowKey: (r: T, i: number) => string
  pageSize?: number
  onEdit?: (r: T, col: GridCol<T>, raw: string) => void
  isEdited?: (r: T, col: GridCol<T>) => Cell | undefined
  toolbar?: React.ReactNode
  empty?: React.ReactNode
}) {
  const [page, setPage] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  useEffect(() => { if (page >= pages) setPage(0) }, [page, pages])
  const shown = rows.slice(page * pageSize, page * pageSize + pageSize)

  const totals = useMemo(() => cols.map((c) => {
    if (!c.total) return null
    if (c.total === "sum") {
      let s = 0, any = false
      for (const r of rows) {
        const v = c.get(r)
        if (typeof v === "number" && Number.isFinite(v)) { s += v; any = true }
      }
      return any ? s : null
    }
    return c.total(rows)
  }), [rows, cols])
  const hasTotals = totals.some((t) => t != null)

  const exportRows = (): ExportRow[] => rows.map((r) => {
    const o: ExportRow = {}
    for (const c of cols) {
      const v = c.get(r)
      o[c.label] = typeof v === "number" ? (Number.isFinite(v) ? v : null) : (v ?? null)
    }
    return o
  })

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">{toolbar}</div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">{rows.length.toLocaleString("en-IN")} rows</span>
          <ExportButton filename={exportName} sheets={() => [{ name: exportSheet, rows: exportRows() }]} />
        </div>
      </div>
      <div className="max-h-[65vh] overflow-auto rounded-lg border">
        <table className="w-full border-collapse text-xs tabular-nums">
          <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
            <tr>
              {cols.map((c) => (
                <th key={c.key} title={c.title}
                  className={cn("whitespace-nowrap border-b px-2 py-2 text-left font-semibold text-muted-foreground",
                    c.fmt && c.fmt !== "text" && "text-right", c.sticky && "sticky left-0 z-20 bg-muted")}
                  style={c.width ? { minWidth: c.width } : undefined}>
                  {c.label}{c.editable && <Pencil className="ml-1 inline h-2.5 w-2.5 opacity-50" />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const rk = rowKey(r, page * pageSize + i)
              return (
                <tr key={rk} className="border-b border-border/40 hover:bg-muted/30">
                  {cols.map((c) => {
                    const v = c.get(r)
                    const id = `${rk}::${c.key}`
                    const orig = isEdited?.(r, c)
                    const numeric = c.fmt && c.fmt !== "text"
                    return (
                      <td key={c.key}
                        className={cn("whitespace-nowrap px-2 py-1", numeric && "text-right",
                          c.sticky && "sticky left-0 bg-card", c.cellClass?.(r),
                          orig !== undefined && "bg-sky-500/15 font-medium",
                          c.editable && onEdit && "cursor-text")}
                        title={orig !== undefined ? `Edited — was ${orig ?? "(blank)"}` : undefined}
                        onDoubleClick={() => c.editable && onEdit && setEditing(id)}>
                        {editing === id ? (
                          <input autoFocus defaultValue={v == null ? "" : String(v)}
                            className="w-full min-w-[5rem] rounded border border-sky-500 bg-background px-1 text-right"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur()
                              if (e.key === "Escape") setEditing(null)
                            }}
                            onBlur={(e) => {
                              setEditing(null)
                              if (e.target.value !== (v == null ? "" : String(v))) onEdit!(r, c, e.target.value)
                            }} />
                        ) : fmt(v, c.fmt)}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {!rows.length && (
              <tr><td colSpan={cols.length} className="py-10 text-center text-sm text-muted-foreground">{empty ?? "No rows match the filters."}</td></tr>
            )}
          </tbody>
          {hasTotals && rows.length > 0 && (
            <tfoot className="sticky bottom-0 bg-muted/95 font-semibold backdrop-blur">
              <tr>
                {cols.map((c, i) => (
                  <td key={c.key} className={cn("whitespace-nowrap border-t px-2 py-1.5", c.fmt && c.fmt !== "text" && "text-right",
                    c.sticky && "sticky left-0 bg-muted")}>
                    {i === 0 ? "Total" : fmt(totals[i], c.fmt)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs">
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
          <span className="tabular-nums">Page {page + 1} of {pages}</span>
          <Button size="sm" variant="outline" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
        </div>
      )}
    </div>
  )
}

/** Secondary nav used inside the module (pill buttons). */
export function SubNav<T extends string>({ items, value, onChange }: {
  items: { id: T; label: string; badge?: React.ReactNode }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((it) => (
        <button key={it.id} type="button" onClick={() => onChange(it.id)}
          className={cn("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
            value === it.id ? "border-primary/50 bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:bg-muted/50")}>
          {it.label}{it.badge}
        </button>
      ))}
    </div>
  )
}
