import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { AgentWorkspace } from "@/components/agent-workspace"
import { scheduleExportRows, type PublishedDay } from "@/components/my-schedule"
import { api } from "@/lib/api"
import { addDays, localISODate } from "@/lib/domain/horizon"
import { AGENTS } from "@/lib/domain/seed"
import { useScheduleSync } from "@/lib/scheduleSync"
import { useAuth } from "@/store/auth"
import { useWfm } from "@/store/wfm"

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  setSessionExpiredHandler: vi.fn(),
  tokenStore: { get: () => null, set: vi.fn(), clear: vi.fn() },
}))
const get = vi.mocked(api.get)

const today = localISODate()
const a01 = AGENTS[0]
const day = (plan_date: string, over: Partial<PublishedDay> = {}): PublishedDay => ({
  plan_date, agent_key: a01.id, agent_name: a01.name, team: "Alpha", shift_start: 540, shift_end: 1020,
  breaks: [{ id: "b", type: "lunch", label: "Lunch", start: 780, end: 810 }],
  channels: [{ id: "c", channel: "phone", start: 540, end: 1020 }], overtime: [], activities: [], ...over,
})

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<MemoryRouter><QueryClientProvider client={qc}><AgentWorkspace agentId={a01.id} /></QueryClientProvider></MemoryRouter>)
}

beforeEach(() => {
  get.mockReset()
  useWfm.setState({ agents: AGENTS })
  useScheduleSync.setState({ status: "synced", canWrite: false, serverAgents: {} })
  useAuth.setState({ user: { id: "u", email: "ava@x", full_name: "Ava", is_superuser: false, role_names: ["Employee"], permission_codes: ["schedule:read"] } })
  get.mockImplementation(async (url: string) => {
    if (url === "/scheduling/my-schedule") return { data: { data: { agent_keys: [a01.id], days: [day(today), day(addDays(today, 1))] } } }
    if (url === "/reports/my-performance") {
      return { data: { data: { attendance: [{ employee_code: a01.id, employee_name: a01.name, date: today, code: "Late", category: "late", minutes_late: 7, minutes_early_logout: 2 }] } } }
    }
    return { data: { data: [] } }
  })
})

describe("agent's own workspace", () => {
  it("shows only their own performance, from 'me' endpoints with no person in them", async () => {
    renderIt()
    expect(await screen.findByText("My performance")).toBeInTheDocument()
    expect(await screen.findByText("Minutes late")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("Late days").nextSibling).toHaveTextContent("1"))
    expect(screen.getByText("Minutes late").nextSibling).toHaveTextContent("7")

    const calls = get.mock.calls.map((c) => c[0] as string)
    expect(calls).toContain("/reports/my-performance")
    expect(calls.some((u) => u.includes("agent-schedule") || u.includes("performance-actuals") || u.includes("/employees"))).toBe(false)
    for (const c of get.mock.calls) expect(JSON.stringify(c[1] ?? {})).not.toMatch(/employee_id|agent_key/)
  })

  it("no longer shows the simulated adherence score", async () => {
    renderIt()
    await screen.findByText("My performance")
    expect(screen.queryByText("Adherence today")).not.toBeInTheDocument()
    expect(screen.getByText("Planned hours")).toBeInTheDocument()
  })

  it("offers export of their schedule and performance", async () => {
    renderIt()
    expect(await screen.findByRole("button", { name: /Export my schedule/ })).toBeInTheDocument()
    expect(await screen.findByRole("button", { name: /Export my performance/ })).toBeInTheDocument()
  })

  it("switches period", async () => {
    renderIt()
    fireEvent.click(await screen.findByRole("button", { name: "Last 30 days" }))
    await waitFor(() => expect(get).toHaveBeenCalledWith("/reports/my-performance", { params: { start: addDays(today, -29), end: today } }))
  })

  it("looks back further: the last 3 months, or any dates (up to 190 days)", async () => {
    renderIt()
    const perf = within((await screen.findByText("My performance")).closest(".glass") as HTMLElement)
    fireEvent.click(perf.getByRole("button", { name: "Last 3 months" }))
    await waitFor(() => expect(get).toHaveBeenCalledWith("/reports/my-performance", { params: { start: addDays(today, -90), end: today } }))

    fireEvent.click(perf.getByRole("button", { name: "Custom dates" }))
    fireEvent.change(screen.getByLabelText("Performance from"), { target: { value: addDays(today, -150) } })
    fireEvent.change(screen.getByLabelText("Performance to"), { target: { value: addDays(today, -120) } })
    await waitFor(() => expect(get).toHaveBeenCalledWith("/reports/my-performance", { params: { start: addDays(today, -150), end: addDays(today, -120) } }))
    expect(get).toHaveBeenCalledWith("/scheduling/my-schedule", { params: { start: addDays(today, -150), end: addDays(today, -120) } })

    fireEvent.change(screen.getByLabelText("Performance from"), { target: { value: addDays(today, -330) } }) // 211 days
    expect(screen.getByRole("alert")).toHaveTextContent("Pick at most 190 days")
    fireEvent.change(screen.getByLabelText("Performance from"), { target: { value: addDays(today, -100) } })
    expect(screen.getByRole("alert")).toHaveTextContent("The end date is before the start")
  })

  it("My schedule looks back too: the last 4 weeks, 3 months, or any dates", async () => {
    renderIt()
    const period = await screen.findByRole("group", { name: "Schedule period" })
    fireEvent.click(within(period).getByRole("button", { name: "Last 4 weeks" }))
    await waitFor(() => expect(get).toHaveBeenCalledWith("/scheduling/my-schedule", { params: { start: addDays(today, -28), end: addDays(today, -1) } }))
    expect(screen.getByText(/My schedule — last 4 weeks/)).toBeInTheDocument()
    fireEvent.click(within(period).getByRole("button", { name: "Last 3 months" }))
    await waitFor(() => expect(get).toHaveBeenCalledWith("/scheduling/my-schedule", { params: { start: addDays(today, -91), end: addDays(today, -1) } }))
    fireEvent.click(within(period).getByRole("button", { name: "Custom dates" }))
    fireEvent.change(screen.getByLabelText("Schedule from"), { target: { value: "2026-01-01" } })
    fireEvent.change(screen.getByLabelText("Schedule to"), { target: { value: "2026-01-31" } })
    await waitFor(() => expect(get).toHaveBeenCalledWith("/scheduling/my-schedule", { params: { start: "2026-01-01", end: "2026-01-31" } }))
  })
})

describe("schedule export", () => {
  it("writes one readable row per day; a day off isn't shown as a shift", () => {
    const rows = scheduleExportRows([
      day("2026-11-02", { overtime: [{ id: "o", channel: "chat", start: 1020, end: 1080 }] }),
      day("2026-11-03", { activities: [{ id: "x", type: "off", start: 540, end: 1020 }] }),
    ])
    expect(rows[0]).toMatchObject({ Date: "2026-11-02", Status: "Working", "Shift start": "09:00", "Shift end": "17:00", Channels: "Phone 09:00–17:00", Breaks: "Lunch 13:00–13:30", Overtime: "Chat 17:00–18:00" })
    expect(rows[1]).toMatchObject({ Status: "Week off", "Shift start": "", Channels: "", Breaks: "", Activities: "Week off 09:00–17:00" })
  })
})
