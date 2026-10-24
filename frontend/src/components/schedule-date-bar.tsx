import { useQueryClient } from "@tanstack/react-query"
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Send } from "lucide-react"
import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { addDays, fmtDay, fmtDayLong, localISODate, scheduleHorizon, weekStart } from "@/lib/domain/horizon"
import { publishSchedules, type PublishResult } from "@/lib/schedulePublish"
import { switchScheduleDate, useScheduleSync } from "@/lib/scheduleSync"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

/** How far back the date picker goes (the rest of the range is the next 3 months). */
export const LOOK_BACK_DAYS = 14

/** Pick the day shown on the Scheduling page (within the 3-month horizon),
 *  see whether it's published, and publish schedules to agents. */
export function ScheduleDateBar({ canPublish }: { canPublish: boolean }) {
  const date = useWfm((s) => s.scheduleDate)
  const agentCount = useWfm((s) => s.agents.length)
  const { status, canWrite, serverAgents } = useScheduleSync()
  const [publishing, setPublishing] = useState(false)
  const today = localISODate()
  const horizon = scheduleHorizon(today)
  const min = addDays(today, -LOOK_BACK_DAYS)
  const go = (d: string) => void switchScheduleDate(d < min ? min : d > horizon.end ? horizon.end : d)
  const online = status !== "idle" && status !== "offline" && serverAgents !== null
  const published = serverAgents ? Object.values(serverAgents).filter((a) => a.published).length : 0

  return (
    <div className="glass mb-4 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2">
      <CalendarDays className="h-4 w-4 text-primary" />
      <Button variant="outline" size="sm" className="h-8 w-8 p-0" aria-label="Previous day" disabled={date <= min} onClick={() => go(addDays(date, -1))}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Input
        type="date"
        aria-label="Schedule date"
        className="h-8 w-[150px]"
        min={min}
        max={horizon.end}
        value={date}
        onChange={(e) => e.target.value && go(e.target.value)}
      />
      <Button variant="outline" size="sm" className="h-8 w-8 p-0" aria-label="Next day" disabled={date >= horizon.end} onClick={() => go(addDays(date, 1))}>
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" className="h-8 text-xs" disabled={date === today} onClick={() => go(today)}>Today</Button>
      <span className="text-sm font-semibold">{fmtDayLong(date)}</span>
      {online && canWrite && (
        published === 0 ? (
          <Badge variant="warning" title="Agents and team leaders can't see this day until it's published">Draft</Badge>
        ) : published >= agentCount ? (
          <Badge variant="success"><CheckCircle2 className="h-3 w-3" /> Published</Badge>
        ) : (
          <Badge variant="warning" title="Some agents' schedules for this day aren't published yet">Published for {published}/{agentCount}</Badge>
        )
      )}
      {online && !canWrite && <Badge variant="secondary">Published schedules</Badge>}
      <span className="ml-auto text-xs text-muted-foreground">
        Next 3 months: {fmtDay(horizon.start)} – {fmtDay(horizon.end)}
      </span>
      {canPublish && (
        <Button
          size="sm"
          className="h-8"
          disabled={!online}
          title={online ? "Publish schedules so agents and their team leaders can see them" : "Publishing needs the server connection"}
          onClick={() => setPublishing(true)}
        >
          <Send className="h-3.5 w-3.5" /> Publish
        </Button>
      )}
      {publishing && <PublishDialog date={date} onClose={() => setPublishing(false)} />}
    </div>
  )
}

type RangeId = "day" | "week" | "4w" | "all" | "custom"

function PublishDialog({ date, onClose }: { date: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const today = localISODate()
  const horizon = scheduleHorizon(today)
  const ws = weekStart(date)
  const ranges: { id: RangeId; label: string; start: string; end: string }[] = [
    { id: "day", label: `This day · ${fmtDay(date)}`, start: date, end: date },
    { id: "week", label: `This week · ${fmtDay(ws)} – ${fmtDay(addDays(ws, 6))}`, start: ws, end: addDays(ws, 6) },
    { id: "4w", label: `Next 4 weeks · ${fmtDay(today)} – ${fmtDay(addDays(today, 27))}`, start: today, end: addDays(today, 27) },
    { id: "all", label: `All 3 months · ${fmtDay(horizon.start)} – ${fmtDay(horizon.end)}`, start: horizon.start, end: horizon.end },
  ]
  const [choice, setChoice] = useState<RangeId>("all")
  const [custom, setCustom] = useState({ start: date, end: addDays(date, 6) })
  const [note, setNote] = useState("")
  const [step, setStep] = useState<string | null>(null)
  const [result, setResult] = useState<PublishResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const range = choice === "custom" ? custom : ranges.find((r) => r.id === choice)!
  const valid = range.start <= range.end

  async function run() {
    setError(null)
    try {
      const res = await publishSchedules(range.start, range.end, { note, onProgress: setStep })
      setResult(res)
      void queryClient.invalidateQueries({ queryKey: ["schedule-range"] })
    } catch (e) {
      setError((e as { message?: string }).message ?? "Publishing failed")
    } finally {
      setStep(null)
    }
  }

  return (
    <Dialog
      open
      onClose={step ? () => {} : onClose}
      title="Publish schedules"
      description="Agents see their own published schedule and their team leaders see the team's. Once published, every change pops up on their screens."
      footer={
        result ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={!!step}>Cancel</Button>
            <Button onClick={() => void run()} disabled={!valid || !!step}>
              {step ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Publish
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div role="status" className="space-y-1 rounded-lg border border-emerald-500/40 p-3 text-sm">
          <p className="flex items-center gap-1.5 font-semibold text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" /> Published {fmtDay(result.start)} – {fmtDay(result.end)}
          </p>
          <p>
            {result.published.toLocaleString()} agent-day{result.published === 1 ? "" : "s"} published ({result.days} day{result.days === 1 ? "" : "s"} · {result.agents} agent{result.agents === 1 ? "" : "s"})
            {result.unchanged > 0 && ` · ${result.unchanged.toLocaleString()} already published`}
          </p>
          {result.created > 0 && <p className="text-muted-foreground">{result.created.toLocaleString()} schedules nobody had opened were created from their shift patterns first.</p>}
          <p className="text-muted-foreground">
            {result.notified ? `${result.notified} agent/team-leader login${result.notified === 1 ? "" : "s"} notified.` : "Nobody to notify — no agent or team-leader logins are linked to these schedules."}
          </p>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Dates</legend>
            {[...ranges, { id: "custom" as const, label: "Custom range", start: "", end: "" }].map((r) => (
              <label key={r.id} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2", choice === r.id && "border-primary/60 bg-primary/5")}>
                <input type="radio" name="publish-range" className="accent-primary" checked={choice === r.id} onChange={() => setChoice(r.id)} />
                {r.label}
              </label>
            ))}
          </fieldset>
          {choice === "custom" && (
            <div className="flex items-center gap-2">
              <Input type="date" aria-label="Publish from" className="h-8" value={custom.start} onChange={(e) => setCustom({ ...custom, start: e.target.value })} />
              <span className="text-muted-foreground">to</span>
              <Input type="date" aria-label="Publish to" className="h-8" value={custom.end} onChange={(e) => setCustom({ ...custom, end: e.target.value })} />
            </div>
          )}
          <Input placeholder="Note for the audit log (optional)" value={note} maxLength={255} onChange={(e) => setNote(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            Days nobody has opened yet are published as their shift-pattern defaults. Days already published stay as they are; edits to them are live for agents straight away.
          </p>
          {step && <p role="status" className="flex items-center gap-1.5 text-xs text-primary"><Loader2 className="h-3 w-3 animate-spin" /> {step}</p>}
          {error && <p role="alert" className="text-xs text-destructive">✕ {error}</p>}
        </div>
      )}
    </Dialog>
  )
}
