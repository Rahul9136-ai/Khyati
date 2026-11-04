import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import { localISODate } from "@/lib/domain/horizon"
import { AGENTS } from "@/lib/domain/seed"
import { useScheduleSync } from "@/lib/scheduleSync"
import { Scheduling } from "@/pages/Scheduling"
import { useWfm } from "@/store/wfm"

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
  setSessionExpiredHandler: vi.fn(),
  tokenStore: { get: () => null, set: vi.fn(), clear: vi.fn() },
}))

// Charts (recharts) measure their container; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

function Where() {
  return <span data-testid="where">{useLocation().search}</span>
}

function renderPage(url = "/scheduling") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={qc}><Scheduling /><Where /></QueryClientProvider>
    </MemoryRouter>,
  )
}

const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent?.replace(/\d+$/, ""))

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue({ data: { data: [] } })
  useScheduleSync.setState({ status: "idle", canWrite: true, serverAgents: null })
  useWfm.setState({ currentRole: "Super Admin", agents: AGENTS.slice(0, 4), currentAgentId: AGENTS[0].id, dayStore: {} })
})

describe("Scheduling sub-tabs", () => {
  it("splits the page into tabs, opening the daily plan by default", () => {
    renderPage()
    expect(tabNames()).toEqual(["Daily plan", "Multi-week", "Coverage & SL", "Open slots", "Automation", "Insights", "Requests"])
    expect(screen.getByRole("tab", { name: "Daily plan" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByText(/^Daily shift plan/)).toBeInTheDocument()
    expect(screen.queryByText(/^Interval detail/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("tab", { name: /Coverage & SL/ }))
    expect(screen.getByText(/^Interval detail/)).toBeInTheDocument()
    expect(screen.queryByText(/^Daily shift plan/)).not.toBeInTheDocument()
    expect(screen.getByTestId("where").textContent).toBe("?tab=coverage")
  })

  it("opens the tab named in the link", () => {
    renderPage("/scheduling?tab=insights")
    expect(screen.getByRole("tab", { name: /Insights/ })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByText("AI Absence Risk")).toBeInTheDocument()
  })

  it("shows today's live interval from the agents' real-time states, and follows them", () => {
    const sales = AGENTS.slice(0, 4).map((a) => ({ ...a, skills: ["sales"] }))
    const states = (actual: string) => sales.map((a) => ({ id: a.id, actual, scheduled: "AVAIL", secs: 60 }))
    useWfm.setState({ agents: sales, queueId: "sales", scheduleDate: localISODate(), nowIdx: 13, rta: states("AUX1") })
    renderPage("/scheduling?tab=coverage")
    expect(screen.getByText(/^Live now · 13:30 interval/)).toBeInTheDocument()
    const onQueue = () => screen.getByText("On queue now").parentElement!
    expect(onQueue()).toHaveTextContent(/^On queue now0/) // everyone on break
    expect(screen.getAllByTitle(/· Break$/)).toHaveLength(4)
    for (const row of ["Offered", "Vol handled", "Abandoned", "ASA", "On-queue HC"]) {
      expect(screen.getByRole("cell", { name: row })).toBeInTheDocument()
    }

    act(() => useWfm.getState().recallMany(sales.map((a) => a.id)))
    expect(onQueue()).toHaveTextContent(/^On queue now4/)
    expect(screen.getAllByTitle(/· Available · on queue$/)).toHaveLength(4)
  })

  it("projects a day that isn't today", () => {
    useWfm.setState({ scheduleDate: "2030-01-07" })
    renderPage("/scheduling?tab=coverage")
    expect(screen.getByText(/^Projected day/)).toBeInTheDocument()
    expect(screen.queryByText("On queue now")).not.toBeInTheDocument()
  })

  it("gives agents their own tabs, starting on My schedule", () => {
    useWfm.setState({ currentRole: "Agent" })
    renderPage("/scheduling?tab=coverage") // not an agent tab → falls back
    expect(tabNames()).toEqual(["My schedule", "Day view", "Open slots", "Requests"])
    expect(screen.getByRole("tab", { name: "My schedule" })).toHaveAttribute("aria-selected", "true")
  })
})
