import { useQuery } from "@tanstack/react-query"
import { CalendarCheck } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { api } from "@/lib/api"
import { lanes } from "@/lib/domain/channelPlanner"
import { ACTIVITY_BY_ID, CHANNEL_BY_ID, fmtHM } from "@/lib/domain/channels"
import { fmtDay, localISODate, scheduleHorizon, weekStart } from "@/lib/domain/horizon"
import type { ServerDayPlan } from "@/lib/scheduleSync"
import { useScheduleSync } from "@/lib/scheduleSync"
import { cn } from "@/lib/utils"
import { useAuth } from "@/store/auth"

export type PublishedDay = ServerDayPlan & { plan_date: string }

/** An agent's published days for the next 3 months: a signed-in agent's own
 *  (GET /scheduling/my-schedule), or — for staff previewing the Agent view —
 *  that roster agent's, exactly as the agent sees them. */
export function usePublishedDays(agentId: string) {
  const user = useAuth((s) => s.user)
  const status = useScheduleSync((s) => s.status)
  const staff = !!user && (user.is_superuser || user.permission_codes.includes("employee:read"))
  const { start, end } = scheduleHorizon(localISODate())
  const online = status !== "idle" && status !== "offline"
  const query = useQuery({
    queryKey: ["my-schedule", staff ? agentId : "me", start, end],
    queryFn: async () => {
      if (staff) return (await api.get(`/scheduling/agent-schedule/${agentId}`, { params: { start, end } })).data.data as PublishedDay[]
      return ((await api.get("/scheduling/my-schedule", { params: { start, end } })).data.data as { days: PublishedDay[] }).days
    },
    enabled: online && !!user,
    refetchInterval: 30_000,
  })
  return { ...query, online, start, end }
}

/** An agent's published schedule for the next 3 months (see usePublishedDays). */
export function MySchedule({ agentId, onOpenDate }: { agentId: string; onOpenDate: (date: string) => void }) {
  const { data, isLoading, online, start, end } = usePublishedDays(agentId)
  const today = localISODate()
  const weeks = new Map<string, PublishedDay[]>()
  for (const d of data ?? []) weeks.set(weekStart(d.plan_date), [...(weeks.get(weekStart(d.plan_date)) ?? []), d])

  return (
    <Card className="glass mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2"><CalendarCheck className="h-4 w-4 text-primary" /> My schedule — next 3 months</CardTitle>
        <p className="text-xs text-muted-foreground">
          {fmtDay(start)} – {fmtDay(end)} · published shifts only. You get a pop-up whenever one of them changes.
        </p>
      </CardHeader>
      <CardContent>
        {!online ? (
          <p className="text-sm text-muted-foreground">Connecting to the server to load your published schedule…</p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data?.length ? (
          <p className="text-sm text-muted-foreground">No published schedule yet — it appears here as soon as your scheduler publishes it.</p>
        ) : (
          <div className="space-y-3">
            {[...weeks].map(([ws, days]) => (
              <div key={ws}>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Week of {fmtDay(ws)}</p>
                <ul className="divide-y rounded-lg border">
                  {days.map((d) => {
                    // A whole day off / leave / absence replaces the shift.
                    const allDay = d.activities.find((x) => ACTIVITY_BY_ID[x.type]?.fullShift && x.start <= d.shift_start && x.end >= d.shift_end)
                    return (
                    <li key={d.plan_date}>
                      <button
                        type="button"
                        onClick={() => onOpenDate(d.plan_date)}
                        className={cn("flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-xs hover:bg-accent", d.plan_date === today && "bg-primary/5")}
                      >
                        <span className={cn("w-24 font-semibold", d.plan_date === today && "text-primary")}>{fmtDay(d.plan_date)}{d.plan_date === today && " · today"}</span>
                        {allDay ? (
                          <span className="rounded px-2 py-0.5 font-semibold text-white" style={{ background: ACTIVITY_BY_ID[allDay.type].color }}>
                            {ACTIVITY_BY_ID[allDay.type].label} — not working{allDay.note && allDay.note !== ACTIVITY_BY_ID[allDay.type].label ? ` · ${allDay.note}` : ""}
                          </span>
                        ) : (
                        <>
                        <span className="w-24 font-semibold tabular-nums">{fmtHM(d.shift_start)}–{fmtHM(d.shift_end)}</span>
                        <span className="flex flex-wrap gap-1">
                          {lanes(d.channels).map(([ch, s, e]) => (
                            <span key={`${ch}${s}`} className="rounded px-1.5 py-0.5 tabular-nums text-white" style={{ background: CHANNEL_BY_ID[ch].color }}>
                              {CHANNEL_BY_ID[ch].label} {fmtHM(s)}–{fmtHM(e)}
                            </span>
                          ))}
                          {[...d.breaks].sort((x, y) => x.start - y.start).map((b) => (
                            <span key={b.id} className="rounded bg-amber-500/15 px-1.5 py-0.5 tabular-nums text-amber-700 dark:text-amber-400">
                              {b.label || (b.type === "lunch" ? "Lunch" : "Break")} {fmtHM(b.start)}
                            </span>
                          ))}
                          {d.activities.map((x) => (
                            <span key={x.id} className="rounded px-1.5 py-0.5 tabular-nums text-white" style={{ background: ACTIVITY_BY_ID[x.type].color }}>
                              {ACTIVITY_BY_ID[x.type].label} {fmtHM(x.start)}–{fmtHM(x.end)}
                            </span>
                          ))}
                          {d.overtime.map((o) => (
                            <span key={o.id} className="rounded border px-1.5 py-0.5 tabular-nums" style={{ borderColor: CHANNEL_BY_ID[o.channel].color, color: CHANNEL_BY_ID[o.channel].color }}>
                              OT {CHANNEL_BY_ID[o.channel].label} {fmtHM(o.start)}–{fmtHM(o.end)}
                            </span>
                          ))}
                        </span>
                        </>
                        )}
                      </button>
                    </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
