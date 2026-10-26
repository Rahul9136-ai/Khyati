import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ChannelAutoPlan } from "@/components/channel-auto-plan"
import { api } from "@/lib/api"
import { AGENTS } from "@/lib/domain/seed"
import { useScheduleSync } from "@/lib/scheduleSync"
import { useWfm } from "@/store/wfm"

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }))
const get = vi.mocked(api.get)
const put = vi.mocked(api.put)
const post = vi.mocked(api.post)

const DAY = "2026-11-02"
const draft = (key: string, name: string, summary: string) => ({ plan_date: DAY, agent_key: key, agent_name: name, channels: [], base_version: 3, summary })

function renderPanel(canPublish = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ChannelAutoPlan canPublish={canPublish} /></QueryClientProvider>)
}

/** Two saved days on the server, both all-email for 07:00–15:30. */
const row = (key: string) => ({
  plan_date: DAY, agent_key: key, agent_name: `Agent ${key}`, team: "", shift_start: 420, shift_end: 930, version: 5,
  breaks: [], channels: [{ id: "e", channel: "email", start: 420, end: 930 }], overtime: [], activities: [],
})

let drafts: ReturnType<typeof draft>[] = []
beforeEach(() => {
  drafts = []
  get.mockReset()
  put.mockReset()
  post.mockReset()
  useScheduleSync.setState({ status: "synced", canWrite: true, serverAgents: {} })
  useWfm.setState({ agents: AGENTS.slice(0, 2), scheduleDate: "2026-10-26", dayStore: {} })
  get.mockImplementation(async (url: string) => {
    if (url === "/scheduling/channel-drafts") return { data: { data: drafts } }
    if (url === "/scheduling/day-plans/range") return { data: { data: [row(AGENTS[0].id), row(AGENTS[1].id)] } }
    // Summaries for ensureSaved: every agent-day in the range already exists.
    return { data: { data: [] } }
  })
  post.mockImplementation(async (url: string) => {
    if (url.endsWith("/fill")) return { data: { data: { created: 0, existing: 0 } } }
    if (url.endsWith("/publish")) return { data: { data: { applied: 2, stale: [{ agent_key: "a09", reason: "edited" }], published_days: 1, notified: 3 } } }
    return { data: { data: { discarded: drafts.length } } }
  })
  put.mockImplementation(async (_url: string, body: unknown) => {
    drafts = (body as { items: typeof drafts }).items
    return { data: { data: drafts } }
  })
})

describe("auto-plan channels", () => {
  it("plans phone first for the chosen weeks and saves the changes as a draft", async () => {
    renderPanel()
    fireEvent.change(screen.getByLabelText("Chat minimum heads"), { target: { value: "1" } })
    fireEvent.click(screen.getByRole("button", { name: /Plan channels/ }))

    expect(await screen.findByText(/saved as a draft\. Agents won't see it until you publish/)).toBeInTheDocument()
    const body = put.mock.calls[0][1] as { start: string; end: string; items: { agent_key: string; base_version: number; summary: string; channels: { channel: string }[] }[] }
    expect(body.items.map((i) => i.agent_key)).toEqual([AGENTS[0].id, AGENTS[1].id])
    expect(body.items[0].base_version).toBe(5)
    expect(body.items[0].summary).toMatch(/^Email 07:00–15:30 → Phone/)
    // Two agents can't even cover the phone requirement: phone first means chat gets nobody.
    expect(body.items.flatMap((i) => i.channels.map((c) => c.channel))).toEqual(["phone", "phone"])
    expect(get).toHaveBeenCalledWith("/scheduling/day-plans/range", { params: { start: body.start, end: body.end } })

    const table = screen.getByRole("table", { name: "Planned days" })
    expect(within(table).getByText("2 of 2")).toBeInTheDocument()
    expect(screen.getByText(/there just aren't enough free agents/)).toBeInTheDocument()
    expect(await screen.findByText(/2 channel changes on 1 day waiting to be published/)).toBeInTheDocument()
  })

  it("shows waiting drafts and publishes them to agents", async () => {
    drafts = [draft("a01", "Ava Mendez", "Email 07:00–15:30 → Phone 07:00–15:30"), draft("a02", "Liam Carter", "Phone → Chat")]
    renderPanel()
    expect(await screen.findByText(/2 channel changes on 1 day waiting to be published/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/· 2 agents/)) // expand the day
    expect(screen.getByText("Ava Mendez")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /Publish changes/ }))
    expect(await screen.findByText(/Published 2 channel changes and 1 schedule that were still drafts/)).toBeInTheDocument()
    expect(screen.getByText(/1 skipped because the day was edited after planning/)).toBeInTheDocument()
    await waitFor(() => expect(post).toHaveBeenCalledWith("/scheduling/channel-drafts/publish", expect.objectContaining({ start: expect.any(String) })))
  })

  it("can discard, and hides Publish from people who can't publish", async () => {
    drafts = [draft("a01", "Ava Mendez", "x")]
    renderPanel(false)
    expect(await screen.findByText(/1 channel change on 1 day/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Publish changes/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Discard/ }))
    expect(await screen.findByText("✓ Discarded 1 planned change.")).toBeInTheDocument()
  })
})
