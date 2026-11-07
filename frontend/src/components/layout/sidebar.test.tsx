import { fireEvent, render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import type { NavItem } from "@/config/nav"

import { Breadcrumb, Sidebar } from "./sidebar"

const show = (path: string, canSee: (it: NavItem) => boolean = () => true) =>
  render(<MemoryRouter initialEntries={[path]}><Breadcrumb /><Sidebar canSee={canSee} /></MemoryRouter>)
const section = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) })
const pages = () => screen.queryAllByRole("group").flatMap((g) => within(g).getAllByRole("link").map((a) => a.textContent))

describe("Sidebar", () => {
  it("shows only the main sections until one is clicked", () => {
    show("/")
    const main = screen.getByRole("navigation", { name: "Main" })
    expect(within(main).getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/")
    for (const s of ["Planning", "Operations", "Workforce", "Reports & Insights", "Administration"])
      expect(section(s)).toHaveAttribute("aria-expanded", "false")
    expect(pages()).toEqual([])
  })

  it("clicking a section shows its pages; clicking another switches to that one", () => {
    show("/")
    fireEvent.click(section("Reports & Insights"))
    expect(pages()).toEqual(["Reports & KPIs", "Scheduled Reports", "AI Copilot", "Methodology"])
    fireEvent.click(section("Workforce"))
    expect(section("Reports & Insights")).toHaveAttribute("aria-expanded", "false")
    expect(pages()).toEqual(["Employees", "HC Tracker", "Skills", "PTO & Leave"])
    fireEvent.click(section("Workforce"))
    expect(pages()).toEqual([])
  })

  it("opens the section of the page you're on and marks the page", () => {
    show("/planning")
    expect(section("Planning")).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("link", { name: "Capacity Planning" })).toHaveClass("text-primary")
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" })
    expect(crumb).toHaveTextContent("Planning")
    expect(within(crumb).getByText("Capacity Planning")).toHaveAttribute("aria-current", "page")
  })

  it("hides pages (and empty sections) the user can't open", () => {
    show("/", (it) => it.module !== "audit" && it.module !== "settings" && it.module !== "copilot")
    expect(screen.queryByRole("button", { name: /^Administration/ })).toBeNull()
    fireEvent.click(section("Reports & Insights"))
    expect(pages()).toEqual(["Reports & KPIs", "Scheduled Reports", "Methodology"])
  })
})
