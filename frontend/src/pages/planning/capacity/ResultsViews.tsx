import { CheckCircle2, XCircle } from "lucide-react"
import { useMemo, useState } from "react"
import {
  Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { ResultRow } from "@/lib/capacity/engine"
import { safeDiv } from "@/lib/capacity/formulas"
import { monthLabel } from "@/lib/capacity/normalize"
import { useCapacity } from "@/lib/capacity/store"
import { cn } from "@/lib/utils"

import { capacityTone, fmt, passes, useCap } from "./ctx"
import { DataGrid, FilterBar, type GridCol, SubNav } from "./shared"

const KEY_COLS: GridCol<ResultRow>[] = [
  { key: "customer", label: "Customer", get: (r) => r.customer, fmt: "text", sticky: true },
  { key: "sl", label: "Service Line", get: (r) => r.serviceLine, fmt: "text" },
  { key: "loc", label: "Location", get: (r) => r.location, fmt: "text" },
  { key: "month", label: "Month", get: (r) => r.monthLabel, fmt: "text" },
]

/** Σ numerator ÷ Σ denominator over rows where the ratio exists — the honest total for a % column. */
const ratioTotal = (num: (r: ResultRow) => number | null, den: (r: ResultRow) => number | null) => (rows: ResultRow[]) => {
  let n = 0, d = 0
  for (const r of rows) {
    const a = num(r), b = den(r)
    if (a != null && b != null && b !== 0) { n += a; d += b }
  }
  return safeDiv(n, d)
}

function useFilteredRows(): ResultRow[] {
  const { result, filters } = useCap()
  return useMemo(() => result.rows.filter((r) => passes(filters, r)), [result.rows, filters])
}

const flagCol: GridCol<ResultRow> = {
  key: "flags", label: "Flags", fmt: "text",
  get: (r) => [r.baseFteBlankReason ? `Base FTE blank: ${r.baseFteBlankReason}` : null, ...r.flags.filter((f) => !r.baseFteBlankReason || !f.includes("no peak"))]
    .filter(Boolean).join(" · "),
  cellClass: (r) => (r.baseFteBlankReason ? "text-destructive" : r.flags.length ? "text-amber-600" : ""),
}

export function CalculationsView() {
  const [tab, setTab] = useState<"prod" | "qca" | "vol">("prod")
  const rows = useFilteredRows()
  const cfg = useCapacity((s) => s.config)
  const tone = (v: number | null) => capacityTone(v, cfg.thresholdLow, cfg.thresholdHigh)

  const prodCols: GridCol<ResultRow>[] = [
    ...KEY_COLS,
    { key: "p1", label: "P1 Forecasted Volume", get: (r) => r.forecastVolume, fmt: "num", total: "sum" },
    { key: "p2", label: "P2 Peak Target (wtd)", get: (r) => r.peakTarget, fmt: "hc", title: "Volume-weighted: Σ Volume ÷ Σ (Volume ÷ Peak)" },
    { key: "p3", label: "P3 W.days", get: (r) => r.wdays, fmt: "int" },
    { key: "p4", label: "P4 Base FTE", get: (r) => r.baseFte, fmt: "hc", total: "sum", title: "Σ per task: Volume ÷ W.days ÷ Peak (per BILL_TYPE, §7 Q1)" },
    { key: "shB", label: "Shrinkage B", get: (r) => r.shrinkB, fmt: "pct" },
    { key: "shA", label: "Shrinkage A", get: (r) => r.shrinkA, fmt: "pct" },
    { key: "p5", label: "P5 Shrinkage % MIN", get: (r) => r.prod.shrinkage, fmt: "pct" },
    { key: "glB", label: "Glide B", get: (r) => r.glideB, fmt: "pct" },
    { key: "glA", label: "Glide A", get: (r) => r.glideA, fmt: "pct" },
    { key: "p6", label: "P6 Glide % MIN", get: (r) => r.prod.glide, fmt: "pct" },
    { key: "p7", label: "P7 Growth %", get: (r) => r.prod.growth, fmt: "pct" },
    { key: "p8", label: "P8 Overall Buffer %", get: (r) => r.prod.overallBuffer, fmt: "pct" },
    { key: "p9", label: "P9 Buffer HC", get: (r) => r.prod.bufferHc, fmt: "hc", total: "sum" },
    { key: "p10", label: "P10 Req HC Prod", get: (r) => r.prod.reqHcProd, fmt: "hc", total: "sum" },
    { key: "p11", label: "P11 Actual HC", get: (r) => r.actualHc, fmt: "int", total: "sum" },
    { key: "atB", label: "Attrition B", get: (r) => r.attrB, fmt: "pct" },
    { key: "atA", label: "Attrition A (Prod)", get: (r) => r.attrProdA, fmt: "pct" },
    { key: "p12", label: "P12 Attrition % MAX", get: (r) => r.prod.attrition, fmt: "pct" },
    { key: "p13", label: "P13 SNP %", get: (r) => r.prod.snp, fmt: "pct" },
    { key: "p14", label: "P14 Attrition HC", get: (r) => r.prod.attritionHc, fmt: "hc", total: "sum" },
    { key: "p15", label: "P15 Addition", get: (r) => r.additionProd, fmt: "int", total: "sum" },
    { key: "p16", label: "P16 Projected HC", get: (r) => r.prod.projectedHc, fmt: "hc", total: "sum" },
    { key: "p17", label: "P17 Capacity %", get: (r) => r.prod.capacityPct, fmt: "pct", cellClass: (r) => tone(r.prod.capacityPct),
      total: ratioTotal((r) => r.prod.projectedHc, (r) => r.prod.reqHcProd) },
    { key: "p18", label: "P18 VA (HC)", get: (r) => r.prod.va, fmt: "hc", total: "sum" },
    flagCol,
  ]
  const qcaCols: GridCol<ResultRow>[] = [
    ...KEY_COLS,
    { key: "q1", label: "Q1 Budgeted QCA %", get: (r) => r.qca.budgetQcaPct, fmt: "pct" },
    { key: "q2", label: "Q2 Projected Prod HC", get: (r) => r.qca.projectedProdHc, fmt: "hc", total: "sum" },
    { key: "q3", label: "Q3 Req QCA", get: (r) => r.qca.reqQca, fmt: "hc", total: "sum" },
    { key: "q4", label: "Q4 Actual QA", get: (r) => r.actualQa, fmt: "int", total: "sum" },
    { key: "atB", label: "Attrition B", get: (r) => r.attrB, fmt: "pct" },
    { key: "atA", label: "Attrition A (QCA)", get: (r) => r.attrQcaA, fmt: "pct" },
    { key: "q5", label: "Q5 Attrition % MAX", get: (r) => r.qca.attrition, fmt: "pct" },
    { key: "q6", label: "Q6 SNP %", get: (r) => r.qca.snp, fmt: "pct" },
    { key: "q7", label: cfg.qcaAttritionMode === "snp" ? "Q7 Attrition HC (QA × SNP)" : "Q7 Attrition HC (QA × Attr %)", get: (r) => r.qca.attritionHc, fmt: "hc", total: "sum" },
    { key: "q8", label: "Q8 Addition (QCA)", get: (r) => r.additionQca, fmt: "int", total: "sum" },
    { key: "q9", label: "Q9 Projected QCA HC", get: (r) => r.qca.projectedQca, fmt: "hc", total: "sum" },
    { key: "q10", label: "Q10 QCA Capacity %", get: (r) => r.qca.capacityPct, fmt: "pct", cellClass: (r) => tone(r.qca.capacityPct),
      total: ratioTotal((r) => r.qca.projectedQca, (r) => r.qca.reqQca) },
    { key: "q11", label: "Q11 QCA VA", get: (r) => r.qca.va, fmt: "hc", total: "sum" },
    flagCol,
  ]
  const volCols: GridCol<ResultRow>[] = [
    ...KEY_COLS,
    { key: "v1", label: "V1 Forecasted Volume", get: (r) => r.vol.forecastVolume, fmt: "num", total: "sum" },
    { key: "v2", label: "V2 Actual HC", get: (r) => r.vol.actualHc, fmt: "int", total: "sum" },
    { key: "v3", label: "V3 Ramp HC – Trainee", get: (r) => r.vol.rampTrainee, fmt: "int", total: "sum" },
    { key: "v4", label: "V4 Ramp HC – Lateral", get: (r) => r.vol.rampLateral, fmt: "int", total: "sum" },
    { key: "v5", label: "V5 Total Ramp HC", get: (r) => r.vol.totalRampHc, fmt: "int", total: "sum" },
    { key: "v6", label: cfg.rampMode === "grid" ? "V6 Ramp Production (grid)" : `V6 Ramp Production (× ${cfg.rampFlatUnitsPerDay})`, get: (r) => r.vol.rampProduction, fmt: "num", total: "sum" },
    { key: "v7", label: "V7 BAU HC", get: (r) => r.vol.bauHc, fmt: "int", total: "sum" },
    { key: "pk", label: "Peak Target (wtd)", get: (r) => r.peakTarget, fmt: "hc" },
    { key: "wd", label: "W.days", get: (r) => r.wdays, fmt: "int" },
    { key: "v8", label: "V8 BAU Production", get: (r) => r.vol.bauProduction, fmt: "num", total: "sum" },
    { key: "v9", label: "V9 Raw Production", get: (r) => r.vol.rawProduction, fmt: "num", total: "sum" },
    { key: "v10", label: "V10 Actual Productivity", get: (r) => r.vol.actualProductivity, fmt: "num", total: "sum" },
    { key: "v11", label: "V11 Capacity %", get: (r) => r.vol.capacityPct, fmt: "pct", cellClass: (r) => tone(r.vol.capacityPct),
      total: ratioTotal((r) => r.vol.actualProductivity, (r) => r.vol.forecastVolume) },
    { key: "v12", label: "V12 VA (units)", get: (r) => r.vol.vaUnits, fmt: "num", total: "sum" },
    { key: "v13", label: "V13 VA (HC)", get: (r) => r.vol.vaHc, fmt: "hc", total: "sum" },
    { key: "v14", label: "V14 Sampling %", get: (r) => r.vol.samplingPct, fmt: "pct" },
    { key: "v15", label: "V15 To Be Audited", get: (r) => r.vol.toBeAudited, fmt: "num", total: "sum" },
    { key: "v16", label: "V16 Actual QCA", get: (r) => r.vol.actualQca, fmt: "int", total: "sum" },
    { key: "pq", label: "Peak Target QCA (wtd)", get: (r) => r.peakTargetQca, fmt: "hc" },
    { key: "v17", label: "V17 QCA Production", get: (r) => r.vol.qcaProduction, fmt: "num", total: "sum" },
    { key: "v18", label: "V18 QCA Capacity %", get: (r) => r.vol.qcaCapacityPct, fmt: "pct", cellClass: (r) => tone(r.vol.qcaCapacityPct),
      total: ratioTotal((r) => r.vol.qcaProduction, (r) => r.vol.toBeAudited) },
    flagCol,
  ]
  const cols = tab === "prod" ? prodCols : tab === "qca" ? qcaCols : volCols
  const name = tab === "prod" ? "HC Based – Production" : tab === "qca" ? "HC Based – QCA" : "Volume Based"

  return (
    <div className="space-y-3">
      <SubNav value={tab} onChange={setTab} items={[
        { id: "prod", label: "HC Based – Production" }, { id: "qca", label: "HC Based – QCA" }, { id: "vol", label: "Volume Based" },
      ]} />
      <DataGrid rows={rows} cols={cols} rowKey={(r) => `${r.key}|${r.month}`} exportName={`capacity-${tab}`} exportSheet={name}
        toolbar={<FilterBar />} empty="No calculated rows. Import the workbook, or clear the filters." />
    </div>
  )
}

export function SummaryView() {
  const { result, filters } = useCap()
  const rows = useFilteredRows()
  const cfg = useCapacity((s) => s.config)
  const tone = (v: number | null) => capacityTone(v, cfg.thresholdLow, cfg.thresholdHigh)

  const cols: GridCol<ResultRow>[] = [
    ...KEY_COLS,
    { key: "req", label: "Req HC Prod", get: (r) => r.prod.reqHcProd, fmt: "hc", total: "sum" },
    { key: "act", label: "Actual HC", get: (r) => r.actualHc, fmt: "int", total: "sum" },
    { key: "add", label: "Additions", get: (r) => r.additionProd + r.additionQca, fmt: "int", total: "sum" },
    { key: "proj", label: "Projected HC", get: (r) => r.prod.projectedHc, fmt: "hc", total: "sum" },
    { key: "cap", label: "Capacity %", get: (r) => r.prod.capacityPct, fmt: "pct", cellClass: (r) => tone(r.prod.capacityPct),
      total: ratioTotal((r) => r.prod.projectedHc, (r) => r.prod.reqHcProd) },
    { key: "va", label: "VA", get: (r) => r.prod.va, fmt: "hc", total: "sum" },
    { key: "rq", label: "Req QCA", get: (r) => r.qca.reqQca, fmt: "hc", total: "sum" },
    { key: "pq", label: "Projected QCA", get: (r) => r.qca.projectedQca, fmt: "hc", total: "sum" },
    { key: "qc", label: "QCA Capacity %", get: (r) => r.qca.capacityPct, fmt: "pct", cellClass: (r) => tone(r.qca.capacityPct),
      total: ratioTotal((r) => r.qca.projectedQca, (r) => r.qca.reqQca) },
    { key: "qva", label: "QCA VA", get: (r) => r.qca.va, fmt: "hc", total: "sum" },
    { key: "vc", label: "Volume Capacity %", get: (r) => r.vol.capacityPct, fmt: "pct", cellClass: (r) => tone(r.vol.capacityPct),
      total: ratioTotal((r) => r.vol.actualProductivity, (r) => r.vol.forecastVolume) },
    { key: "vu", label: "VA (units)", get: (r) => r.vol.vaUnits, fmt: "num", total: "sum" },
    { key: "vh", label: "VA (HC)", get: (r) => r.vol.vaHc, fmt: "hc", total: "sum" },
    flagCol,
  ]

  // per-month chart over the filtered keys
  const chart = useMemo(() => result.months.filter((m) => !filters.month || m === filters.month).map((m) => {
    const rs = rows.filter((r) => r.month === m)
    const req = rs.reduce((s, r) => s + (r.prod.reqHcProd ?? 0), 0)
    const proj = rs.reduce((s, r) => s + (r.prod.reqHcProd != null ? r.prod.projectedHc : 0), 0)
    return { month: monthLabel(m), "Req HC": +req.toFixed(2), "Projected HC": +proj.toFixed(2),
      "Capacity %": req > 0 ? +((proj / req) * 100).toFixed(2) : null }
  }), [rows, result.months, filters.month])

  // live reconciliation (§6 "Other required tests")
  const recon = useMemo(() => {
    const month = filters.month || result.months[0]
    const sumHc = rows.filter((r) => r.month === month).reduce((s, r) => s + r.actualHc, 0)
    const umHc = result.counts.rosterProd.filter((u) => passes({ ...filters, month: "" }, u)).length
    const sumQa = rows.filter((r) => r.month === month).reduce((s, r) => s + r.actualQa, 0)
    const umQa = result.counts.rosterQa.filter((u) => passes({ ...filters, month: "" }, u)).length
    const sumAdd = rows.reduce((s, r) => s + r.additionProd + r.additionQca, 0)
    const hiring = result.counts.hiring.filter((h) => h.inHorizon && passes(filters, { ...h, month: h.month ?? "" }))
      .reduce((s, h) => s + h.opening, 0)
    return [
      { label: `Actual HC in Summary (${month ? monthLabel(month) : "—"}) = User Mapping ACTIVE Production + Trainee`, a: sumHc, b: umHc },
      { label: `Actual QA in Summary (${month ? monthLabel(month) : "—"}) = User Mapping ACTIVE QA`, a: sumQa, b: umQa },
      { label: "Additions in Summary = Hiring Openings (Approved + OPEN, in horizon)", a: sumAdd, b: hiring },
    ]
  }, [rows, result, filters])

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="glass lg:col-span-2">
          <CardHeader className="pb-1"><CardTitle className="text-sm">Req HC vs Projected HC by month (filtered)</CardTitle></CardHeader>
          <CardContent style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="month" fontSize={11} />
                <YAxis yAxisId="hc" fontSize={11} />
                <YAxis yAxisId="pct" orientation="right" fontSize={11} unit="%" />
                <RTooltip />
                <Legend />
                <Bar yAxisId="hc" dataKey="Req HC" fill="#94a3b8" />
                <Bar yAxisId="hc" dataKey="Projected HC" fill="#0ea5e9" />
                <Line yAxisId="pct" type="monotone" dataKey="Capacity %" stroke="#10b981" dot />
              </ComposedChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card className="glass">
          <CardHeader className="pb-1"><CardTitle className="text-sm">Reconciliation checks</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs">
            {recon.map((c) => (
              <div key={c.label} className="flex items-start gap-2">
                {c.a === c.b ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />}
                <span>{c.label}: <b className="tabular-nums">{fmt(c.a, "int")}</b> vs <b className="tabular-nums">{fmt(c.b, "int")}</b></span>
              </div>
            ))}
            <p className="pt-1 text-muted-foreground">
              Colours: <span className={cn("rounded px-1", tone(0.9))}>&lt; {(cfg.thresholdLow * 100).toFixed(0)}%</span>{" "}
              <span className={cn("rounded px-1", tone(1))}>{(cfg.thresholdLow * 100).toFixed(0)}–{(cfg.thresholdHigh * 100).toFixed(0)}%</span>{" "}
              <span className={cn("rounded px-1", tone(2))}>&gt; {(cfg.thresholdHigh * 100).toFixed(0)}%</span>
            </p>
          </CardContent>
        </Card>
      </div>
      <DataGrid rows={rows} cols={cols} rowKey={(r) => `${r.key}|${r.month}`} exportName="capacity-summary" exportSheet="Summary"
        toolbar={<FilterBar />} empty="No rows. Import the workbook, or clear the filters." />
    </div>
  )
}
