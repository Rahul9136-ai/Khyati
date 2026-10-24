import { useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"

import { ACTIVITY_BY_ID, fmtHM, shiftBounds } from "@/lib/domain/channels"
import { datesBetween, fmtDay, isWeekend, localISODate, parseISODate, scheduleHorizon } from "@/lib/domain/horizon"
import type { Agent } from "@/lib/domain/types"
import { fetchRange, type DaySummary } from "@/lib/schedulePublish"
import { useScheduleSync } from "@/lib/scheduleSync"
import { cn } from "@/lib/utils"
import { baseShiftFor, useWfm } from "@/store/wfm"

/** One agent-day as the overview draws it. */
interface Cell {
  start: number
  end: number
  ot: number
  activities: string[]
  /** "published" = agents can see it; "draft" = saved, not published; "local" = only in this browser. */
  state: "published" | "draft" | "local"
}

/** Every agent's shift for every day of the next 3 months: published days are
 *  solid, drafts dashed. Click a day (or a cell) to open it on the timeline. */
export function ScheduleOverview({ agents, onOpenDate }: { agents: Agent[]; onOpenDate: (date: string) => void }) {
  const [open, setOpen] = useState(true)
  const today = localISODate()
  const { start, end } = scheduleHorizon(today)
  const dates = useMemo(() => datesBetween(start, end), [start, end])
  const { status, canWrite, serverAgents } = useScheduleSync()
  const online = status !== "idle" && status !== "offline"
  const { data: server } = useQuery({
    queryKey: ["schedule-range", start, end],
    queryFn: () => fetchRange(start, end),
    enabled: online,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  const { scheduleDate, dayStore, shiftPatterns, overtimePlan, activityPlan } = useWfm()

  const cells = useMemo(() => {
    const byKey = new Map<string, DaySummary>((server ?? []).map((r) => [`${r.plan_date}|${r.agent_key}`, r]))
    const out = new Map<string, Cell | null>()
    for (const date of dates) {
      for (const a of agents) {
        const key = `${date}|${a.id}`
        const srv = byKey.get(key)
        if (date === scheduleDate) {
          // The selected day comes from the live timeline so edits show at once.
          const [s, e] = shiftBounds(a)
          const ot = (overtimePlan[a.id] ?? []).reduce((t, o) => t + o.end - o.start, 0)
          const acts = [...new Set((activityPlan[a.id] ?? []).map((x) => x.type))]
          const pub = serverAgents?.[a.id]?.published ?? srv?.published
          out.set(key, { start: s, end: e, ot, activities: acts, state: pub ? "published" : serverAgents?.[a.id] || srv ? "draft" : "local" })
        } else if (srv) {
          out.set(key, { start: srv.shift_start, end: srv.shift_end, ot: srv.ot_minutes, activities: srv.activities, state: srv.published ? "published" : "draft" })
        } else if (canWrite || !online) {
          const d = dayStore[date]
          const [s, e] = shiftBounds({ ...a, shift: d?.shifts[a.id] ?? baseShiftFor(a, shiftPatterns) })
          const ot = (d?.overtimePlan[a.id] ?? []).reduce((t, o) => t + o.end - o.start, 0)
          out.set(key, { start: s, end: e, ot, activities: [...new Set((d?.activityPlan[a.id] ?? []).map((x) => x.type))], state: "local" })
        } else {
          out.set(key, null) // view-only: not published yet
        }
      }
    }
    return out
  }, [dates, agents, server, scheduleDate, dayStore, shiftPatterns, overtimePlan, activityPlan, serverAgents, canWrite, online])

  const publishedOn = (date: string) => agents.filter((a) => cells.get(`${date}|${a.id}`)?.state === "published").length
  const months = useMemo(() => {
    const out: { label: string; span: number }[] = []
    for (const d of dates) {
      const label = parseISODate(d).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
      if (out.at(-1)?.label === label) out.at(-1)!.span++
      else out.push({ label, span: 1 })
    }
    return out
  }, [dates])

  return (
    <section className="glass mb-4 rounded-xl border" aria-label="3-month schedule overview">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="font-semibold">Schedules — next 3 months</span>
        <span className="text-xs text-muted-foreground">
          {fmtDay(start)} – {fmtDay(end)} · {dates.length} days · {agents.length} agents
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          <div className="mb-2 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><i className="h-3 w-5 rounded-sm border border-emerald-500/60 bg-emerald-500/15" /> Published — agents can see it</span>
            <span className="flex items-center gap-1.5"><i className="h-3 w-5 rounded-sm border border-dashed border-muted-foreground/60" /> Draft — not published yet</span>
            <span className="flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-violet-500" /> Activity (meeting, training, LOA…)</span>
            <span className="flex items-center gap-1.5"><b className="text-[9px] text-amber-600">OT</b> Overtime</span>
            <span>Click a day to open it below.</span>
          </div>
          <div className="max-h-[420px] overflow-auto rounded-md border">
            <table className="border-separate border-spacing-0 text-[10px]">
              <thead className="sticky top-0 z-20 bg-card">
                <tr>
                  <th className="sticky left-0 z-30 border-b bg-card" />
                  {months.map((mo) => (
                    <th key={mo.label} colSpan={mo.span} className="border-b border-l px-1 py-1 text-left text-[11px] font-semibold">{mo.label}</th>
                  ))}
                </tr>
                <tr>
                  <th className="sticky left-0 z-30 min-w-[150px] border-b bg-card px-2 py-1 text-left text-[11px] font-semibold">Agent</th>
                  {dates.map((d) => {
                    const n = publishedOn(d)
                    const day = parseISODate(d)
                    return (
                      <th key={d} className={cn("border-b border-l p-0 font-normal", isWeekend(d) && "bg-muted/40")}>
                        <button
                          type="button"
                          onClick={() => onOpenDate(d)}
                          aria-label={`Open ${fmtDay(d)}`}
                          aria-current={d === scheduleDate ? "date" : undefined}
                          title={`${fmtDay(d)} · ${n ? `published for ${n}/${agents.length}` : "not published"}`}
                          className={cn(
                            "flex w-11 flex-col items-center py-0.5 hover:bg-primary/10",
                            d === today && "text-primary",
                            d === scheduleDate && "bg-primary/15 font-semibold",
                          )}
                        >
                          <span>{day.toLocaleDateString("en-GB", { weekday: "short" }).slice(0, 2)}</span>
                          <span className="text-[11px] tabular-nums">{day.getDate()}</span>
                          <i
                            className={cn(
                              "h-1 w-6 rounded-full",
                              n === 0 ? "bg-transparent" : n >= agents.length ? "bg-emerald-500" : "bg-amber-500",
                            )}
                          />
                        </button>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id}>
                    <th scope="row" className="sticky left-0 z-10 border-b bg-card px-2 py-0.5 text-left font-medium">
                      <span className="block max-w-[150px] truncate text-[11px]">{a.name}</span>
                    </th>
                    {dates.map((d) => {
                      const c = cells.get(`${d}|${a.id}`)
                      const label = c
                        ? `${a.name} · ${fmtDay(d)} · ${fmtHM(c.start)}–${fmtHM(c.end)}` +
                          (c.activities.length ? ` · ${c.activities.map((t) => ACTIVITY_BY_ID[t as keyof typeof ACTIVITY_BY_ID]?.label ?? t).join(", ")}` : "") +
                          (c.ot ? ` · OT ${(c.ot / 60).toFixed(c.ot % 60 ? 1 : 0)}h` : "") +
                          ` · ${c.state === "published" ? "published" : "draft"}`
                        : `${a.name} · ${fmtDay(d)} · not published`
                      return (
                        <td key={d} className={cn("border-b border-l p-0.5", isWeekend(d) && "bg-muted/40", d === scheduleDate && "bg-primary/10")}>
                          <button
                            type="button"
                            title={label}
                            aria-label={label}
                            onClick={() => onOpenDate(d)}
                            className={cn(
                              "relative flex h-6 w-10 items-center justify-center rounded-sm tabular-nums hover:ring-1 hover:ring-primary",
                              c?.state === "published" && "border border-emerald-500/50 bg-emerald-500/10",
                              c && c.state !== "published" && "border border-dashed border-muted-foreground/50 text-muted-foreground",
                              !c && "text-muted-foreground/50",
                            )}
                          >
                            {c ? fmtHM(c.start) : "–"}
                            {c?.ot ? <b className="absolute -top-px right-0 text-[7px] leading-none text-amber-600">OT</b> : null}
                            {c?.activities.length ? (
                              <span className="absolute bottom-px left-1/2 flex -translate-x-1/2 gap-px">
                                {c.activities.slice(0, 3).map((t) => (
                                  <i key={t} className="h-1 w-1 rounded-full" style={{ background: ACTIVITY_BY_ID[t as keyof typeof ACTIVITY_BY_ID]?.color ?? "#64748b" }} />
                                ))}
                              </span>
                            ) : null}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
