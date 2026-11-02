import { useQuery } from "@tanstack/react-query"
import { Gauge, Loader2 } from "lucide-react"
import { useMemo, useState } from "react"

import { ExportButton } from "@/components/export-button"
import { PersonStats } from "@/components/performance-reports"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { api } from "@/lib/api"
import { noBreakFor } from "@/lib/domain/channels"
import { addDays, fmtDay, localISODate, weekStart } from "@/lib/domain/horizon"
import type { Agent } from "@/lib/domain/types"
import { personReport, type AttendanceRow } from "@/lib/performanceReport"
import { dayFromServer, useScheduleSync, type ServerDayPlan } from "@/lib/scheduleSync"
import type { RangeDay } from "@/lib/workRuleApply"
import { useAuth } from "@/store/auth"
import { useWfm } from "@/store/wfm"

type Row = ServerDayPlan & { plan_date: string }

/** An agent's own performance: their published schedule and recorded attendance.
 *  A signed-in agent's data comes from "me" endpoints that take no person; staff
 *  previewing the Agent view read that agent's published days. */
export function AgentPerformance({ agent }: { agent: Agent }) {
  const { queues, workCompliance, shiftPatterns } = useWfm()
  const user = useAuth((s) => s.user)
  const status = useScheduleSync((s) => s.status)
  const online = status !== "idle" && status !== "offline"
  const staff = !!user && (user.is_superuser || user.permission_codes.includes("employee:read"))
  const today = localISODate()
  const monday = weekStart(today)
  const periods = [
    { label: "This week", start: monday, end: addDays(monday, 6) },
    { label: "Last week", start: addDays(monday, -7), end: addDays(monday, -1) },
    { label: "Last 30 days", start: addDays(today, -29), end: today },
  ]
  const [picked, setPicked] = useState(0)
  const { start, end } = periods[picked]

  const days = useQuery({
    queryKey: ["my-performance-days", staff ? agent.id : "me", start, end],
    queryFn: async () => {
      if (staff) return (await api.get(`/scheduling/agent-schedule/${agent.id}`, { params: { start, end } })).data.data as Row[]
      return ((await api.get("/scheduling/my-schedule", { params: { start, end } })).data.data as { days: Row[] }).days
    },
    enabled: online && !!user,
  })
  const attendance = useQuery({
    queryKey: ["my-performance-attendance", staff ? agent.id : "me", start, end],
    queryFn: async () => {
      const path = staff ? "/reports/performance-actuals" : "/reports/my-performance"
      return (await api.get(path, { params: { start, end } })).data.data.attendance as AttendanceRow[]
    },
    enabled: online && !!user,
    retry: false,
  })

  const report = useMemo(() => {
    if (!days.data) return null
    const guard = noBreakFor(agent, shiftPatterns)
    const mine: RangeDay[] = days.data.map((r) => ({ date: r.plan_date, day: { ...dayFromServer(r), ...(guard ? { noBreak: guard } : {}) }, source: "published" }))
    return personReport(
      {
        start,
        end,
        agents: [agent],
        queues,
        days: new Map([[agent.id, mine]]),
        compliance: workCompliance,
        actuals: attendance.isError ? null : { attendance: attendance.data ?? [], queues: [] },
      },
      agent,
    )
  }, [days.data, attendance.data, attendance.isError, agent, shiftPatterns, queues, workCompliance, start, end])

  return (
    <Card className="glass mb-4">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2"><Gauge className="h-4 w-4 text-primary" /> My performance</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">Only your own figures: nobody else's can be seen from here.</p>
          </div>
          {report && <ExportButton label="Export my performance" filename={`my-performance-${start}-to-${end}`} sheets={() => report.sheets} />}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-1">
          {periods.map((p, i) => (
            <Button key={p.label} size="sm" variant={i === picked ? "secondary" : "ghost"} className="h-8 text-xs" aria-pressed={i === picked} onClick={() => setPicked(i)}>{p.label}</Button>
          ))}
          <span className="ml-2 text-xs text-muted-foreground">{fmtDay(start)} – {fmtDay(end)}</span>
        </div>
        {!online ? (
          <p className="text-sm text-muted-foreground">Connecting to the server to load your figures…</p>
        ) : days.isLoading ? (
          <p role="status" className="flex items-center gap-1.5 text-xs text-primary"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</p>
        ) : days.isError ? (
          <p className="text-sm text-destructive">Couldn't load your figures. Please try again.</p>
        ) : report ? (
          <>
            {!report.summary.days && <p className="text-xs text-muted-foreground">No published schedule in this period yet.</p>}
            <PersonStats p={report.summary} />
            <p className="text-[11px] text-muted-foreground">
              Hours are from your published schedule, not time logged by a phone system. Calls, AHT and adherence aren't shown because they need a phone-system feed.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
