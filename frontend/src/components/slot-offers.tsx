import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Hand, Lock, Minus, Plus, Sparkles, Trash2, Unlock, X } from "lucide-react"
import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { fmtHM } from "@/lib/domain/channels"
import { fmtDay, localISODate, scheduleHorizon } from "@/lib/domain/horizon"
import { usePublishedDays } from "@/components/my-schedule"
import { SLOT_KIND_BY_ID, slotMisfit, suggestSlots, type SlotKind, type SlotOptions } from "@/lib/domain/slots"
import type { Agent, PlanRow, Queue } from "@/lib/domain/types"
import {
  cancelClaim, claimOffer, deleteOffer, errorText, fetchOffers, OFFERS_KEY, openOffers, patchOffer, refreshAfterClaim, type Offer,
} from "@/lib/offers"
import { useScheduleSync } from "@/lib/scheduleSync"
import { cn } from "@/lib/utils"

const when = (o: { kind: SlotKind; start: number; end: number }) => (o.kind === "leave" ? "Full day" : `${fmtHM(o.start)}–${fmtHM(o.end)}`)

function KindChip({ kind }: { kind: SlotKind }) {
  const k = SLOT_KIND_BY_ID[kind]
  return (
    <span className="inline-flex w-12 justify-center rounded px-1.5 py-0.5 text-[10px] font-bold text-white" style={{ background: k.color }} title={k.long}>
      {k.label}
    </span>
  )
}

/** "3 filled · 2 left" with a bar. */
function FillBar({ o }: { o: Pick<Offer, "filled" | "left" | "capacity" | "kind"> }) {
  const pct = o.capacity ? (o.filled / o.capacity) * 100 : 100
  return (
    <span className="flex min-w-[150px] items-center gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: SLOT_KIND_BY_ID[o.kind].color }} />
      </span>
      <span className="text-xs tabular-nums">
        <b>{o.filled}</b> filled · <b className={o.left ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>{o.left}</b> left
      </span>
    </span>
  )
}

/** Scheduler view: slots suggested from Required vs scheduled heads for the
 *  selected day and queue, opened to agents, then tracked as they fill. */
export function SlotOffersManager({
  date,
  queue,
  plan,
  lost,
  firstIntervalStart,
  agents,
  canEdit,
}: {
  date: string
  queue: Queue
  plan: PlanRow[]
  /** Heads per interval already off on an activity (meeting, VTO, leave…). */
  lost: number[]
  firstIntervalStart: number
  agents: Agent[]
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const status = useScheduleSync((s) => s.status)
  const online = status !== "idle" && status !== "offline"
  const [opts, setOpts] = useState<SlotOptions>({ blockMinutes: 60, timeOff: "vto", ot: true, leave: false })
  const [edits, setEdits] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const { data: offers = [] } = useQuery({
    queryKey: [...OFFERS_KEY, date, date],
    queryFn: () => fetchOffers(date, date),
    enabled: online,
    refetchInterval: 20_000,
  })
  // Only what isn't already on offer for this queue is suggested.
  const open = useMemo(() => offers.filter((o) => o.queue_key === queue.id && o.status === "open"), [offers, queue.id])
  const suggestions = useMemo(() => suggestSlots(plan, lost, firstIntervalStart, opts, open), [plan, lost, firstIntervalStart, opts, open])
  const keyOf = (s: { kind: string; start: number; end: number }) => `${s.kind}@${s.start}-${s.end}`
  const capOf = (s: { kind: string; start: number; end: number; capacity: number }) => edits[keyOf(s)] ?? s.capacity
  const openSuggestions = suggestions.filter((s) => capOf(s) > 0)
  const eligible = agents.filter((a) => a.skills.includes(queue.id)).map((a) => a.id)

  async function run(fn: () => Promise<string>) {
    setBusy(true)
    setMsg(null)
    try {
      setMsg({ ok: true, text: await fn() })
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    } finally {
      setBusy(false)
      void refreshAfterClaim(queryClient)
    }
  }

  const openAll = () =>
    run(async () => {
      const res = await openOffers(
        openSuggestions.map((s) => ({
          plan_date: date, queue_key: queue.id, queue_name: queue.name, kind: s.kind, start: s.start, end: s.end, capacity: capOf(s), eligible,
        })),
      )
      setEdits({})
      return `Opened ${res.created} new slot${res.created === 1 ? "" : "s"}${res.updated ? `, updated ${res.updated}` : ""} · ${res.notified} agent${res.notified === 1 ? "" : "s"} notified`
    })

  return (
    <Card className="glass mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2"><Hand className="h-4 w-4 text-primary" /> Open slots — VTO · PTO · Overtime · Leave</CardTitle>
        <p className="text-xs text-muted-foreground">
          {fmtDay(date)} · {queue.name}. Worked out from Required HC vs scheduled heads (net of meetings, VTO and leave already booked) in each interval:
          time off where you're over, overtime where you're short, full-day leave where the whole day has room. Agents take them first come, first served,
          and each one is written into their schedule.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {canEdit && (
          <section aria-label="Suggested slots">
            <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                Over-staffing as
                <Select
                  aria-label="Offer over-staffing as"
                  className="h-7 text-xs"
                  value={opts.timeOff ?? ""}
                  onChange={(e) => setOpts({ ...opts, timeOff: (e.target.value || null) as SlotOptions["timeOff"] })}
                  options={[{ value: "vto", label: "VTO" }, { value: "pto", label: "PTO" }, { value: "", label: "Don't offer" }]}
                />
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" className="accent-primary" checked={opts.ot} onChange={(e) => setOpts({ ...opts, ot: e.target.checked })} /> Overtime where short
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" className="accent-primary" checked={opts.leave} onChange={(e) => setOpts({ ...opts, leave: e.target.checked })} /> Full-day leave
              </label>
              <label className="flex items-center gap-1.5">
                Slot length
                <Select
                  aria-label="Slot length"
                  className="h-7 text-xs"
                  value={String(opts.blockMinutes)}
                  onChange={(e) => setOpts({ ...opts, blockMinutes: Number(e.target.value) })}
                  options={[{ value: "30", label: "30 min" }, { value: "60", label: "1 hour" }, { value: "120", label: "2 hours" }]}
                />
              </label>
            </div>
            {suggestions.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                {open.length
                  ? `Everything the requirement allows for ${queue.name} is already open — see the slots below.`
                  : `Staffing matches the requirement for ${queue.name} — nothing to open with these options.`}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-left text-muted-foreground">
                    <tr><th className="px-3 py-1.5">Type</th><th className="px-3 py-1.5">When</th><th className="px-3 py-1.5">Why</th><th className="px-3 py-1.5">Slots</th></tr>
                  </thead>
                  <tbody>
                    {suggestions.map((s) => (
                      <tr key={keyOf(s)} className="border-t">
                        <td className="px-3 py-1.5"><KindChip kind={s.kind} /></td>
                        <td className="px-3 py-1.5 tabular-nums">{when(s)}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {s.kind === "ot" ? `${-s.net} short of required` : s.kind === "leave" ? `${s.net} over required all day` : `${s.net} over required`}
                        </td>
                        <td className="px-3 py-1.5">
                          <Input
                            type="number"
                            min={0}
                            max={999}
                            aria-label={`${SLOT_KIND_BY_ID[s.kind].label} slots ${when(s)}`}
                            className="h-7 w-20 text-xs"
                            value={capOf(s)}
                            onChange={(e) => setEdits({ ...edits, [keyOf(s)]: Math.max(0, Number(e.target.value) || 0) })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" disabled={!online || busy || !openSuggestions.length} onClick={() => void openAll()} title={online ? undefined : "Needs the server connection"}>
                <Sparkles className="h-3.5 w-3.5" /> Open {openSuggestions.reduce((t, s) => t + capOf(s), 0)} slot{openSuggestions.reduce((t, s) => t + capOf(s), 0) === 1 ? "" : "s"}
              </Button>
              <span className="text-[11px] text-muted-foreground">Offered to the {eligible.length} agents skilled for {queue.name}; they get a pop-up.</span>
            </div>
          </section>
        )}

        {msg && (
          <p role="status" className={cn("rounded-lg border px-3 py-2 text-xs", msg.ok ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-destructive/40 text-destructive")}>
            {msg.ok ? "✓ " : "✕ "}{msg.text}
          </p>
        )}

        <section aria-label="Open slots for this day">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Slots for {fmtDay(date)}</h3>
          {!online ? (
            <p className="text-sm text-muted-foreground">Slots live on the server — connect to see them.</p>
          ) : !offers.length ? (
            <p className="text-sm text-muted-foreground">No slots open for this day yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {offers.map((o) => (
                <li key={o.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-xs", o.status === "closed" && "opacity-60")}>
                  <KindChip kind={o.kind} />
                  <span className="w-24 font-semibold tabular-nums">{when(o)}</span>
                  <span className="w-24 truncate text-muted-foreground">{o.queue_name}</span>
                  <FillBar o={o} />
                  {o.status === "closed" && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase">Closed</span>}
                  <span className="flex flex-1 flex-wrap gap-1">
                    {o.claims.map((c) => (
                      <span key={c.id} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5">
                        {c.agent_name}
                        {canEdit && (
                          <button
                            type="button"
                            aria-label={`Cancel ${c.agent_name}'s ${SLOT_KIND_BY_ID[o.kind].label}`}
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => void run(async () => { await cancelClaim(c.id); return `Cancelled ${c.agent_name}'s ${SLOT_KIND_BY_ID[o.kind].label} — taken back out of their schedule` })}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </span>
                    ))}
                  </span>
                  {canEdit && (
                    <span className="ml-auto flex items-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={`Fewer ${SLOT_KIND_BY_ID[o.kind].label} slots`} disabled={busy || o.capacity <= o.filled}
                        onClick={() => void run(async () => { await patchOffer(o.id, { capacity: o.capacity - 1 }); return `${SLOT_KIND_BY_ID[o.kind].label} ${when(o)}: ${o.capacity - 1} slots` })}>
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={`More ${SLOT_KIND_BY_ID[o.kind].label} slots`} disabled={busy}
                        onClick={() => void run(async () => { await patchOffer(o.id, { capacity: o.capacity + 1 }); return `${SLOT_KIND_BY_ID[o.kind].label} ${when(o)}: ${o.capacity + 1} slots` })}>
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy}
                        onClick={() => void run(async () => { await patchOffer(o.id, { status: o.status === "open" ? "closed" : "open" }); return `${SLOT_KIND_BY_ID[o.kind].label} ${when(o)} ${o.status === "open" ? "closed" : "reopened"}` })}>
                        {o.status === "open" ? <><Lock className="h-3 w-3" /> Close</> : <><Unlock className="h-3 w-3" /> Reopen</>}
                      </Button>
                      {o.filled === 0 && (
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={`Remove ${SLOT_KIND_BY_ID[o.kind].label} ${when(o)}`} disabled={busy}
                          onClick={() => void run(async () => { await deleteOffer(o.id); return `Removed ${SLOT_KIND_BY_ID[o.kind].label} ${when(o)}` })}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  )
}

/** Agent view: every open slot they can take in the next 3 months with how
 *  many are filled / left, and the ones they've taken (which they can give back). */
export function AgentSlotOffers({ agentId, staffPreview }: { agentId: string; staffPreview: boolean }) {
  const queryClient = useQueryClient()
  const status = useScheduleSync((s) => s.status)
  const online = status !== "idle" && status !== "offline"
  const { start, end } = scheduleHorizon(localISODate())
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const { data: offers = [] } = useQuery({
    queryKey: [...OFFERS_KEY, start, end],
    queryFn: () => fetchOffers(start, end),
    enabled: online,
    refetchInterval: 20_000,
  })
  // Staff previewing the Agent view act for that roster agent.
  const mineOf = (o: Offer) => o.mine ?? (staffPreview ? o.claims.find((c) => c.agent_key === agentId) ?? null : null)
  // Check each slot against the agent's published day up front, rather than
  // letting them click and be told it doesn't fit.
  const { data: days } = usePublishedDays(agentId)
  const dayOn = useMemo(() => new Map((days ?? []).map((d) => [d.plan_date, d])), [days])
  const misfit = (o: Offer): string | null => {
    if (!days) return null // not loaded yet — the server still checks
    const d = dayOn.get(o.plan_date)
    return d ? slotMisfit(o.kind, o.start, o.end, [d.shift_start, d.shift_end]) : "Your schedule for this day isn't published yet"
  }
  const shown = offers.filter((o) => mineOf(o) || o.status === "open")
  const byDate = new Map<string, Offer[]>()
  for (const o of shown) byDate.set(o.plan_date, [...(byDate.get(o.plan_date) ?? []), o])

  async function act(o: Offer, fn: () => Promise<unknown>, done: string) {
    setBusy(o.id)
    setMsg(null)
    try {
      await fn()
      setMsg({ ok: true, text: done })
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    } finally {
      setBusy(null)
      void refreshAfterClaim(queryClient)
    }
  }

  return (
    <Card className="glass mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2"><Hand className="h-4 w-4 text-primary" /> Open slots for you — VTO · PTO · Overtime · Leave</CardTitle>
        <p className="text-xs text-muted-foreground">First come, first served. Taking a slot adds it to your schedule straight away; you can give it back until the day.</p>
      </CardHeader>
      <CardContent>
        {msg && (
          <p role="status" className={cn("mb-2 rounded-lg border px-3 py-2 text-xs", msg.ok ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-destructive/40 text-destructive")}>
            {msg.ok ? "✓ " : "✕ "}{msg.text}
          </p>
        )}
        {!online ? (
          <p className="text-sm text-muted-foreground">Connecting to the server…</p>
        ) : !shown.length ? (
          <p className="text-sm text-muted-foreground">No slots open right now — you'll get a pop-up when VTO, PTO, overtime or leave opens up.</p>
        ) : (
          <div className="space-y-3">
            {[...byDate].map(([d, list]) => (
              <div key={d}>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{fmtDay(d)}</p>
                <ul className="divide-y rounded-lg border">
                  {list.map((o) => {
                    const mine = mineOf(o)
                    const label = SLOT_KIND_BY_ID[o.kind].label
                    const why = mine ? null : misfit(o)
                    return (
                      <li key={o.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-xs", why && "opacity-60")}>
                        <KindChip kind={o.kind} />
                        <span className="w-24 font-semibold tabular-nums">{when(o)}</span>
                        <span className="w-24 truncate text-muted-foreground">{o.queue_name}</span>
                        <FillBar o={o} />
                        <span className="ml-auto">
                          {why ? (
                            <span className="text-[11px] italic text-muted-foreground">{why}</span>
                          ) : mine ? (
                            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy === o.id}
                              onClick={() => void act(o, () => cancelClaim(mine.id), `Gave back ${label} ${fmtDay(o.plan_date)} ${when(o)}`)}>
                              ✓ Yours · Give back
                            </Button>
                          ) : (
                            <Button size="sm" className="h-7 text-xs" disabled={busy === o.id || o.left === 0}
                              onClick={() => void act(o, () => claimOffer(o.id, staffPreview ? agentId : undefined), `${label} ${fmtDay(o.plan_date)} ${when(o)} is yours — added to your schedule`)}>
                              {o.left === 0 ? "Full" : `Take ${label}`}
                            </Button>
                          )}
                        </span>
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
