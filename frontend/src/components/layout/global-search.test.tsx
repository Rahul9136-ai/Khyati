import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { beforeEach, describe, expect, it } from "vitest"

import { GlobalSearch } from "@/components/layout/global-search"
import { AGENTS } from "@/lib/domain/seed"
import { useWfm } from "@/store/wfm"

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

function renderSearch() {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="*" element={<><GlobalSearch /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  )
  return screen.getByRole("combobox", { name: "Search pages and employees" })
}

beforeEach(() => {
  useWfm.setState({ currentRole: "Super Admin", agents: AGENTS.slice(0, 3), formerEmployees: { x9: { ...AGENTS[5], id: "x9", name: "Old Timer" } } })
})

describe("global search", () => {
  it("finds a page and opens it with Enter", () => {
    const box = renderSearch()
    fireEvent.change(box, { target: { value: "sched" } })
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Scheduling")]))
    fireEvent.keyDown(box, { key: "Enter" })
    expect(screen.getByTestId("where").textContent).toBe("/scheduling")
    expect(box).toHaveValue("")
  })

  it("finds current and former employees and opens their profile", () => {
    const box = renderSearch()
    fireEvent.change(box, { target: { value: AGENTS[1].name.split(" ")[0] } })
    fireEvent.click(screen.getByRole("option", { name: new RegExp(AGENTS[1].name) }))
    expect(screen.getByTestId("where").textContent).toBe(`/employees/${AGENTS[1].id}`)
    fireEvent.change(box, { target: { value: "old tim" } })
    expect(screen.getByRole("option", { name: /Old Timer.*Former employee/ })).toBeInTheDocument()
  })

  it("moves with the arrow keys and says when nothing matches", () => {
    const box = renderSearch()
    fireEvent.change(box, { target: { value: "re" } })
    fireEvent.keyDown(box, { key: "ArrowDown" })
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true")
    fireEvent.change(box, { target: { value: "zzzz" } })
    expect(screen.getByText('No pages or employees match "zzzz".')).toBeInTheDocument()
  })

  it("only offers pages and people the role can open", () => {
    useWfm.setState({ currentRole: "Agent" })
    const box = renderSearch()
    fireEvent.change(box, { target: { value: "employ" } })
    expect(screen.queryByRole("option", { name: /Employees/ })).not.toBeInTheDocument()
    fireEvent.change(box, { target: { value: AGENTS[1].name } })
    expect(screen.queryByRole("option")).not.toBeInTheDocument()
  })
})
