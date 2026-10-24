import { useMemo, useState } from "react"
import { CheckCircle2, Clock, XCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  CHANNEL_BY_ID,
  CHANNELS,
  channelsWorked,
  fmtHM,
  proposeOvertime,
  toMins,
  type Channel,
  type OtTiming,
} from "@/lib/domain/channels"
import type { Agent } from "@/lib/domain/types"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

export interface AddOvertimePreset {
  agentIds?: string[]
  channel?: Channel
  timing?: OtTiming
}

const DURATIONS = [30, 60, 90, 120, 180, 240]
const fmtDur = (m: number) => (m % 60 ? `${(m / 60).toFixed(1)}h` : `${m / 60}h`)
let nextId = 0

/** Add OT on a chosen channel for one or many agents, previewing exactly where
 *  each agent's block lands (or why it can't) before anything is saved. */
export function AddOvertimeDialog({
  agents,
  preset,
  onClose,
}: {
  agents: Agent[]
  preset?: AddOvertimePreset
  onClose: () => void
}) {
  const { overtimePlan, channelPlan, addOvertime } = useWfm()
  const [channel, setChannel] = useState<Channel>(preset?.channel ?? "phone")
  const [timing, setTiming] = useState<OtTiming>(preset?.timing ?? "after")
  const [duration, setDuration] = useState(60)
  const [custom, setCustom] = useState({ start: "17:00", end: "18:00" })
  const [scope, setScope] = useState<"channel" | "all">(preset?.agentIds ? "all" : "channel")
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preset?.agentIds ?? []))

  const req = useMemo(
    () => ({ channel, timing, duration, start: toMins(custom.start), end: toMins(custom.end) }),
    [channel, timing, duration, custom],
  )
  // Agents skilled on (working) the chosen channel come first; "all" lets you cross-train.
  const listed = useMemo(
    () =>
      agents
        .filter((a) => scope === "all" || selected.has(a.id) || channelsWorked(a, channelPlan, overtimePlan).has(channel))
        .filter((a) => !query || `${a.name} ${a.team}`.toLowerCase().includes(query.toLowerCase())),
    [agents, scope, selected, channelPlan, overtimePlan, channel, query],
  )
  const proposals = useMemo(
    () => new Map(agents.map((a) => [a.id, proposeOvertime(a, overtimePlan[a.id] ?? [], req)])),
    [agents, overtimePlan, req],
  )
  const ready = [...selected].flatMap((id) => {
    const p = proposals.get(id)
    return p?.ok ? [{ agentId: id, segment: { ...p.segment, id: `ot${Date.now().toString(36)}${nextId++}` } }] : []
  })
  const blocked = [...selected].filter((id) => proposals.get(id) && !proposals.get(id)!.ok).length
  const totalMins = ready.reduce((t, r) => t + r.segment.end - r.segment.start, 0)

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  function save() {
    if (!ready.length) return
    const names = ready.map((r) => agents.find((a) => a.id === r.agentId)?.name ?? r.agentId)
    const when = timing === "custom" ? `${custom.start}–${custom.end}` : `${fmtDur(duration)} ${timing} shift`
    addOvertime(
      ready,
      `${CHANNEL_BY_ID[channel].label} · ${when} · ${ready.length} agent(s), ${fmtDur(totalMins)} total: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` +${names.length - 5}` : ""}`,
    )
    onClose()
  }

  const chip = (on: boolean) =>
    cn(
      "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
      on ? "border-primary/60 bg-primary/10 font-semibold text-foreground" : "text-muted-foreground hover:bg-muted/40",
    )

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add overtime"
      description="Pick the channel, when the OT runs, and who works it. Blocks touching existing OT on the same channel are merged."
      className="max-w-3xl"
      footer={
        <>
          {blocked > 0 && <span className="mr-auto self-center text-xs text-amber-500">{blocked} selected agent(s) can't take this OT — see reasons below.</span>}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!ready.length}>
            <Clock className="h-4 w-4" /> Add {fmtDur(totalMins || 0)} OT{ready.length ? ` · ${ready.length} agent${ready.length > 1 ? "s" : ""}` : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase text-muted-foreground">Channel</h3>
          <div className="flex flex-wrap gap-2">
            {CHANNELS.map((c) => (
              <button key={c.id} type="button" aria-pressed={channel === c.id} className={chip(channel === c.id)} onClick={() => setChannel(c.id)}>
                <i
                  className="h-3 w-4 rounded-sm"
                  style={{
                    backgroundColor: `${c.color}1f`,
                    backgroundImage: `linear-gradient(${c.color} 1px, transparent 1px), linear-gradient(90deg, ${c.color} 1px, transparent 1px)`,
                    backgroundSize: "4px 4px",
                    boxShadow: `inset 0 0 0 1px ${c.color}`,
                  }}
                />
                {c.label} OT
              </button>
            ))}
          </div>
        </section>

        <section className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div>
            <h3 className="mb-1.5 text-xs font-semibold uppercase text-muted-foreground">When</h3>
            <div className="flex flex-wrap gap-2">
              {([["after", "After shift"], ["before", "Before shift"], ["custom", "Set times"]] as const).map(([id, label]) => (
                <button key={id} type="button" aria-pressed={timing === id} className={chip(timing === id)} onClick={() => setTiming(id)}>{label}</button>
              ))}
            </div>
          </div>
          {timing === "custom" ? (
            <div className="flex items-center gap-2">
              <Input type="time" step={900} className="w-28" aria-label="OT start" value={custom.start} onChange={(e) => e.target.value && setCustom({ ...custom, start: e.target.value })} />
              <span className="text-muted-foreground">–</span>
              <Input type="time" step={900} className="w-28" aria-label="OT end" value={custom.end} onChange={(e) => e.target.value && setCustom({ ...custom, end: e.target.value })} />
            </div>
          ) : (
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase text-muted-foreground">Length</h3>
              <div className="flex flex-wrap gap-2">
                {DURATIONS.map((d) => (
                  <button key={d} type="button" aria-pressed={duration === d} className={chip(duration === d)} onClick={() => setDuration(d)}>{fmtDur(d)}</button>
                ))}
              </div>
            </div>
          )}
        </section>

        <section>
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">Agents</h3>
            <button type="button" className={chip(scope === "channel")} onClick={() => setScope("channel")}>Working {CHANNEL_BY_ID[channel].label}</button>
            <button type="button" className={chip(scope === "all")} onClick={() => setScope("all")}>All agents</button>
            <Input className="ml-auto h-8 w-44" placeholder="Search name / team" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search agents" />
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => setSelected(new Set([...selected, ...listed.filter((a) => proposals.get(a.id)?.ok).map((a) => a.id)]))}
            >
              Select all eligible
            </Button>
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-lg border">
            {listed.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">No agents match. Try "All agents".</p>}
            {listed.map((a) => {
              const p = proposals.get(a.id)!
              const on = selected.has(a.id)
              const worked = channelsWorked(a, channelPlan, overtimePlan)
              return (
                <label
                  key={a.id}
                  className={cn("flex cursor-pointer items-center gap-3 border-b px-3 py-1.5 text-sm last:border-b-0 hover:bg-muted/30", on && "bg-primary/5")}
                >
                  <input type="checkbox" className="accent-primary" checked={on} onChange={() => toggle(a.id)} aria-label={`Select ${a.name}`} />
                  <span className="w-36 truncate font-medium">{a.name}</span>
                  <span className="w-24 tabular-nums text-xs text-muted-foreground">{a.shift}</span>
                  <span className="flex w-14 gap-1">
                    {CHANNELS.filter((c) => worked.has(c.id)).map((c) => (
                      <i key={c.id} title={c.label} className="h-2 w-2 rounded-full" style={{ background: c.color }} />
                    ))}
                  </span>
                  <span className={cn("ml-auto flex items-center gap-1 text-xs tabular-nums", p.ok ? "text-emerald-500" : "text-destructive")}>
                    {p.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                    {p.ok ? `${fmtHM(p.segment.start)}–${fmtHM(p.segment.end)}` : p.reason}
                  </span>
                </label>
              )
            })}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {selected.size} selected · {ready.length} will get OT{totalMins ? ` · ${fmtDur(totalMins)} in total` : ""}. OT counts toward coverage & SL for every queue the agent is skilled on.
          </p>
        </section>
      </div>
    </Dialog>
  )
}
