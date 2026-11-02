import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import { parseEmails, type ReportSchedule } from "@/lib/scheduledReports"
import { ScheduledReports } from "@/pages/ScheduledReports"
import { useAuth } from "@/store/auth"

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  setSessionExpiredHandler: vi.fn(),
  tokenStore: { get: () => null, set: vi.fn(), clear: vi.fn() },
}))
const get = vi.mocked(api.get)
const post = vi.mocked(api.post)

const LIST = { id: "l1", name: "Team leaders", emails: ["a@x.dev", "b@x.dev"] }
const SUB: ReportSchedule = {
  id: "s1", name: "Ops daily", frequency: "daily", weekdays: [0, 1, 2, 3, 4], send_time: "08:00", timezone: "Asia/Kolkata", lob: "",
  to_recipients: ["boss@x.dev"], cc_recipients: ["list:l1"], active: true, next_run_at: "2026-11-03T02:30:00Z", last_run_at: null, last_status: "",
}
let subs: ReportSchedule[] = []
let configured = true

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ScheduledReports /></QueryClientProvider>)
}

beforeEach(() => {
  subs = []
  configured = true
  get.mockReset()
  post.mockReset()
  useAuth.setState({ user: { id: "u", email: "m@x", full_name: "M", is_superuser: false, role_names: [], permission_codes: ["report:export"] } })
  get.mockImplementation(async (url: string) => {
    if (url.endsWith("/status")) return { data: { data: { configured, provider: configured ? "smtp" : "", from: "reports@x.dev" } } }
    if (url.endsWith("/lists")) return { data: { data: [LIST] } }
    if (url.endsWith("/preview")) return { data: { data: { subject: "Daily · 1 Nov", html: "<h1>Dash</h1>" } } }
    if (url.endsWith("/runs")) return { data: { data: [] } }
    return { data: { data: subs } }
  })
})

describe("parseEmails", () => {
  it("handles commas, semicolons, spaces, new lines and display names", () => {
    expect(parseEmails("a@x.dev, b@x.dev; c@x.dev\nd@x.dev e@x.dev")).toEqual({ valid: ["a@x.dev", "b@x.dev", "c@x.dev", "d@x.dev", "e@x.dev"], invalid: [] })
    expect(parseEmails("Asha Rao <asha@x.dev>, nope, a@x.dev, a@x.dev")).toEqual({ valid: ["asha@x.dev", "a@x.dev"], invalid: ["nope"] })
  })
})

describe("Scheduled Reports", () => {
  it("creates a schedule with separate To and CC, including a list", async () => {
    post.mockResolvedValue({ data: { data: SUB } })
    renderIt()
    fireEvent.click(await screen.findByRole("button", { name: /New schedule/ }))
    const d = screen.getByRole("dialog")
    fireEvent.click(within(d).getByRole("button", { name: "Create schedule" }))
    expect(within(d).getByRole("alert")).toHaveTextContent("Give the report a name.")
    fireEvent.change(within(d).getByLabelText("Report name"), { target: { value: "Ops MTD" } })
    fireEvent.click(within(d).getByRole("button", { name: /MTD/ }))
    fireEvent.click(within(d).getByRole("button", { name: "Create schedule" }))
    expect(within(d).getByRole("alert")).toHaveTextContent("Add at least one recipient in To.")

    const to = within(d).getByLabelText("To email")
    fireEvent.change(to, { target: { value: "boss@x.dev, oops" } })
    fireEvent.blur(to)
    expect(within(d).getByText("Not valid: oops")).toBeInTheDocument()
    fireEvent.change(to, { target: { value: "" } })
    fireEvent.change(await within(d).findByLabelText("Add a distribution list to CC"), { target: { value: "list:l1" } })
    fireEvent.click(within(d).getByRole("button", { name: "Create schedule" }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][0]).toBe("/reports/scheduled")
    expect(post.mock.calls[0][1]).toMatchObject({ name: "Ops MTD", frequency: "mtd", to_recipients: ["boss@x.dev"], cc_recipients: ["list:l1"] })
  })

  it("weekly sends on one day only", async () => {
    renderIt()
    fireEvent.click(await screen.findByRole("button", { name: /New schedule/ }))
    const d = screen.getByRole("dialog")
    fireEvent.click(within(d).getByRole("button", { name: /Weekly/ }))
    fireEvent.click(within(d).getByRole("button", { name: "Fri" }))
    const pressed = within(within(d).getByRole("group", { name: "Days to send" })).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true")
    expect(pressed.map((b) => b.textContent)).toEqual(["Fri"])
  })

  it("shows To and CC, and only sends after confirming", async () => {
    subs = [SUB]
    post.mockResolvedValue({ data: { data: { id: "r", trigger: "manual", status: "sent", error: "", to_recipients: ["boss@x.dev"], cc_recipients: ["a@x.dev", "b@x.dev"], period_start: "2026-11-01", period_end: "2026-11-01", created_at: "2026-11-02T00:00:00Z" } } })
    renderIt()
    expect(await screen.findByText("Ops daily")).toBeInTheDocument()
    expect(screen.getByText(/boss@x\.dev/)).toBeInTheDocument()
    expect(await screen.findByText((_, el) => el?.textContent === "CC: Team leaders")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Send now/ }))
    expect(post).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("emails the real To and CC")
    fireEvent.click(screen.getByRole("button", { name: "Send it" }))
    expect(await screen.findByText("✓ Sent to 1 in To and 2 in CC.")).toBeInTheDocument()
    expect(post).toHaveBeenCalledWith("/reports/scheduled/s1/send")
  })

  it("renders the preview in a locked-down frame", async () => {
    renderIt()
    fireEvent.click(await screen.findByRole("button", { name: "Daily" }))
    const frame = await screen.findByTitle("Report preview")
    expect(frame).toHaveAttribute("sandbox", "")
    expect(frame.getAttribute("srcdoc")).toContain("Dash")
  })

  it("warns when email isn't set up, and explains without permission", async () => {
    configured = false
    const { unmount } = renderIt()
    expect(await screen.findByText(/Email isn't set up on the server yet/)).toBeInTheDocument()
    unmount()
    useAuth.setState({ user: { id: "u", email: "t@x", full_name: "T", is_superuser: false, role_names: [], permission_codes: ["report:read"] } })
    renderIt()
    expect(screen.getByText(/You need the “report:export” permission/)).toBeInTheDocument()
  })
})
