import { CalendarPlus, FileDown, Plus, Sigma, SlidersHorizontal, Sparkles, Trash2, Upload } from "lucide-react"
import { useMemo, useRef, useState } from "react"

import { LockedHint, PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { enumerateDays, parseYMD, ymd } from "@/lib/domain/dates"
import {
  appliesTo, datesWithValues, downloadDriversTemplate, DRIVER_KINDS, DRIVER_TARGETS, driverMultiplier, learnElasticity,
  parseDriversFile, planValues, recentLevel, type DriverKind, type DriverTarget, type ForecastDriver,
} from "@/lib/domain/drivers"
import type { History } from "@/lib/domain/history"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

const dateCls =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
const Field = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
  <label className="block">
    <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
  </label>
)

/** Mean multiplier a driver applies over the period (for the "Impact" column). */
function periodImpact(d: ForecastDriver, start: string, end: string): number {
  const days = enumerateDays(parseYMD(start), parseYMD(end))
  if (!days.length) return 0
  return days.reduce((a, day) => a + driverMultiplier(d, ymd(day)), 0) / days.length - 1
}

/**
 * Forecast drivers — the dependent features the forecast moves with. Each one has
 * recorded (past) and planned (future) values, a reference level and an
 * elasticity on volume or AHT; the elasticity can be learned from history.
 * Applied on the Forecasting page and everywhere the date-range plan is used
 * (Reports, Scenario Studio), and published with the forecast.
 */
export function ForecastDriversPanel({ queueId, history, start, end }: { queueId: string; history: History; start: string; end: string }) {
  const {
    queues, forecastDrivers, addForecastDriver, updateForecastDriver, addDriverValues, removeForecastDriver,
    importForecastDrivers, can,
  } = useWfm()
  const editable = can("forecasting", "edit")
  const lastHist = ymd(history.lastDate)
  const queueName = queues.find((q) => q.id === queueId)?.name ?? queueId

  const fileRef = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // ---- add dialog ----
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [kind, setKind] = useState<DriverKind>("Marketing spend")
  const [unit, setUnit] = useState("")
  const [dq, setDq] = useState("all")
  const [target, setTarget] = useState<DriverTarget>("volume")
  const [reference, setReference] = useState(100)
  const [elasticity, setElasticity] = useState(0.3)
  const [pFrom, setPFrom] = useState(start)
  const [pTo, setPTo] = useState(end)
  const [pValue, setPValue] = useState<string>("")
  const [pEnd, setPEnd] = useState<string>("")
  const [error, setError] = useState("")

  // ---- plan-values dialog ----
  const [planFor, setPlanFor] = useState<ForecastDriver | null>(null)

  function resetForm() {
    setName(""); setKind("Marketing spend"); setUnit(""); setDq("all"); setTarget("volume")
    setReference(100); setElasticity(0.3); setPFrom(start); setPTo(end); setPValue(""); setPEnd(""); setError("")
  }

  function submit() {
    if (!name.trim()) return setError("Name is required.")
    if (!(reference > 0)) return setError("Reference level must be above 0.")
    if (!Number.isFinite(elasticity)) return setError("Elasticity must be a number.")
    const v = pValue.trim() === "" ? undefined : Number(pValue)
    const ve = pEnd.trim() === "" ? undefined : Number(pEnd)
    if (v !== undefined && (!Number.isFinite(v) || pTo < pFrom)) return setError("Check the planned value and its dates.")
    addForecastDriver({
      name: name.trim(), kind, unit: unit.trim(), queueId: dq, target, reference, elasticity, elasticitySource: "manual",
      values: v === undefined ? [] : planValues(pFrom, pTo, v, Number.isFinite(ve) ? ve : undefined), enabled: true,
    })
    setOpen(false)
    resetForm()
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const { series, errors } = await parseDriversFile(file, queues)
      if (!series.length) {
        setMsg({ ok: false, text: `No driver columns in ${file.name}. ${errors.slice(0, 2).join("; ")}` })
      } else {
        const { added, updated } = importForecastDrivers(series, file.name, (s) => {
          const tmp = { values: s.values } as ForecastDriver
          const lvl = recentLevel(tmp, lastHist)
          return lvl ?? s.values.reduce((a, v) => a + v.value, 0) / s.values.length
        })
        setMsg({
          ok: true,
          text: `Imported ${series.length} driver column(s) from ${file.name}: ${added} new, ${updated} updated${errors.length ? ` · ${errors.length} cell(s) skipped` : ""}. New drivers start at elasticity 0 — click “Learn” to measure their effect from history.`,
        })
      }
    } catch (err) {
      setMsg({ ok: false, text: `Could not read ${file.name}: ${(err as Error).message}` })
    }
    e.target.value = ""
  }

  function learn(d: ForecastDriver) {
    const r = learnElasticity(d, history)
    if ("error" in r) return setMsg({ ok: false, text: `${d.name}: ${r.error}` })
    updateForecastDriver(d.id, { elasticity: r.elasticity, elasticitySource: "learned", learned: r }, "Learned driver elasticity")
    setMsg({
      ok: true,
      text: `${d.name}: learned elasticity ${r.elasticity} from ${r.n} days of ${queueName} history (R² ${r.r2.toFixed(2)}${r.r2 < 0.1 ? " — weak link, check the data" : ""}).`,
    })
  }

  const shown = useMemo(
    () => forecastDrivers.filter((d) => d.queueId === "all" || d.queueId === queueId),
    [forecastDrivers, queueId],
  )
  const otherQueues = forecastDrivers.length - shown.length

  return (
    <Card className="glass mt-4">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4" /> Forecast drivers</CardTitle>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Dependent features the forecast moves with: marketing spend, active customers, orders, website traffic, billing
            runs, price changes and more. Add the driver's recorded history and its planned values. The forecast is
            multiplied by (value ÷ reference)^elasticity on each day, and drivers compound with one another and with the events log.
          </p>
        </div>
        <PermissionGate module="forecasting" fallback={<LockedHint label="Needs forecasting edit access" />}>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFile} />
            <Button variant="outline" size="sm" onClick={() => downloadDriversTemplate(history.lastDate)}>
              <FileDown className="h-4 w-4" /> Template
            </Button>
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload className="h-4 w-4" /> Import drivers
            </Button>
            <Button size="sm" onClick={() => { resetForm(); setOpen(true) }}>
              <Plus className="h-4 w-4" /> Add driver
            </Button>
          </div>
        </PermissionGate>
      </CardHeader>
      <CardContent>
        {msg && (
          <div className={cn("mb-4 rounded-lg border px-4 py-2.5 text-sm", msg.ok ? "border-emerald-500/40 text-emerald-500" : "border-destructive/40 text-destructive")}>
            {msg.ok ? "✓ " : "✕ "}{msg.text}
          </div>
        )}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Driver</TableHead>
                <TableHead>Queue</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Elasticity</TableHead>
                <TableHead>Values</TableHead>
                <TableHead>Impact on period</TableHead>
                <TableHead>On</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((d) => {
                const all = datesWithValues(d, "0000-01-01", "9999-12-31")
                const past = all.filter((k) => k <= lastHist).length
                const planned = all.length - past
                const impact = appliesTo(d, queueId) ? periodImpact(d, start, end) : 0
                return (
                  <TableRow key={d.id} className={cn(!d.enabled && "opacity-60")}>
                    <TableCell className="text-left font-medium">
                      {d.name}
                      <div className="text-xs text-muted-foreground">{d.kind}{d.unit ? ` · ${d.unit}` : ""}</div>
                    </TableCell>
                    <TableCell>{d.queueId === "all" ? "All queues" : queues.find((q) => q.id === d.queueId)?.name ?? d.queueId}</TableCell>
                    <TableCell><Badge variant="outline">{d.target === "aht" ? "AHT" : "Volume"}</Badge></TableCell>
                    <TableCell className="tabular-nums">
                      {editable ? (
                        <Input
                          type="number"
                          className="h-8 w-24"
                          defaultValue={d.reference}
                          aria-label={`${d.name} reference level`}
                          onBlur={(e) => { const v = +e.target.value; if (v > 0 && v !== d.reference) updateForecastDriver(d.id, { reference: v }, "Changed driver reference") }}
                        />
                      ) : d.reference.toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        {editable ? (
                          <Input
                            key={`${d.id}-${d.elasticity}`}
                            type="number"
                            step={0.05}
                            className="h-8 w-20"
                            defaultValue={d.elasticity}
                            aria-label={`${d.name} elasticity`}
                            onBlur={(e) => { const v = +e.target.value; if (Number.isFinite(v) && v !== d.elasticity) updateForecastDriver(d.id, { elasticity: v, elasticitySource: "manual" }, "Changed driver elasticity") }}
                          />
                        ) : <span className="tabular-nums">{d.elasticity}</span>}
                        {d.elasticitySource === "learned" && d.learned && (
                          <Badge variant="success" title={`Learned from ${d.learned.n} days · R² ${d.learned.r2.toFixed(2)}`}>R² {d.learned.r2.toFixed(2)}</Badge>
                        )}
                        {editable && d.target === "volume" && (
                          <Button size="sm" variant="ghost" onClick={() => learn(d)} title="Learn the elasticity from this queue's history">
                            <Sigma className="h-3.5 w-3.5" /> Learn
                          </Button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums text-muted-foreground">
                      {past} past · {planned} planned
                    </TableCell>
                    <TableCell className={cn("font-semibold tabular-nums", impact > 0.0005 ? "text-amber-500" : impact < -0.0005 ? "text-emerald-500" : "text-muted-foreground")}>
                      {Math.abs(impact) < 0.0005 ? "—" : `${impact > 0 ? "+" : ""}${(impact * 100).toFixed(1)}%`}
                    </TableCell>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={d.enabled}
                        disabled={!editable}
                        aria-label={`Use ${d.name}`}
                        onChange={(e) => updateForecastDriver(d.id, { enabled: e.target.checked }, e.target.checked ? "Enabled forecast driver" : "Disabled forecast driver")}
                        className="h-4 w-4 accent-primary"
                      />
                    </TableCell>
                    <TableCell>
                      <PermissionGate module="forecasting" fallback={<span className="text-xs text-muted-foreground">—</span>}>
                        <div className="flex">
                          <Button size="sm" variant="ghost" onClick={() => setPlanFor(d)} aria-label={`Plan values for ${d.name}`} title="Plan future values">
                            <CalendarPlus className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => removeForecastDriver(d.id)} aria-label={`Remove ${d.name}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </PermissionGate>
                    </TableCell>
                  </TableRow>
                )
              })}
              {shown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                    No drivers yet. Add one by hand, or import a sheet with a Date column and one column per driver (past
                    rows are the history, future rows are the plan). Then click <Sparkles className="inline h-3.5 w-3.5" /> Learn to measure each driver's effect.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {otherQueues > 0 && <p className="mt-2 text-xs text-muted-foreground">{otherQueues} driver(s) for other queues are hidden.</p>}
      </CardContent>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add forecast driver"
        description="A number per date that the target moves with. At the reference level the driver changes nothing. Elasticity is the % change in the target for each 1% change in the driver."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={!editable}><Plus className="h-4 w-4" /> Add driver</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => { setName(e.target.value); setError("") }} placeholder="e.g. Paid search spend" autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value as DriverKind)} options={DRIVER_KINDS.map((k) => ({ value: k, label: k }))} className="w-full" />
            </Field>
            <Field label="Unit (optional)">
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="e.g. $ / day, customers" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Queue">
              <Select value={dq} onChange={(e) => setDq(e.target.value)} options={[{ value: "all", label: "All queues" }, ...queues.map((q) => ({ value: q.id, label: q.name }))]} className="w-full" />
            </Field>
            <Field label="Affects">
              <Select value={target} onChange={(e) => setTarget(e.target.value as DriverTarget)} options={DRIVER_TARGETS.map((t) => ({ value: t.id, label: t.name }))} className="w-full" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Reference level" hint="The driver's normal level, which the history already reflects">
              <Input type="number" value={reference} onChange={(e) => setReference(+e.target.value)} />
            </Field>
            <Field label="Elasticity" hint="0.3 = +10% driver → ≈ +2.9% target; negative lowers it">
              <Input type="number" step={0.05} value={elasticity} onChange={(e) => setElasticity(+e.target.value)} />
            </Field>
          </div>
          <div className="rounded-lg border p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Planned value (optional, can be added later)</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From"><input type="date" value={pFrom} onChange={(e) => setPFrom(e.target.value)} className={dateCls} /></Field>
              <Field label="To"><input type="date" value={pTo} min={pFrom} onChange={(e) => setPTo(e.target.value)} className={dateCls} /></Field>
              <Field label="Value"><Input type="number" value={pValue} onChange={(e) => setPValue(e.target.value)} placeholder="e.g. 120" /></Field>
              <Field label="Ramp to (optional)"><Input type="number" value={pEnd} onChange={(e) => setPEnd(e.target.value)} placeholder="value on the last day" /></Field>
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </Dialog>

      {planFor && (
        <PlanValuesDialog
          driver={planFor}
          start={start}
          end={end}
          onClose={() => setPlanFor(null)}
          onSave={(vals) => { addDriverValues(planFor.id, vals); setPlanFor(null) }}
        />
      )}
    </Card>
  )
}

function PlanValuesDialog({ driver, start, end, onClose, onSave }: {
  driver: ForecastDriver
  start: string
  end: string
  onClose: () => void
  onSave: (v: ReturnType<typeof planValues>) => void
}) {
  const [from, setFrom] = useState(start)
  const [to, setTo] = useState(end)
  const [value, setValue] = useState(String(driver.reference))
  const [ramp, setRamp] = useState("")
  const [err, setErr] = useState("")
  function save() {
    const v = Number(value)
    const r = ramp.trim() === "" ? undefined : Number(ramp)
    if (!Number.isFinite(v) || (r !== undefined && !Number.isFinite(r))) return setErr("Values must be numbers.")
    if (to < from) return setErr("End date must be on or after the start date.")
    onSave(planValues(from, to, v, r))
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Plan ${driver.name}`}
      description={`Sets the driver's value over a date range (reference ${driver.reference.toLocaleString()}${driver.unit ? ` ${driver.unit}` : ""}). It overrides any value already recorded or planned on those dates.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save}><CalendarPlus className="h-4 w-4" /> Save plan</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={dateCls} /></Field>
        <Field label="To"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={dateCls} /></Field>
        <Field label="Value"><Input type="number" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
        <Field label="Ramp to (optional)"><Input type="number" value={ramp} onChange={(e) => setRamp(e.target.value)} placeholder="value on the last day" /></Field>
      </div>
      {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
    </Dialog>
  )
}
