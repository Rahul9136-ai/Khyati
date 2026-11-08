import { useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { ACTIVITY_BY_ID, fmtHM, shiftBounds } from "@/lib/domain/channels"
import { employedOn } from "@/lib/domain/employeeProfile"
import { addDays, datesBetween, fmtDay, isWeekend, localISODate, parseISODate, scheduleHorizon } from "@/lib/domain/horizon"
import type { Agent } from "@/lib/domain/types"
import { fetchRange, useScheduleHorizon, type DaySummary } from "@/lib/schedulePublish"
import { useScheduleSync } from "@/lib/scheduleSync"
import { cn } from "@/lib/utils"
import { scheduleForDate, useWfm } from "@/store/wfm"

/** Activities that take the whole day, shown in place of the shift time —
 *  most important first when a day has several. */
const DAY_STATUS = ["absence", "leave", "loa", "off"] as const
type DayStatus = (typeof DAY_STATUS)[number]
const STATUS_LABEL: Record<DayStatus, string> = { absence: "Absence", leave: "Leave", loa: "LOA", off: "Week off" }
const dayStatus = (activities: string[]): DayStatus | null => DAY_STATUS.find((t) => activities.includes(t)) ?? null

/** One agent-day as the overview draws it. */
interface Cell {
  start: number
  end: number
  ot: number
  activities: string[]
  /** "published" = agents can see it; "draft" = saved, not published; "local" = only in this browser. */
  state: "published" | "draft" | "local"
}

/** Days drawn at once (4 weeks). */
const WINDOW_DAYS = 28

/** The 4-week window that holds `date` (or the first one). */
function windowStartFor(dates: string[], date: string): number {
  const i = dates.indexOf(date)
  return i < 0 ? 0 : Math.floor(i / WINDOW_DAYS) * WINDOW_DAYS
}

/** Weeks of history the overview shows before today (whole 4-week pages, so a
 *  page starts on today); fewer when the generated horizon is very long, so the
 *  whole range stays within one server request (380 days). */
export const PAST_WEEKS = 12
const MAX_RANGE_DAYS = 380
function pastDays(today: string, end: string): number {
  const ahead = datesBetween(today, end).length
  const room = Math.max(0, MAX_RANGE_DAYS - ahead)
  return Math.min(PAST_WEEKS * 7, Math.floor(room / WINDOW_DAYS) * WINDOW_DAYS)
}

/** Every agent's shift for every day of the next 3 months (or as far as
 *  schedules have been generated): published days are solid, drafts dashed. Click a day (or a cell) to open it on the timeline. */
export function ScheduleOverview({ agents, onOpenDate }: { agents: Agent[]; onOpenDate: (date: string) => void }) {
  const [open, setOpen] = useState(true)
  const today = localISODate()
  const { end } = useScheduleHorizon()
  const extended = end !== scheduleHorizon(today).end
  // History too: past days show what was saved (and published) then.
  const back = pastDays(today, end)
  const start = addDays(today, -back)
  const allDates = useMemo(() => datesBetween(start, end), [start, end])
  // Four weeks on screen at a time: a long generated horizon (up to 52 weeks ×
  // every agent) drawn at once froze the page for seconds.
  const selected = useWfm((s) => s.scheduleDate)
  const [offset, setOffset] = useState(() => windowStartFor(allDates, selected))
  const first = Math.min(offset, Math.max(0, allDates.length - WINDOW_DAYS))
  const dates = useMemo(() => allDates.slice(first, first + WINDOW_DAYS), [allDates, first])
  const windows = Math.max(1, Math.ceil(allDates.length / WINDOW_DAYS))
  const windowNo = Math.floor(first / WINDOW_DAYS) + 1
  // Picking another day in the date bar brings its weeks up (paging with
  // Previous / Next doesn't — only a change of the selected day does).
  const lastSelected = useRef(selected)
  useEffect(() => {
    if (lastSelected.current === selected) return
    lastSelected.current = selected
    const i = allDates.indexOf(selected)
    if (i >= 0) setOffset(windowStartFor(allDates, selected))
  }, [selected, allDates])
  const { status, canWrite, serverAgents } = useScheduleSync()
  const online = status !== "idle" && status !== "offline"
  const { data: server } = useQuery({
    queryKey: ["schedule-range", start, end],
    queryFn: () => fetchRange(start, end),
    enabled: online,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  const { scheduleDate, dayStore, shiftPatterns, overtimePlan, activityPlan, agents: roster, breakOverrides, channelPlan, employeeProfiles } = useWfm()
  /** Not on the books that day — before they join or after their last working day. */
  const outside = useCallback((agentId: string, date: string) => {
    const p = employeeProfiles[agentId]
    return !!p && !employedOn(p, date)
  }, [employeeProfiles])

  const cells = useMemo(() => {
    const byKey = new Map<string, DaySummary>((server ?? []).map((r) => [`${r.plan_date}|${r.agent_key}`, r]))
    const out = new Map<string, Cell | null>()
    for (const date of dates) {
      // This browser's copy of the date (parked edits, or work-rule defaults incl. week offs).
      let local: ReturnType<typeof scheduleForDate> | null = null
      for (const a of agents) {
        const key = `${date}|${a.id}`
        if (outside(a.id, date)) {
          out.set(key, null)
          continue
        }
        const srv = byKey.get(key)
        if (date < today && !srv && !(date === scheduleDate && serverAgents?.[a.id])) {
          out.set(key, null) // a past day nobody saved: there's no record, so nothing is made up
          continue
        }
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
          local ??= scheduleForDate({ scheduleDate, dayStore, agents: roster, shiftPatterns, breakOverrides, channelPlan, overtimePlan, activityPlan }, date)
          const me = local.agents.find((x) => x.id === a.id) ?? a
          const [s, e] = shiftBounds(me)
          const ot = (local.overtimePlan[a.id] ?? []).reduce((t, o) => t + o.end - o.start, 0)
          out.set(key, { start: s, end: e, ot, activities: [...new Set((local.activityPlan[a.id] ?? []).map((x) => x.type))], state: "local" })
        } else {
          out.set(key, null) // view-only: not published yet
        }
      }
    }
    return out
  }, [dates, agents, server, scheduleDate, dayStore, shiftPatterns, overtimePlan, activityPlan, serverAgents, canWrite, online, roster, breakOverrides, channelPlan, outside, today])

  // Days off / leave / absence per agent and in total over the period.
  const counts = useMemo(() => {
    const per = new Map<string, Record<DayStatus, number>>()
    const total: Record<DayStatus, number> = { absence: 0, leave: 0, loa: 0, off: 0 }
    for (const a of agents) {
      const mine: Record<DayStatus, number> = { absence: 0, leave: 0, loa: 0, off: 0 }
      for (const d of dates) {
        const st = dayStatus(cells.get(`${d}|${a.id}`)?.activities ?? [])
        if (st) {
          mine[st]++
          total[st]++
        }
      }
      per.set(a.id, mine)
    }
    return { per, total }
  }, [agents, dates, cells])

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
        <span className="font-semibold">Schedules — {back ? `past ${back / 7} weeks and ` : ""}{extended ? `through ${fmtDay(end)}` : "next 3 months"}</span>
        <span className="text-xs text-muted-foreground">
          {fmtDay(start)} – {fmtDay(end)} · {allDates.length} days · {agents.length} agents
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          <div className="mb-2 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><i className="h-3 w-5 rounded-sm border border-emerald-500/60 bg-emerald-500/15" /> Published — agents can see it</span>
            <span className="flex items-center gap-1.5"><i className="h-3 w-5 rounded-sm border border-dashed border-muted-foreground/60" /> Draft — not published yet</span>
            {DAY_STATUS.map((t) => (
              <span key={t} className="flex items-center gap-1.5">
                <i className="flex h-3 items-center rounded-sm px-1 text-[8px] font-bold not-italic text-white" style={{ background: ACTIVITY_BY_ID[t].color }}>{ACTIVITY_BY_ID[t].short}</i>
                {STATUS_LABEL[t]} <b className="tabular-nums text-foreground">{counts.total[t]}</b>
              </span>
            ))}
            <span className="flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-violet-500" /> Part-day activity (meeting, training, VTO…)</span>
            <span className="flex items-center gap-1.5"><b className="text-[9px] text-amber-600">OT</b> Overtime</span>
            <span>Click a day to open it below.</span>
          </div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <Button variant="outline" size="sm" className="h-7" disabled={first === 0} onClick={() => setOffset(Math.max(0, first - WINDOW_DAYS))}>
              <ChevronLeft className="h-3.5 w-3.5" /> Previous 4 weeks
            </Button>
            <span className="font-medium tabular-nums">
              {dates.length ? `${fmtDay(dates[0])} – ${fmtDay(dates.at(-1)!)}` : "—"}
            </span>
            <span className="text-muted-foreground">· weeks {(windowNo - 1) * 4 + 1}–{Math.min(windowNo * 4, Math.ceil(allDates.length / 7))} of {Math.ceil(allDates.length / 7)}</span>
            <Button variant="outline" size="sm" className="h-7" disabled={first + WINDOW_DAYS >= allDates.length} onClick={() => setOffset(first + WINDOW_DAYS)}>
              Next 4 weeks <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            {windows > 1 && (
              <Button variant="ghost" size="sm" className="h-7" disabled={first === back} onClick={() => setOffset(back)}>
                This week
              </Button>
            )}
            {dates[0] < today && <span className="text-muted-foreground">Past days show what was saved then (view only).</span>}
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
                {agents.map((a) => {
                  const mine = counts.per.get(a.id)!
                  const tally = DAY_STATUS.filter((t) => mine[t]).map((t) => `${mine[t]} ${ACTIVITY_BY_ID[t].short}`).join(" · ")
                  return (
                  <tr key={a.id}>
                    <th scope="row" className="sticky left-0 z-10 border-b bg-card px-2 py-0.5 text-left font-medium">
                      <span className="block max-w-[150px] truncate text-[11px]">{a.name}</span>
                      {tally && <span className="block text-[9px] font-normal text-muted-foreground" title="Days off / leave / absence in these dates">{tally}</span>}
                    </th>
                    {dates.map((d) => {
                      const c = cells.get(`${d}|${a.id}`)
                      const status = c ? dayStatus(c.activities) : null
                      const others = c ? c.activities.filter((t) => t !== status) : []
                      const label = c
                        ? `${a.name} · ${fmtDay(d)} · ${status ? STATUS_LABEL[status] : `${fmtHM(c.start)}–${fmtHM(c.end)}`}` +
                          (others.length ? ` · ${others.map((t) => ACTIVITY_BY_ID[t as keyof typeof ACTIVITY_BY_ID]?.label ?? t).join(", ")}` : "") +
                          (c.ot ? ` · OT ${(c.ot / 60).toFixed(c.ot % 60 ? 1 : 0)}h` : "") +
                          ` · ${c.state === "published" ? "published" : "draft"}`
                        : outside(a.id, d)
                          ? `${a.name} · ${fmtDay(d)} · not employed`
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
                              c?.state === "published" && !status && "border border-emerald-500/50 bg-emerald-500/10",
                              c && c.state !== "published" && !status && "border border-dashed border-muted-foreground/50 text-muted-foreground",
                              // Draft off / leave / absence: dashed white edge, slightly faded.
                              status && "font-bold text-white",
                              status && c?.state !== "published" && "border border-dashed border-white/70 opacity-75",
                              !c && "text-muted-foreground/50",
                              !c && outside(a.id, d) && "cursor-default bg-[repeating-linear-gradient(135deg,transparent,transparent_3px,hsl(var(--muted))_3px,hsl(var(--muted))_5px)]",
                            )}
                            style={status ? { background: ACTIVITY_BY_ID[status].color } : undefined}
                          >
                            {status ? ACTIVITY_BY_ID[status].short : c ? fmtHM(c.start) : outside(a.id, d) ? "" : "–"}
                            {c?.ot ? <b className="absolute -top-px right-0 text-[7px] leading-none text-amber-600">OT</b> : null}
                            {others.length ? (
                              <span className="absolute bottom-px left-1/2 flex -translate-x-1/2 gap-px">
                                {others.slice(0, 3).map((t) => (
                                  <i key={t} className="h-1 w-1 rounded-full" style={{ background: ACTIVITY_BY_ID[t as keyof typeof ACTIVITY_BY_ID]?.color ?? "#64748b" }} />
                                ))}
                              </span>
                            ) : null}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
