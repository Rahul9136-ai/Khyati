import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import { AGENTS } from "@/lib/domain/seed"
import { DEFAULT_SHIFT_PATTERNS } from "@/lib/domain/shiftPatterns"
import { DEFAULT_WORK_COMPLIANCE, DEFAULT_WORK_RULES, type WorkRule } from "@/lib/domain/workRules"
import { flushSettings, localSettings, startSettingsSync, stopSettingsSync, useSettingsSync } from "@/lib/settingsSync"
import { useWfm } from "@/store/wfm"

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), put: vi.fn() } }))
const get = vi.mocked(api.get)
const put = vi.mocked(api.put)

const [a, b] = AGENTS
const row = (key: string, value: unknown, version: number) => ({ key, value, version, updated_at: "2026-10-27T10:00:00Z", updated_by: "x" })
const nightRule: WorkRule = { id: "wr-night", name: "Night 8h", shiftMinutes: 480, breaks: [{ type: "lunch", minutes: 30 }], weekOff: [0], weekOffMode: "fixed", defaultStart: "22:00" }

let server: ReturnType<typeof row>[] = []
beforeEach(() => {
  localStorage.clear()
  get.mockReset()
  put.mockReset()
  server = []
  useWfm.setState({ agents: AGENTS.slice(0, 2), shiftPatterns: DEFAULT_SHIFT_PATTERNS, workRules: DEFAULT_WORK_RULES, workCompliance: DEFAULT_WORK_COMPLIANCE })
  get.mockImplementation(async () => ({ data: { data: server } }))
  put.mockImplementation(async (url: string, body: unknown) => {
    const key = url.split("/").pop()!
    const { value } = body as { value: unknown }
    const prev = server.find((r) => r.key === key)
    const next = row(key, value, (prev?.version ?? 0) + 1)
    server = [...server.filter((r) => r.key !== key), next]
    return { data: { data: next } }
  })
})
afterEach(() => stopSettingsSync())

describe("shared work rules & week offs", () => {
  it("loads what's saved on the server (another browser's changes)", async () => {
    server = [
      row("work_rules", [...DEFAULT_WORK_RULES, nightRule], 4),
      row("agent_rules", { [a.id]: { shiftPatternId: "wr:wr-night@22:00", weekOff: [0], weekOffMode: "rotating" } }, 2),
    ]
    await startSettingsSync({ canWrite: true })
    const s = useWfm.getState()
    expect(s.workRules.at(-1)).toEqual(nightRule)
    expect(s.agents[0]).toMatchObject({ shiftPatternId: "wr:wr-night@22:00", weekOff: [0], weekOffMode: "rotating" })
    // The rule's pattern is generated so the schedule can use it.
    // (Schedules can't run past midnight yet, so a 22:00 start ends at 24:00.)
    expect(s.shiftPatterns.find((p) => p.id === "wr:wr-night@22:00")).toMatchObject({ start: "22:00", end: "24:00" })
    // Keys the server didn't have yet are uploaded from this browser.
    expect(put.mock.calls.map((c) => c[0]).sort()).toEqual(["/scheduling/settings/shift_patterns", "/scheduling/settings/work_compliance"])
    expect(useSettingsSync.getState().status).toBe("synced")
  })

  it("saves changes made here, with the version they were based on", async () => {
    await startSettingsSync({ canWrite: true })
    expect(put).toHaveBeenCalledTimes(4) // first browser: everything uploaded
    put.mockClear()

    useWfm.getState().assignWorkRule([b.id], { ruleId: "wr-9h", start: "08:00", weekOff: [5, 6], weekOffMode: "fixed" })
    await flushSettings()
    expect(put).toHaveBeenCalledTimes(1)
    const [url, body] = put.mock.calls[0] as [string, { value: Record<string, unknown>; base_version: number }]
    expect(url).toBe("/scheduling/settings/agent_rules")
    expect(body.base_version).toBe(1)
    expect(body.value[b.id]).toEqual({ shiftPatternId: "wr:wr-9h@08:00", weekOff: [5, 6], weekOffMode: "fixed" })
  })

  it("someone else saved first: loads theirs and says so", async () => {
    await startSettingsSync({ canWrite: true })
    put.mockRejectedValueOnce({ status: 409, message: "changed", details: { version: 7, value: [nightRule] } })
    useWfm.getState().addWorkRule({ name: "Mine", shiftMinutes: 480, breaks: [], weekOff: [], weekOffMode: "fixed", defaultStart: "09:00" })
    await flushSettings()
    expect(useWfm.getState().workRules).toEqual([nightRule])
    expect(useSettingsSync.getState().status).toBe("conflict")
  })

  it("uploads changes made while offline once the server is back", async () => {
    await startSettingsSync({ canWrite: true }) // version 1 everywhere
    stopSettingsSync()
    useWfm.getState().setWeekOff([a.id], [2], "fixed") // offline edit
    put.mockClear()
    await startSettingsSync({ canWrite: true })
    expect(put.mock.calls.map((c) => c[0])).toEqual(["/scheduling/settings/agent_rules"])
    expect(server.find((r) => r.key === "agent_rules")!.value).toEqual(localSettings().agent_rules)
  })

  it("view-only users load but never save", async () => {
    server = [row("work_rules", [nightRule], 3)]
    await startSettingsSync({ canWrite: false })
    expect(useWfm.getState().workRules).toEqual([nightRule])
    useWfm.getState().addWorkRule({ name: "x", shiftMinutes: 480, breaks: [], weekOff: [], defaultStart: "09:00" })
    await flushSettings()
    expect(put).not.toHaveBeenCalled()
    expect(useSettingsSync.getState().status).toBe("readonly")
  })

  it("server unreachable: keeps working locally", async () => {
    get.mockRejectedValue({ message: "Network Error" })
    await startSettingsSync({ canWrite: true })
    expect(useSettingsSync.getState()).toMatchObject({ status: "offline" })
    expect(useWfm.getState().workRules).toEqual(DEFAULT_WORK_RULES)
  })
})
