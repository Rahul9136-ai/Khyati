import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import { flushWorkspace, mergeById, pollWorkspace, startWorkspaceSync, stopWorkspaceSync, useWorkspaceSync, WORKSPACE_KEYS } from "@/lib/workspaceSync"
import { useWfm } from "@/store/wfm"

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), put: vi.fn() } }))
const get = vi.mocked(api.get)
const put = vi.mocked(api.put)

/** A fake /workspace/data server: versions, 409 on a stale save, 403 for areas you can't change. */
let server: Record<string, { value: unknown; version: number }>
let readOnly: Set<string>
let offline: boolean
const fail = (status: number, details?: unknown) => Promise.reject({ status, message: `HTTP ${status}`, details })

beforeEach(() => {
  localStorage.clear()
  stopWorkspaceSync()
  get.mockReset()
  put.mockReset()
  server = {}
  readOnly = new Set()
  offline = false
  useWfm.setState({ scenarios: [], ptoRequests: [], auditLog: [], users: useWfm.getState().users })
  get.mockImplementation(async (url: string, cfg?: unknown) => {
    if (offline) return Promise.reject({ message: "Network Error" })
    const values = (cfg as { params?: { values?: boolean } })?.params?.values !== false
    if (url === "/workspace/data")
      return {
        data: {
          data: {
            areas: Object.entries(server).map(([key, a]) => ({ key, version: a.version, ...(values ? { value: a.value } : {}) })),
            keys: Object.fromEntries(WORKSPACE_KEYS.map((k) => [k, !readOnly.has(k)])),
          },
        },
      }
    const key = url.split("/").pop()!
    return { data: { data: { key, ...server[key] } } }
  })
  put.mockImplementation(async (url: string, body: unknown) => {
    if (offline) return Promise.reject({ message: "Network Error" })
    const key = url.split("/").pop()!
    const { value, base_version } = body as { value: unknown; base_version: number }
    if (readOnly.has(key)) return fail(403)
    const cur = server[key]
    if (cur && JSON.stringify(cur.value) === JSON.stringify(value)) return { data: { data: { key, version: cur.version } } }
    if ((cur?.version ?? 0) !== base_version) return fail(409, { version: cur?.version ?? 0, value: cur?.value ?? null })
    server[key] = { value: JSON.parse(JSON.stringify(value)), version: (cur?.version ?? 0) + 1 }
    return { data: { data: { key, version: server[key].version } } }
  })
})
afterEach(() => stopWorkspaceSync())

const scenario = (id: string, name: string) => ({ id, name, createdAt: 1 }) as never
const putKeys = () => put.mock.calls.map((c) => (c[0] as string).split("/").pop())

describe("everything you add is saved on the server", () => {
  it("a first sign-in saves this browser's data for the organisation", async () => {
    await startWorkspaceSync()
    expect(new Set(putKeys())).toEqual(new Set(WORKSPACE_KEYS))
    expect(put.mock.calls.every((c) => (c[1] as { base_version: number }).base_version === 0)).toBe(true)
    expect(useWorkspaceSync.getState().status).toBe("saved")
  })

  it("what another browser / device added shows up here", async () => {
    server.scenarios = { value: [scenario("s1", "Peak +20%")], version: 3 }
    server.ptoRequests = { value: [{ id: "p1", agentId: "a1", type: "Sick", from: "2026-11-10", to: "2026-11-10", days: 1, status: "Pending" }], version: 7 }
    await startWorkspaceSync()
    expect(useWfm.getState().scenarios).toEqual([scenario("s1", "Peak +20%")])
    expect(useWfm.getState().ptoRequests).toHaveLength(1)
    expect(putKeys()).not.toContain("scenarios") // nothing to send back
  })

  it("an added item is saved, stays after a reload, and is gone only once removed", async () => {
    await startWorkspaceSync()
    useWfm.setState({ scenarios: [scenario("s1", "Peak +20%"), scenario("s2", "New site")] })
    await flushWorkspace()
    expect(server.scenarios.value).toHaveLength(2)

    // reload: a new session in the same browser, nothing new to save, nothing lost
    stopWorkspaceSync()
    put.mockClear()
    await startWorkspaceSync()
    expect(useWfm.getState().scenarios).toHaveLength(2)
    expect(put).not.toHaveBeenCalled()

    // another device (same server, empty browser) sees both
    stopWorkspaceSync()
    localStorage.clear()
    useWfm.setState({ scenarios: [] })
    await startWorkspaceSync()
    expect(useWfm.getState().scenarios).toHaveLength(2)

    // removing one removes it everywhere
    useWfm.setState({ scenarios: [scenario("s2", "New site")] })
    await flushWorkspace()
    expect(server.scenarios.value).toEqual([scenario("s2", "New site")])
  })

  it("picks up other people's changes while you work", async () => {
    await startWorkspaceSync()
    server.scenarios = { value: [scenario("s9", "From a colleague")], version: server.scenarios.version + 1 }
    await pollWorkspace()
    expect(useWfm.getState().scenarios).toEqual([scenario("s9", "From a colleague")])
  })

  it("changes made offline are kept and saved when the server is back", async () => {
    await startWorkspaceSync()
    offline = true
    useWfm.setState({ scenarios: [scenario("s1", "Made offline")] })
    await flushWorkspace()
    expect(useWorkspaceSync.getState().status).toBe("offline")
    expect(useWfm.getState().scenarios).toHaveLength(1)

    // later (even after closing the browser): the next sign-in uploads it
    stopWorkspaceSync()
    offline = false
    await startWorkspaceSync()
    expect(server.scenarios.value).toEqual([scenario("s1", "Made offline")])
  })

  it("two people adding to a log at once: both entries are kept", async () => {
    await startWorkspaceSync()
    const mine = { id: "mine", ts: 200, user: "me", category: "Config", action: "x", detail: "" }
    const theirs = { id: "theirs", ts: 100, user: "them", category: "Config", action: "y", detail: "" }
    server.auditLog = { value: [theirs], version: server.auditLog.version + 1 } // saved meanwhile elsewhere
    useWfm.setState({ auditLog: [mine] as never })
    await flushWorkspace()
    expect(server.auditLog.value).toEqual([mine, theirs])
    expect(useWfm.getState().auditLog).toEqual([mine, theirs])
    expect(useWorkspaceSync.getState().status).toBe("saved")
  })

  it("two people changing the same list: theirs is loaded and you're told", async () => {
    await startWorkspaceSync()
    server.scenarios = { value: [scenario("t", "Theirs")], version: server.scenarios.version + 1 }
    useWfm.setState({ scenarios: [scenario("m", "Mine")] })
    await flushWorkspace()
    expect(useWfm.getState().scenarios).toEqual([scenario("t", "Theirs")])
    expect(useWorkspaceSync.getState()).toMatchObject({ status: "conflict", message: expect.stringMatching(/scenarios/) })
  })

  it("areas you may not change stay in this browser and aren't retried", async () => {
    readOnly.add("users")
    await startWorkspaceSync()
    expect(putKeys()).not.toContain("users")
    useWfm.setState({ users: [] })
    await flushWorkspace()
    expect(putKeys()).not.toContain("users")
    expect(useWorkspaceSync.getState().status).toBe("saved")
  })
})

describe("mergeById", () => {
  it("keeps every entry once, newest first like the local list", () => {
    const a = { id: "a", ts: 3 }, b = { id: "b", ts: 2 }, c = { id: "c", ts: 1 }
    expect(mergeById([b, c], [a, c])).toEqual([a, b, c])
    expect(mergeById([b], [{ ...b, ts: 2, seen: true }])).toEqual([{ ...b, seen: true }])
    expect(mergeById(null, [a])).toEqual([a])
  })
})
