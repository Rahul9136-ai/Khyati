import { useQuery } from "@tanstack/react-query"
import { CalendarCheck } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { api } from "@/lib/api"
import { ACTIVITY_BY_ID, CHANNEL_BY_ID, fmtHM } from "@/lib/domain/channels"
import { fmtDay, localISODate, scheduleHorizon, weekStart } from "@/lib/domain/horizon"
import type { ServerDayPlan } from "@/lib/scheduleSync"
import { useScheduleSync } from "@/lib/scheduleSync"
import { cn } from "@/lib/utils"
import { useAuth } from "@/store/auth"

type PublishedDay = ServerDayPlan & { plan_date: string }

/** An agent's published schedule for the next 3 months. A signed-in agent
 *  gets their own (GET /scheduling/my-schedule); staff previewing the Agent
 *  view get that roster agent's published days, exactly as the agent sees them. */
export function MySchedule({ agentId, onOpenDate }: { agentId: string; onOpenDate: (date: string) => void }) {
  const user = useAuth((s) => s.user)
  const status = useScheduleSync((s) => s.status)
  const staff = !!user && (user.is_superuser || user.permission_codes.includes("employee:read"))
  const { start, end } = scheduleHorizon(localISODate())
  const online = status !== "idle" && status !== "offline"
  const { data, isLoading } = useQuery({
    queryKey: ["my-schedule", staff ? agentId : "me", start, end],
    queryFn: async () => {
      if (staff) return (await api.get(`/scheduling/agent-schedule/${agentId}`, { params: { start, end } })).data.data as PublishedDay[]
      return ((await api.get("/scheduling/my-schedule", { params: { start, end } })).data.data as { days: PublishedDay[] }).days
    },
    enabled: online && !!user,
    refetchInterval: 30_000,
  })
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
                  {days.map((d) => (
                    <li key={d.plan_date}>
                      <button
                        type="button"
                        onClick={() => onOpenDate(d.plan_date)}
                        className={cn("flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-xs hover:bg-accent", d.plan_date === today && "bg-primary/5")}
                      >
                        <span className={cn("w-24 font-semibold", d.plan_date === today && "text-primary")}>{fmtDay(d.plan_date)}{d.plan_date === today && " · today"}</span>
                        <span className="w-24 font-semibold tabular-nums">{fmtHM(d.shift_start)}–{fmtHM(d.shift_end)}</span>
                        <span className="flex flex-wrap gap-1">
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
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
