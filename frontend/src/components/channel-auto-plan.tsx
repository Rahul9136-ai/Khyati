import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Send, Shuffle, Trash2 } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import {
  discardChannelDrafts, DRAFTS_KEY, fetchDrafts, planChannels, publishChannelDrafts, type ChannelDraft, type DayPlanStats,
} from "@/lib/channelAutoPlan"
import { addDays, fmtDay, localISODate, scheduleHorizon, weekStart } from "@/lib/domain/horizon"
import { errorText } from "@/lib/offers"
import { useScheduleSync } from "@/lib/scheduleSync"
import { cn } from "@/lib/utils"

type RangeId = "1w" | "2w" | "4w" | "rest"

const hrs = (h: number) => (h % 1 ? h.toFixed(1) : String(h))

/** "12.5 → 3" — green when the gap is closed, amber when some remains. */
function GapCell({ gap }: { gap: { before: number; after: number } }) {
  return (
    <td className="px-3 py-1.5 tabular-nums">
      {hrs(gap.before)} → <b className={gap.after ? "text-amber-600" : "text-emerald-600 dark:text-emerald-400"}>{hrs(gap.after)}</b>
    </td>
  )
}

/** Re-plans Phone / Chat / Email for future weeks from the requirement (phone
 *  first, then a chat minimum, email takes the rest), holds the result as a
 *  draft only schedulers see, and publishes it to agents and team leaders. */
export function ChannelAutoPlan({ canPublish }: { canPublish: boolean }) {
  const queryClient = useQueryClient()
  const status = useScheduleSync((s) => s.status)
  const online = status !== "idle" && status !== "offline"
  const today = localISODate()
  const horizon = scheduleHorizon(today)
  const next = addDays(weekStart(today), 7) // next Monday
  const ranges: Record<RangeId, { label: string; start: string; end: string }> = {
    "1w": { label: `Next week · ${fmtDay(next)} – ${fmtDay(addDays(next, 6))}`, start: next, end: addDays(next, 6) },
    "2w": { label: `Next 2 weeks · ${fmtDay(next)} – ${fmtDay(addDays(next, 13))}`, start: next, end: addDays(next, 13) },
    "4w": { label: `Next 4 weeks · ${fmtDay(next)} – ${fmtDay(addDays(next, 27))}`, start: next, end: addDays(next, 27) },
    rest: { label: `Rest of the 3 months · ${fmtDay(next)} – ${fmtDay(horizon.end)}`, start: next, end: horizon.end },
  }
  const [rangeId, setRangeId] = useState<RangeId>("1w")
  const range = ranges[rangeId]
  const [chatMin, setChatMin] = useState(2)
  const [step, setStep] = useState<string | null>(null)
  const [stats, setStats] = useState<DayPlanStats[] | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // Every pending draft in the 3 months, whichever range it was planned for.
  const { data: drafts = [] } = useQuery({
    queryKey: [...DRAFTS_KEY, today, horizon.end],
    queryFn: () => fetchDrafts(today, horizon.end),
    enabled: online,
  })
  const byDate = new Map<string, ChannelDraft[]>()
  for (const d of drafts) byDate.set(d.plan_date, [...(byDate.get(d.plan_date) ?? []), d])

  async function run(fn: () => Promise<string>) {
    setMsg(null)
    try {
      setMsg({ ok: true, text: await fn() })
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    } finally {
      setStep(null)
      void queryClient.invalidateQueries({ queryKey: DRAFTS_KEY })
    }
  }

  const plan = () =>
    run(async () => {
      const res = await planChannels(range.start, range.end, { chatMin }, setStep)
      setStats(res.stats)
      const moved = res.stats.reduce((t, d) => t + d.changed, 0)
      return moved
        ? `Planned ${moved} channel change${moved === 1 ? "" : "s"} over ${res.stats.filter((d) => d.changed).length} days — saved as a draft. Agents won't see it until you publish.`
        : "Every day already matches the need — nothing to change."
    })

  const publish = () =>
    run(async () => {
      setStep("Publishing…")
      const res = await publishChannelDrafts(today, horizon.end)
      setStats(null)
      for (const key of [["schedule-range"], ["my-schedule"]]) void queryClient.invalidateQueries({ queryKey: key })
      return (
        `Published ${res.applied} channel change${res.applied === 1 ? "" : "s"}` +
        (res.published_days ? ` and ${res.published_days} schedule${res.published_days === 1 ? "" : "s"} that were still drafts` : "") +
        " — agents and team leaders can see them and got a pop-up." +
        (res.stale.length ? ` ${res.stale.length} skipped because the day was edited after planning — plan again to include them.` : "")
      )
    })

  const discard = () =>
    run(async () => {
      const n = await discardChannelDrafts(today, horizon.end)
      setStats(null)
      return `Discarded ${n} planned change${n === 1 ? "" : "s"}.`
    })

  return (
    <Card className="glass mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2"><Shuffle className="h-4 w-4 text-primary" /> Auto-plan channels — future weeks</CardTitle>
        <p className="text-xs text-muted-foreground">
          Works out who should be on Phone, Chat and Email in every 30-min interval: <b>phone first</b> (enough heads on the line for every
          queue's forecast — agents on breaks, meetings or time off aren't counted), then the chat minimum, and everyone else on email. Agents keep their channel wherever the need doesn't change; breaks,
          meetings, time off and OT are left alone. Changes stay a draft only schedulers can see until you publish them.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Select aria-label="Weeks to plan" className="h-8 text-xs" value={rangeId} onChange={(e) => setRangeId(e.target.value as RangeId)}
            options={(Object.keys(ranges) as RangeId[]).map((id) => ({ value: id, label: ranges[id].label }))} />
          <label className="flex items-center gap-1.5">
            Chat minimum
            <Input type="number" min={0} max={99} aria-label="Chat minimum heads" className="h-8 w-16 text-xs" value={chatMin}
              onChange={(e) => setChatMin(Math.max(0, Number(e.target.value) || 0))} />
            heads
          </label>
          <Button size="sm" className="h-8" disabled={!online || !!step} onClick={() => void plan()} title={online ? undefined : "Needs the server connection"}>
            {step ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shuffle className="h-3.5 w-3.5" />} Plan channels
          </Button>
        </div>
        {step && <p role="status" className="flex items-center gap-1.5 text-xs text-primary"><Loader2 className="h-3 w-3 animate-spin" /> {step}</p>}
        {msg && (
          <p role="status" className={cn("rounded-lg border px-3 py-2 text-xs", msg.ok ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-destructive/40 text-destructive")}>
            {msg.ok ? "✓ " : "✕ "}{msg.text}
          </p>
        )}

        {stats && stats.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs" aria-label="Planned days">
              <thead className="bg-muted/40 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5">Day</th>
                  <th className="px-3 py-1.5">Agents moved</th>
                  <th className="px-3 py-1.5" title="Head-hours below the requirement over the day">Phone short (head-hours)</th>
                  <th className="px-3 py-1.5" title="Head-hours below the chat minimum over the day">Chat below minimum (head-hours)</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((d) => (
                  <tr key={d.date} className="border-t">
                    <td className="px-3 py-1.5 font-medium">{fmtDay(d.date)}</td>
                    <td className="px-3 py-1.5 tabular-nums">{d.changed} of {d.agents}</td>
                    <GapCell gap={d.phoneGap} />
                    <GapCell gap={d.chatGap} />
                  </tr>
                ))}
              </tbody>
            </table>
            {stats.some((d) => d.phoneGap.after) && (
              <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
                Where phone is still short there just aren't enough free agents — that's a staffing gap (see Open slots → overtime), not a channel one.
              </p>
            )}
          </div>
        )}

        <section aria-label="Planned channel changes">
          {drafts.length === 0 ? (
            <p className="text-xs text-muted-foreground">No planned channel changes waiting to be published.</p>
          ) : (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">
                  {drafts.length} channel change{drafts.length === 1 ? "" : "s"} on {byDate.size} day{byDate.size === 1 ? "" : "s"} waiting to be published
                </span>
                <span className="text-xs text-muted-foreground">— agents and team leaders can't see them yet.</span>
                <span className="ml-auto flex gap-2">
                  <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={!!step} onClick={() => void discard()}>
                    <Trash2 className="h-3.5 w-3.5" /> Discard
                  </Button>
                  {canPublish && (
                    <Button size="sm" className="h-8" disabled={!!step} onClick={() => void publish()}>
                      <Send className="h-3.5 w-3.5" /> Publish changes
                    </Button>
                  )}
                </span>
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {[...byDate].map(([date, list]) => (
                  <details key={date} className="rounded border bg-card px-3 py-1.5 text-xs">
                    <summary className="cursor-pointer font-medium">
                      {fmtDay(date)} · {list.length} agent{list.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="mt-1 space-y-0.5 text-muted-foreground">
                      {list.map((d) => (
                        <li key={d.agent_key}><b className="text-foreground">{d.agent_name || d.agent_key}</b>: {d.summary}</li>
                      ))}
                    </ul>
                  </details>
                ))}
              </div>
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  )
}
