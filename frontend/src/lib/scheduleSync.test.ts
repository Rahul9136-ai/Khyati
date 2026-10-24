import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import { agentDay, toMins } from "@/lib/domain/channels"
import { AGENTS } from "@/lib/domain/seed"
import {
  flush,
  fromServerPlan,
  pull,
  SAVE_DEBOUNCE_MS,
  startScheduleSync,
  stopScheduleSync,
  toServerPlan,
  useScheduleSync,
  type ServerDayPlan,
} from "@/lib/scheduleSync"
import { useWfm } from "@/store/wfm"

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), put: vi.fn() } }))

const DATE = "2026-10-26"
const get = vi.mocked(api.get)
const put = vi.mocked(api.put)

/** In-memory stand-in for /scheduling/day-plans with the backend's versioning + 409. */
let server: Map<string, ServerDayPlan & { version: number }>
let offline = false
function fakeBackend() {
  get.mockImplementation(async () => {
    if (offline) throw { code: "network_error", message: "down" }
    return { data: { data: [...server.values()].map((r) => structuredClone(r)) } }
  })
  put.mockImplementation(async (_url: string, body: unknown) => {
    if (offline) throw { code: "network_error", message: "down" }
    const { items } = body as { items: (ServerDayPlan & { base_version?: number })[] }
    const stale = items.filter((i) => i.base_version !== undefined && server.get(i.agent_key) && server.get(i.agent_key)!.version !== i.base_version)
    if (stale.length) throw { status: 409, code: "conflict", message: "stale" }
    const saved = items.map((item) => {
      const i = { ...item }
      delete i.base_version
      const row = { ...i, version: (server.get(i.agent_key)?.version ?? 0) + 1 }
      server.set(i.agent_key, row)
      return structuredClone(row)
    })
    return { data: { data: saved } }
  })
}

const a01 = AGENTS[0].id // 07:00–15:30
const shiftOf = (id: string) => useWfm.getState().agents.find((a) => a.id === id)!.shift
const lastPutKeys = () => (put.mock.calls.at(-1)![1] as { items: ServerDayPlan[] }).items.map((i) => i.agent_key)
const lastPutItems = () => (put.mock.calls.at(-1)![1] as { items: (ServerDayPlan & { base_version?: number })[] }).items

function serverRowFor(id: string, over: Partial<ServerDayPlan> = {}, version = 1): ServerDayPlan & { version: number } {
  const s = useWfm.getState()
  const a = s.agents.find((x) => x.id === id)!
  return { ...toServerPlan(a, agentDay(a, s.shiftPatterns, s.breakOverrides, s.channelPlan, s.overtimePlan, s.activityPlan)), ...over, version }
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  server = new Map()
  offline = false
  get.mockReset()
  put.mockReset()
  fakeBackend()
  useWfm.setState({ agents: AGENTS, breakOverrides: {}, channelPlan: {}, overtimePlan: {}, activityPlan: {} })
})
afterEach(() => {
  stopScheduleSync()
  vi.useRealTimers()
})

describe("wire format", () => {
  it("round-trips an agent's day through the server shape", () => {
    const s = useWfm.getState()
    const a = s.agents[0]
    const day = agentDay(a, s.shiftPatterns, s.breakOverrides, s.channelPlan, s.overtimePlan, s.activityPlan)
    const patch = fromServerPlan(toServerPlan(a, day))
    expect(patch.shift).toBe(a.shift)
    expect(patch.breaks.map((b) => b.offsetMinutes)).toEqual([120, 240, 360])
  })
})

describe("schedule sync", () => {
  it("uploads every schedule when the server has none for the day", async () => {
    await startScheduleSync({ canWrite: true, date: DATE })
    expect(get).toHaveBeenCalledWith(`/scheduling/day-plans/${DATE}`)
    expect(lastPutKeys()).toHaveLength(AGENTS.length)
    expect(lastPutItems().every((i) => i.base_version === undefined)).toBe(true)
    expect((put.mock.calls[0][1] as { detail: string }).detail).toBe("Initial upload of the day's schedules")
    expect(useScheduleSync.getState().status).toBe("synced")
  })

  it("loads the server's copy into the timeline (server wins) and uploads only what's missing", async () => {
    server.set(a01, serverRowFor(a01, {
      shift_start: toMins("08:00"), shift_end: toMins("16:30"),
      channels: [{ id: "p", channel: "email", start: toMins("08:00"), end: toMins("16:30") }],
      breaks: [{ id: "b2", type: "lunch", label: "Lunch", start: toMins("12:00"), end: toMins("12:30") }],
      activities: [{ id: "m", type: "meeting", start: toMins("10:00"), end: toMins("10:30"), note: "Q3" }],
    }, 4))
    await startScheduleSync({ canWrite: true, date: DATE })

    expect(shiftOf(a01)).toBe("08:00–16:30")
    expect(useWfm.getState().channelPlan[a01]).toEqual([{ id: "p", channel: "email", start: toMins("08:00"), end: toMins("16:30") }])
    expect(useWfm.getState().activityPlan[a01]).toEqual([{ id: "m", type: "meeting", start: toMins("10:00"), end: toMins("10:30"), note: "Q3" }])
    expect(lastPutKeys()).not.toContain(a01)
    expect(lastPutKeys()).toHaveLength(AGENTS.length - 1)
  })

  it("saves only the changed agents after a local edit, with the version they were based on", async () => {
    await startScheduleSync({ canWrite: true, date: DATE })
    put.mockClear()
    const s = useWfm.getState()
    const a = s.agents[0]
    const day = agentDay(a, s.shiftPatterns, s.breakOverrides, s.channelPlan, s.overtimePlan, s.activityPlan)
    s.updateAgentDay(a01, { ...fromServerPlan(toServerPlan(a, day)), shift: "07:30–15:30" }, "Shift 07:00–15:30 → 07:30–15:30")
    expect(useScheduleSync.getState().status).toBe("saving")

    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(put).toHaveBeenCalledTimes(1)
    expect(lastPutItems()).toEqual([expect.objectContaining({ agent_key: a01, shift_start: toMins("07:30"), base_version: 1 })])
    expect((put.mock.calls[0][1] as { detail: string }).detail).toMatch(/Edited schedule on timeline: .*07:30/)
    expect(server.get(a01)!.version).toBe(2)
    expect(useScheduleSync.getState().status).toBe("synced")

    // Nothing changed → nothing sent.
    await flush()
    expect(put).toHaveBeenCalledTimes(1)
  })

  it("on a 409 (someone else saved first) reloads the server copy", async () => {
    await startScheduleSync({ canWrite: true, date: DATE })
    // Another user moves a01's shift on the server.
    server.set(a01, { ...server.get(a01)!, shift_start: toMins("09:00"), shift_end: toMins("17:30"), channels: [{ id: "x", channel: "chat", start: toMins("09:00"), end: toMins("17:30") }], breaks: [], version: 7 })
    useWfm.getState().addActivities([{ agentId: a01, segment: { id: "t", type: "training", start: toMins("10:00"), end: toMins("11:00") } }], "local")
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)

    expect(useScheduleSync.getState().status).toBe("conflict")
    expect(shiftOf(a01)).toBe("09:00–17:30")
    expect(useWfm.getState().activityPlan[a01]).toBeUndefined()
  })

  it("pulls other users' changes while idle", async () => {
    await startScheduleSync({ canWrite: true, date: DATE })
    server.set(a01, { ...server.get(a01)!, shift_start: toMins("06:30"), shift_end: toMins("15:00"), channels: [{ id: "x", channel: "phone", start: toMins("06:30"), end: toMins("15:00") }], breaks: [], version: 3 })
    await pull()
    expect(shiftOf(a01)).toBe("06:30–15:00")
  })

  it("works offline and pushes offline edits once the server is back (if nobody else changed them)", async () => {
    await startScheduleSync({ canWrite: true, date: DATE })
    stopScheduleSync()
    offline = true
    await startScheduleSync({ canWrite: true, date: DATE })
    expect(useScheduleSync.getState().status).toBe("offline")

    // Edit while offline (reload simulated by restarting sync later).
    useWfm.getState().addActivities([{ agentId: a01, segment: { id: "o", type: "coaching", start: toMins("14:00"), end: toMins("14:30") } }], "offline edit")
    stopScheduleSync()
    offline = false
    put.mockClear()
    await startScheduleSync({ canWrite: true, date: DATE })

    expect(lastPutItems()).toEqual([expect.objectContaining({ agent_key: a01, base_version: 1 })])
    expect(server.get(a01)!.activities).toEqual([{ id: "o", type: "coaching", start: toMins("14:00"), end: toMins("14:30") }])
    expect(useWfm.getState().activityPlan[a01]).toHaveLength(1)
  })

  it("keeps the server version when an offline edit raced someone else's change", async () => {
    await startScheduleSync({ canWrite: true, date: DATE })
    stopScheduleSync()
    useWfm.getState().addActivities([{ agentId: a01, segment: { id: "o", type: "coaching", start: toMins("14:00"), end: toMins("14:30") } }], "offline edit")
    server.set(a01, { ...server.get(a01)!, version: 5 }) // changed by someone else meanwhile
    await startScheduleSync({ canWrite: true, date: DATE })
    expect(useWfm.getState().activityPlan[a01]).toBeUndefined()
    expect(useScheduleSync.getState()).toMatchObject({ status: "conflict", message: expect.stringMatching(/1 schedule\(s\) edited offline/) })
  })

  it("never writes for view-only users", async () => {
    await startScheduleSync({ canWrite: false, date: DATE })
    useWfm.getState().addActivities([{ agentId: a01, segment: { id: "o", type: "coaching", start: toMins("14:00"), end: toMins("14:30") } }], "x")
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2)
    expect(put).not.toHaveBeenCalled()
    expect(useScheduleSync.getState().status).toBe("readonly")
  })
})
