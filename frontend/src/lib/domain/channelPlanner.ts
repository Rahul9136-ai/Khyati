// Automatic Phone / Chat / Email alignment for a day ("phone first").
//
// In every 30-min interval, the agents who are actually available (on shift,
// not on a break and not in a meeting / VTO / leave…) are split:
//   1. Phone — enough to cover the requirement (heads needed on the line for
//      all queues together, before shrinkage — breaks and activities are
//      already taken out by only counting free agents), less phone OT;
//   2. Chat  — a minimum number of heads, less chat OT;
//   3. Email — everyone left over.
// To keep schedules calm, an agent stays on the channel they had in the
// previous interval (or the one they're already scheduled on) when possible,
// so blocks only change where the need does. OT blocks are never moved.
import { CHANNELS, fmtHM, type AgentDay, type Channel, type ChannelSegment } from "@/lib/domain/channels"

export interface ChannelPlanOptions {
  /** Chat heads to keep in every interval once phone is covered. */
  chatMin: number
}

export interface PlannedAgent {
  key: string
  before: ChannelSegment[]
  after: ChannelSegment[]
  changed: boolean
}

export interface ChannelDayPlan {
  agents: PlannedAgent[]
  /** Heads on each channel per interval (incl. OT), before and after. */
  before: Record<Channel, number[]>
  after: Record<Channel, number[]>
  need: number[]
  /** How far phone falls below the requirement / chat below its minimum,
   *  in head-hours over the day (0 = covered everywhere). */
  phoneGap: { before: number; after: number }
  chatGap: { before: number; after: number }
}

const covers = (x: { start: number; end: number }, t: number) => x.start <= t && t < x.end

/** Free to take contacts at minute t: on shift, not on a break or activity. */
export function availableAt(day: AgentDay, t: number): boolean {
  return covers({ start: day.shift[0], end: day.shift[1] }, t) && !day.breaks.some((b) => covers(b, t)) && !day.activities.some((a) => covers(a, t))
}

const channelAt = (segs: ChannelSegment[], t: number): Channel | undefined => segs.find((s) => covers(s, t))?.channel

/** Join neighbouring blocks on the same channel (ids aside) so plans compare by content. */
export function lanes(segs: ChannelSegment[]): [Channel, number, number][] {
  const out: [Channel, number, number][] = []
  for (const s of [...segs].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1)
    if (last && last[0] === s.channel && last[2] === s.start) last[2] = s.end
    else out.push([s.channel, s.start, s.end])
  }
  return out
}

export const describeLanes = (segs: ChannelSegment[]) =>
  lanes(segs).map(([c, s, e]) => `${CHANNELS.find((x) => x.id === c)!.label} ${fmtHM(s)}–${fmtHM(e)}`).join(" · ")

function heads(days: { day: AgentDay; segs: ChannelSegment[] }[], times: number[]): Record<Channel, number[]> {
  const out: Record<Channel, number[]> = { phone: [], chat: [], email: [] }
  times.forEach((t, i) => {
    for (const c of CHANNELS) out[c.id][i] = 0
    for (const { day, segs } of days) {
      const ch = availableAt(day, t) ? channelAt(segs, t) : undefined
      if (ch) out[ch][i]++
      for (const o of day.ot) if (covers(o, t)) out[o.channel][i]++
    }
  })
  return out
}

export function planChannelDay(
  agents: { key: string; day: AgentDay }[],
  need: number[],
  firstIntervalStart: number,
  opts: ChannelPlanOptions,
): ChannelDayPlan {
  const times = need.map((_, i) => firstIntervalStart + i * 30)
  const prev = new Map<string, Channel>()
  const chosen = new Map<string, (Channel | undefined)[]>(agents.map((a) => [a.key, []]))
  const prefer = (want: Channel) => (a: { key: string; day: AgentDay }, i: number) =>
    (prev.get(a.key) === want ? 0 : 2) + (channelAt(a.day.channels, times[i]) === want ? 0 : 1)

  times.forEach((t, i) => {
    const free = agents.filter((a) => availableAt(a.day, t))
    const otOn = (ch: Channel) => agents.reduce((n, a) => n + a.day.ot.filter((o) => o.channel === ch && covers(o, t)).length, 0)
    let pool = [...free]
    const take = (want: Channel, count: number) => {
      const order = pool.map((a) => ({ a, score: prefer(want)(a, i) })).sort((x, y) => x.score - y.score || x.a.key.localeCompare(y.a.key))
      const picked = order.slice(0, Math.max(0, count)).map((x) => x.a)
      for (const a of picked) chosen.get(a.key)![i] = want
      pool = pool.filter((a) => !picked.includes(a))
    }
    take("phone", Math.ceil(need[i]) - otOn("phone"))
    take("chat", opts.chatMin - otOn("chat"))
    take("email", pool.length)
    for (const a of free) prev.set(a.key, chosen.get(a.key)![i]!)
  })

  const planned: PlannedAgent[] = agents.map(({ key, day }) => {
    const picks = chosen.get(key)!
    const before = day.channels
    if (!picks.some(Boolean)) return { key, before, after: before, changed: false } // never free in the window
    // Breaks / activities / time before the first interval keep the nearest choice.
    const firstPick = picks.find(Boolean)!
    let carry: Channel = firstPick
    const filled = times.map((_, i) => (carry = picks[i] ?? carry))
    const [s, e] = day.shift
    const channelFor = (t: number): Channel => {
      const i = Math.floor((t - firstIntervalStart) / 30)
      if (i < 0) return firstPick
      if (i >= filled.length) return filled.at(-1)!
      return filled[i]
    }
    // Cut the shift at interval boundaries and label each piece.
    const cuts = [s, ...times.filter((t) => t > s && t < e), e]
    const after: ChannelSegment[] = []
    for (let k = 0; k < cuts.length - 1; k++) {
      const ch = channelFor(cuts[k])
      const last = after.at(-1)
      if (last && last.channel === ch) last.end = cuts[k + 1]
      else after.push({ id: `ap${after.length}`, channel: ch, start: cuts[k], end: cuts[k + 1] })
    }
    const changed = JSON.stringify(lanes(before)) !== JSON.stringify(lanes(after))
    return { key, before, after: changed ? after : before, changed }
  })

  const beforeHeads = heads(agents.map((a) => ({ day: a.day, segs: a.day.channels })), times)
  const afterHeads = heads(agents.map((a, i) => ({ day: a.day, segs: planned[i].after })), times)
  // Each interval is half an hour, so a head short there is 0.5 head-hours.
  const gap = (h: Record<Channel, number[]>) => ({
    phone: need.reduce((t, n, i) => t + Math.max(0, Math.ceil(n) - h.phone[i]) / 2, 0),
    chat: need.reduce((t, _, i) => t + Math.max(0, opts.chatMin - h.chat[i]) / 2, 0),
  })
  const [b, a] = [gap(beforeHeads), gap(afterHeads)]
  return {
    agents: planned,
    before: beforeHeads,
    after: afterHeads,
    need,
    phoneGap: { before: b.phone, after: a.phone },
    chatGap: { before: b.chat, after: a.chat },
  }
}
