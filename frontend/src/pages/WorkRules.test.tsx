import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import { AGENTS } from "@/lib/domain/seed"
import { DEFAULT_SHIFT_PATTERNS } from "@/lib/domain/shiftPatterns"
import { DEFAULT_WORK_COMPLIANCE, DEFAULT_WORK_RULES } from "@/lib/domain/workRules"
import { useScheduleSync } from "@/lib/scheduleSync"
import { WorkRules } from "@/pages/WorkRules"
import { useWfm } from "@/store/wfm"

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }))
const get = vi.mocked(api.get)
const put = vi.mocked(api.put)
const post = vi.mocked(api.post)

const [A, B, C3] = AGENTS
const SAT = "2026-11-07"
/** A saved Saturday for A: the old 07:00–15:30 shift, no week off. */
const savedSat = { plan_date: SAT, agent_key: A.id, agent_name: A.name, team: A.team, shift_start: 420, shift_end: 930, version: 4,
  breaks: [], channels: [{ id: "p", channel: "phone", start: 420, end: 930 }], overtime: [], activities: [] }

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<MemoryRouter><QueryClientProvider client={qc}><WorkRules /></QueryClientProvider></MemoryRouter>)
}

beforeEach(() => {
  get.mockReset()
  put.mockReset()
  post.mockReset()
  useScheduleSync.setState({ status: "synced", canWrite: true, serverAgents: {} })
  useWfm.setState({
    currentRole: "Super Admin", agents: AGENTS.slice(0, 3), shiftPatterns: DEFAULT_SHIFT_PATTERNS, workRules: DEFAULT_WORK_RULES,
    workCompliance: DEFAULT_WORK_COMPLIANCE, scheduleDate: "2026-10-26", dayStore: {},
  })
  get.mockImplementation(async (url: string) => ({ data: { data: url === "/scheduling/day-plans/range" ? [savedSat] : [] } }))
  post.mockResolvedValue({ data: { data: { created: 0, existing: 0 } } })
  put.mockResolvedValue({ data: { data: [] } })
})

const agentRow = (name: string) => screen.getByRole("checkbox", { name: `Select ${name}` }).closest("tr")!

describe("Work Rules page", () => {
  it("assigns a shift + break pattern and week offs to an agent", () => {
    renderPage()
    fireEvent.change(screen.getByLabelText(`${A.name} work rule`), { target: { value: "wr-9h" } })
    let me = useWfm.getState().agents[0]
    expect(me).toMatchObject({ shiftPatternId: "wr:wr-9h@09:00", weekOff: [5, 6] }) // the rule's usual start and days off
    expect(within(agentRow(A.name)).getByText("09:00–18:00")).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(`${A.name} start`), { target: { value: "07:30" } })
    within(screen.getByRole("group", { name: `${A.name} days off` })).getByRole("button", { name: "Wed off" }).click()
    me = useWfm.getState().agents[0]
    expect(me).toMatchObject({ shiftPatternId: "wr:wr-9h@07:30", weekOff: [2, 5, 6] })
    expect(within(agentRow(A.name)).getByText("07:30–16:30")).toBeInTheDocument()
  })

  it("picks a fixed or rotating week off from the presets", () => {
    renderPage()
    fireEvent.change(screen.getByLabelText(`${A.name} days off preset`), { target: { value: "fixed-sat-sun" } })
    expect(useWfm.getState().agents[0]).toMatchObject({ weekOff: [5, 6], weekOffMode: "fixed" })
    fireEvent.change(screen.getByLabelText(`${A.name} days off preset`), { target: { value: "rotating-2" } })
    expect(useWfm.getState().agents[0]).toMatchObject({ weekOff: [5, 6], weekOffMode: "rotating" })
    expect(within(agentRow(A.name)).getByText(/This week off .* · next week/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(`${A.name} days off type`), { target: { value: "fixed" } })
    expect(useWfm.getState().agents[0].weekOffMode).toBe("fixed")
  })

  it("staggers two days off in a row across the selected agents", () => {
    renderPage()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    fireEvent.click(screen.getByRole("button", { name: /Stagger days off/ }))
    expect(useWfm.getState().agents.map((a) => a.weekOff)).toEqual([[5, 6], [0, 6], [0, 1]])
    expect(screen.getByText(/Staggered 2 days off in a row across 3 agents/)).toBeInTheDocument()
  })

  it("writes the rules into saved schedules: new shift, rule breaks and the week off", async () => {
    useWfm.getState().assignWorkRule([A.id], { ruleId: "wr-8h", start: "09:00", weekOff: [5, 6] })
    renderPage()
    fireEvent.click(screen.getByRole("button", { name: /Apply to schedules/ }))
    expect(await screen.findByText(/Updated 1 agent-day on 1 date with the work rules/)).toBeInTheDocument()
    expect(put).toHaveBeenCalledTimes(1)
    const [url, body] = put.mock.calls[0] as [string, { items: { agent_key: string; shift_start: number; shift_end: number; base_version: number; breaks: unknown[]; activities: { type: string }[] }[] }]
    expect(url).toBe(`/scheduling/day-plans/${SAT}`)
    expect(body.items[0]).toMatchObject({ agent_key: A.id, shift_start: 540, shift_end: 1020, base_version: 4 })
    expect(body.items[0].breaks).toHaveLength(3)
    expect(body.items[0].activities.map((x) => x.type)).toEqual(["off"])
  })

  it("reports compliance and highlights who breaks a rule", async () => {
    get.mockResolvedValue({ data: { data: [] } }) // nothing saved: the roster's own patterns
    renderPage()
    fireEvent.click(screen.getByRole("button", { name: "Compliance" }))
    // Nobody has a week off yet → every agent works 7 days in a row.
    const table = await screen.findByRole("table", { name: "Compliance report" })
    expect(screen.getByText("3 of 3 agents break a rule")).toBeInTheDocument()
    expect(within(table).getAllByText(/0 days off in the week of/).length).toBe(3)

    useWfm.getState().setWeekOff([A.id, B.id, C3.id], [5, 6])
    await waitFor(() => expect(screen.getByText("All 3 agents compliant")).toBeInTheDocument())

    // Tighten the hours-in-a-row limit below the patterns' stretches.
    fireEvent.change(screen.getByLabelText("Max work in a row without a break"), { target: { value: "1.5" } })
    expect(useWfm.getState().workCompliance.maxContinuousWorkHours).toBe(1.5)
    expect(await screen.findByText(/3 of 3 agents break a rule/)).toBeInTheDocument()
    expect(within(table).getAllByText(/without a break — max 1h30 in a row/).length).toBeGreaterThan(0)
  })

  it("builds a new rule and flags it when it breaks compliance", () => {
    renderPage()
    fireEvent.click(screen.getByRole("button", { name: "Shift & break patterns" }))
    fireEvent.click(screen.getByRole("button", { name: /New work rule/ }))
    const dialog = screen.getByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("Shift length in hours"), { target: { value: "4" } })
    while (within(dialog).queryAllByRole("button", { name: "Remove break" }).length) fireEvent.click(within(dialog).getAllByRole("button", { name: "Remove break" })[0])
    expect(within(dialog).getByText(/4h shift with no break/)).toBeInTheDocument()
    expect(within(dialog).getByText(/4h of work without a break — max 3h in a row/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole("button", { name: /\+?Break$/ }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Create rule" }))
    expect(useWfm.getState().workRules.at(-1)).toMatchObject({ name: "4h · 15m break", shiftMinutes: 240, breaks: [{ type: "break", minutes: 15 }] })
  })
})
