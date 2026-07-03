// Mock contact-centre data. One business day at 30-min intervals, 07:00–19:00.
import type { Agent, AuxCode, Interval, Queue, RtaEntry } from "./types"

export const QUEUES: Queue[] = [
  { id: "sales", name: "Sales", color: "#6366f1", slTarget: 0.8, targetTime: 20, aht: 280 },
  { id: "support", name: "Tech Support", color: "#22c55e", slTarget: 0.8, targetTime: 30, aht: 410 },
  { id: "billing", name: "Billing & Care", color: "#f59e0b", slTarget: 0.85, targetTime: 20, aht: 240 },
]

export const INTERVALS: Interval[] = Array.from({ length: 24 }, (_, i) => {
  const mins = 7 * 60 + i * 30
  const hh = String(Math.floor(mins / 60)).padStart(2, "0")
  const mm = String(mins % 60).padStart(2, "0")
  return { idx: i, label: `${hh}:${mm}` }
})

export const SHAPE = [
  0.22, 0.35, 0.52, 0.7, 0.86, 0.95, 1.0, 0.92, 0.8, 0.72, 0.78, 0.85, 0.7, 0.58, 0.62, 0.74,
  0.88, 0.96, 0.9, 0.78, 0.6, 0.44, 0.3, 0.2,
]

export const PEAKS: Record<string, number> = { sales: 44, support: 28, billing: 42 }

export function forecastFor(queueId: string): number[] {
  const peak = PEAKS[queueId] ?? 40
  return SHAPE.map((s, i) => {
    const jitter = 0.9 + ((i * 7 + queueId.length) % 5) * 0.04
    return Math.round(peak * s * jitter)
  })
}

export function actualsFor(queueId: string, upTo: number): (number | null)[] {
  const fc = forecastFor(queueId)
  return fc.map((v, i) => {
    if (i > upTo) return null
    const drift = 1 + Math.sin(i * 1.3 + queueId.length) * 0.12 + (i > 12 ? 0.06 : -0.03)
    return Math.max(0, Math.round(v * drift))
  })
}

export const SHRINKAGE = 0.25

export const TEAMS: Record<string, { tl: string }> = {
  Alpha: { tl: "Marcus Webb" },
  Bravo: { tl: "Elena Faro" },
  Charlie: { tl: "Sam Okoye" },
}

// Colours are deliberately distinct from the queue palette (indigo/green/amber)
// so an agent's AUX state never reads as a skill colour on the grids:
// productive = teal/sky, break = pink, lunch = orange.
export const AUX: AuxCode[] = [
  { code: "AVAIL", label: "Available", color: "#14b8a6", cat: "productive" },
  { code: "ACW", label: "After-Call Work", color: "#38bdf8", cat: "productive" },
  { code: "AUX1", label: "Break", color: "#f472b6", cat: "break", deferrable: true },
  { code: "AUX2", label: "Lunch", color: "#fb923c", cat: "break", deferrable: false },
  { code: "AUX3", label: "Team Meeting", color: "#8b5cf6", cat: "shrink", deferrable: true },
  { code: "AUX4", label: "Training", color: "#a78bfa", cat: "shrink", deferrable: false },
  { code: "AUX5", label: "Coaching", color: "#d946ef", cat: "shrink", deferrable: true },
  { code: "OFFLINE", label: "Logged Out", color: "#ef4444", cat: "offline" },
]
export const AUX_BY_CODE: Record<string, AuxCode> = Object.fromEntries(AUX.map((a) => [a.code, a]))

export function inAdherence(actualCode: string, schedCode: string): boolean {
  if (actualCode === schedCode) return true
  const a = AUX_BY_CODE[actualCode]
  const s = AUX_BY_CODE[schedCode]
  return a?.cat === "productive" && s?.cat === "productive"
}

// Actual adherence-to-schedule for one agent today: 100% minus time spent
// off-plan, over the elapsed shift so far. Historic exceptions are a stable
// per-agent deduction (hashed from the id) so the number is deterministic;
// an agent currently off-plan keeps losing adherence as their timer ticks.
export function agentAdherencePct(r: RtaEntry, elapsedSecs = 6 * 3600): number {
  const h = [...r.id].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7)
  const scrambled = Math.imul(h, 2654435761) >>> 0 // spread consecutive ids apart
  const priorOffSecs = 60 + (scrambled % 540) // 1–10 min of earlier exceptions
  const offNowSecs = inAdherence(r.actual, r.scheduled) ? 0 : r.secs
  return Math.max(0.4, 1 - (priorOffSecs + offNowSecs) / elapsedSecs)
}

const FIRST = [
  "Ava", "Liam", "Noah", "Mia", "Ethan", "Sofia", "Omar", "Grace", "Lucas", "Priya", "Daniel",
  "Hana", "Isla", "Mateo", "Zara", "Kai", "Nina", "Theo", "Aria", "Reza", "Yara", "Finn", "Leah",
  "Arjun", "Cleo", "Sven", "Maya", "Ivan", "Tess", "Diego",
]
const LAST = [
  "Mendez", "Carter", "Patel", "Chen", "Brooks", "Rossi", "Haddad", "Kim", "Muller", "Nair",
  "Okafor", "Sato", "Novak", "Reyes", "Khan", "Berg", "Lopez", "Ali", "Costa", "Singh", "Park",
  "Ahmed", "Webb", "Mehta", "Dubois", "Cruz", "Holt", "Ivanov", "Frost", "Gomez",
]
const ROSTER_PLAN = [
  { shift: "07:00–15:30", patternId: "sp-early", n: 8, team: "Alpha" },
  { shift: "08:00–16:30", patternId: "sp-midam", n: 6, team: "Alpha" },
  { shift: "09:30–18:00", patternId: "sp-midday", n: 8, team: "Bravo" },
  { shift: "10:30–19:00", patternId: "sp-late", n: 8, team: "Charlie" },
]
const SKILL_CYCLE = [
  ["sales", "billing"], ["support", "sales"], ["billing", "support"], ["sales", "support"],
  ["support", "billing"], ["billing", "sales"], ["sales"], ["support"], ["billing"],
  ["sales", "support"],
]

export function makeAgents(): Agent[] {
  const out: Agent[] = []
  let i = 0
  ROSTER_PLAN.forEach((block) => {
    for (let k = 0; k < block.n; k++, i++) {
      out.push({
        id: "a" + String(i + 1).padStart(2, "0"),
        name: `${FIRST[i]} ${LAST[i]}`,
        skills: SKILL_CYCLE[i % SKILL_CYCLE.length],
        shift: block.shift,
        shiftPatternId: block.patternId,
        team: block.team,
        tl: TEAMS[block.team].tl,
      })
    }
  })
  return out
}

export const AGENTS = makeAgents()

export function makeRTA(agents: Agent[]): RtaEntry[] {
  return agents.map((a, i) => {
    const sched =
      i % 11 === 4 ? "AUX1" :
      i % 13 === 6 ? "AUX2" :
      i % 17 === 9 ? "AUX4" :
      i % 19 === 7 ? "AUX3" :
      i % 7 === 3 ? "ACW" : "AVAIL"
    let actual = sched
    const r = i % 10
    if (sched === "AVAIL") {
      if (r === 2) actual = "AUX1"
      else if (r === 5) actual = "OFFLINE"
      else if (r === 8) actual = "AUX5"
      else if (r === 3) actual = "ACW"
    }
    const secs = ((i * 53 + 17) % 1100) + 40
    return { id: a.id, actual, scheduled: sched, secs }
  })
}

export const RTA = makeRTA(AGENTS)
