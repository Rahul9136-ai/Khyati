import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ConnectSettings } from "@/components/connect-settings"
import { api } from "@/lib/api"
import { useAuth } from "@/store/auth"

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { baseURL: "http://localhost:8000/api/v1" } },
  setSessionExpiredHandler: vi.fn(),
  tokenStore: { get: () => null, set: vi.fn(), clear: vi.fn() },
}))
const get = vi.mocked(api.get)
const post = vi.mocked(api.post)
const patch = vi.mocked(api.patch)

const hook = {
  id: "h1", url: "https://crm.example/hook", description: "HubSpot", events: ["*"], active: true, secret: "whsec_abcdefghijklmnop",
  created_by_email: "admin@x", created_at: "2026-10-27T09:00:00Z", last_success_at: null, last_failure_at: null, consecutive_failures: 0,
}
let keys: unknown[] = []

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ConnectSettings /></QueryClientProvider>)
}

beforeEach(() => {
  keys = []
  get.mockReset()
  post.mockReset()
  patch.mockReset()
  useAuth.setState({ user: { id: "u", email: "admin@x", full_name: "Admin", is_superuser: false, role_names: [], permission_codes: ["integration:manage", "schedule:read", "schedule:write"] } })
  get.mockImplementation(async (url: string) => {
    const data: Record<string, unknown> = {
      "/connect/api-keys": keys,
      "/connect/scopes": [{ code: "schedule:read", description: "View schedules" }, { code: "schedule:write", description: "Edit schedules" }, { code: "employee:read", description: "View employees" }],
      "/connect/webhooks": [hook],
      "/connect/events": [{ type: "schedule.updated", description: "Day changed" }, { type: "slot.claimed", description: "Slot taken" }, { type: "ping", description: "Test" }],
      "/connect/webhooks/h1/deliveries": [],
    }
    return { data: { data: data[url] ?? [] } }
  })
})

describe("API & Webhooks settings", () => {
  it("creates an API key and shows it once", async () => {
    post.mockImplementation(async (_url: string, body: unknown) => {
      const k = { id: "k1", name: "Salesforce", prefix: "wfm_AbCd1234", scopes: (body as { scopes: string[] }).scopes, created_by_email: "admin@x", created_at: "2026-10-27T09:00:00Z", last_used_at: null, expires_at: null, revoked_at: null }
      keys = [k]
      return { data: { data: { ...k, key: "wfm_AbCd1234_secret_value" } } }
    })
    renderIt()
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Salesforce" } })
    const create = screen.getByRole("button", { name: /Create key/ })
    await waitFor(() => expect(create).toBeEnabled()) // once the grantable permissions have loaded
    fireEvent.click(create)
    expect(await screen.findByTestId("new-api-key")).toHaveTextContent("wfm_AbCd1234_secret_value")
    expect(screen.getByText(/it won't be shown again/)).toBeInTheDocument()
    // "Read & update schedules" preset, limited to what the user may grant.
    expect(post).toHaveBeenCalledWith("/connect/api-keys", { name: "Salesforce", scopes: ["schedule:read", "schedule:write", "employee:read"], expires_in_days: null })
    const table = await screen.findByRole("table", { name: "API keys" })
    expect(await within(table).findByText("wfm_AbCd1234…")).toBeInTheDocument()
  })

  it("adds a webhook, sends a test and pauses it", async () => {
    post.mockImplementation(async (url: string) => {
      if (url.endsWith("/test")) return { data: { data: { id: "d1", event_type: "ping", status: "delivered", response_status: 200, duration_ms: 42, error: "" } } }
      return { data: { data: hook } }
    })
    patch.mockResolvedValue({ data: { data: { ...hook, active: false } } })
    renderIt()
    fireEvent.change(screen.getByLabelText("Webhook URL"), { target: { value: "https://crm.example/hook" } })
    fireEvent.click(screen.getByRole("button", { name: /Add webhook/ }))
    await waitFor(() => expect(post).toHaveBeenCalledWith("/connect/webhooks", { url: "https://crm.example/hook", description: "", events: ["*"] }))

    fireEvent.click(await screen.findByRole("button", { name: /Send test/ }))
    expect(await screen.findByText("✓ Test delivered — HTTP 200 in 42 ms.")).toBeInTheDocument()
    expect(screen.getByText("whsec_abcd••••••••")).toBeInTheDocument() // secret hidden until asked

    fireEvent.click(screen.getByRole("checkbox", { name: "Active: https://crm.example/hook" }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/connect/webhooks/h1", { active: false }))
    // Unticking one event keeps the others ("*" expands to the list first).
    fireEvent.click(screen.getByRole("checkbox", { name: "slot.claimed" }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/connect/webhooks/h1", { events: ["schedule.updated"] }))
  })

  it("explains what's needed without the permission", () => {
    useAuth.setState({ user: { id: "u", email: "tl@x", full_name: "TL", is_superuser: false, role_names: [], permission_codes: ["schedule:read"] } })
    renderIt()
    expect(screen.getByText(/You need the “integration:manage” permission/)).toBeInTheDocument()
  })
})
