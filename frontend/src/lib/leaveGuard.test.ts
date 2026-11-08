import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import { guardLeaving, hasPendingSaves } from "@/lib/leaveGuard"
import { flushWorkspace, startWorkspaceSync, stopWorkspaceSync, WORKSPACE_KEYS } from "@/lib/workspaceSync"
import { useWfm } from "@/store/wfm"

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), put: vi.fn(), defaults: { baseURL: "http://srv/api/v1" } },
  tokenStore: { access: "tok" },
}))
const get = vi.mocked(api.get)
const put = vi.mocked(api.put)

const hide = () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
  document.dispatchEvent(new Event("visibilitychange"))
}
const show = () => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })

describe("leave guard", () => {
  afterEach(show)

  it("saves when the tab is hidden, sends a last request on close, and warns only while something is unsaved", () => {
    let pending = true
    const flush = vi.fn(), beacon = vi.fn()
    const off = guardLeaving({ pending: () => pending, flush, beacon })
    hide()
    expect(flush).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event("pagehide"))
    expect(beacon).toHaveBeenCalledTimes(1)

    const leave = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(leave)
    expect(leave.defaultPrevented).toBe(true) // the browser asks "leave site?"

    pending = false
    const calm = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(calm)
    expect(calm.defaultPrevented).toBe(false)
    off()
    expect(hasPendingSaves()).toBe(false)
  })
})

describe("workspace changes made just before leaving", () => {
  let server: Record<string, { value: unknown; version: number }>
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    server = {}
    get.mockReset(); put.mockReset()
    useWfm.setState({ scenarios: [] })
    get.mockImplementation(async () => ({ data: { data: { areas: [], keys: Object.fromEntries(WORKSPACE_KEYS.map((k) => [k, true])) } } }))
    put.mockImplementation(async (url: string, body: unknown) => {
      const key = url.split("/").pop()!
      const { value } = body as { value: unknown }
      server[key] = { value, version: (server[key]?.version ?? 0) + 1 }
      return { data: { data: { key, version: server[key].version } } }
    })
  })
  afterEach(() => { stopWorkspaceSync(); vi.useRealTimers(); show() })

  it("are saved at once when the tab is hidden (no waiting for the debounce)", async () => {
    await startWorkspaceSync()
    put.mockClear()
    useWfm.setState({ scenarios: [{ id: "s1", name: "Added then tab closed" } as never] })
    expect(hasPendingSaves()).toBe(true)
    hide()
    await vi.advanceTimersByTimeAsync(0) // no debounce wait
    expect(put).toHaveBeenCalledWith("/workspace/data/scenarios", expect.objectContaining({ value: [{ id: "s1", name: "Added then tab closed" }] }))
    await flushWorkspace()
    expect(hasPendingSaves()).toBe(false)
  })

  it("go out with a keepalive request if the page closes first", async () => {
    await startWorkspaceSync()
    const fetchSpy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response("{}"))
    vi.stubGlobal("fetch", fetchSpy)
    useWfm.setState({ scenarios: [{ id: "s2", name: "Closed instantly" } as never] })
    window.dispatchEvent(new Event("pagehide"))
    const call = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith("/workspace/data/scenarios"))
    expect(call).toBeDefined()
    expect(call![1]).toMatchObject({ method: "PUT", keepalive: true, headers: expect.objectContaining({ Authorization: "Bearer tok" }) })
    expect(JSON.parse(call![1]!.body as string).value).toEqual([{ id: "s2", name: "Closed instantly" }])
    vi.unstubAllGlobals()
  })
})
