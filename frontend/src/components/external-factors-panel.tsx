import { CalendarClock, FileDown, Plus, Trash2, Upload } from "lucide-react"
import { useRef, useState } from "react"

import { LockedHint, PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TODAY, ymd } from "@/lib/domain/dates"
import {
  downloadFactorsTemplate, FACTOR_CATEGORIES, factorStatus, parseFactorsFile, type FactorCategory,
} from "@/lib/domain/externalFactors"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

const STATUS_BADGE = {
  past: { variant: "secondary" as const, label: "Past" },
  active: { variant: "success" as const, label: "Active" },
  upcoming: { variant: "warning" as const, label: "Upcoming" },
}

/**
 * The shared "event log" — known campaigns, holidays, weather, outages, new/lost
 * clients, launches and the like, each with a date range (past or future) and a
 * volume impact %. One list, backed by the store, editable from both Forecasting
 * (where it adjusts that queue's date-range forecast) and Scenario Studio (where
 * it seeds a what-if's volume change) — an event logged in either place shows up
 * in both.
 */
export function ExternalFactorsPanel({
  title = "Events log",
  description = "Known campaigns, holidays, weather, outages, client wins/losses and launches — anything that can spike or dent volume in a way the statistical model can't see coming on its own.",
}: {
  title?: string
  description?: string
}) {
  const {
    queues, externalFactors, addExternalFactor, importExternalFactors, removeExternalFactor, can,
  } = useWfm()

  const fileRef = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [category, setCategory] = useState<FactorCategory>("Marketing")
  const [queueId, setQueueId] = useState("all")
  const [from, setFrom] = useState(ymd(TODAY))
  const [to, setTo] = useState(ymd(TODAY))
  const [impact, setImpact] = useState(20)
  const [note, setNote] = useState("")
  const [error, setError] = useState("")

  const editable = can("forecasting", "edit")

  function resetForm() {
    setName(""); setCategory("Marketing"); setQueueId("all")
    setFrom(ymd(TODAY)); setTo(ymd(TODAY)); setImpact(20); setNote(""); setError("")
  }

  function submit() {
    if (!name.trim()) return setError("Name is required.")
    if (to < from) return setError("End date must be on or after the start date.")
    if (!Number.isFinite(impact) || impact <= -100) return setError("Impact % must be greater than -100.")
    addExternalFactor({ name: name.trim(), category, queueId, from, to, impactPct: impact, note: note.trim() || undefined })
    resetForm()
    setOpen(false)
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const { rows, errors } = await parseFactorsFile(file, queues)
      if (!rows.length) {
        setMsg({ ok: false, text: `No valid rows in ${file.name}. ${errors.slice(0, 2).join("; ")}` })
      } else {
        importExternalFactors(rows, file.name)
        setMsg({ ok: true, text: `Imported ${rows.length} event(s) from ${file.name}${errors.length ? ` (${errors.length} row(s) skipped)` : ""}.` })
      }
    } catch (err) {
      setMsg({ ok: false, text: `Could not read ${file.name}: ${(err as Error).message}` })
    }
    e.target.value = ""
  }

  const sorted = [...externalFactors].sort((a, b) => (a.from < b.from ? 1 : -1))

  return (
    <Card className="glass mt-4">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4" /> {title}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <PermissionGate module="forecasting" fallback={<LockedHint label="Needs forecasting edit access" />}>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFile} />
            <Button variant="outline" size="sm" onClick={downloadFactorsTemplate}>
              <FileDown className="h-4 w-4" /> Template
            </Button>
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload className="h-4 w-4" /> Import
            </Button>
            <Button size="sm" onClick={() => { resetForm(); setOpen(true) }}>
              <Plus className="h-4 w-4" /> Add event
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Queue</TableHead>
              <TableHead>Dates</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Impact</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((f) => {
              const status = STATUS_BADGE[factorStatus(f)]
              return (
                <TableRow key={f.id}>
                  <TableCell className="text-left font-medium">
                    {f.name}
                    {f.note && <div className="text-xs text-muted-foreground">{f.note}</div>}
                  </TableCell>
                  <TableCell><Badge variant="outline">{f.category}</Badge></TableCell>
                  <TableCell>{f.queueId === "all" ? "All queues" : queues.find((q) => q.id === f.queueId)?.name ?? f.queueId}</TableCell>
                  <TableCell className="tabular-nums">{f.from}{f.to !== f.from ? ` → ${f.to}` : ""}</TableCell>
                  <TableCell><Badge variant={status.variant}>{status.label}</Badge></TableCell>
                  <TableCell className={cn("font-semibold tabular-nums", f.impactPct >= 0 ? "text-amber-500" : "text-emerald-500")}>
                    {f.impactPct >= 0 ? "+" : ""}{f.impactPct}%
                  </TableCell>
                  <TableCell>
                    <PermissionGate module="forecasting" fallback={<span className="text-xs text-muted-foreground">—</span>}>
                      <Button size="sm" variant="ghost" onClick={() => removeExternalFactor(f.id)} aria-label={`Remove ${f.name}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </PermissionGate>
                  </TableCell>
                </TableRow>
              )
            })}
            {sorted.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  No events logged yet — add a known campaign, holiday, client change or outage (past or future) to
                  adjust the forecast and staffing requirement for it.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add event"
        description="Applies a volume multiplier over the date range, on top of the statistical baseline. A past date range records what actually happened; a future one adjusts the forecast and the staffing requirement for it."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={!editable}><Plus className="h-4 w-4" /> Add event</Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Name</span>
            <Input value={name} onChange={(e) => { setName(e.target.value); setError("") }} placeholder="e.g. Black Friday campaign" autoFocus />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Category</span>
              <Select value={category} onChange={(e) => setCategory(e.target.value as FactorCategory)} options={FACTOR_CATEGORIES.map((c) => ({ value: c, label: c }))} className="w-full" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Queue</span>
              <Select value={queueId} onChange={(e) => setQueueId(e.target.value)} options={[{ value: "all", label: "All queues" }, ...queues.map((q) => ({ value: q.id, label: q.name }))]} className="w-full" />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">From (past or future)</span>
              <input
                type="date"
                value={from}
                onChange={(e) => { setFrom(e.target.value); setError("") }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">To</span>
              <input
                type="date"
                value={to}
                min={from}
                onChange={(e) => { setTo(e.target.value); setError("") }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Volume impact (%)</span>
            <Input type="number" step={5} value={impact} onChange={(e) => setImpact(+e.target.value)} />
            <span className="mt-1 block text-xs text-muted-foreground">Positive = more contacts (campaign, new client), negative = fewer (holiday/outage/client loss).</span>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Note (optional)</span>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Context for other planners" />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </Dialog>
    </Card>
  )
}
