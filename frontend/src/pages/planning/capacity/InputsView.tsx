import { CheckCircle2, FileUp, Info, TriangleAlert } from "lucide-react"
import { useMemo, useRef, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ratioOf } from "@/lib/capacity/engine"
import { keyOf, monthLabel, normApproved, normHiringType, num, parseMonth } from "@/lib/capacity/normalize"
import type { Cell, Row } from "@/lib/capacity/parse"
import { SHEETS, SHEET_BY_ID, type SheetId } from "@/lib/capacity/schema"
import { editKey, useCapacity } from "@/lib/capacity/store"

import { type Fmt, passes, useCap } from "./ctx"
import { DataGrid, FilterBar, type GridCol, SubNav } from "./shared"

/** Which column carries Customer / SL / Location / Month on each sheet (for the shared filters). */
const FILTER_COLS: Partial<Record<SheetId, { customer?: string; serviceLine?: string; location?: string; month?: string }>> = {
  userMapping: { customer: "Customer Name", serviceLine: "Service Line", location: "City" },
  forecast: { customer: "Customer Name", serviceLine: "SERVICE_LINE", location: "Location" },
  target: { customer: "Customer Name", serviceLine: "ServiceLine" },
  ramp: { customer: "Customer Name", serviceLine: "ServiceLine" },
  hiring: { customer: "Customer Name", serviceLine: "SL-As Per EM", location: "Location", month: "Due to delivery month" },
  budgetBuffer: { customer: "Customer Name", serviceLine: "SL", location: "Location", month: "Month" },
  actualShrinkage: { customer: "Customer Name", serviceLine: "Service Line", location: "Location" },
  actualAttrition: { customer: "Customer Name", serviceLine: "Vertical", location: "Location" },
  budgetAttrition: { customer: "Customer Name", serviceLine: "SL", location: "Location", month: "Month" },
  budgetQca: { customer: "Customer Name", serviceLine: "SL", month: "Month" },
  trainingDays: { customer: "Customer Name", serviceLine: "Vertical" },
  sampling: { customer: "Customer Name", serviceLine: "Service Line" },
  workingDays: { month: "Month" },
}

/** Columns whose totals mean something. */
const SUMMABLE = new Set(["Opening", "Base FTE", "Required FTE", "Buffer HC", "Shrinkage", "Prod Buffer",
  "Glidepath+Complexity+Review", "Growth Buffer", "Denominator", "Numerator", "Days"])

export function InputsView() {
  const dataset = useCapacity((s) => s.dataset)
  const edits = useCapacity((s) => s.edits)
  const editCell = useCapacity((s) => s.editCell)
  const importFile = useCapacity((s) => s.importFile)
  const { filters, canEdit } = useCap()
  const [sheet, setSheet] = useState<SheetId>("userMapping")
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const def = SHEET_BY_ID[sheet]
  const data = dataset[sheet]
  const fc = useMemo(() => FILTER_COLS[sheet] ?? {}, [sheet])

  // designation → user type, for the derived "User Type" columns
  const userType = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of dataset.designationType?.rows ?? []) {
      const k = keyOf(r["Designation"])
      if (!m.has(k)) m.set(k, String(r["User Type"] ?? ""))
    }
    return m
  }, [dataset.designationType])

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => passes(filters, {
    customer: fc.customer ? r[fc.customer] : undefined,
    serviceLine: fc.serviceLine ? r[fc.serviceLine] : undefined,
    location: fc.location ? r[fc.location] : undefined,
    month: fc.month ? parseMonth(r[fc.month]) : undefined,
  })), [data, filters, fc])

  const cols = useMemo((): GridCol<Row>[] => {
    if (!data) return []
    const typeOf = new Map(def.columns.map((c) => [c.name, c.type]))
    const fmtOf = (name: string): Fmt => {
      const t = typeOf.get(name)
      if (t === "pct") return "pct"
      if (t === "number") return "num"
      if (data.monthColumns?.includes(name)) return "num"
      return "text"
    }
    let names = data.columns
    if (sheet === "forecast" && filters.month)
      names = names.filter((n) => !data.monthColumns?.includes(n) || parseMonth(n.replace(/^units\s*_\s*/i, "")) === filters.month)
    const base: GridCol<Row>[] = [
      { key: "__row", label: "Row #", get: (r) => r.__row, fmt: "int", sticky: true },
      ...names.map((n): GridCol<Row> => ({
        key: n, label: n, get: (r) => r[n], fmt: fmtOf(n), editable: canEdit,
        total: SUMMABLE.has(n) || data.monthColumns?.includes(n) ? "sum" : undefined,
      })),
    ]
    const derived: GridCol<Row>[] = []
    if (sheet === "budgetAttrition")
      derived.push({ key: "attr", label: "Attrition % (= Numerator ÷ Denominator)", get: ratioOf, fmt: "pct", cellClass: () => "bg-emerald-500/5" })
    if (sheet === "budgetQca")
      derived.push({ key: "qca", label: "QCA % (= Numerator ÷ Denominator)", get: ratioOf, fmt: "pct", cellClass: () => "bg-emerald-500/5" })
    if (sheet === "hiring") {
      derived.push(
        { key: "typeN", label: "Type (normalised)", get: (r) => normHiringType(r["Type"]), fmt: "text", cellClass: () => "bg-emerald-500/5" },
        { key: "apprN", label: "Approved (normalised)", get: (r) => normApproved(r["Approved Status"]).value, fmt: "text",
          cellClass: (r) => normApproved(r["Approved Status"]).typo ? "bg-amber-500/15" : "bg-emerald-500/5" },
        { key: "ut", label: "User Type (Designation)", get: (r) => userType.get(keyOf(r["Designation"])) ?? "— not mapped", fmt: "text", cellClass: () => "bg-emerald-500/5" },
      )
    }
    if (sheet === "userMapping")
      derived.push({ key: "ut", label: "User Type (Designation)", get: (r) => userType.get(keyOf(r["Job Name"])) ?? "— not mapped", fmt: "text",
        cellClass: (r) => userType.has(keyOf(r["Job Name"])) ? "bg-emerald-500/5" : "bg-amber-500/15" })
    return [...base, ...derived]
  }, [data, def, sheet, canEdit, filters.month, userType])

  const onEdit = (r: Row, c: GridCol<Row>, raw: string) => {
    const type = def.columns.find((x) => x.name === c.key)?.type ?? (data?.monthColumns?.includes(c.key) ? "number" : "text")
    let v: Cell = raw.trim() === "" ? null : raw.trim()
    if (v != null && (type === "number" || type === "pct")) v = num(v) ?? v
    if (v != null && type === "month") { const m = parseMonth(v); v = m ? monthLabel(m) : v }
    editCell(sheet, r.__row, c.key, v)
  }

  const editedCount = Object.keys(edits).filter((k) => k.startsWith(`${sheet}:`)).length

  async function onFile(f: File | undefined) {
    if (!f) return
    const rep = await importFile(f, sheet)
    if (rep.errors.length) setMsg({ ok: false, text: rep.errors.map((e) => e.message).join(" ") })
    else if (!rep.loaded.length) setMsg({ ok: false, text: `No "${def.label}" sheet found in ${f.name}.` })
    else setMsg({ ok: true, text: `${def.label} replaced from ${f.name}: ${rep.loaded[0].rows} rows.` })
    if (fileRef.current) fileRef.current.value = ""
  }

  return (
    <div className="space-y-3">
      <SubNav value={sheet} onChange={(v) => { setSheet(v); setMsg(null) }}
        items={SHEETS.map((s) => {
          const n = dataset[s.id]?.rows.length
          return {
            id: s.id, label: s.label,
            badge: n == null ? <span className="text-[10px] text-destructive">·missing</span>
              : <span className={n === s.expectedRows ? "text-[10px] opacity-60" : "text-[10px] text-amber-600"}>{n}</span>,
          }
        })} />

      <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-dashed px-3 py-2 text-xs">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 font-medium">
            {def.label}
            {data && (data.rows.length === def.expectedRows
              ? <Badge variant="success"><CheckCircle2 className="h-3 w-3" /> {data.rows.length} rows</Badge>
              : <Badge variant="warning"><TriangleAlert className="h-3 w-3" /> {data.rows.length} rows (sample file: {def.expectedRows})</Badge>)}
            {editedCount > 0 && <Badge variant="default">{editedCount} edited cell{editedCount > 1 ? "s" : ""}</Badge>}
          </div>
          {def.note && <p className="flex items-center gap-1 text-muted-foreground"><Info className="h-3 w-3" /> {def.note}</p>}
          {data && <p className="text-muted-foreground">From {data.fileName} → sheet "{data.sheetName}" · header row {def.headerRow}{canEdit && " · double-click a cell to edit; Calculations and Summary update immediately"}</p>}
          {!fc.month && filters.month && <p className="text-muted-foreground">The Month filter doesn't apply to this sheet.</p>}
        </div>
        {canEdit && (
          <>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.xlsm,.csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}><FileUp className="h-3.5 w-3.5" /> Replace this sheet</Button>
          </>
        )}
      </div>
      {msg && <p className={msg.ok ? "text-xs text-emerald-600" : "text-xs text-destructive"}>{msg.text}</p>}

      {data ? (
        <DataGrid rows={rows} cols={cols} rowKey={(r) => String(r.__row)} exportName={`capacity-input-${sheet}`} exportSheet={def.label}
          onEdit={canEdit ? onEdit : undefined}
          isEdited={(r, c) => { const k = editKey(sheet, r.__row, c.key); return k in edits ? edits[k] : undefined }}
          toolbar={<FilterBar />} />
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">
          "{def.label}" isn't loaded. Import the workbook at the top, or use "Replace this sheet".
        </p>
      )}
    </div>
  )
}
