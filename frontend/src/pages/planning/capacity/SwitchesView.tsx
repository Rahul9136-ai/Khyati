import { RotateCcw } from "lucide-react"
import { useMemo } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ADDITIONAL_DECISIONS, type BillTreatment, type CapacityConfig, DEFAULT_CONFIG, SWITCH_DOCS, treatmentFor,
} from "@/lib/capacity/config"
import { useCapacity } from "@/lib/capacity/store"
import { cn } from "@/lib/utils"

const sel = "h-8 rounded-md border bg-background px-2 text-xs"
const numIn = "h-8 w-24 rounded-md border bg-background px-2 text-right text-xs tabular-nums"

export function SwitchesView({ canEdit }: { canEdit: boolean }) {
  const cfg = useCapacity((s) => s.config)
  const setConfig = useCapacity((s) => s.setConfig)
  const resetConfig = useCapacity((s) => s.resetConfig)
  const forecast = useCapacity((s) => s.dataset.forecast)
  const billTypes = useMemo(() => {
    const s = new Set(Object.keys(cfg.billTypeTreatment))
    for (const r of forecast?.rows ?? []) if (r["BILL_TYPE"]) s.add(String(r["BILL_TYPE"]))
    return [...s].sort()
  }, [forecast, cfg.billTypeTreatment])

  const changed = (k: keyof CapacityConfig) => JSON.stringify(cfg[k]) !== JSON.stringify(DEFAULT_CONFIG[k])
  const pctInput = (k: keyof CapacityConfig, v: number) => (
    <span className="inline-flex items-center gap-1">
      <input type="number" step="0.01" disabled={!canEdit} defaultValue={+(v * 100).toFixed(4)} key={v} className={numIn}
        onBlur={(e) => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) setConfig({ [k]: n / 100 } as Partial<CapacityConfig>) }} />%
    </span>
  )

  const control = (key: keyof CapacityConfig) => {
    switch (key) {
      case "billTypeTreatment":
        return (
          <div className="space-y-1">
            {billTypes.map((b) => (
              <div key={b} className="flex items-center justify-between gap-2">
                <span className="text-xs">{b}</span>
                <select className={sel} disabled={!canEdit} value={treatmentFor(cfg, b)}
                  onChange={(e) => setConfig({ billTypeTreatment: { ...cfg.billTypeTreatment, [b]: e.target.value as BillTreatment } })}>
                  <option value="transaction">Volume ÷ W.days ÷ Peak</option>
                  <option value="fte">Units = Base FTE</option>
                  <option value="hourly">Units ÷ (W.days × hours)</option>
                  <option value="exclude">Excluded</option>
                </select>
              </div>
            ))}
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-xs text-muted-foreground">Hours per day (Hourly FTE)</span>
              <input type="number" disabled={!canEdit} defaultValue={cfg.hoursPerDay} key={cfg.hoursPerDay} className={numIn}
                onBlur={(e) => { const n = parseFloat(e.target.value); if (n > 0) setConfig({ hoursPerDay: n }) }} />
            </div>
          </div>
        )
      case "glideActualPct":
        return (
          <div className="flex flex-wrap items-center gap-2">
            <select className={sel} disabled={!canEdit} value={cfg.glideActualPct == null ? "none" : "manual"}
              onChange={(e) => setConfig({ glideActualPct: e.target.value === "none" ? null : 0.1 })}>
              <option value="none">Budgeted Glide % only</option>
              <option value="manual">MIN(B, manual A)</option>
            </select>
            {cfg.glideActualPct != null && pctInput("glideActualPct", cfg.glideActualPct)}
          </div>
        )
      case "qcaAttritionMode":
        return (
          <select className={sel} disabled={!canEdit} value={cfg.qcaAttritionMode} onChange={(e) => setConfig({ qcaAttritionMode: e.target.value as "snp" | "attrition" })}>
            <option value="snp">Actual QA × SNP % (sheet)</option>
            <option value="attrition">Actual QA × Attrition %</option>
          </select>
        )
      case "rampMode":
        return (
          <div className="flex flex-wrap items-center gap-2">
            <select className={sel} disabled={!canEdit} value={cfg.rampMode} onChange={(e) => setConfig({ rampMode: e.target.value as "grid" | "flat" })}>
              <option value="grid">Peak × Ramp Grid % (live)</option>
              <option value="flat">Flat units/day (sheet)</option>
            </select>
            {cfg.rampMode === "flat" && (
              <input type="number" disabled={!canEdit} defaultValue={cfg.rampFlatUnitsPerDay} key={cfg.rampFlatUnitsPerDay} className={numIn}
                onBlur={(e) => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) setConfig({ rampFlatUnitsPerDay: n }) }} />
            )}
          </div>
        )
      case "samplingMode":
        return (
          <div className="flex flex-wrap items-center gap-2">
            <select className={sel} disabled={!canEdit} value={cfg.samplingMode} onChange={(e) => setConfig({ samplingMode: e.target.value as "grid" | "flat" })}>
              <option value="grid">Sampling Grid (live)</option>
              <option value="flat">Flat % (sheet)</option>
            </select>
            <span className="text-xs text-muted-foreground">Flat / fallback</span>{pctInput("samplingFlatPct", cfg.samplingFlatPct)}
          </div>
        )
      case "volumeShrinkageSource":
        return (
          <select className={sel} disabled={!canEdit} value={cfg.volumeShrinkageSource} onChange={(e) => setConfig({ volumeShrinkageSource: e.target.value as CapacityConfig["volumeShrinkageSource"] })}>
            <option value="min">1 − P5 (MIN of B, A)</option>
            <option value="budget">1 − Budgeted only</option>
            <option value="actual">1 − Actual only</option>
          </select>
        )
      case "carryForwardBudget":
        return (
          <select className={sel} disabled={!canEdit} value={cfg.carryForwardBudget ? "yes" : "no"} onChange={(e) => setConfig({ carryForwardBudget: e.target.value === "yes" })}>
            <option value="yes">Carry last budget month forward (flagged)</option>
            <option value="no">No budget → Actual only / 0 (flagged)</option>
          </select>
        )
      case "missingPeakMode":
        return (
          <select className={sel} disabled={!canEdit} value={cfg.missingPeakMode} onChange={(e) => setConfig({ missingPeakMode: e.target.value as CapacityConfig["missingPeakMode"] })}>
            <option value="blank-key">Blank the key's Base FTE (strict)</option>
            <option value="exclude-task">Drop only that task (flagged)</option>
          </select>
        )
      case "volumeForecastBasis":
        return (
          <select className={sel} disabled={!canEdit} value={cfg.volumeForecastBasis} onChange={(e) => setConfig({ volumeForecastBasis: e.target.value as CapacityConfig["volumeForecastBasis"] })}>
            <option value="units">Units as-is (V1 = P1)</option>
            <option value="equivalent">FTE-billed → equivalent volume</option>
          </select>
        )
      default:
        return null
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Every open decision is a switch. The defaults reproduce the workbook. Changes apply to Calculations and Summary immediately and are saved in this browser.
        </p>
        {canEdit && <Button size="sm" variant="outline" onClick={resetConfig}><RotateCcw className="h-3.5 w-3.5" /> Reset all to workbook defaults</Button>}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {SWITCH_DOCS.map((d) => (
          <Card key={d.id} className={cn("glass", changed(d.key) && "border-amber-500/50")}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Badge variant={d.status === "open" ? "warning" : "secondary"}>{d.id}</Badge>
                {d.question}
                {changed(d.key) && <Badge variant="warning">changed</Badge>}
              </CardTitle>
              <p className="text-xs text-muted-foreground">Default: {d.defaultText}</p>
            </CardHeader>
            <CardContent>{control(d.key)}</CardContent>
          </Card>
        ))}
        <Card className="glass">
          <CardHeader className="pb-2"><CardTitle className="text-sm">SNP % and Capacity colour thresholds</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div className="flex items-center justify-between">SNP % (P13 / Q6){pctInput("snpPct", cfg.snpPct)}</div>
            <div className="flex items-center justify-between">Red below{pctInput("thresholdLow", cfg.thresholdLow)}</div>
            <div className="flex items-center justify-between">Amber above{pctInput("thresholdHigh", cfg.thresholdHigh)}</div>
          </CardContent>
        </Card>
      </div>
      <Card className="glass">
        <CardHeader className="pb-2"><CardTitle className="text-sm">Other decisions the spec doesn't cover (fixed, documented)</CardTitle></CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            {ADDITIONAL_DECISIONS.map((d) => <li key={d}>{d}</li>)}
          </ol>
        </CardContent>
      </Card>
    </div>
  )
}
