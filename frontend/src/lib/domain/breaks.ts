// Break optimisation. Every shift pattern places breaks at the same offsets
// (+2h / +4h / +6h), so whole shift-blocks vanish from the phones at once and
// service level dips in sync. The optimiser staggers each agent's break and
// lunch (±60 min, in 30-min steps) to minimise the volume-weighted SL
// shortfall across every queue — honestly, through the same Erlang C math the
// rest of the app uses.
import { serviceLevel, trafficIntensity } from "./erlang"
import { INTERVALS } from "./seed"
import { resolvePatternForAgent, type BreakSegment, type BreakType, type ShiftPattern } from "./shiftPatterns"
import type { Agent, Queue } from "./types"

/** Per-agent break segments (offsets relative to that agent's shift start)
 *  that replace the shared pattern defaults once the optimiser has run. */
export type BreakOverrides = Record<string, BreakSegment[]>

const DASH = "–"
const toMins = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}
const intervalStart = (i: number) => 7 * 60 + i * 30

function shiftRange(shift: string): [number, number] {
  const [s, e] = shift.split(DASH)
  return [toMins(s), toMins(e)]
}

export function effectiveSegments(agent: Agent, patterns: ShiftPattern[], overrides: BreakOverrides): BreakSegment[] {
  return overrides[agent.id] ?? resolvePatternForAgent(agent, patterns).breaks
}

function idxForOffset(shiftStartMins: number, offsetMinutes: number, durationMinutes: number): number[] {
  const s = shiftStartMins + offsetMinutes
  const e = s + durationMinutes
  const out: number[] = []
  for (let i = 0; i < INTERVALS.length; i++) {
    const m = intervalStart(i)
    if (m >= s && m < e) out.push(i)
  }
  return out
}

/** Interval → break type map for one agent, honouring optimiser overrides. */
export function agentBreakMarkers(agent: Agent, patterns: ShiftPattern[], overrides: BreakOverrides): Map<number, BreakType> {
  const [start] = shiftRange(agent.shift)
  const map = new Map<number, BreakType>()
  for (const seg of effectiveSegments(agent, patterns, overrides)) {
    idxForOffset(start, seg.offsetMinutes, seg.durationMinutes).forEach((i) => map.set(i, seg.type))
  }
  return map
}

function onShiftIdx(shift: string): boolean[] {
  const [s, e] = shiftRange(shift)
  return INTERVALS.map((_, i) => {
    const m = intervalStart(i)
    return m >= s && m < e
  })
}

/** Heads actually on the phones per interval: on shift and not on break. */
export function breakAwareCoverage(
  queueId: string,
  agents: Agent[],
  patterns: ShiftPattern[],
  overrides: BreakOverrides,
): number[] {
  const cover = INTERVALS.map(() => 0)
  for (const a of agents) {
    if (!a.skills.includes(queueId)) continue
    const shift = onShiftIdx(a.shift)
    const markers = agentBreakMarkers(a, patterns, overrides)
    for (let i = 0; i < cover.length; i++) if (shift[i] && !markers.has(i)) cover[i]++
  }
  return cover
}

/** Erlang C projected SL per interval for a given coverage line. */
export function projectedSLRow(volume: number[], coverage: number[], queue: Queue, shrinkage: number): number[] {
  return INTERVALS.map((_, i) => {
    const v = volume[i] ?? 0
    const net = Math.round((coverage[i] ?? 0) * (1 - shrinkage))
    return serviceLevel(net, trafficIntensity(v, queue.aht, 1800), queue.aht, queue.targetTime)
  })
}

export interface BreakOptimisation {
  overrides: BreakOverrides
  /** Break/lunch segments that ended up in a different slot. */
  moved: number
  /** Queue-intervals (volume > 0) below SL target, before → after. */
  beforeUnder: number
  afterUnder: number
}

export function optimiseBreaks(
  queues: Queue[],
  forecasts: Record<string, number[]>,
  shrinkage: number,
  agents: Agent[],
  patterns: ShiftPattern[],
  current: BreakOverrides,
): BreakOptimisation {
  // Working copy of every agent's segments.
  const segs: Record<string, BreakSegment[]> = {}
  agents.forEach((a) => {
    segs[a.id] = effectiveSegments(a, patterns, current).map((s) => ({ ...s }))
  })

  const qMeta = queues.map((q) => {
    const vol = forecasts[q.id] ?? INTERVALS.map(() => 0)
    return { q, vol, intensity: vol.map((v) => trafficIntensity(v, q.aht, 1800)) }
  })
  const skilled: Record<string, number[]> = {}
  agents.forEach((a) => {
    skilled[a.id] = qMeta.flatMap(({ q }, qi) => (a.skills.includes(q.id) ? [qi] : []))
  })

  // Break-aware coverage per queue from the working segments.
  const cov: number[][] = qMeta.map(() => INTERVALS.map(() => 0))
  const shiftIdx: Record<string, boolean[]> = {}
  const shiftStart: Record<string, number> = {}
  agents.forEach((a) => {
    shiftIdx[a.id] = onShiftIdx(a.shift)
    shiftStart[a.id] = shiftRange(a.shift)[0]
    const onBreak = new Set(segs[a.id].flatMap((s) => idxForOffset(shiftStart[a.id], s.offsetMinutes, s.durationMinutes)))
    for (const qi of skilled[a.id]) {
      for (let i = 0; i < INTERVALS.length; i++) if (shiftIdx[a.id][i] && !onBreak.has(i)) cov[qi][i]++
    }
  })

  // Volume-weighted SL shortfall for one cell; the optimiser minimises its sum.
  // The deficit term keeps intervals whose SL already bottomed out at 0% from
  // becoming free dumping grounds — sinking further below the Erlang floor
  // still costs, so breaks spread instead of piling into one dead interval.
  const cellPenalty = (qi: number, i: number, covVal: number) => {
    const { q, vol, intensity } = qMeta[qi]
    if (!vol[i]) return 0
    const net = Math.round(covVal * (1 - shrinkage))
    const sl = serviceLevel(net, intensity[i], q.aht, q.targetTime)
    const deficit = Math.max(0, intensity[i] - net)
    return vol[i] * Math.max(0, q.slTarget - sl) + 2 * deficit
  }
  const pen: number[][] = qMeta.map((_, qi) => INTERVALS.map((_, i) => cellPenalty(qi, i, cov[qi][i])))

  const underCount = () =>
    qMeta.reduce((acc, { q, vol, intensity }, qi) => {
      for (let i = 0; i < INTERVALS.length; i++) {
        if (!vol[i]) continue
        const net = Math.round(cov[qi][i] * (1 - shrinkage))
        if (serviceLevel(net, intensity[i], q.aht, q.targetTime) < q.slTarget) acc++
      }
      return acc
    }, 0)

  const beforeUnder = underCount()
  let moved = 0

  // Coordinate descent: two passes, one segment at a time, ±90 min window.
  for (let pass = 0; pass < 2; pass++) {
    for (const a of agents) {
      const [ss, se] = shiftRange(a.shift)
      const shiftLen = se - ss
      for (const seg of segs[a.id]) {
        const oldIdx = idxForOffset(ss, seg.offsetMinutes, seg.durationMinutes)
        const otherIdx = new Set(
          segs[a.id].filter((x) => x.id !== seg.id).flatMap((x) => idxForOffset(ss, x.offsetMinutes, x.durationMinutes)),
        )
        let bestOffset = seg.offsetMinutes
        let bestDelta = 0
        for (let k = -3; k <= 3; k++) {
          if (k === 0) continue
          const cand = seg.offsetMinutes + k * 30
          // keep a 30-min buffer from both shift edges, stay inside the shift
          if (cand < 30 || cand + seg.durationMinutes > shiftLen - 30) continue
          const newIdx = idxForOffset(ss, cand, seg.durationMinutes)
          if (newIdx.some((i) => otherIdx.has(i)) || newIdx.length === 0) continue
          let delta = 0
          for (const qi of skilled[a.id]) {
            for (const i of oldIdx) delta += cellPenalty(qi, i, cov[qi][i] + 1) - pen[qi][i]
            for (const i of newIdx) delta += cellPenalty(qi, i, cov[qi][i] - 1) - pen[qi][i]
          }
          if (delta < bestDelta - 1e-9) {
            bestDelta = delta
            bestOffset = cand
          }
        }
        if (bestOffset !== seg.offsetMinutes) {
          const newIdx = idxForOffset(ss, bestOffset, seg.durationMinutes)
          for (const qi of skilled[a.id]) {
            for (const i of oldIdx) {
              cov[qi][i]++
              pen[qi][i] = cellPenalty(qi, i, cov[qi][i])
            }
            for (const i of newIdx) {
              cov[qi][i]--
              pen[qi][i] = cellPenalty(qi, i, cov[qi][i])
            }
          }
          seg.offsetMinutes = bestOffset
          moved++
        }
      }
    }
  }

  return { overrides: segs, moved, beforeUnder, afterUnder: underCount() }
}
