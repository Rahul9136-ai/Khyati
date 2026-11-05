import { useMemo, useState } from "react"

import { Select } from "@/components/ui/select"
import { type DataException, type ExceptionCode, countByCode } from "@/lib/capacity/engine"
import { parseMonth } from "@/lib/capacity/normalize"
import { cn } from "@/lib/utils"

import { passes, useCap } from "./ctx"
import { DataGrid, FilterBar, type GridCol } from "./shared"

const LABEL: Record<ExceptionCode, string> = {
  "forecast-task-missing": "Forecast TASK_NUMBER not in Target Details",
  "forecast-duplicate": "Duplicate Forecast TASK_NUMBER + Location",
  "job-not-in-designation": "Job Name missing from Designation Type",
  "approved-typo": "Apprvoed typo in Approved Status",
  "no-budget-month": "No budget (Buffer / Attrition / QCA %) for key-months",
  "hiring-before-horizon": "Hiring due before the forecast starts",
  "hiring-after-horizon": "Hiring due after the forecast ends",
  "additional-billing": "Additional Billing - Flat Rate (money values)",
  "spelling-variant": "Location / Service Line spelling variants",
  "unknown-location": "Location not in the location map",
  "unparsable-month": "Unparsable month",
  "div-by-zero": "Division by zero",
  "missing-lookup": "Missing lookup",
  "peak-target-invalid": "Peak Target Prod is 0 / blank",
  "missing-dop": "Date of Production missing",
  "non-numeric": "Value is not a number",
  "sno-gap": "Hiring S.No gap",
  "hiring-designation-missing": "Hiring Designation missing from Designation Type",
  "duplicate-lookup": "Duplicate lookup row",
  "hiring-not-approved": "Hiring row not Approved + OPEN",
}

/** Counts stated in build prompt §5 for the sample file. */
const SPEC_COUNT: Partial<Record<ExceptionCode, number>> = {
  "forecast-task-missing": 7, "forecast-duplicate": 5, "job-not-in-designation": 4, "approved-typo": 56,
  "hiring-before-horizon": 37, "additional-billing": 5,
}

const SEV_CLASS = { error: "text-destructive", warning: "text-amber-600", info: "text-muted-foreground" }

export function ExceptionsView() {
  const { result, filters } = useCap()
  const [code, setCode] = useState<string>("")
  const [sev, setSev] = useState<string>("")
  const counts = useMemo(() => countByCode(result.exceptions), [result.exceptions])

  const rows = useMemo(() => result.exceptions.filter((e) =>
    (!code || e.code === code) && (!sev || e.severity === sev)
    && passes(filters, { customer: e.customer, serviceLine: e.serviceLine, location: e.location,
      month: e.month ? (parseMonth(e.month) ?? undefined) : undefined })), [result.exceptions, code, sev, filters])

  const cols: GridCol<DataException>[] = [
    { key: "sev", label: "Severity", get: (e) => e.severity, fmt: "text", cellClass: (e) => cn("font-semibold uppercase", SEV_CLASS[e.severity]) },
    { key: "sheet", label: "Source sheet", get: (e) => e.sheet, fmt: "text" },
    { key: "row", label: "Row #", get: (e) => e.row, fmt: "int" },
    { key: "issue", label: "Issue", get: (e) => e.issue, fmt: "text" },
    { key: "value", label: "Value", get: (e) => e.value, fmt: "text" },
    { key: "action", label: "Action taken", get: (e) => e.action, fmt: "text" },
    { key: "cust", label: "Customer", get: (e) => e.customer ?? "", fmt: "text" },
    { key: "sl", label: "Service Line", get: (e) => e.serviceLine ?? "", fmt: "text" },
    { key: "loc", label: "Location", get: (e) => e.location ?? "", fmt: "text" },
    { key: "type", label: "Type", get: (e) => LABEL[e.code], fmt: "text" },
  ]

  const codes = Object.keys(LABEL) as ExceptionCode[]
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {codes.filter((c) => counts[c] || SPEC_COUNT[c] !== undefined).map((c) => {
          const n = counts[c] ?? 0
          const spec = SPEC_COUNT[c]
          return (
            <button key={c} type="button" onClick={() => setCode(code === c ? "" : c)}
              className={cn("rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                code === c ? "border-primary/60 bg-primary/5" : "hover:bg-muted/40")}>
              <div className="font-medium">{LABEL[c]}</div>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span className="text-lg font-semibold tabular-nums">{n}</span>
                {spec !== undefined && (
                  <span className={n === spec ? "text-emerald-600" : "text-amber-600"}>
                    spec: {spec} {n === spec ? "✓" : "≠"}
                  </span>
                )}
              </div>
            </button>
          )
        })}
      </div>
      <DataGrid rows={rows} cols={cols} rowKey={(_, i) => String(i)} exportName="capacity-data-exceptions" exportSheet="Data Exceptions"
        toolbar={<>
          <FilterBar />
          <Select value={code} onChange={(e) => setCode(e.target.value)} className="h-8 text-xs"
            options={[{ value: "", label: "All issue types" }, ...codes.filter((c) => counts[c]).map((c) => ({ value: c, label: `${LABEL[c]} (${counts[c]})` }))]} />
          <Select value={sev} onChange={(e) => setSev(e.target.value)} className="h-8 text-xs"
            options={[{ value: "", label: "All severities" }, { value: "error", label: "Errors" }, { value: "warning", label: "Warnings" }, { value: "info", label: "Info" }]} />
        </>}
        empty="No exceptions match." />
    </div>
  )
}
