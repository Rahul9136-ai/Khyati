import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SchedulePopup } from "@/components/layout/schedule-popup"
import { MySchedule } from "@/components/my-schedule"
import { ScheduleDateBar } from "@/components/schedule-date-bar"
import { ScheduleOverview } from "@/components/schedule-overview"
import { api } from "@/lib/api"
import { addDays, datesBetween, localISODate, scheduleHorizon } from "@/lib/domain/horizon"
import { AGENTS } from "@/lib/domain/seed"
import { useScheduleSync } from "@/lib/scheduleSync"
import { useAuth } from "@/store/auth"
import { useWfm } from "@/store/wfm"

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
  setSessionExpiredHandler: vi.fn(),
  tokenStore: { access: null, refresh: null, set: vi.fn(), clear: vi.fn() },
}))
const get = vi.mocked(api.get)
const post = vi.mocked(api.post)

const today = localISODate()
const tomorrow = addDays(today, 1)
const [a01, a02] = AGENTS

function Where() {
  return <span data-testid="where">{useLocation().pathname + useLocation().search}</span>
}

function renderWith(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="*" element={<>{ui}<Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  get.mockReset()
  post.mockReset()
  post.mockResolvedValue({ data: { data: {} } })
  useWfm.setState({ agents: AGENTS, breakOverrides: {}, channelPlan: {}, overtimePlan: {}, activityPlan: {}, scheduleDate: today, dayStore: {} })
  useScheduleSync.setState({ status: "synced", canWrite: true, planDate: today, serverAgents: {} })
  useAuth.setState({ user: { id: "u", email: "admin@x", full_name: "Admin", is_superuser: true, role_names: [], permission_codes: [] } })
})

describe("schedule change pop-up", () => {
  const note = (over: object) => ({ id: "n1", kind: "schedule_changed", title: "Your schedule changed · Mon 26 Oct", body: "Lunch 11:00 → 11:30", link: "/scheduling?date=2026-10-26", read_at: null, created_at: "2026-10-24T10:00:00Z", ...over })

  it("pops up schedule news (not other notifications) and marks it read on Got it", async () => {
    get.mockResolvedValue({ data: { data: [note({}), note({ id: "x", kind: "request_decided", title: "Leave approved" })] } })
    renderWith(<SchedulePopup />)
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Your schedule changed · Mon 26 Oct")).toBeInTheDocument()
    expect(within(dialog).getByText("Lunch 11:00 → 11:30")).toBeInTheDocument()
    expect(screen.queryByText("Leave approved")).not.toBeInTheDocument()
    expect(get).toHaveBeenCalledWith("/notifications", { params: { unread_only: true } })

    fireEvent.click(within(dialog).getByRole("button", { name: "Got it" }))
    await waitFor(() => expect(post).toHaveBeenCalledWith("/notifications/n1/read"))
  })

  it("shows a TL digest line per agent and opens the day from View schedule", async () => {
    get.mockResolvedValue({ data: { data: [note({ title: "Team schedule changed · Mon 26 Oct", body: "Ava Mendez: Lunch 11:00 → 11:30\nLiam Carter: + Meeting 13:00–14:00" }), note({ id: "n2", kind: "schedule_published", title: "Team schedules published" })] } })
    renderWith(<SchedulePopup />)
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Ava Mendez: Lunch 11:00 → 11:30",
      "Liam Carter: + Meeting 13:00–14:00",
    ])
    expect(within(dialog).getByText(/1 of 2 schedule updates/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole("button", { name: "View schedule" }))
    expect(screen.getByTestId("where").textContent).toBe("/scheduling?date=2026-10-26")
    await waitFor(() => expect(post).toHaveBeenCalledWith("/notifications/n1/read"))
  })
})

describe("3-month overview", () => {
  it("draws every day of the next 3 months, published vs draft, and opens a day on click", async () => {
    get.mockResolvedValue({ data: { data: [
      { plan_date: tomorrow, agent_key: a01.id, agent_name: a01.name, team: a01.team, shift_start: 9 * 60, shift_end: 17 * 60 + 30, ot_minutes: 60, activities: ["meeting"], version: 2, published: true },
    ] } })
    const onOpen = vi.fn()
    renderWith(<ScheduleOverview agents={[a01, a02]} onOpenDate={onOpen} />)
    const { start, end } = scheduleHorizon(today)
    expect(get).toHaveBeenCalledWith("/scheduling/day-plans", { params: { start, end } })

    // ~190 cells: allow for a slow role query when the whole suite runs in parallel.
    const published = await screen.findByRole(
      "button",
      { name: new RegExp(`^${a01.name} · .* · 09:00–17:30 · Meeting · OT 1h · published$`) },
      { timeout: 5000 },
    )
    expect(published).toHaveTextContent("09:00")
    // Not saved on the server → the shift-pattern default, as a draft.
    const draft = screen.getAllByRole("button", { name: new RegExp(`^${a02.name} · .* · 07:00–15:30 · draft$`) })
    expect(draft).toHaveLength(datesBetween(start, end).length)

    fireEvent.click(published)
    expect(onOpen).toHaveBeenCalledWith(tomorrow)
    fireEvent.click(screen.getByRole("button", { name: /Schedules — next 3 months/ })) // collapses
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })

  it("view-only users see only published days", async () => {
    useScheduleSync.setState({ canWrite: false, serverAgents: {} })
    get.mockResolvedValue({ data: { data: [] } })
    renderWith(<ScheduleOverview agents={[a02]} onOpenDate={() => {}} />)
    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(screen.getAllByRole("button", { name: new RegExp(`^${a02.name} · .* · not published$`) }).length).toBeGreaterThan(80)
  })
})

describe("date bar", () => {
  it("shows the day's publish state and steps through the 3-month range", async () => {
    useScheduleSync.setState({ serverAgents: Object.fromEntries(AGENTS.map((a, i) => [a.id, { published: i < 10 }])) })
    renderWith(<ScheduleDateBar canPublish />)
    expect(screen.getByText(`Published for 10/${AGENTS.length}`)).toBeInTheDocument()
    expect(screen.getByLabelText("Schedule date")).toHaveAttribute("max", scheduleHorizon(today).end)

    fireEvent.click(screen.getByRole("button", { name: "Next day" }))
    await waitFor(() => expect(useWfm.getState().scheduleDate).toBe(tomorrow))
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled()
  })

  it("publishes the chosen range from the dialog", async () => {
    get.mockResolvedValue({ data: { data: [] } }) // nothing saved yet → every day gets filled
    post.mockImplementation(async (url: string, body: unknown) => {
      if (url.endsWith("/fill")) return { data: { data: { created: (body as { items: unknown[] }).items.length, existing: 0 } } }
      return { data: { data: { start: today, end: today, days: 1, agents: AGENTS.length, published: AGENTS.length, unchanged: 0, notified: 3 } } }
    })
    useScheduleSync.setState({ serverAgents: {} })
    renderWith(<ScheduleDateBar canPublish />)
    expect(screen.getByText("Draft")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Publish" }))
    const dialog = screen.getByRole("dialog")
    fireEvent.click(within(dialog).getByLabelText(/^This day/))
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }))

    expect(await within(dialog).findByText(/agent-days published/)).toHaveTextContent(`${AGENTS.length} agent-days published (1 day · ${AGENTS.length} agents)`)
    expect(within(dialog).getByText("3 agent/team-leader logins notified.")).toBeInTheDocument()
    expect(post).toHaveBeenCalledWith("/scheduling/day-plans/publish", { start: today, end: today, note: "" })
  })

  it("hides Publish from people who can't publish", () => {
    renderWith(<ScheduleDateBar canPublish={false} />)
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument()
  })
})

describe("my schedule (agent view)", () => {
  it("lists a signed-in agent's published days", async () => {
    useAuth.setState({ user: { id: "u", email: "ava@x", full_name: "Ava", is_superuser: false, role_names: ["Employee"], permission_codes: ["schedule:read"] } })
    get.mockResolvedValue({ data: { data: { agent_keys: [a01.id], days: [{
      plan_date: tomorrow, agent_key: a01.id, agent_name: a01.name, team: "Alpha", shift_start: 420, shift_end: 930,
      breaks: [{ id: "b2", type: "lunch", label: "Lunch", start: 660, end: 690 }], channels: [],
      overtime: [{ id: "o", channel: "chat", start: 930, end: 990 }],
      activities: [{ id: "m", type: "training", start: 780, end: 840 }],
    }] } } })
    const onOpen = vi.fn()
    renderWith(<MySchedule agentId={a01.id} onOpenDate={onOpen} />)
    const row = await screen.findByRole("button", { name: /07:00–15:30/ })
    expect(row).toHaveTextContent("Lunch 11:00")
    expect(row).toHaveTextContent("Training 13:00–14:00")
    expect(row).toHaveTextContent("OT Chat 15:30–16:30")
    expect(get.mock.calls[0][0]).toBe("/scheduling/my-schedule")
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith(tomorrow)
  })

  it("staff previewing the Agent view get that agent's published days", async () => {
    get.mockResolvedValue({ data: { data: [] } })
    renderWith(<MySchedule agentId={a01.id} onOpenDate={() => {}} />)
    expect(await screen.findByText(/No published schedule yet/)).toBeInTheDocument()
    expect(get.mock.calls[0][0]).toBe(`/scheduling/agent-schedule/${a01.id}`)
  })
})
