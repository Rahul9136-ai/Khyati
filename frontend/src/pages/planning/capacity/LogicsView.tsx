import { CheckCircle2, RotateCcw, XCircle } from "lucide-react"
import { useMemo, useState } from "react"

import { ExportButton } from "@/components/export-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { countByCode } from "@/lib/capacity/engine"
import { type CalcInputs, GOLDEN_CASES, GOLDEN_INPUTS, goldenPass, runCalculator } from "@/lib/capacity/golden"
import { SHEETS } from "@/lib/capacity/schema"
import { useCapacity } from "@/lib/capacity/store"
import { cn } from "@/lib/utils"

import { useCap } from "./ctx"

type Field = { k: keyof CalcInputs; label: string; pct?: boolean }

const PROD_FIELDS: Field[] = [
  { k: "volume", label: "Forecasted Volume" }, { k: "peak", label: "Peak target" }, { k: "wdays", label: "W.days" },
  { k: "shrinkB", label: "Shrinkage B", pct: true }, { k: "shrinkA", label: "Shrinkage A", pct: true },
  { k: "glideB", label: "Glide B", pct: true }, { k: "glideA", label: "Glide A", pct: true },
  { k: "growth", label: "Growth buffer", pct: true }, { k: "actualHc", label: "Actual HC" },
  { k: "attrB", label: "Attrition B", pct: true }, { k: "attrA", label: "Attrition A", pct: true },
  { k: "snp", label: "SNP", pct: true }, { k: "addition", label: "Addition" },
]
const QCA_FIELDS: Field[] = [
  { k: "budgetQcaPct", label: "Budgeted QCA %", pct: true }, { k: "actualQa", label: "Actual QA" },
  { k: "qcaAttrB", label: "Attrition B", pct: true }, { k: "qcaAttrA", label: "Attrition A", pct: true },
  { k: "qcaSnp", label: "SNP", pct: true }, { k: "qcaAddition", label: "Addition" },
]
const VOL_FIELDS: Field[] = [
  { k: "vVolume", label: "Forecasted Volume" }, { k: "vActualHc", label: "Actual HC" },
  { k: "rampTrainee", label: "Ramp Trainee" }, { k: "rampLateral", label: "Ramp Lateral" },
  { k: "rampUnitsPerDay", label: "Ramp units/day (sheet: 15)" }, { k: "vPeak", label: "Peak target" },
  { k: "vWdays", label: "W.days" }, { k: "vShrinkage", label: "Shrinkage", pct: true },
  { k: "samplingPct", label: "Sampling % (sheet: 18%)", pct: true }, { k: "actualQca", label: "Actual QCA" },
  { k: "peakQca", label: "QCA peak target" },
]

const SECTION_OF: Record<string, Field[]> = {
  "HC Based – Production": PROD_FIELDS, "HC Based – QCA": QCA_FIELDS, "Volume Based": VOL_FIELDS,
}
const FORMULA_TEXT: Record<string, string> = {
  "Base FTE": "Volume ÷ W.days ÷ Peak", "Shrinkage % = MIN(0.10, 0.06)": "MIN(B, A)", "Glide % = MIN(0.06, 0.10)": "MIN(B, A)",
  "Overall Buffer": "Shrinkage + Glide + Growth", "Buffer HC": "Base FTE × Overall Buffer", "Req HC Prod": "Base FTE + Buffer HC",
  "Attrition % = MAX(0.11, 0.15)": "MAX(B, A)", "Attrition HC": "Actual HC × Attrition %", "Projected HC": "Actual HC − Attrition HC + Addition",
  "Capacity %": "Projected ÷ Req", VA: "Projected − Req", "Projected Prod HC": "= P16", "Req QCA": "Projected Prod HC × Budgeted QCA %",
  "Attrition %": "MAX(B, A)", "Attrition HC (= QA × SNP)": "Actual QA × SNP (switch Q3)", "Projected QCA": "Actual QA − Attrition HC + Addition",
  "QCA Capacity %": "Projected QCA ÷ Req QCA  /  QCA Production ÷ To Be Audited", "QCA VA": "Projected QCA − Req QCA",
  "Total Ramp HC": "Trainee + Lateral", "Ramp Production (15 × 15 × 21)": "Ramp HC × units/day × W.days", "BAU HC": "Actual HC − Ramp HC",
  "BAU Production (75 × 24 × 21)": "BAU HC × Peak × W.days", "Raw Production": "Ramp + BAU production",
  "Actual Productivity (× 0.94)": "Raw × (1 − Shrinkage)", "VA units": "Actual Productivity − Forecast", "VA HC": "VA units ÷ Peak ÷ W.days",
  "To Be Audited": "Actual Productivity × Sampling %", "QCA Production (2 × 100 × 21)": "Actual QCA × QCA peak × W.days",
}

export function LogicsView() {
  const [inputs, setInputs] = useState<CalcInputs>(GOLDEN_INPUTS)
  const live = useMemo(() => runCalculator(inputs), [inputs])
  const isGolden = JSON.stringify(inputs) === JSON.stringify(GOLDEN_INPUTS)
  const report = useTestReport()

  const field = (f: Field) => (
    <label key={f.k} className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{f.label}</span>
      <input type="number" step="any" value={String(inputs[f.k])}
        className="h-7 w-24 rounded border border-sky-500/30 bg-sky-500/5 px-1.5 text-right tabular-nums"
        onChange={(e) => { const v = parseFloat(e.target.value); setInputs({ ...inputs, [f.k]: Number.isNaN(v) ? 0 : v }) }} />
    </label>
  )

  const sections = ["HC Based – Production", "HC Based – QCA", "Volume Based"] as const
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          The sheet "Calculation &amp; Logics" as a live calculator, run through the <b>same formula code</b> as the Calculations sub-tabs.
          Pre-filled with the sheet's values; change any blue input to see the outputs move.
        </p>
        <div className="flex items-center gap-2">
          {!isGolden && <Button size="sm" variant="outline" onClick={() => setInputs(GOLDEN_INPUTS)}><RotateCcw className="h-3.5 w-3.5" /> Reset to sheet values</Button>}
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">QCA attrition (Q3)</span>
            <select value={inputs.qcaMode} onChange={(e) => setInputs({ ...inputs, qcaMode: e.target.value as "snp" | "attrition" })}
              className="h-7 rounded border bg-background px-1 text-xs">
              <option value="snp">QA × SNP (sheet)</option><option value="attrition">QA × Attrition %</option>
            </select>
          </label>
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        {sections.map((s) => (
          <Card key={s} className="glass">
            <CardHeader className="pb-2"><CardTitle className="text-sm">{s}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-1.5">{SECTION_OF[s].map(field)}</div>
              <table className="w-full text-xs tabular-nums">
                <thead><tr className="border-b text-muted-foreground">
                  <th className="py-1 text-left font-medium">Output</th><th className="pl-3 text-right font-medium">Value</th>
                  <th className="pl-3 text-right font-medium">Expected</th><th className="w-5" />
                </tr></thead>
                <tbody>
                  {GOLDEN_CASES.filter((c) => c.section === s).map((c) => {
                    const v = c.actual(live)
                    const pass = goldenPass(c, v)
                    return (
                      <tr key={c.label} className="border-b border-border/40" title={FORMULA_TEXT[c.label]}>
                        <td className="py-1 pr-2">{c.label}<div className="text-[10px] text-muted-foreground">{FORMULA_TEXT[c.label]}</div></td>
                        <td className="pl-3 text-right font-semibold">{v == null ? "(blank)" : v.toFixed(Math.max(4, c.dp))}</td>
                        <td className="pl-3 text-right text-muted-foreground">{isGolden ? c.expected : "—"}</td>
                        <td className="pl-1 text-right">{isGolden && (pass ? <CheckCircle2 className="inline h-3.5 w-3.5 text-emerald-600" /> : <XCircle className="inline h-3.5 w-3.5 text-destructive" />)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="glass">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            Test report
            <Badge variant={report.every((r) => r.pass) ? "success" : "destructive"}>
              {report.filter((r) => r.pass).length} / {report.length} pass
            </Badge>
          </CardTitle>
          <ExportButton filename="capacity-test-report" label="Download report" sheets={() => [{
            name: "Test report",
            rows: report.map((r) => ({ Section: r.section, Case: r.label, Expected: r.expected, Actual: r.actual, Result: r.pass ? "PASS" : "FAIL" })),
          }]} />
        </CardHeader>
        <CardContent>
          <p className="mb-2 text-xs text-muted-foreground">
            Golden cases always run on the sheet's values (independent of the calculator above), compared to 4 dp or better. Data checks run on the workbook currently loaded.
          </p>
          <div className="max-h-[50vh] overflow-auto rounded border">
            <table className="w-full text-xs tabular-nums">
              <thead className="sticky top-0 bg-muted"><tr className="text-left text-muted-foreground">
                <th className="px-2 py-1.5">Section</th><th className="px-2">Case</th><th className="px-2 text-right">Expected</th>
                <th className="px-2 text-right">Actual</th><th className="px-2">Result</th>
              </tr></thead>
              <tbody>
                {report.map((r, i) => (
                  <tr key={i} className="border-t border-border/40">
                    <td className="px-2 py-1 text-muted-foreground">{r.section}</td>
                    <td className="px-2">{r.label}</td>
                    <td className="px-2 text-right">{String(r.expected)}</td>
                    <td className="px-2 text-right">{String(r.actual)}</td>
                    <td className={cn("px-2 font-semibold", r.pass ? "text-emerald-600" : "text-destructive")}>{r.pass ? "PASS" : "FAIL"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/** Golden cases + checks on the loaded workbook (row counts, exception counts, reconciliation, no NaN). */
function useTestReport() {
  const { result } = useCap()
  const dataset = useCapacity((s) => s.dataset)
  return useMemo(() => {
    const out: { section: string; label: string; expected: string | number | null; actual: string | number | null; pass: boolean }[] = []
    const g = runCalculator(GOLDEN_INPUTS)
    for (const c of GOLDEN_CASES) {
      const v = c.actual(g)
      out.push({ section: c.section, label: c.label, expected: c.expected === null ? "(blank)" : c.expected,
        actual: v == null ? "(blank)" : +v.toFixed(Math.max(6, c.dp)), pass: goldenPass(c, v) })
    }
    const loaded = SHEETS.filter((s) => dataset[s.id])
    if (!loaded.length) return out
    for (const s of SHEETS)
      out.push({ section: "Data: row counts", label: s.label, expected: s.expectedRows, actual: dataset[s.id]?.rows.length ?? "not loaded",
        pass: dataset[s.id]?.rows.length === s.expectedRows })
    const sno = dataset.hiring?.rows.map((r) => r["S.No"]) ?? []
    out.push({ section: "Data: Hiring", label: "S.No runs 1…N with no gaps", expected: `1…${sno.length}`,
      actual: sno.every((v, i) => v === i + 1) ? `1…${sno.length}` : "gap found", pass: sno.length > 0 && sno.every((v, i) => v === i + 1) })
    const codes = countByCode(result.exceptions)
    const exp: [string, string, number][] = [
      ["forecast-task-missing", "Forecast TASK_NUMBER not in Target Details", 7], ["forecast-duplicate", "Duplicate Forecast TASK_NUMBER + Location (pairs)", 5],
      ["job-not-in-designation", "Job Name missing from Designation Type", 4], ["approved-typo", "Apprvoed typo", 56],
      ["hiring-before-horizon", "Hiring due before Sep'26", 37], ["additional-billing", "Additional Billing - Flat Rate rows", 5],
    ]
    for (const [code, label, n] of exp)
      out.push({ section: "Data: exceptions (§5)", label, expected: n, actual: codes[code] ?? 0, pass: (codes[code] ?? 0) === n })
    let bad = 0
    for (const r of result.rows)
      for (const v of [r.baseFte, r.prod.reqHcProd, r.prod.capacityPct, r.prod.va, r.qca.capacityPct, r.qca.va, r.vol.capacityPct, r.vol.vaHc, r.vol.qcaCapacityPct])
        if (v != null && !Number.isFinite(v)) bad++
    out.push({ section: "Data: integrity", label: "No NaN / Infinity in results", expected: 0, actual: bad, pass: bad === 0 })
    const m0 = result.months[0]
    const hc = result.rows.filter((r) => r.month === m0).reduce((s, r) => s + r.actualHc, 0)
    out.push({ section: "Data: reconciliation", label: "Σ Actual HC (one month) = User Mapping ACTIVE Prod + Trainee", expected: result.counts.rosterProd.length, actual: hc, pass: hc === result.counts.rosterProd.length })
    const adds = result.rows.reduce((s, r) => s + r.additionProd + r.additionQca, 0)
    const hires = result.counts.hiring.filter((h) => h.inHorizon).reduce((s, h) => s + h.opening, 0)
    out.push({ section: "Data: reconciliation", label: "Σ Additions = Hiring Openings (Approved + OPEN, in horizon)", expected: hires, actual: adds, pass: adds === hires })
    return out
  }, [result, dataset])
}

