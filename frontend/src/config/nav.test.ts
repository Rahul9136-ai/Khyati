import { describe, expect, it } from "vitest"

import { findNav, NAV } from "./nav"

describe("sidebar sections", () => {
  it("has only main sections at the top level", () => {
    expect(NAV.map((g) => g.group)).toEqual(["Dashboard", "Planning", "Operations", "Workforce", "Reports & Insights", "Legends", "Administration"])
  })

  it("keeps Reports & KPIs, Scheduled Reports, AI Copilot and Methodology under Reports & Insights", () => {
    const group = NAV.find((g) => g.group === "Reports & Insights")
    expect(group?.items.map((i) => i.label)).toEqual(["Reports & KPIs", "Scheduled Reports", "AI Copilot", "Methodology"])
  })

  it("every page appears exactly once", () => {
    const paths = NAV.flatMap((g) => g.items.map((i) => i.to))
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).toHaveLength(25)
  })

  it("finds the section and page for a path", () => {
    expect(findNav("/planning")?.group.group).toBe("Planning")
    expect(findNav("/employees/123")?.item.label).toBe("Employees")
    expect(findNav("/")?.item.label).toBe("Dashboard")
    expect(findNav("/nowhere")).toBeNull()
  })
})
