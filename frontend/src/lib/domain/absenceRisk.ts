// AI absence/no-show risk — flags agents statistically likely to be absent or
// late for an upcoming shift, so a scheduler can build in buffer *before* it
// happens instead of reacting on the day.
//
// There's no backend attendance-history endpoint feeding these two (frontend-
// simulated) pages, so this stands up a deterministic synthetic attendance
// ledger per agent — seeded by agent id, so it's stable across renders and
// reloads, not re-randomised on every click — and scores risk from it. Swap
// `attendanceHistory` for a real ledger (e.g. the backend attendance module)
// without touching the scoring or the UI once one exists.
import { mulberry32 } from "./modelUtils"
import type { Agent } from "./types"

export type RiskLevel = "low" | "medium" | "high"

export interface AbsenceRisk {
  agentId: string
  name: string
  riskPct: number // 0–100
  level: RiskLevel
  sampleSize: number
  recentAbsences: number
  recentLates: number
  reason: string
}

const HISTORY_LEN = 20 // last 20 scheduled shifts

function seedFromId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0
  return h || 1
}

/** Deterministic synthetic attendance ledger for one agent's last
 * `HISTORY_LEN` scheduled shifts — each agent gets their own stable baseline
 * absence/lateness rate (some agents just run hotter than others), then a
 * per-shift roll against it. */
function attendanceHistory(agentId: string): { absent: boolean; late: boolean }[] {
  const rand = mulberry32(seedFromId(agentId))
  const baseAbsenceRate = 0.02 + rand() * 0.16 // 2%–18%, varies per agent
  const baseLateRate = 0.02 + rand() * 0.14 // 2%–16%
  const out: { absent: boolean; late: boolean }[] = []
  for (let i = 0; i < HISTORY_LEN; i++) {
    const absent = rand() < baseAbsenceRate
    out.push({ absent, late: !absent && rand() < baseLateRate })
  }
  return out
}

function levelFor(riskPct: number): RiskLevel {
  if (riskPct >= 30) return "high"
  if (riskPct >= 15) return "medium"
  return "low"
}

/** Risk score per agent, weighted toward absences (costlier than lateness) —
 * 70/30 split, rounded to a whole percent. */
export function computeAbsenceRisk(agents: Agent[]): AbsenceRisk[] {
  return agents
    .map((a) => {
      const hist = attendanceHistory(a.id)
      const recentAbsences = hist.filter((h) => h.absent).length
      const recentLates = hist.filter((h) => h.late).length
      const riskPct = Math.round(
        (recentAbsences / HISTORY_LEN) * 70 + (recentLates / HISTORY_LEN) * 30,
      )
      const level = levelFor(riskPct)
      const reason = recentAbsences === 0 && recentLates === 0
        ? `Clean record over the last ${HISTORY_LEN} shifts.`
        : `Absent ${recentAbsences} and late ${recentLates} of the last ${HISTORY_LEN} shifts.`
      return {
        agentId: a.id, name: a.name, riskPct, level,
        sampleSize: HISTORY_LEN, recentAbsences, recentLates, reason,
      }
    })
    .sort((a, b) => b.riskPct - a.riskPct)
}
