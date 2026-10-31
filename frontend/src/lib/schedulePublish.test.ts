import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import { toMins } from "@/lib/domain/channels"
import { addDays, datesBetween, isISODate, localISODate, scheduleHorizon, weekStart } from "@/lib/domain/horizon"
import { AGENTS } from "@/lib/domain/seed"
import { missingDays, publishSchedules } from "@/lib/schedulePublish"
import { startScheduleSync, stopScheduleSync, switchScheduleDate, useScheduleSync, type ServerDayPlan } from "@/lib/scheduleSync"
import { scheduleForDate, useWfm } from "@/store/wfm"

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }))

const get = vi.mocked(api.get)
const put = vi.mocked(api.put)
const post = vi.mocked(api.post)
const D1 = "2026-10-26"
const D2 = "2026-10-27"
const a01 = AGENTS[0].id // Early pattern 07:00–15:30
const shiftOf = (id: string) => useWfm.getState().agents.find((a) => a.id === id)!.shift

/** Day plans by date → agent, with the backend's versioning and published flag. */
let server: Map<string, Map<string, ServerDayPlan & { version: number }>>
const rowsOn = (d: string) => server.get(d) ?? server.set(d, new Map()).get(d)!

beforeEach(() => {
  localStorage.clear()
  server = new Map()
  get.mockReset()
  put.mockReset()
  post.mockReset()
  get.mockImplementation(async (url: string, cfg?: { params?: unknown }) => {
    if (url === "/scheduling/labour-law") return { data: { data: { country_code: null, overrides: {}, version: 0 } } }
    if (url === "/scheduling/day-plans") {
      const { start, end } = cfg!.params as { start: string; end: string }
      const out = [...server].filter(([d]) => d >= start && d <= end).flatMap(([d, rows]) =>
        [...rows.values()].map((r) => ({ plan_date: d, agent_key: r.agent_key, shift_start: r.shift_start, shift_end: r.shift_end, published: !!r.published_at })),
      )
      return { data: { data: out } }
    }
    const d = url.split("/").at(-1)!
    return { data: { data: [...rowsOn(d).values()].map((r) => structuredClone(r)) } }
  })
  put.mockImplementation(async (url: string, body: unknown) => {
    const d = url.split("/").at(-1)!
    const saved = (body as { items: ServerDayPlan[] }).items.map((i) => {
      const row = { ...i, version: (rowsOn(d).get(i.agent_key)?.version ?? 0) + 1, published_at: rowsOn(d).get(i.agent_key)?.published_at ?? null }
      delete (row as { base_version?: number }).base_version
      rowsOn(d).set(i.agent_key, row)
      return structuredClone(row)
    })
    return { data: { data: saved } }
  })
  post.mockImplementation(async (url: string, body: unknown) => {
    if (url === "/scheduling/day-plans/fill") {
      const items = (body as { items: (ServerDayPlan & { plan_date: string })[] }).items
      for (const { plan_date, ...i } of items) rowsOn(plan_date).set(i.agent_key, { ...i, version: 1, published_at: null })
      return { data: { data: { created: items.length, existing: 0 } } }
    }
    const { start, end } = body as { start: string; end: string }
    let published = 0
    for (const d of datesBetween(start, end)) {
      for (const r of rowsOn(d).values()) {
        if (!r.published_at) {
          r.published_at = "2026-10-24T10:00:00Z"
          published++
        }
      }
    }
    return { data: { data: { start, end, days: 0, agents: AGENTS.length, published, unchanged: 0, notified: 4 } } }
  })
  useWfm.setState({ agents: AGENTS, breakOverrides: {}, channelPlan: {}, overtimePlan: {}, activityPlan: {}, scheduleDate: D1, dayStore: {} })
})
afterEach(() => stopScheduleSync())

describe("calendar helpers", () => {
  it("covers the next three months like the backend's default horizon", () => {
    expect(scheduleHorizon("2026-10-24")).toEqual({ start: "2026-10-24", end: "2027-01-23" })
    expect(scheduleHorizon("2026-11-30").end).toBe("2027-02-27")
    expect(datesBetween("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"])
    expect(weekStart("2026-11-01")).toBe("2026-10-26") // Sunday → that week's Monday
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30") // across a DST change
    expect([isISODate("2026-02-30"), isISODate("2026-02-28"), isISODate(null)]).toEqual([false, true, false])
  })
})

describe("per-date schedules", () => {
  it("parks the current day's edits and loads defaults for a date never opened", () => {
    const s = useWfm.getState()
    s.updateAgentDays([{ agentId: a01, patch: { shift: "08:00–16:30", breaks: [], channels: [{ id: "p", channel: "chat", start: toMins("08:00"), end: toMins("16:30") }], overtime: [], activities: [] } }], "edit D1")
    expect(shiftOf(a01)).toBe("08:00–16:30")

    useWfm.getState().setScheduleDate(D2)
    expect(useWfm.getState().scheduleDate).toBe(D2)
    expect(shiftOf(a01)).toBe("07:00–15:30") // D2 = shift-pattern default
    expect(useWfm.getState().channelPlan[a01]).toBeUndefined()
    expect(scheduleForDate(useWfm.getState(), D1).agents[0].shift).toBe("08:00–16:30")

    useWfm.getState().setScheduleDate(D1)
    expect(shiftOf(a01)).toBe("08:00–16:30")
    expect(useWfm.getState().channelPlan[a01]?.[0].channel).toBe("chat")
    expect(Object.keys(useWfm.getState().dayStore)).toEqual([D2])
  })

  it("forgets days more than two weeks past", () => {
    const old = addDays(localISODate(), -20)
    useWfm.setState({ dayStore: { [old]: { shifts: {}, breakOverrides: {}, channelPlan: {}, overtimePlan: {}, activityPlan: {} } } })
    useWfm.getState().setScheduleDate(D2)
    expect(useWfm.getState().dayStore[old]).toBeUndefined()
  })
})

describe("syncing across dates", () => {
  it("saves the old day before switching and loads the new day's server copy", async () => {
    await startScheduleSync({ canWrite: true })
    expect(rowsOn(D1).size).toBe(AGENTS.length) // initial upload for D1
    expect(rowsOn(D1).get(a01)!.team_lead).toBe(AGENTS[0].tl)

    rowsOn(D2).set(a01, { ...structuredClone(rowsOn(D1).get(a01)!), shift_start: toMins("09:00"), shift_end: toMins("17:30"), breaks: [], channels: [{ id: "x", channel: "email", start: toMins("09:00"), end: toMins("17:30") }], published_at: "2026-10-24T10:00:00Z" })
    useWfm.getState().addActivities([{ agentId: a01, segment: { id: "m", type: "meeting", start: toMins("10:00"), end: toMins("11:00") } }], "pending")
    await switchScheduleDate(D2)

    expect(rowsOn(D1).get(a01)!.activities).toHaveLength(1) // flushed to D1, not D2
    expect(useWfm.getState().scheduleDate).toBe(D2)
    expect(shiftOf(a01)).toBe("09:00–17:30")
    expect(useScheduleSync.getState()).toMatchObject({ planDate: D2, canWrite: true })
    expect(useScheduleSync.getState().serverAgents![a01]).toEqual({ published: true })
    expect(rowsOn(D2).get(a01)!.channels[0].channel).toBe("email") // server copy untouched
  })

  it("view-only users see which agents are published for the day", async () => {
    rowsOn(D1).set(a01, { agent_key: a01, agent_name: "", team: "", shift_start: 420, shift_end: 930, breaks: [], channels: [], overtime: [], activities: [], version: 2, published_at: "2026-10-24T10:00:00Z" })
    await startScheduleSync({ canWrite: false })
    expect(useScheduleSync.getState()).toMatchObject({ status: "readonly", canWrite: false, serverAgents: { [a01]: { published: true } } })
    expect(put).not.toHaveBeenCalled()
  })
})

describe("publishing", () => {
  it("creates the days nobody opened from shift patterns, then publishes the range", async () => {
    await startScheduleSync({ canWrite: true })
    useWfm.getState().setScheduleDate(D1)
    const steps: string[] = []
    const res = await publishSchedules(D1, D2, { note: "Week 44", onProgress: (s) => steps.push(s) })

    const fill = post.mock.calls.find(([url]) => url === "/scheduling/day-plans/fill")![1] as { items: { plan_date: string; agent_key: string; shift_start: number }[] }
    expect(fill.items).toHaveLength(AGENTS.length) // D1 already saved by the sync; D2 filled
    expect(fill.items.every((i) => i.plan_date === D2)).toBe(true)
    expect(fill.items.find((i) => i.agent_key === a01)!.shift_start).toBe(toMins("07:00"))
    expect(post).toHaveBeenLastCalledWith("/scheduling/day-plans/publish", { start: D1, end: D2, note: "Week 44" })
    expect(res).toMatchObject({ published: AGENTS.length * 2, created: AGENTS.length, notified: 4 })
    expect(steps.at(-1)).toBe("Publishing…")
    expect(useScheduleSync.getState().serverAgents![a01]).toEqual({ published: true })
  })

  it("uses a parked day's edits for days that were opened but never saved", () => {
    useWfm.setState({ dayStore: { [D2]: { shifts: { [a01]: "10:00–18:30" }, breakOverrides: {}, channelPlan: {}, overtimePlan: {}, activityPlan: {} } } })
    const days = missingDays(D2, D2, new Set())
    expect(days.find((d) => d.agent_key === a01)).toMatchObject({ plan_date: D2, shift_start: toMins("10:00"), shift_end: toMins("18:30") })
    expect(missingDays(D2, D2, new Set([`${D2}|${a01}`])).some((d) => d.agent_key === a01)).toBe(false)
  })
})
