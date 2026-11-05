import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { fireEvent, render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it } from "vitest"

import { DEFAULT_CONFIG } from "@/lib/capacity/config"
import { type Dataset, parseWorkbook } from "@/lib/capacity/parse"
import { useCapacity } from "@/lib/capacity/store"
import { miniWorkbook } from "@/lib/capacity/testWorkbook"

import { CapacityModule } from "./CapacityModule"

function load() {
  const parsed = parseWorkbook(miniWorkbook(), "mini.xlsx")
  const dataset: Dataset = Object.fromEntries(parsed.sheets.map((s) => [s.id, s]))
  useCapacity.setState({ dataset, config: DEFAULT_CONFIG, edits: {}, lastImport: null, hydrated: true })
}

const renderIt = (cp = "summary") => render(
  <MemoryRouter initialEntries={[`/planning?cp=${cp}`]}><CapacityModule legacy={<p>legacy LOB plan</p>} /></MemoryRouter>,
)

// jsdom has no ResizeObserver; the Summary chart (recharts) needs one.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

beforeEach(load)

describe("Capacity Planning module", () => {
  it("shows every sub-tab and keeps the LOB plan reachable", () => {
    renderIt()
    for (const name of ["Inputs", "Calculations", "Summary", "Calculation & Logics", "Switches (§7)", "LOB monthly plan"])
      expect(screen.getByRole("button", { name: new RegExp(`^${name.replace(/[()§&]/g, ".")}`) })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "LOB monthly plan" }))
    expect(screen.getByText("legacy LOB plan")).toBeInTheDocument()
  })

  it("Summary shows Req HC, and editing an input recalculates it", () => {
    renderIt()
    // Base FTE = 2100 ÷ 21 ÷ 10 = 10; buffer 13% → Req HC 11.30
    expect(screen.getAllByText("11.30").length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole("button", { name: "Inputs" }))
    fireEvent.click(screen.getByRole("button", { name: /^Working Days/ }))
    const cell = screen.getAllByRole("cell").find((c) => c.textContent === "21")!
    fireEvent.doubleClick(cell)
    const input = within(cell).getByRole("textbox")
    fireEvent.change(input, { target: { value: "42" } })
    fireEvent.blur(input)
    expect(useCapacity.getState().edits["workingDays:2:Days"]).toBe(21)

    fireEvent.click(screen.getByRole("button", { name: "Summary" }))
    // W.days doubled → Base FTE 5 → Req HC 5.65
    expect(screen.getAllByText("5.65").length).toBeGreaterThan(0)
    expect(screen.queryByText("11.30")).toBeNull()
  })

  it("the Calculation & Logics test report passes every golden case", () => {
    renderIt("logics")
    const badge = screen.getByText(/\d+ \/ \d+ pass/)
    const [ok, total] = badge.textContent!.match(/\d+/g)!.map(Number)
    // the mini workbook doesn't have the sample file's row counts, so only golden cases are checked here
    expect(screen.getAllByText("PASS").length).toBeGreaterThanOrEqual(33)
    expect(ok).toBeLessThanOrEqual(total)
  })

  it("never shows NaN, Infinity or #DIV/0!", () => {
    for (const cp of ["summary", "calc", "exceptions"]) {
      const { container, unmount } = renderIt(cp)
      expect(container.textContent).not.toMatch(/NaN|Infinity|#DIV\/0!|#N\/A/)
      unmount()
    }
  })
})

const SAMPLE = process.env.AFORCE_SAMPLE
  ?? path.join(os.homedir(), "Downloads", "Aforce - Sample data - East Division-v1.xlsx")

describe.skipIf(!fs.existsSync(SAMPLE))("with the real sample workbook", () => {
  it("renders every sub-tab with no NaN / Infinity / #DIV/0!, and the full test report passes", () => {
    const parsed = parseWorkbook(new Uint8Array(fs.readFileSync(SAMPLE)), "sample.xlsx")
    useCapacity.setState({ dataset: Object.fromEntries(parsed.sheets.map((s) => [s.id, s])), config: DEFAULT_CONFIG, edits: {}, hydrated: true })
    for (const cp of ["summary", "calc", "exceptions", "inputs", "switches"]) {
      const { container, unmount } = renderIt(cp)
      expect(container.textContent, cp).not.toMatch(/NaN|Infinity|#DIV\/0!|#N\/A/)
      unmount()
    }
    renderIt("logics")
    const [ok, total] = screen.getByText(/\d+ \/ \d+ pass/).textContent!.match(/\d+/g)!.map(Number)
    expect(screen.queryAllByText("FAIL")).toHaveLength(0)
    expect(ok).toBe(total)
  })
})
