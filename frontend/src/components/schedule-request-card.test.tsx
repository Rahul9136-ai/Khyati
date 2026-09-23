import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ScheduleRequestCard } from "@/components/schedule-request-card"
import * as integrations from "@/lib/integrations"
import type { IntegrationConfig } from "@/lib/integrations"
import * as sr from "@/lib/scheduleRequest"
import type { ParseResult, ParsedRequest } from "@/lib/scheduleRequest"
import { useAuth } from "@/store/auth"
import { useWfm } from "@/store/wfm"

vi.mock("@/lib/scheduleRequest", async (orig) => ({ ...(await orig<typeof sr>()), parseScheduleRequest: vi.fn() }))
vi.mock("@/lib/integrations", async (orig) => ({
  ...(await orig<typeof integrations>()), raiseApproval: vi.fn(), getConfig: vi.fn(),
}))

const parsed = (over: Partial<ParsedRequest> = {}): ParsedRequest => ({
  employee_name: "Priya Sharma", employee_id: "E1004", action: "Mark Absence", date_or_week: "2026-06-26",
  field_to_change: "Absence & Sickness (HC)", new_value: "1", raw_message: "Priya Sharma (E1004) is sick today",
  confidence: "High", ...over,
})
const result = (p: ParsedRequest, extra: Partial<ParseResult> = {}): ParseResult => ({ parsed: p, parser: "rules", matched_employee: null, ...extra })

const baseConfig: IntegrationConfig = {
  slack_enabled: false, slack_configured: false, slack_channel: "", slack_webhook_set: false,
  slack_bot_token_set: false, slack_signing_secret_set: false, teams_enabled: false, teams_configured: false,
  teams_webhook_set: false, teams_security_token_set: false, default_approver_id: null,
  auto_apply_on_approve: true, any_channel_live: false, automation_enabled: false,
  auto_apply_min_confidence: "High", slack_command_channel: "", teams_command_channel: "",
  teams_app_id_set: false, teams_app_password_set: false,
}

function renderCard(source: "scheduling" | "intraday") {
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ScheduleRequestCard source={source} /></MemoryRouter>
    </QueryClientProvider>,
  )
}

function setup(source: "scheduling" | "intraday") {
  renderCard(source)
  fireEvent.click(screen.getByText("Schedule change request"))
}
async function parseMessage(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/e\.g\./), { target: { value: text } })
  fireEvent.click(screen.getByRole("button", { name: /parse message/i }))
  await screen.findByText(/^(High|Medium|Low) confidence$/)
}

describe("ScheduleRequestCard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWfm.setState({ currentRole: "Super Admin" })
    useAuth.setState({ user: null, status: "anonymous", error: null })
  })

  it("is collapsed until opened, then parses and shows every field", async () => {
    vi.mocked(sr.parseScheduleRequest).mockResolvedValue(result(parsed()))
    renderCard("scheduling")
    expect(screen.queryByRole("button", { name: /parse message/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("Schedule change request"))
    await parseMessage("Priya Sharma (E1004) is sick today")

    // the app's anchored "today" is sent so "today"/"tomorrow" resolve against it
    expect(sr.parseScheduleRequest).toHaveBeenCalledWith("Priya Sharma (E1004) is sick today", "2026-06-26")
    expect(screen.getByDisplayValue("Priya Sharma")).toBeInTheDocument()
    expect(screen.getByDisplayValue("E1004")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Mark Absence")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Absence & Sickness (HC)")).toBeInTheDocument()
    expect(screen.getByText("High confidence")).toBeInTheDocument()
  })

  it("raises a Real-Time request for approval with the right kind, source and employee", async () => {
    vi.mocked(sr.parseScheduleRequest).mockResolvedValue(
      result(parsed(), { matched_employee: { id: "uuid-1", employee_code: "E1004", name: "Priya Sharma", team_id: null } }),
    )
    vi.mocked(integrations.raiseApproval).mockResolvedValue({ id: "ap-1" } as integrations.Approval)
    setup("intraday")
    await parseMessage("Priya Sharma (E1004) is sick today")
    fireEvent.click(screen.getByRole("button", { name: /send for om approval \(real-time\)/i }))

    await waitFor(() => expect(integrations.raiseApproval).toHaveBeenCalledTimes(1))
    const body = vi.mocked(integrations.raiseApproval).mock.calls[0][0]
    expect(body.source).toBe("intraday")
    expect(body.kind).toBe("absence_mark")
    expect(body.employee_id).toBe("uuid-1")
    expect(body.payload).toMatchObject({ employee_code: "E1004", action: "Mark Absence", new_value: "1", raised_from: "realtime" })
    expect(await screen.findByText(/sent to the operations manager/i)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /open in approvals/i })).toHaveAttribute("href", "/approvals?focus=ap-1")
  })

  it("won't send without an employee ID — and never guesses one", async () => {
    vi.mocked(sr.parseScheduleRequest).mockResolvedValue(
      result(parsed({ employee_id: null, confidence: "Low", raw_message: "Priya is sick today" })),
    )
    setup("scheduling")
    await parseMessage("Priya is sick today")
    const send = screen.getByRole("button", { name: /^send for om approval \(/i })
    expect(screen.getByText("Low confidence")).toBeInTheDocument()
    expect(screen.getByText(/no employee id was found/i)).toBeInTheDocument()
    expect(send).toBeDisabled()

    fireEvent.change(screen.getByLabelText("Employee ID"), { target: { value: "E1004" } })
    expect(send).toBeEnabled()
  })

  it("changing the action resets the field and value, and the edited values are what get raised", async () => {
    vi.mocked(sr.parseScheduleRequest).mockResolvedValue(result(parsed()))
    vi.mocked(integrations.raiseApproval).mockResolvedValue({ id: "ap-2" } as integrations.Approval)
    setup("scheduling")
    await parseMessage("Priya Sharma (E1004) is sick today")
    fireEvent.change(screen.getByDisplayValue("Mark Absence"), { target: { value: "Cancel Leave" } })
    expect(screen.getByDisplayValue("Planned Leave (HC)")).toBeInTheDocument()
    expect(screen.getByDisplayValue("0")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /send for om approval \(scheduling\)/i }))
    await waitFor(() => expect(integrations.raiseApproval).toHaveBeenCalled())
    const body = vi.mocked(integrations.raiseApproval).mock.calls[0][0]
    expect(body).toMatchObject({ source: "scheduling", kind: "leave_cancel" })
    expect(body.payload).toMatchObject({ field_to_change: "Planned Leave (HC)", new_value: "0" })
  })

  it("shows the server's error message when parsing fails", async () => {
    vi.mocked(sr.parseScheduleRequest).mockRejectedValue({ response: { data: { error: { message: "Requires one of: intraday:write, schedule:write" } } } })
    setup("scheduling")
    fireEvent.change(screen.getByPlaceholderText(/e\.g\./), { target: { value: "x" } })
    fireEvent.click(screen.getByRole("button", { name: /parse message/i }))
    expect(await screen.findByText(/requires one of/i)).toBeInTheDocument()
  })

  it("is hidden for roles that can't raise approvals", () => {
    useWfm.setState({ currentRole: "Agent" })
    renderCard("scheduling")
    expect(screen.queryByText("Schedule change request")).not.toBeInTheDocument()
  })

  describe("automation status banner", () => {
    function asIntegrationManager() {
      useAuth.setState({
        status: "authenticated", error: null,
        user: { id: "u1", email: "admin@test.dev", full_name: "Admin", is_superuser: true,
               role_names: ["Super Admin"], permission_codes: ["integration:manage"] },
      })
    }

    it("never calls getConfig for a role without integration:manage", async () => {
      renderCard("scheduling")
      await new Promise((r) => setTimeout(r, 0))
      expect(integrations.getConfig).not.toHaveBeenCalled()
    })

    it("shows 'connected' with the right channels and threshold when automation is live", async () => {
      asIntegrationManager()
      vi.mocked(integrations.getConfig).mockResolvedValue({
        ...baseConfig, automation_enabled: true, slack_command_channel: "C123", auto_apply_min_confidence: "Medium",
      })
      renderCard("scheduling")
      expect(await screen.findByText("Automation connected")).toBeInTheDocument()
      expect(screen.getByText(/@mention the bot in\s*Slack/)).toBeInTheDocument()
      expect(screen.getByText(/medium-confidence requests apply immediately/)).toBeInTheDocument()
    })

    it("shows 'not connected' when no command channel is configured", async () => {
      asIntegrationManager()
      vi.mocked(integrations.getConfig).mockResolvedValue(baseConfig)
      renderCard("scheduling")
      expect(await screen.findByText("Automation not connected")).toBeInTheDocument()
    })
  })
})
