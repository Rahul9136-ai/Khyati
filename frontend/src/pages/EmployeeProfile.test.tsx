import { fireEvent, render, screen, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { defaultProfile } from "@/lib/domain/employeeProfile"
import { addDays, localISODate } from "@/lib/domain/horizon"
import { AGENTS } from "@/lib/domain/seed"
import { missingDays } from "@/lib/schedulePublish"
import { HcTracker } from "@/pages/HcTracker"
import { EmployeeProfile } from "@/pages/EmployeeProfile"
import { Employees } from "@/pages/Employees"
import { useWfm } from "@/store/wfm"

const [ava, liam] = AGENTS

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/employees" element={<Employees />} />
        <Route path="/employees/:id" element={<EmployeeProfile />} />
        <Route path="/hc-tracker" element={<HcTracker />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useWfm.setState({
    currentRole: "Super Admin", currentUser: "Priya Admin", agents: AGENTS.slice(0, 3), rta: AGENTS.slice(0, 3).map((a) => ({ id: a.id, actual: "AVAIL", scheduled: "AVAIL", secs: 1 })),
    employeeProfiles: {}, formerEmployees: {}, employeeChanges: [],
  })
})

describe("employee profile page", () => {
  it("edits the administrative details and data-source IDs, then saves", () => {
    renderAt(`/employees/${ava.id}`)
    expect(screen.getByRole("heading", { name: "Profile: Mendez, Ava" })).toBeInTheDocument()
    const save = screen.getByRole("button", { name: /Save/ })
    expect(save).toBeDisabled()

    fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Trainer" } })
    fireEvent.change(screen.getByLabelText("Employee number"), { target: { value: "67965" } })
    fireEvent.change(screen.getByLabelText("Prod_Parham_Phone employee ID"), { target: { value: "13670" } })
    fireEvent.change(screen.getByLabelText("Prod_Parham_Phone extension"), { target: { value: "4411" } })
    fireEvent.click(screen.getByLabelText("QMData enrolled"))
    fireEvent.change(screen.getByLabelText("Team lead"), { target: { value: "Elena Faro" } })
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
    fireEvent.click(save)

    const saved = useWfm.getState().employeeProfiles[ava.id]
    expect(saved).toMatchObject({ jobTitle: "Trainer", employeeNumber: "67965", teamLead: "Elena Faro" })
    expect(saved.sources["prod-parham-phone"]).toMatchObject({ employeeId: "13670", extension: "4411" })
    expect(saved.sources.qmdata.enabled).toBe(true)
    expect(useWfm.getState().agents.find((a) => a.id === ava.id)!.tl).toBe("Elena Faro") // team lead flows to the roster
    expect(screen.getByRole("status")).toHaveTextContent("Profile saved.")
  })

  it("sets a wage from an effective date and shows its history", () => {
    renderAt(`/employees/${ava.id}`)
    fireEvent.click(screen.getByRole("button", { name: "Change wage amount" }))
    fireEvent.change(screen.getByLabelText("New wage amount"), { target: { value: "18.5" } })
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))
    expect(screen.getByLabelText("Wage amount")).toHaveTextContent("18.50")
    fireEvent.click(screen.getByRole("button", { name: "Wage amount history" }))
    expect(screen.getByRole("list", { name: "Wage amount history list" }).children).toHaveLength(2)
  })

  it("hides the tax ID until revealed, and reverts unsaved edits", () => {
    useWfm.setState({ employeeProfiles: {} })
    renderAt(`/employees/${ava.id}`)
    fireEvent.click(screen.getByRole("button", { name: "Show tax ID" }))
    fireEvent.change(screen.getByLabelText("Tax ID (SSN)"), { target: { value: "123-45-6789" } })
    fireEvent.click(screen.getByRole("button", { name: "Hide tax ID" }))
    expect(screen.getByLabelText("Tax ID (SSN)")).toHaveTextContent("•••-••-6789")
    fireEvent.click(screen.getByRole("button", { name: /Revert/ }))
    expect(screen.getByLabelText("Tax ID (SSN)")).toHaveTextContent("—")
  })

  it("keeps someone on the roster through their last working day", () => {
    renderAt(`/employees/${liam.id}`)
    fireEvent.click(screen.getByRole("button", { name: /Terminate/ }))
    fireEvent.click(screen.getAllByRole("button", { name: /Terminate/ }).at(-1)!) // last working day = today
    const s = useWfm.getState()
    expect(s.employeeProfiles[liam.id].endDate).toBe(localISODate())
    expect(s.agents.some((a) => a.id === liam.id)).toBe(true) // still working today
    expect(screen.getByRole("status")).toHaveTextContent(/comes off the roster, schedules and the real-time board after/)
    expect(screen.getByRole("button", { name: /Delete/ })).toBeDisabled()
  })

  it("takes a leaver off the campaign after their last working day, and brings them back if it's cleared", () => {
    const yesterday = addDays(localISODate(), -1)
    renderAt(`/employees/${liam.id}`)
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: yesterday } })
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))

    let s = useWfm.getState()
    expect(s.agents.some((a) => a.id === liam.id)).toBe(false) // off the roster / scheduling
    expect(s.rta.some((r) => r.id === liam.id)).toBe(false) // off the real-time board
    expect(s.formerEmployees[liam.id]?.name).toBe(liam.name)
    expect(s.employeeChanges.map((c) => [c.action, c.by])).toEqual([["Exited", "Priya Admin"], ["Updated", "Priya Admin"]])
    expect(s.employeeChanges[0].detail).toMatch(new RegExp(`^Removed from ${liam.team} · .* after last working day ${yesterday}$`))
    expect(s.employeeChanges[1].detail).toBe(`Last working day — → ${yesterday}`)
    expect(screen.getByRole("note")).toHaveTextContent(`${liam.name} left after`)
    expect(screen.getByRole("button", { name: /Delete/ })).toBeEnabled()

    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    s = useWfm.getState()
    expect(s.agents.some((a) => a.id === liam.id)).toBe(true)
    expect(s.formerEmployees[liam.id]).toBeUndefined()
    expect(s.employeeChanges[0].action).toBe("Rehired")
  })

  it("settles a future end date once it has passed", () => {
    const lastDay = addDays(localISODate(), 3)
    useWfm.getState().saveEmployeeProfile(liam.id, { ...defaultProfile(liam, localISODate()), endDate: lastDay })
    expect(useWfm.getState().agents.some((a) => a.id === liam.id)).toBe(true) // still serving notice
    // No schedules are generated for them after their last day.
    const days = missingDays(addDays(lastDay, -1), addDays(lastDay, 2), new Set()).filter((d) => d.agent_key === liam.id)
    expect(days.map((d) => d.plan_date)).toEqual([addDays(lastDay, -1), lastDay])

    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(`${addDays(lastDay, 1)}T09:00:00`))
    try {
      useWfm.getState().settleEmployment()
    } finally {
      vi.useRealTimers()
    }
    const s = useWfm.getState()
    expect(s.agents.some((a) => a.id === liam.id)).toBe(false)
    expect(s.employeeChanges[0]).toMatchObject({ action: "Exited", by: "System" })
  })

  it("deletes a former employee's record", () => {
    useWfm.getState().saveEmployeeProfile(liam.id, { ...defaultProfile(liam, localISODate()), endDate: addDays(localISODate(), -2) })
    renderAt(`/employees/${liam.id}`)
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    fireEvent.click(screen.getAllByRole("button", { name: /Delete/ }).at(-1)!)
    const s = useWfm.getState()
    expect(s.formerEmployees[liam.id]).toBeUndefined()
    expect(s.employeeProfiles[liam.id]).toBeUndefined()
    expect(s.employeeChanges[0].action).toBe("Deleted")
    expect(screen.getByText("Roster directory · skills · teams")).toBeInTheDocument() // back on Employees
  })

  it("is read-only without edit access to employees", () => {
    useWfm.setState({ currentRole: "Read-Only Viewer" })
    renderAt(`/employees/${ava.id}`)
    expect(screen.getByLabelText("Job title")).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Change wage amount" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Terminate/ })).toBeDisabled()
  })
})

describe("employees list", () => {
  it("shows and filters by job title and links to each profile", () => {
    useWfm.setState({ employeeProfiles: {} })
    useWfm.getState().saveEmployeeProfile(ava.id, { ...defaultProfile(ava, localISODate()), jobTitle: "Quality Analyst" })
    renderAt("/employees")
    expect(screen.getByRole("option", { name: "Trainer" })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Job title filter"), { target: { value: "Quality Analyst" } })
    expect(screen.getByRole("link", { name: ava.name })).toHaveAttribute("href", `/employees/${ava.id}`)
    expect(screen.queryByRole("link", { name: liam.name })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /^Profile$/ })).not.toBeInTheDocument() // the separate Profile button is gone
  })

  it("onboards an employee with their administrative details, then opens the profile", () => {
    renderAt("/employees")
    fireEvent.click(screen.getByRole("button", { name: /Add employee/ }))
    const dialog = screen.getByRole("dialog")
    const q = (label: string) => within(dialog).getByLabelText(label)
    fireEvent.change(within(dialog).getByPlaceholderText("e.g. Jordan Blake"), { target: { value: "Siro Sothing" } })
    fireEvent.change(q("Job title"), { target: { value: "Trainer" } })
    fireEvent.change(q("Team"), { target: { value: "Bravo" } })
    fireEvent.change(q("Join date"), { target: { value: "2024-03-21" } })
    fireEvent.change(q("End date"), { target: { value: "2027-03-20" } })
    fireEvent.change(q("Employee type"), { target: { value: "Contractor" } })
    fireEvent.change(q("Employee number"), { target: { value: "67965" } })
    fireEvent.change(q("Organization"), { target: { value: "Travel Helpdesk - IND" } })
    fireEvent.change(q("Wage amount"), { target: { value: "15.5" } })
    fireEvent.click(within(dialog).getByRole("button", { name: /Add & open profile/ }))

    const added = useWfm.getState().agents.find((a) => a.name === "Siro Sothing")!
    expect(added).toMatchObject({ team: "Bravo", tl: "Elena Faro" }) // reporting line followed the team
    expect(useWfm.getState().employeeProfiles[added.id]).toMatchObject({
      jobTitle: "Trainer", startDate: "2024-03-21", endDate: "2027-03-20", employeeType: "Contractor", employeeNumber: "67965",
      teamLead: "Elena Faro", wage: [{ value: 15.5, from: "2024-03-21", to: null }],
      organization: [{ value: "Travel Helpdesk - IND", from: "2024-03-21", to: null }],
    })
    // Landed on the new profile, showing what was entered.
    expect(screen.getByRole("heading", { name: "Profile: Sothing, Siro" })).toBeInTheDocument()
    expect(screen.getByLabelText("Start date")).toHaveValue("2024-03-21")
    expect(screen.getByLabelText("End date")).toHaveValue("2027-03-20")
    expect(screen.getByLabelText("Organization")).toHaveTextContent("Travel Helpdesk - IND")
  })

  it("won't onboard with an end date before the join date", () => {
    renderAt("/employees")
    fireEvent.click(screen.getByRole("button", { name: /Add employee/ }))
    const dialog = screen.getByRole("dialog")
    fireEvent.change(within(dialog).getByPlaceholderText("e.g. Jordan Blake"), { target: { value: "Early Leaver" } })
    fireEvent.change(within(dialog).getByLabelText("Join date"), { target: { value: "2026-05-01" } })
    fireEvent.change(within(dialog).getByLabelText("End date"), { target: { value: "2026-04-01" } })
    fireEvent.click(within(dialog).getAllByRole("button", { name: /Add employee/ }).at(-1)!)
    expect(within(dialog).getByRole("alert")).toHaveTextContent("End date can't be before the join date.")
    expect(useWfm.getState().agents.some((a) => a.name === "Early Leaver")).toBe(false)
  })
})

describe("profile dates", () => {
  it("edits the join and end date on an existing profile", () => {
    renderAt(`/employees/${ava.id}`)
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2024-03-21" } })
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2027-01-31" } })
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    expect(useWfm.getState().employeeProfiles[ava.id]).toMatchObject({ startDate: "2024-03-21", endDate: "2027-01-31" })
  })
})


describe("HC tracker", () => {
  it("lists past and present employees with status, campaign, last working day, supervisor and who changed them", () => {
    const today = localISODate()
    const wfm = useWfm.getState()
    wfm.saveEmployeeProfile(ava.id, { ...defaultProfile(ava, today), endDate: addDays(today, 10), supervisor: "Elena Faro", organization: [{ value: "Travel Helpdesk - IND", from: "2024-01-01", to: null }] })
    wfm.saveEmployeeProfile(liam.id, { ...defaultProfile(liam, today), endDate: addDays(today, -5) })
    renderAt("/hc-tracker")

    const row = (name: string) => screen.getByRole("link", { name }).closest("tr")!
    expect(row(ava.name)).toHaveTextContent("Notice period")
    expect(row(ava.name)).toHaveTextContent("Travel Helpdesk - IND")
    expect(row(ava.name)).toHaveTextContent("Elena Faro")
    expect(row(liam.name)).toHaveTextContent("Exited")
    expect(row(liam.name)).toHaveTextContent("by Priya Admin")
    expect(row(AGENTS[2].name)).toHaveTextContent("Active")

    fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "Exited" } })
    expect(screen.queryByRole("link", { name: ava.name })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: `Show ${liam.name}'s changes` }))
    expect(within(screen.getByRole("list", { name: `${liam.name} changes` })).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringMatching(/Exited.*after last working day.*by Priya Admin$/),
      expect.stringMatching(/Updated.*Last working day — → .*by Priya Admin$/),
    ])
  })
})
