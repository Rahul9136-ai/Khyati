import { fireEvent, render, screen, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it } from "vitest"

import { defaultProfile } from "@/lib/domain/employeeProfile"
import { AGENTS } from "@/lib/domain/seed"
import { localISODate } from "@/lib/domain/horizon"
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
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useWfm.setState({ currentRole: "Super Admin", agents: AGENTS.slice(0, 3), employeeProfiles: {} })
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

  it("terminates, then deletes an employee", () => {
    renderAt(`/employees/${liam.id}`)
    expect(screen.getByRole("button", { name: /Delete/ })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: /Terminate/ }))
    fireEvent.click(screen.getAllByRole("button", { name: /Terminate/ }).at(-1)!)
    expect(useWfm.getState().employeeProfiles[liam.id].endDate).toBe(localISODate())

    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    fireEvent.click(screen.getAllByRole("button", { name: /Delete/ }).at(-1)!)
    expect(useWfm.getState().agents.some((a) => a.id === liam.id)).toBe(false)
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
    expect(screen.getAllByRole("link", { name: /Profile/ })).toHaveLength(1)
    expect(screen.getByRole("link", { name: ava.name })).toHaveAttribute("href", `/employees/${ava.id}`)
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

