import { useQuery } from "@tanstack/react-query"
import { FileBarChart, Loader2 } from "lucide-react"
import { useMemo, useState } from "react"

import { ExportButton } from "@/components/export-button"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { parseYMD } from "@/lib/domain/dates"
import { addDays, fmtDay, localISODate, weekStart } from "@/lib/domain/horizon"
import { fetchPerformanceActuals, lobReport, personReport, type PersonSummary } from "@/lib/performanceReport"
import { planRange } from "@/lib/report-granularity"
import { useScheduleSync } from "@/lib/scheduleSync"
import { cn } from "@/lib/utils"
import { fetchRangeRows, rangeDays } from "@/lib/workRuleApply"
import { useWfm } from "@/store/wfm"

const MAX_DAYS = 92
const h = (mins: number) => `${(mins / 60).toFixed(1)}h`
const dayCount = (a: string, b: string) => Math.round((parseYMD(b).getTime() - parseYMD(a).getTime()) / 86_400_000) + 1

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
    </div>
  )
}

export function PersonStats({ p }: { p: PersonSummary }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:grid-cols-6">
      <Stat label="Working days" value={p.working} />
      <Stat label="Week offs" value={p.weekOff} />
      <Stat label="Leave days" value={p.leave} />
      <Stat label="Absence days" value={p.absence} />
      <Stat label="Scheduled" value={h(p.scheduledMins)} />
      <Stat label="Planned work" value={h(p.workedMins)} />
      <Stat label="Breaks" value={h(p.breakMins)} />
      <Stat label="Overtime" value={h(p.otMins)} />
      <Stat label="Compliance issues" value={p.issues} />
      <Stat label="Absences recorded" value={p.attendance ? p.attendance.absent : "No records"} />
      <Stat label="Late days" value={p.attendance ? p.attendance.late : "No records"} />
      <Stat label="Minutes late" value={p.attendance ? p.attendance.lateMins : "No records"} />
      <Stat label="Early logout (min)" value={p.attendance ? p.attendance.earlyMins : "No records"} />
    </div>
  )
}

/** Reports → Performance: pick a period and an LOB or a person, see it, export it. */
export function PerformanceReports() {
  const { agents, queues, workCompliance, forecasts, forecastMethod, importedActuals, externalFactors, shrinkage, dayStore, scheduleDate } = useWfm()
  const syncStatus = useScheduleSync((s) => s.status)
  const canWrite = useScheduleSync((s) => s.canWrite)
  const online = syncStatus !== "idle" && syncStatus !== "offline"
  const today = localISODate()
  const monday = weekStart(today)
  const quick = [
    { label: "This week", start: monday, end: addDays(monday, 6) },
    { label: "Last week", start: addDays(monday, -7), end: addDays(monday, -1) },
    { label: "Last 30 days", start: addDays(today, -29), end: today },
    { label: "Next 4 weeks", start: addDays(monday, 7), end: addDays(monday, 34) },
  ]
  const [start, setStart] = useState(quick[0].start)
  const [end, setEnd] = useState(quick[0].end)
  const [scope, setScope] = useState<"lob" | "person">("lob")
  const [lobId, setLobId] = useState("")
  const [personId, setPersonId] = useState(agents[0]?.id ?? "")

  const period = !start || !end ? "Pick both dates" : start > end ? "The end date is before the start" : dayCount(start, end) > MAX_DAYS ? `A report can cover at most ${MAX_DAYS} days` : null
  const enabled = !period && online
  const saved = useQuery({ queryKey: ["performance-days", start, end], queryFn: () => fetchRangeRows(start, end), enabled, staleTime: 30_000 })
  const actuals = useQuery({ queryKey: ["performance-actuals", start, end], queryFn: () => fetchPerformanceActuals(start, end), enabled, retry: false, staleTime: 30_000 })
  const loading = enabled && (saved.isLoading || actuals.isLoading)

  const input = useMemo(() => {
    if (period || loading) return null
    return {
      start,
      end,
      agents,
      queues,
      // View-only people see saved schedules only: a plan nobody saved isn't their data.
      days: rangeDays(start, end, saved.data ?? [], online && !canWrite),
      compliance: workCompliance,
      actuals: actuals.data ?? null,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rangeDays reads the parked days from the store
  }, [period, loading, start, end, agents, queues, saved.data, actuals.data, workCompliance, online, canWrite, dayStore, scheduleDate])

  const lob = useMemo(() => {
    if (!input || scope !== "lob") return null
    const planned = planRange({ forecasts, forecastMethod, importedActuals, externalFactors, shrinkage, agents, queues }, parseYMD(start), parseYMD(end))
    return lobReport(input, planned, lobId || null)
  }, [input, scope, lobId, forecasts, forecastMethod, importedActuals, externalFactors, shrinkage, agents, queues, start, end])

  const person = useMemo(() => {
    const a = agents.find((x) => x.id === personId)
    return input && scope === "person" && a ? personReport(input, a) : null
  }, [input, scope, agents, personId])

  const sheets = lob?.sheets ?? person?.sheets ?? []
  const scopeName = scope === "person" ? (person?.summary.agent.name ?? "person") : lobId ? (queues.find((q) => q.id === lobId)?.name ?? "lob") : "all-lobs"
  const slug = scopeName.toLowerCase().replace(/[^a-z0-9]+/g, "-")

  return (
    <Card className="glass mb-4">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2"><FileBarChart className="h-4 w-4 text-primary" /> Performance reports</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">By LOB or for one person: schedules, hours, time off, compliance and recorded attendance. Excel has one sheet per section.</p>
          </div>
          {sheets.length > 0 && <ExportButton variant="default" label="Export report" filename={`performance-${slug}-${start}-to-${end}`} sheets={() => sheets} />}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-end gap-2">
          <div className="inline-flex rounded-lg bg-muted p-1" role="group" aria-label="Report for">
            {(["lob", "person"] as const).map((id) => (
              <button key={id} type="button" aria-pressed={scope === id} onClick={() => setScope(id)}
                className={cn("rounded-md px-3 py-1 text-sm font-medium", scope === id ? "bg-background shadow-sm" : "text-muted-foreground")}>
                {id === "lob" ? "By LOB" : "Selected person"}
              </button>
            ))}
          </div>
          {scope === "lob" ? (
            <Select aria-label="LOB" className="h-9 text-sm" value={lobId} onChange={(e) => setLobId(e.target.value)}
              options={[{ value: "", label: "All LOBs" }, ...queues.map((q) => ({ value: q.id, label: q.name }))]} />
          ) : (
            <Select aria-label="Person" className="h-9 text-sm" value={personId} onChange={(e) => setPersonId(e.target.value)}
              options={[...agents].sort((a, b) => a.name.localeCompare(b.name)).map((a) => ({ value: a.id, label: `${a.name} · ${a.team}` }))} />
          )}
          <label className="block text-xs">
            <span className="mb-1 block text-muted-foreground">From</span>
            <Input type="date" aria-label="Report from" className="w-auto" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block text-muted-foreground">To</span>
            <Input type="date" aria-label="Report to" className="w-auto" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-1">
            {quick.map((q) => (
              <Button key={q.label} size="sm" variant={q.start === start && q.end === end ? "secondary" : "ghost"} className="h-9 text-xs" onClick={() => { setStart(q.start); setEnd(q.end) }}>{q.label}</Button>
            ))}
          </div>
        </div>

        {period && <p role="alert" className="text-xs text-destructive">{period}</p>}
        {loading && <p role="status" className="flex items-center gap-1.5 text-xs text-primary"><Loader2 className="h-3 w-3 animate-spin" /> Loading schedules and attendance…</p>}
        {!online && <p className="text-xs text-muted-foreground">Offline: this report uses the schedules kept in this browser, without recorded attendance or queue actuals.</p>}
        {enabled && actuals.isError && <p className="text-xs text-amber-600">Attendance and queue actuals couldn't be loaded, so they're left out of this report.</p>}

        {person && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{person.summary.agent.name} · {person.summary.lob} · {person.summary.agent.team} · {fmtDay(start)} – {fmtDay(end)}</p>
            <PersonStats p={person.summary} />
            {person.summary.notSaved > 0 && <p className="text-xs text-amber-600">{person.summary.notSaved} of {person.summary.days} days have no saved schedule, so they show the plan from the work rule or shift pattern.</p>}
            {!person.summary.days && <p className="text-xs text-muted-foreground">No saved schedules for this person in the period.</p>}
          </div>
        )}

        {lob && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full whitespace-nowrap text-xs" aria-label="LOB performance">
              <thead className="bg-muted/40 text-left text-muted-foreground">
                <tr>
                  {["LOB", "Agents", "Scheduled", "Planned work", "Overtime", "Week offs", "Leave", "Absence", "Compliance issues", "Forecast volume", "Required (forecast)", "Projected SL"].map((c) => <th key={c} className="px-3 py-1.5">{c}</th>)}
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {lob.rows.map((r) => (
                  <tr key={r.lob} className="border-t">
                    <td className="px-3 py-1.5 font-medium">{r.lob}</td>
                    <td className="px-3 py-1.5">{r.agents}</td>
                    <td className="px-3 py-1.5">{h(r.scheduledMins)}</td>
                    <td className="px-3 py-1.5">{h(r.workedMins)}</td>
                    <td className="px-3 py-1.5">{h(r.otMins)}</td>
                    <td className="px-3 py-1.5">{r.weekOff}</td>
                    <td className="px-3 py-1.5">{r.leave}</td>
                    <td className="px-3 py-1.5">{r.absence}</td>
                    <td className="px-3 py-1.5">{r.issues}</td>
                    <td className="px-3 py-1.5">{Math.round(r.volume).toLocaleString()}</td>
                    <td className="px-3 py-1.5">{r.requiredHours.toFixed(1)}h</td>
                    <td className="px-3 py-1.5">{(r.projectedSl * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {lob && !lob.actualRows && !loading && <p className="text-xs text-muted-foreground">No recorded queue results for this selection and period, so the forecast columns are the only volume figures.</p>}

        {(lob || person) && (
          <p className="text-[11px] text-muted-foreground">
            Hours are what was scheduled, not time actually worked or logged by a phone system. Adherence and per-agent calls / AHT aren't included: they need a phone-system (ACD) feed, and the tool's adherence scores are simulated until one is connected.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
