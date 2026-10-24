import { useState } from "react"
import { Plus, RotateCcw, Scale, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import {
  effectiveLaw,
  LABOUR_LAW_BY_CODE,
  LABOUR_LAW_DISCLAIMER,
  LABOUR_LAWS,
  type BreakRule,
  type LabourLaw,
  type LawOverrides,
} from "@/lib/domain/labourLaw"
import { useWfm } from "@/store/wfm"

type NumKey = Exclude<
  { [K in keyof LabourLaw]: LabourLaw[K] extends number | null ? K : never }[keyof LabourLaw],
  undefined
>

const FIELDS: { key: NumKey; label: string; unit: "h" | "min"; reference?: boolean }[] = [
  { key: "standardDailyHours", label: "Standard hours a day (overtime after)", unit: "h" },
  { key: "maxDailyHours", label: "Max hours a day incl. overtime", unit: "h" },
  { key: "maxDailyOtHours", label: "Max overtime a day", unit: "h" },
  { key: "maxSpreadHours", label: "Max spread of the working day", unit: "h" },
  { key: "maxContinuousWorkHours", label: "Max work without a break", unit: "h" },
  { key: "minBreakBlockMinutes", label: "Breaks shorter than this don't count", unit: "min" },
  { key: "standardWeeklyHours", label: "Standard hours a week", unit: "h", reference: true },
  { key: "maxWeeklyHours", label: "Max hours a week", unit: "h", reference: true },
  { key: "minDailyRestHours", label: "Min rest between shifts", unit: "h", reference: true },
]

/** Pick a country → its labour-law preset applies; every value can be adjusted. */
export function LabourLawDialog({ canEdit, onClose }: { canEdit: boolean; onClose: () => void }) {
  const { labourLaw, setLabourLawCountry, setLabourLawOverrides } = useWfm()
  const [country, setCountry] = useState<string | null>(labourLaw.country)
  const [overrides, setOverrides] = useState<LawOverrides>(labourLaw.country === country ? labourLaw.overrides : {})
  const statute = country ? LABOUR_LAW_BY_CODE[country] : null
  const law = effectiveLaw(country, overrides)

  function pickCountry(code: string | null) {
    setCountry(code)
    setOverrides(code === labourLaw.country ? labourLaw.overrides : {})
  }

  const setNum = (key: NumKey, raw: string) => {
    const v = raw.trim() === "" ? null : Number(raw)
    if (v != null && (Number.isNaN(v) || v < 0)) return
    const next = { ...overrides }
    if (statute && v === statute[key]) delete next[key]
    else next[key] = v
    setOverrides(next)
  }
  const setRules = (rules: BreakRule[]) => {
    const next = { ...overrides }
    if (statute && JSON.stringify(rules) === JSON.stringify(statute.breakRules)) delete next.breakRules
    else next.breakRules = rules
    setOverrides(next)
  }

  function save() {
    if (country !== labourLaw.country) setLabourLawCountry(country)
    if (JSON.stringify(overrides) !== JSON.stringify(country === labourLaw.country ? labourLaw.overrides : {})) setLabourLawOverrides(overrides)
    onClose()
  }

  const adjusted = Object.keys(overrides).length

  return (
    <Dialog
      open
      onClose={onClose}
      title="Labour law"
      description="Select a country and its scheduling rules are applied automatically. Schedules are checked against them (warnings — nothing is blocked)."
      className="max-w-3xl"
      footer={
        canEdit ? (
          <>
            {adjusted > 0 && (
              <Button variant="ghost" className="mr-auto" onClick={() => setOverrides({})}>
                <RotateCcw className="h-4 w-4" /> Reset to statute
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save}>Apply</Button>
          </>
        ) : (
          <Button variant="outline" onClick={onClose}>Close</Button>
        )
      }
    >
      <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
        <div className="flex flex-wrap items-center gap-2">
          <Scale className="h-4 w-4 text-primary" />
          <Select
            aria-label="Country"
            disabled={!canEdit}
            value={country ?? ""}
            onChange={(e) => pickCountry(e.target.value || null)}
            options={[{ value: "", label: "No labour law selected" }, ...LABOUR_LAWS.map((l) => ({ value: l.code, label: l.name }))]}
          />
          {adjusted > 0 && <span className="text-xs text-amber-600 dark:text-amber-400">{adjusted} value(s) adjusted from statute</span>}
        </div>

        {law && statute ? (
          <>
            <div className="rounded-lg border bg-muted/20 p-3 text-xs">
              <p><b>Source:</b> {law.source}</p>
              <p className="mt-1 text-muted-foreground">{law.notes}</p>
            </div>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Daily rules (checked on every schedule)</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {FIELDS.filter((f) => !f.reference).map((f) => (
                  <NumberField key={f.key} field={f} value={law[f.key]} statute={statute[f.key]} disabled={!canEdit} onChange={(v) => setNum(f.key, v)} />
                ))}
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase text-muted-foreground">Required breaks</h3>
                {canEdit && (
                  <Button variant="outline" size="sm" onClick={() => setRules([...law.breakRules, { afterHours: 6, minBreakMinutes: 30, continuous: false }])}>
                    <Plus className="h-3.5 w-3.5" /> Add rule
                  </Button>
                )}
              </div>
              {law.breakRules.length === 0 && <p className="text-xs text-muted-foreground">No statutory break requirement.</p>}
              <div className="space-y-1.5">
                {law.breakRules.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
                    After
                    <Input type="number" min={0} step={0.5} className="h-8 w-20" aria-label={`Break rule ${i + 1} after hours`} disabled={!canEdit} value={r.afterHours}
                      onChange={(e) => setRules(law.breakRules.map((x, j) => (j === i ? { ...x, afterHours: Number(e.target.value) || 0 } : x)))} />
                    h worked, at least
                    <Input type="number" min={1} className="h-8 w-20" aria-label={`Break rule ${i + 1} minutes`} disabled={!canEdit} value={r.minBreakMinutes}
                      onChange={(e) => setRules(law.breakRules.map((x, j) => (j === i ? { ...x, minBreakMinutes: Number(e.target.value) || 0 } : x)))} />
                    min
                    <label className="flex items-center gap-1">
                      <input type="checkbox" className="accent-primary" disabled={!canEdit} checked={r.continuous}
                        onChange={(e) => setRules(law.breakRules.map((x, j) => (j === i ? { ...x, continuous: e.target.checked } : x)))} />
                      in one uninterrupted break
                    </label>
                    {canEdit && (
                      <Button variant="ghost" size="sm" aria-label={`Remove break rule ${i + 1}`} onClick={() => setRules(law.breakRules.filter((_, j) => j !== i))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">For reference (needs more than one day — not checked)</h3>
              <div className="grid gap-2 sm:grid-cols-3">
                {FIELDS.filter((f) => f.reference).map((f) => (
                  <NumberField key={f.key} field={f} value={law[f.key]} statute={statute[f.key]} disabled={!canEdit} onChange={(v) => setNum(f.key, v)} />
                ))}
              </div>
            </section>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Choose a country to apply its working-time, overtime and break rules to the schedules.</p>
        )}

        <p className="rounded-md border border-amber-500/40 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">{LABOUR_LAW_DISCLAIMER}</p>
      </div>
    </Dialog>
  )
}

function NumberField({
  field,
  value,
  statute,
  disabled,
  onChange,
}: {
  field: (typeof FIELDS)[number]
  value: number | null
  statute: number | null
  disabled: boolean
  onChange: (raw: string) => void
}) {
  const changed = value !== statute
  return (
    <label className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs">
      <span>
        {field.label}
        {changed && <span className="ml-1 text-amber-600 dark:text-amber-400">(statute {statute ?? "—"})</span>}
      </span>
      <span className="flex items-center gap-1">
        <Input
          type="number"
          min={0}
          step={field.unit === "h" ? 0.5 : 5}
          className="h-7 w-20 text-xs"
          aria-label={field.label}
          placeholder="none"
          disabled={disabled}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="w-6 text-muted-foreground">{field.unit}</span>
      </span>
    </label>
  )
}
