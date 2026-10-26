import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { AgentSlotOffers, SlotOffersManager } from "@/components/slot-offers"
import { api } from "@/lib/api"
import type { Offer } from "@/lib/offers"
import { AGENTS, QUEUES } from "@/lib/domain/seed"
import type { PlanRow } from "@/lib/domain/types"
import { useScheduleSync } from "@/lib/scheduleSync"
import { useAuth } from "@/store/auth"

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  setSessionExpiredHandler: vi.fn(),
  tokenStore: { access: null, refresh: null, set: vi.fn(), clear: vi.fn() },
}))
const get = vi.mocked(api.get)
const post = vi.mocked(api.post)
const patch = vi.mocked(api.patch)

const DAY = "2026-10-26"
const queue = QUEUES[0]
const row = (scheduled: number, required: number): PlanRow => ({
  idx: 0, label: "", volume: 0, intensity: 0, requiredNet: 0, requiredGross: required, scheduled, variance: scheduled - required,
  targetSL: 0.8, projSL: 0.8, asa: 0, occupancy: 0,
})
// 09:00–11:00: 2 over, then 11:00–12:00: 1 short.
const plan = [row(9, 7), row(9, 7), row(9, 7), row(9, 7), row(6, 7), row(6, 7)]

function offer(over: Partial<Offer>): Offer {
  return {
    id: "o1", plan_date: DAY, queue_key: queue.id, queue_name: queue.name, kind: "vto", start: 9 * 60, end: 11 * 60,
    capacity: 5, filled: 3, left: 2, channel: null, status: "open", note: "", claims: [], mine: null, ...over,
  }
}
const claim = (id: string, agent: (typeof AGENTS)[number]) => ({ id, agent_key: agent.id, agent_name: agent.name, start: 540, end: 660, status: "filled" as const, created_at: "" })

function renderWith(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  get.mockReset()
  post.mockReset()
  patch.mockReset()
  useScheduleSync.setState({ status: "synced", canWrite: true, serverAgents: {} })
  useAuth.setState({ user: null }) // no published days loaded → the server alone decides what fits
})

describe("scheduler: open slots", () => {
  it("suggests VTO and OT from requirement vs schedule and opens them for skilled agents", async () => {
    get.mockResolvedValue({ data: { data: [] } })
    post.mockResolvedValue({ data: { data: { created: 2, updated: 0, notified: 9, offers: [] } } })
    renderWith(<SlotOffersManager date={DAY} queue={queue} plan={plan} lost={[]} firstIntervalStart={9 * 60} agents={AGENTS} canEdit />)

    const table = screen.getByRole("table")
    expect(within(table).getAllByRole("row").slice(1).map((r) => r.textContent)).toEqual([
      "VTO09:00–11:002 over required",
      "OT11:00–12:001 short of required",
    ])
    fireEvent.change(screen.getByLabelText("VTO slots 09:00–11:00"), { target: { value: "1" } })
    fireEvent.click(screen.getByRole("button", { name: "Open 2 slots" }))

    await screen.findByText(/Opened 2 new slots · 9 agents notified/)
    const body = post.mock.calls[0][1] as { items: { kind: string; capacity: number; eligible: string[]; start: number }[] }
    expect(body.items.map((i) => [i.kind, i.start, i.capacity])).toEqual([["vto", 540, 1], ["ot", 660, 1]])
    expect(body.items[0].eligible).toEqual(AGENTS.filter((a) => a.skills.includes(queue.id)).map((a) => a.id))
  })

  it("can switch over-staffing to PTO and add full-day leave", () => {
    get.mockResolvedValue({ data: { data: [] } })
    renderWith(<SlotOffersManager date={DAY} queue={queue} plan={[row(9, 7), row(9, 7)]} lost={[]} firstIntervalStart={9 * 60} agents={AGENTS} canEdit />)
    fireEvent.change(screen.getByLabelText("Offer over-staffing as"), { target: { value: "pto" } })
    fireEvent.click(screen.getByLabelText("Full-day leave"))
    expect(screen.getAllByRole("row").slice(1).map((r) => r.textContent)).toEqual(["LeaveFull day2 over required all day"])
  })

  it("tracks opened slots: filled / left, who took them, capacity and closing", async () => {
    get.mockResolvedValue({ data: { data: [offer({ claims: [claim("c1", AGENTS[0]), claim("c2", AGENTS[1]), claim("c3", AGENTS[2])] })] } })
    patch.mockResolvedValue({ data: { data: offer({}) } })
    renderWith(<SlotOffersManager date={DAY} queue={queue} plan={plan} lost={[]} firstIntervalStart={9 * 60} agents={AGENTS} canEdit />)

    const item = (await screen.findByText(AGENTS[0].name)).closest("li")!
    expect(item).toHaveTextContent("3 filled · 2 left")
    expect(item).toHaveTextContent(AGENTS[2].name)
    fireEvent.click(within(item).getByRole("button", { name: "More VTO slots" }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/scheduling/offers/o1", { capacity: 6 }))
    fireEvent.click(within(item).getByRole("button", { name: /Close/ }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/scheduling/offers/o1", { status: "closed" }))
    fireEvent.click(within(item).getByRole("button", { name: `Cancel ${AGENTS[1].name}'s VTO` }))
    await waitFor(() => expect(post).toHaveBeenCalledWith("/scheduling/offers/claims/c2/cancel"))
  })

  it("team leaders (view only) see the slots without controls", async () => {
    get.mockResolvedValue({ data: { data: [offer({})] } })
    renderWith(<SlotOffersManager date={DAY} queue={queue} plan={plan} lost={[]} firstIntervalStart={9 * 60} agents={AGENTS} canEdit={false} />)
    expect(await screen.findByText(/3/, { selector: "b" })).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Close/ })).not.toBeInTheDocument()
  })
})

describe("agent: open slots for you", () => {
  it("shows filled / left and takes or gives back a slot", async () => {
    const mine = claim("c9", AGENTS[0])
    get.mockResolvedValue({ data: { data: [
      offer({}),
      offer({ id: "o2", kind: "ot", start: 16 * 60, end: 17 * 60, capacity: 2, filled: 2, left: 0 }),
      offer({ id: "o3", kind: "leave", start: 0, end: 1440, plan_date: "2026-10-28", capacity: 1, filled: 1, left: 0, mine, claims: [mine] }),
    ] } })
    post.mockResolvedValue({ data: { data: offer({}) } })
    renderWith(<AgentSlotOffers agentId={AGENTS[0].id} staffPreview={false} />)

    const vto = (await screen.findByRole("button", { name: "Take VTO" })).closest("li")!
    expect(vto).toHaveTextContent("09:00–11:00")
    expect(vto).toHaveTextContent("3 filled · 2 left")
    expect(screen.getByRole("button", { name: "Full" })).toBeDisabled() // OT: 2 filled · 0 left
    expect(screen.getByRole("button", { name: /Yours · Give back/ }).closest("li")).toHaveTextContent("Full day")

    fireEvent.click(within(vto).getByRole("button", { name: "Take VTO" }))
    await screen.findByText(/VTO .* is yours — added to your schedule/)
    expect(post).toHaveBeenCalledWith("/scheduling/offers/o1/claim", {})

    fireEvent.click(screen.getByRole("button", { name: /Yours · Give back/ }))
    await waitFor(() => expect(post).toHaveBeenCalledWith("/scheduling/offers/claims/c9/cancel"))
  })

  it("shows the server's reason when a slot can't be taken", async () => {
    get.mockResolvedValue({ data: { data: [offer({})] } })
    post.mockRejectedValue({ message: "No VTO slots left" })
    renderWith(<AgentSlotOffers agentId={AGENTS[0].id} staffPreview={false} />)
    fireEvent.click(await screen.findByRole("button", { name: "Take VTO" }))
    expect(await screen.findByText(/No VTO slots left/)).toBeInTheDocument()
  })

  it("greys out slots that don't fit the agent's published day, with the reason", async () => {
    useAuth.setState({ user: { id: "u", email: "ava@x", full_name: "Ava", is_superuser: false, role_names: ["Employee"], permission_codes: ["schedule:read"] } })
    get.mockImplementation(async (url: string) => {
      if (url === "/scheduling/my-schedule") {
        return { data: { data: { agent_keys: [AGENTS[0].id], days: [{ plan_date: DAY, agent_key: AGENTS[0].id, shift_start: 420, shift_end: 930, breaks: [], channels: [], overtime: [], activities: [] }] } } }
      }
      return { data: { data: [
        offer({}), // VTO 09:00–11:00 — inside 07:00–15:30: fits
        offer({ id: "o2", kind: "ot", start: 8 * 60, end: 9 * 60 }), // OT while already working
        offer({ id: "o3", kind: "vto", start: 17 * 60, end: 18 * 60 }), // after the shift
        offer({ id: "o4", plan_date: "2026-10-30" }), // not published for them yet
      ] } }
    })
    renderWith(<AgentSlotOffers agentId={AGENTS[0].id} staffPreview={false} />)
    expect(await screen.findByText("You're already working 08:00–09:00")).toBeInTheDocument()
    expect(screen.getByText("You're not working 17:00–18:00 that day")).toBeInTheDocument()
    expect(screen.getByText("Your schedule for this day isn't published yet")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Take VTO" })).toHaveLength(1)
    expect(get).toHaveBeenCalledWith("/scheduling/my-schedule", expect.anything())
  })

  it("staff previewing the Agent view take slots for that agent", async () => {
    get.mockResolvedValue({ data: { data: [offer({})] } })
    post.mockResolvedValue({ data: { data: offer({}) } })
    renderWith(<AgentSlotOffers agentId={AGENTS[3].id} staffPreview />)
    fireEvent.click(await screen.findByRole("button", { name: "Take VTO" }))
    await waitFor(() => expect(post).toHaveBeenCalledWith("/scheduling/offers/o1/claim", { agent_key: AGENTS[3].id }))
  })
})
