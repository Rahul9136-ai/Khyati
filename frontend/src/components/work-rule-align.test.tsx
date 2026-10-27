import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { WorkRuleAlign } from "@/components/work-rule-align"
import { api } from "@/lib/api"
import { toMins } from "@/lib/domain/channels"
import { AGENTS } from "@/lib/domain/seed"
import { DEFAULT_SHIFT_PATTERNS } from "@/lib/domain/shiftPatterns"
import { DEFAULT_WORK_RULES } from "@/lib/domain/workRules"
import { useScheduleSync } from "@/lib/scheduleSync"
import { useWfm } from "@/store/wfm"

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }))
const get = vi.mocked(api.get)
const put = vi.mocked(api.put)
const post = vi.mocked(api.post)

const [A, B] = AGENTS
// The tests run "today" = whatever the clock says; pin the period explicitly.
const FROM = "2026-11-02" // Monday
const TO = "2026-11-08"

function setPeriod(from = FROM, to = TO) {
  fireEvent.change(screen.getByLabelText("Align from"), { target: { value: from } })
  fireEvent.change(screen.getByLabelText("Align to"), { target: { value: to } })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-27T10:00:00"))
  get.mockReset()
  put.mockReset()
  post.mockReset()
  useWfm.setState({ agents: AGENTS.slice(0, 2), shiftPatterns: DEFAULT_SHIFT_PATTERNS, workRules: DEFAULT_WORK_RULES, scheduleDate: "2026-10-27", dayStore: {}, activityPlan: {}, breakOverrides: {}, channelPlan: {}, overtimePlan: {} })
  useWfm.getState().assignWorkRule([A.id], { ruleId: "wr-8h", start: "10:00", weekOff: [5, 6], weekOffMode: "fixed" })
})

describe("align schedules to work rules", () => {
  it("offline: aligns the dates kept in this browser for the chosen period", () => {
    useScheduleSync.setState({ status: "offline", canWrite: false })
    // Sat 7 Nov was opened before and parked with A still on the old 07:00–15:30 shift.
    useWfm.setState({ dayStore: { "2026-11-07": { shifts: { [A.id]: "07:00–15:30", [B.id]: "07:00–15:30" }, breakOverrides: {}, channelPlan: {}, overtimePlan: {}, activityPlan: {} } } })
    render(<WorkRuleAlign />)
    setPeriod()
    fireEvent.click(screen.getByRole("button", { name: /Preview changes/ }))
    return screen.findByRole("table", { name: "Alignment preview" }).then((table) => {
      expect(within(table).getByText("Sat 7 Nov")).toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "Align 1 schedule" }))
      return screen.findByText(/Aligned 1 schedule on 1 day .* Saved in this browser/).then(() => {
        const parked = useWfm.getState().dayStore["2026-11-07"]
        expect(parked.shifts[A.id]).toBe("10:00–18:00")
        expect(parked.activityPlan[A.id]).toEqual([{ id: "week-off", type: "off", start: toMins("10:00"), end: toMins("18:00"), note: "Week off" }])
        expect(parked.shifts[B.id]).toBe("07:00–15:30") // not on a rule
        expect(put).not.toHaveBeenCalled()
      })
    })
  })

  it("online: aligns saved days and can publish the period afterwards", async () => {
    useScheduleSync.setState({ status: "synced", canWrite: true, serverAgents: {} })
    const saved = { plan_date: "2026-11-02", agent_key: A.id, agent_name: A.name, team: A.team, shift_start: 420, shift_end: 930, version: 2,
      breaks: [], channels: [{ id: "p", channel: "phone", start: 420, end: 930 }], overtime: [], activities: [] }
    get.mockImplementation(async (url: string) => ({ data: { data: url === "/scheduling/day-plans/range" ? [saved] : [] } }))
    post.mockImplementation(async (url: string) => ({ data: { data: url.endsWith("/fill") ? { created: 13, existing: 1 } : { start: FROM, end: TO, days: 7, agents: 2, published: 14, unchanged: 0, notified: 3 } } }))
    put.mockResolvedValue({ data: { data: [] } })
    render(<WorkRuleAlign canPublish />)
    setPeriod()
    fireEvent.click(screen.getByRole("button", { name: /Preview changes/ }))
    expect(await screen.findByText(/1 schedule on 1 day will change/)).toBeInTheDocument()
    expect(screen.getByText(/13 agent-days not saved yet will be created from the rules/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("checkbox", { name: /Publish Mon 2 Nov – Sun 8 Nov afterwards/ }))
    fireEvent.click(screen.getByRole("button", { name: "Align 1 schedule & publish" }))
    expect(await screen.findByText(/Aligned 1 schedule on 1 day .* Published 14 schedules/)).toBeInTheDocument()
    expect(put).toHaveBeenCalledWith("/scheduling/day-plans/2026-11-02", expect.objectContaining({ items: [expect.objectContaining({ shift_start: 600, shift_end: 1080, base_version: 2 })] }))
    expect(post).toHaveBeenCalledWith("/scheduling/day-plans/publish", { start: FROM, end: TO, note: "Aligned with work rules" })
  })

  it("checks the period", () => {
    useScheduleSync.setState({ status: "offline", canWrite: false })
    render(<WorkRuleAlign />)
    setPeriod(TO, FROM)
    expect(screen.getByText("The end date is before the start")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Preview changes/ })).toBeDisabled()
    setPeriod(FROM, "2027-06-01")
    expect(screen.getByText(/Schedules go up to/)).toBeInTheDocument()
  })
})
