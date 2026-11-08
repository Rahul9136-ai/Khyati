import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { buildLegends, legendSheets } from "@/lib/domain/legends"
import { AUX, QUEUES } from "@/lib/domain/seed"
import * as exporter from "@/lib/export"
import { useWfm } from "@/store/wfm"

import { Legends } from "./Legends"

beforeEach(() => {
  useWfm.setState({ lobs: [], queues: QUEUES.map((q) => ({ ...q })) })
})

describe("Legends", () => {
  it("lists every legend group with colour swatches", () => {
    render(<Legends />)
    for (const t of ["Lines of business & queues", "Agent states (AUX codes)", "Schedule activities", "Contact channels",
      "Time-off & overtime slots", "Capacity % colours", "Statuses & indicators", "Forecast models", "Roles", "Abbreviations & terms"])
      expect(screen.getByRole("region", { name: t })).toBeInTheDocument()
    const aux = screen.getByRole("region", { name: "Agent states (AUX codes)" })
    expect(within(aux).getAllByRole("row")).toHaveLength(AUX.length + 1)
    expect(within(aux).getByLabelText("Colour Ochre #d97706")).toBeInTheDocument() // AUX1 Break
    // the organisation's own queues are included
    expect(within(screen.getByRole("region", { name: "Lines of business & queues" })).getByText(QUEUES[0].name)).toBeInTheDocument()
  })

  it("search narrows every group; a group filter shows just that one", () => {
    render(<Legends />)
    fireEvent.change(screen.getByLabelText("Search legends"), { target: { value: "aht" } })
    const glossary = screen.getByRole("region", { name: "Abbreviations & terms" })
    expect(within(glossary).getByText("Average Handle Time")).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Roles" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))
    fireEvent.click(screen.getByRole("button", { name: "Capacity % colours" }))
    expect(screen.getAllByRole("region")).toHaveLength(1)
    expect(screen.getByText("Below 95%")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Agent states (AUX codes)" }))
    fireEvent.change(screen.getByLabelText("Search legends"), { target: { value: "zzzz" } })
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument()
  })

  it("exports what's shown to Excel: everything on one sheet, then a sheet per group", () => {
    const xlsx = vi.spyOn(exporter, "downloadXLSX").mockImplementation(() => {})
    render(<Legends />)
    fireEvent.click(screen.getByRole("button", { name: /Export/ }))
    fireEvent.click(screen.getByRole("button", { name: /Excel/ }))
    const [name, sheets] = xlsx.mock.calls[0]
    expect(name).toBe("purvi-legends")
    expect(sheets[0].name).toBe("All legends")
    expect(sheets.slice(1).map((s) => s.name)).toContain("Agent states (AUX codes)")
    expect(sheets[0].rows.find((r) => r.Code === "AUX1")).toMatchObject({ Group: "Agent states (AUX codes)", Name: "Break", "Colour name": "Ochre", Colour: "#d97706" })
    expect(sheets.every((s) => s.name.length <= 31)).toBe(true)
  })

  it("the capacity bands follow the Capacity Planning switches", () => {
    const g = buildLegends({ queues: [], lobs: [], capacityLow: 0.9, capacityHigh: 1.1 }).find((x) => x.id === "capacity")!
    expect(g.items.map((i) => i.label)).toEqual(["Below 90%", "90% – 110%", "Above 110%"])
    const sheets = legendSheets([g])
    expect(sheets).toHaveLength(2)
  })
})
