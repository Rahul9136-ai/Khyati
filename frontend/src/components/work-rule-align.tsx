import { CalendarCheck, Eye, Loader2 } from "lucide-react"
import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { addDays, datesBetween, fmtDay, localISODate, scheduleHorizon, weekStart } from "@/lib/domain/horizon"
import { parseWorkRulePatternId } from "@/lib/domain/workRules"
import { errorText } from "@/lib/offers"
import { useScheduleSync } from "@/lib/scheduleSync"
import { cn } from "@/lib/utils"
import { applyWorkRules, previewAlignment, type AlignPreview } from "@/lib/workRuleApply"
import { useWfm } from "@/store/wfm"

/** Align schedules with each agent's work rule (shift, breaks, week off) for a
 *  chosen period: preview what changes, then apply — and optionally publish. */
export function WorkRuleAlign({ selectedIds = [], canPublish = false }: { selectedIds?: string[]; canPublish?: boolean }) {
  const agents = useWfm((s) => s.agents)
  const status = useScheduleSync((s) => s.status)
  const syncCanWrite = useScheduleSync((s) => s.canWrite)
  const online = status !== "idle" && status !== "offline"
  const today = localISODate()
  const horizon = scheduleHorizon(today)
  const monday = weekStart(today)
  const quick = [
    { label: "This week", start: today, end: addDays(monday, 6) },
    { label: "Next week", start: addDays(monday, 7), end: addDays(monday, 13) },
    { label: "Next 4 weeks", start: addDays(monday, 7), end: addDays(monday, 34) },
    { label: "Rest of 3 months", start: today, end: horizon.end },
  ]
  const [start, setStart] = useState(quick[1].start)
  const [end, setEnd] = useState(quick[1].end)
  const teams = useMemo(() => [...new Set(agents.map((a) => a.team))].sort(), [agents])
  const [who, setWho] = useState<string>("rules")
  const [publish, setPublish] = useState(false)
  const [preview, setPreview] = useState<AlignPreview | null>(null)
  const [step, setStep] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const onRule = agents.filter((a) => parseWorkRulePatternId(a.shiftPatternId) || a.weekOff !== undefined)
  const agentIds: string[] | null =
    who === "selected" ? selectedIds : who === "rules" ? null : who.startsWith("team:") ? agents.filter((a) => a.team === who.slice(5)).map((a) => a.id) : null
  const whoCount = agentIds ? agentIds.length : onRule.length
  const days = start && end && start <= end ? datesBetween(start, end).length : 0
  const periodError = !start || !end ? "Pick both dates" : start > end ? "The end date is before the start" : end > horizon.end ? `Schedules go up to ${fmtDay(horizon.end)}` : null
  const writable = online ? syncCanWrite : true

  const reset = () => { setPreview(null); setMsg(null) }
  const setPeriod = (s: string, e: string) => { setStart(s); setEnd(e); reset() }

  async function run(fn: () => Promise<void>) {
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    } finally {
      setStep(null)
    }
  }

  const doPreview = () =>
    run(async () => {
      setStep("Checking schedules against the work rules…")
      setPreview(await previewAlignment(start, end, agentIds, online))
    })

  const doAlign = () =>
    run(async () => {
      const res = await applyWorkRules(start, end, agentIds, setStep, { online, publish: publish && online && canPublish })
      setPreview(null)
      setMsg({
        ok: true,
        text:
          (res.changed
            ? `Aligned ${res.changed} schedule${res.changed === 1 ? "" : "s"} on ${res.days} day${res.days === 1 ? "" : "s"} (${fmtDay(start)} – ${fmtDay(end)}) with the work rules.`
            : `Every schedule from ${fmtDay(start)} to ${fmtDay(end)} already follows the work rules.`) +
          (res.created ? ` ${res.created} new day${res.created === 1 ? "" : "s"} created from the rules.` : "") +
          (res.conflicts ? ` ${res.conflicts} day${res.conflicts === 1 ? "" : "s"} skipped — someone saved them meanwhile; align again.` : "") +
          (res.published ? ` Published ${res.published} schedule${res.published === 1 ? "" : "s"} — agents and team leaders can see them.` : online && res.changed ? " Days already published changed live (agents got a pop-up)." : "") +
          (online ? "" : " Saved in this browser — it goes to the server when you're back online."),
      })
    })

  const total = preview?.changes.length ?? 0
  return (
    <Card className="glass mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><CalendarCheck className="h-4 w-4 text-primary" /> Align schedules to work rules</CardTitle>
        <p className="text-xs text-muted-foreground">
          Sets every schedule in the period to the agent's work rule: shift times, the break pattern and the week off (fixed or rotating). Channels stretch to
          the new shift; meetings and time off inside it are kept. Preview first — nothing changes until you align.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="mb-1 block text-muted-foreground">From</span>
            <Input type="date" aria-label="Align from" className="h-8 w-36 text-xs" min={today} max={horizon.end} value={start} onChange={(e) => setPeriod(e.target.value, end)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-muted-foreground">To</span>
            <Input type="date" aria-label="Align to" className="h-8 w-36 text-xs" min={start || today} max={horizon.end} value={end} onChange={(e) => setPeriod(start, e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-1">
            {quick.map((q) => (
              <Button key={q.label} size="sm" variant={q.start === start && q.end === end ? "secondary" : "ghost"} className="h-8 text-xs" onClick={() => setPeriod(q.start, q.end)}>
                {q.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Agents to align" className="h-8 text-xs" value={who} onChange={(e) => { setWho(e.target.value); reset() }}
            options={[
              { value: "rules", label: `Everyone on a rule or with week offs (${onRule.length})` },
              ...(selectedIds.length ? [{ value: "selected", label: `Selected agents (${selectedIds.length})` }] : []),
              ...teams.map((t) => ({ value: `team:${t}`, label: `Team ${t} (${agents.filter((a) => a.team === t).length})` })),
            ]} />
          <span className="text-muted-foreground">{days ? `${days} day${days === 1 ? "" : "s"} · ${whoCount} agent${whoCount === 1 ? "" : "s"}` : ""}</span>
          <Button size="sm" variant="outline" className="h-8" disabled={!!periodError || !!step || !whoCount} onClick={() => void doPreview()}>
            <Eye className="h-3.5 w-3.5" /> Preview changes
          </Button>
          {periodError && <span className="text-destructive">{periodError}</span>}
          {!online && <span className="text-muted-foreground">Offline — only the schedules kept in this browser are aligned.</span>}
        </div>

        {step && <p role="status" className="flex items-center gap-1.5 text-primary"><Loader2 className="h-3 w-3 animate-spin" /> {step}</p>}
        {msg && (
          <p role="status" className={cn("rounded-lg border px-3 py-2", msg.ok ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-destructive/40 text-destructive")}>
            {msg.ok ? "✓ " : "✕ "}{msg.text}
          </p>
        )}

        {preview && (
          <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <p className="font-medium">
              {total
                ? `${total} schedule${total === 1 ? "" : "s"} on ${preview.byDate.length} day${preview.byDate.length === 1 ? "" : "s"} will change`
                : "Every saved schedule in the period already follows the work rules."}
              {preview.unsaved > 0 && <span className="font-normal text-muted-foreground"> · {preview.unsaved} agent-day{preview.unsaved === 1 ? "" : "s"} not saved yet will be created from the rules</span>}
            </p>
            {total > 0 && (
              <div className="max-h-64 overflow-auto rounded border bg-card">
                <table className="w-full" aria-label="Alignment preview">
                  <thead className="sticky top-0 bg-muted/60 text-left text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5">Day</th>
                      <th className="px-3 py-1.5">Schedules changing</th>
                      <th className="px-3 py-1.5">Week off added</th>
                      <th className="px-3 py-1.5">Week off removed</th>
                      <th className="px-3 py-1.5">Shift time</th>
                      <th className="px-3 py-1.5">Breaks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.byDate.map((d) => (
                      <tr key={d.date} className="border-t tabular-nums">
                        <td className="px-3 py-1 font-medium">{fmtDay(d.date)}</td>
                        <td className="px-3 py-1">{d.agents}</td>
                        <td className="px-3 py-1">{d.offAdded || "–"}</td>
                        <td className="px-3 py-1">{d.offRemoved || "–"}</td>
                        <td className="px-3 py-1">{d.shifts || "–"}</td>
                        <td className="px-3 py-1">{d.breaks || "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              {online && canPublish && (
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" className="accent-primary" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
                  Publish {fmtDay(start)} – {fmtDay(end)} afterwards so agents see it
                </label>
              )}
              <Button size="sm" className="ml-auto h-8" disabled={!writable || !!step || (!total && !preview.unsaved && !publish)} onClick={() => void doAlign()}>
                <CalendarCheck className="h-3.5 w-3.5" /> {total ? `Align ${total} schedule${total === 1 ? "" : "s"}` : "Align"}{publish && online && canPublish ? " & publish" : ""}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
