import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, Trash2, Upload } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { runEngine } from "@/lib/capacity/engine"
import { SHEETS, SHEET_BY_ID } from "@/lib/capacity/schema"
import { useCapacity } from "@/lib/capacity/store"
import { useWfm } from "@/store/wfm"

import { ExceptionsView } from "./ExceptionsView"
import { InputsView } from "./InputsView"
import { LogicsView } from "./LogicsView"
import { CalculationsView, SummaryView } from "./ResultsViews"
import { CapacityCtx, EMPTY_FILTERS, type Filters } from "./ctx"
import { SubNav } from "./shared"
import { SwitchesView } from "./SwitchesView"

type View = "inputs" | "calc" | "summary" | "logics" | "exceptions" | "switches" | "lob"
const VIEWS: View[] = ["inputs", "calc", "summary", "logics", "exceptions", "switches", "lob"]

/**
 * Capacity Planning (East Division workbook model). Mirrors
 * "Aforce - Sample data - East Division-v1.xlsx": 14 input sheets, 3 calculation
 * sheets, Summary, the Calculation & Logics calculator and Data Exceptions.
 * `legacy` is the LOB monthly plan that used to be the whole tab — kept as-is.
 */
export function CapacityModule({ legacy }: { legacy: React.ReactNode }) {
  const hydrate = useCapacity((s) => s.hydrate)
  const hydrated = useCapacity((s) => s.hydrated)
  const dataset = useCapacity((s) => s.dataset)
  const config = useCapacity((s) => s.config)
  const lastImport = useCapacity((s) => s.lastImport)
  const busy = useCapacity((s) => s.busy)
  const importFile = useCapacity((s) => s.importFile)
  const clearData = useCapacity((s) => s.clearData)
  const canEdit = useWfm((s) => s.can("planning", "edit"))
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const fileRef = useRef<HTMLInputElement>(null)

  const [params, setParams] = useSearchParams()
  const raw = params.get("cp") as View | null
  const view: View = raw && VIEWS.includes(raw) ? raw : "summary"
  const setView = (v: View) => setParams((prev) => {
    const p = new URLSearchParams(prev)
    p.set("cp", v)
    return p
  }, { replace: true })

  useEffect(() => { void hydrate() }, [hydrate])

  const result = useMemo(() => runEngine(dataset, config), [dataset, config])
  const loaded = SHEETS.filter((s) => dataset[s.id]).length
  const hasData = loaded > 0
  const errorCount = result.exceptions.filter((e) => e.severity === "error").length
  const warningCount = result.exceptions.filter((e) => e.severity === "warning").length
  const blankRows = result.rows.filter((r) => r.baseFte == null).length

  async function onFile(f: File | undefined) {
    if (!f) return
    await importFile(f)
    if (fileRef.current) fileRef.current.value = ""
  }

  const shownView: View = !hasData && view !== "lob" && view !== "logics" && view !== "switches" ? "inputs" : view

  return (
    <CapacityCtx.Provider value={{ result, filters, setFilters, canEdit }}>
      <div className="space-y-4">
        <Card className="glass">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex items-center gap-3">
              <FileSpreadsheet className="h-5 w-5 text-primary" />
              <div className="text-sm">
                <div className="font-semibold">Capacity Planning — East Division model</div>
                <div className="text-xs text-muted-foreground">
                  {!hydrated ? "Loading saved data…"
                    : hasData ? <>
                        {loaded}/14 inputs loaded{lastImport && <> from <b>{lastImport.fileName}</b> · {new Date(lastImport.at).toLocaleString()}</>}
                        {" · "}{result.rows.length.toLocaleString("en-IN")} calculated rows · {result.months.length} months
                      </>
                    : "No workbook loaded yet. Import the Excel workbook (all 14 sheets) to build the plan."}
                </div>
              </div>
              {hasData && (
                <button type="button" onClick={() => setView("exceptions")} className="shrink-0 whitespace-nowrap"
                  title="Data issues found in the workbook — open Data Exceptions">
                  {errorCount > 0
                    ? <Badge variant="destructive" className="whitespace-nowrap"><AlertTriangle className="h-3 w-3" />
                        {blankRows} row{blankRows === 1 ? "" : "s"} can't be calculated · {warningCount} data warnings</Badge>
                    : <Badge variant="success" className="whitespace-nowrap"><CheckCircle2 className="h-3 w-3" />
                        All rows calculated · {warningCount} data warnings</Badge>}
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {canEdit && (
                <>
                  <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.xls" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
                  <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Import workbook
                  </Button>
                  {hasData && (
                    <Button size="sm" variant="outline" onClick={() => { if (window.confirm("Remove the imported workbook and all edits from this browser?")) clearData() }}>
                      <Trash2 className="h-3.5 w-3.5" /> Clear
                    </Button>
                  )}
                </>
              )}
            </div>
          </CardContent>
          {lastImport && (lastImport.errors.length > 0 || lastImport.missing.length > 0) && (
            <CardContent className="space-y-1 pt-0 text-xs">
              {lastImport.errors.map((e, i) => <p key={i} className="text-destructive">✕ {e.message}</p>)}
              {lastImport.missing.length > 0 && (
                <p className="text-amber-600">Not found in {lastImport.fileName}: {lastImport.missing.map((m) => SHEET_BY_ID[m].label).join(", ")}</p>
              )}
            </CardContent>
          )}
        </Card>

        <SubNav value={shownView} onChange={setView} items={[
          { id: "inputs", label: "Inputs" },
          { id: "calc", label: "Calculations" },
          { id: "summary", label: "Summary" },
          { id: "logics", label: "Calculation & Logics" },
          { id: "exceptions", label: "Data Exceptions", badge: hasData ? <span className="text-[10px] opacity-70">{result.exceptions.length}</span> : undefined },
          { id: "switches", label: "Switches (§7)" },
          { id: "lob", label: "LOB monthly plan" },
        ]} />

        {shownView === "inputs" && <InputsView />}
        {shownView === "calc" && <CalculationsView />}
        {shownView === "summary" && <SummaryView />}
        {shownView === "logics" && <LogicsView />}
        {shownView === "exceptions" && <ExceptionsView />}
        {shownView === "switches" && <SwitchesView canEdit={canEdit} />}
        {shownView === "lob" && legacy}
      </div>
    </CapacityCtx.Provider>
  )
}
