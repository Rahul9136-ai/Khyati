// Keeps every open browser tab of the app in step. The store is saved to
// localStorage ("flowforce-wfm"); when another tab saves, its changes are
// taken over here: the real-time board, roster, profiles, the Intraday clock …
// and every day's schedule. Each tab keeps its own view (which day the
// Scheduling page shows): a day's schedule is applied wherever this tab keeps
// that day — its open day or a parked one — so browsing a different date in
// one tab doesn't move the others, and the real-time board (which follows
// today's schedule) reads the same schedule in every tab.
import type { Agent } from "@/lib/domain/types"
import { useWfm, type DaySlices } from "@/store/wfm"

const STORAGE_KEY = "flowforce-wfm"

/** Store fields every tab shares as they are. */
export const SHARED_KEYS = [
  "rta", "nowIdx", "employeeProfiles", "formerEmployees", "employeeChanges", "dataSources",
  "queues", "shiftPatterns", "workRules", "workCompliance", "shrinkage", "thresholds", "ruleState",
  "exceptions", "ptoRequests", "swaps", "messages", "auditLog", "skillChangeRecommendations", "forecasts",
] as const

type State = ReturnType<typeof useWfm.getState>
type Saved = Partial<Pick<State, "scheduleDate" | "dayStore" | "agents" | "breakOverrides" | "channelPlan" | "overtimePlan" | "activityPlan">>

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Every date's schedule a state holds: its open day from the top-level
 *  slices, the rest from dayStore. */
export function datedSchedules(st: Saved): Record<string, DaySlices> {
  const out: Record<string, DaySlices> = { ...(st.dayStore ?? {}) }
  if (st.scheduleDate) {
    out[st.scheduleDate] = {
      shifts: Object.fromEntries((st.agents ?? []).map((a) => [a.id, a.shift])),
      breakOverrides: st.breakOverrides ?? {},
      channelPlan: st.channelPlan ?? {},
      overtimePlan: st.overtimePlan ?? {},
      activityPlan: st.activityPlan ?? {},
    }
  }
  return out
}

/** Apply another tab's saved state; returns the keys that changed. */
export function applyRemoteState(raw: string | null): string[] {
  if (!raw) return []
  let saved: { state?: Partial<State> }
  try {
    saved = JSON.parse(raw)
  } catch {
    return []
  }
  const remote = saved.state
  if (!remote) return []
  const local = useWfm.getState()
  const patch: Record<string, unknown> = {}
  for (const k of SHARED_KEYS) {
    if (!(k in remote)) continue
    const v = (remote as Record<string, unknown>)[k]
    // Only real differences — writing identical values back would bounce between tabs forever.
    if (!same(v, (local as unknown as Record<string, unknown>)[k])) patch[k] = v
  }

  // Schedules, date by date.
  const mine = datedSchedules(local)
  const theirs = datedSchedules(remote)
  const changedDays = Object.keys(theirs).filter((d) => !same(theirs[d], mine[d]))
  const openDay = local.scheduleDate
  const dayStore = { ...local.dayStore }
  let dayStoreChanged = false
  for (const d of changedDays) {
    if (d === openDay) {
      patch.breakOverrides = theirs[d].breakOverrides
      patch.channelPlan = theirs[d].channelPlan
      patch.overtimePlan = theirs[d].overtimePlan
      patch.activityPlan = theirs[d].activityPlan
    } else {
      dayStore[d] = theirs[d]
      dayStoreChanged = true
    }
  }
  if (dayStoreChanged) patch.dayStore = dayStore

  // The roster: their list of people, with shifts for this tab's open day.
  if (remote.agents) {
    const shifts = changedDays.includes(openDay) ? theirs[openDay].shifts : mine[openDay]?.shifts ?? {}
    const agents: Agent[] = remote.agents.map((a) => ({ ...a, shift: shifts[a.id] ?? a.shift }))
    if (!same(agents, local.agents)) patch.agents = agents
  }

  const keys = Object.keys(patch)
  if (keys.length) useWfm.setState(patch as Partial<State>)
  return keys
}

/** Start listening for other tabs' saves; returns a function that stops it. */
export function startCrossTabSync(): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY && e.storageArea === localStorage) applyRemoteState(e.newValue)
  }
  window.addEventListener("storage", onStorage)
  return () => window.removeEventListener("storage", onStorage)
}
