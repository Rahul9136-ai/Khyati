// Every sub-tab of the Capacity Planning module, driven like a user would.
import { fireEvent, render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it } from "vitest"

import { DEFAULT_CONFIG } from "@/lib/capacity/config"
import { type Dataset, parseWorkbook } from "@/lib/capacity/parse"
import { SHEETS } from "@/lib/capacity/schema"
import { useCapacity } from "@/lib/capacity/store"
import { miniWorkbook } from "@/lib/capacity/testWorkbook"
import { useWfm } from "@/store/wfm"

import { CapacityModule } from "./CapacityModule"

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\%&§]/g, "\\$&")
const nav = (label: string) => screen.getByRole("button", { name: new RegExp(`^${esc(label)}`) })
const rowsShown = () => screen.getByText(/^[\d,]+ rows$/).textContent

/** Row counts of the synthetic workbook (testWorkbook.ts). */
const MINI_ROWS: Record<string, number> = {
  userMapping: 11, forecast: 2, target: 1, ramp: 1, hiring: 3, budgetBuffer: 1, actualShrinkage: 1, actualAttrition: 1,
  budgetAttrition: 1, budgetQca: 1, trainingDays: 1, designationType: 2, sampling: 1, workingDays: 2,
}

function load() {
  const parsed = parseWorkbook(miniWorkbook(), "mini.xlsx")
  const dataset: Dataset = Object.fromEntries(parsed.sheets.map((s) => [s.id, s]))
  useCapacity.setState({ dataset, config: DEFAULT_CONFIG, edits: {}, lastImport: null, hydrated: true })
  useWfm.setState({ currentRole: "Super Admin" })
}
const renderIt = (cp = "summary") => render(
  <MemoryRouter initialEntries={[`/planning?cp=${cp}`]}><CapacityModule legacy={<p>legacy LOB plan</p>} /></MemoryRouter>,
)

beforeEach(load)

describe("header", () => {
  it('is titled "Capacity Planning" only', () => {
    renderIt()
    expect(screen.getByText("Capacity Planning", { selector: "div" })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/East Division model/)
  })
  it("shows the inputs loaded and the calculated row count", () => {
    renderIt()
    expect(screen.getByText(/14\/14 inputs loaded/)).toBeInTheDocument()
    expect(screen.getByText(/2 calculated rows · 2 months/)).toBeInTheDocument()
  })
  it("the status badge counts blocked rows and opens Data Exceptions", () => {
    renderIt()
    const badge = screen.getByRole("button", { name: /1 row can't be calculated · \d+ data warnings/ })
    fireEvent.click(badge)
    expect(screen.getByDisplayValue("All issue types")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Apprvoed typo in Approved Status/ })).toBeInTheDocument()
  })
  it("with no workbook, opens on Inputs and asks for one", () => {
    useCapacity.setState({ dataset: {} })
    renderIt("summary")
    expect(screen.getByText(/No workbook loaded yet/)).toBeInTheDocument()
    expect(screen.getByText(/"User Mapping" isn't loaded/)).toBeInTheDocument()
  })
})

describe("Inputs", () => {
  it("opens every one of the 14 input sheets with its rows", () => {
    renderIt("inputs")
    for (const s of SHEETS) {
      fireEvent.click(nav(s.label))
      expect(rowsShown(), s.label).toBe(`${MINI_ROWS[s.id]} rows`)
      expect(screen.getByText(new RegExp(`sheet ".*" · header row ${s.headerRow}`))).toBeInTheDocument()
    }
  })
  it("shows calculated columns: Attrition % and QCA % = Numerator ÷ Denominator", () => {
    renderIt("inputs")
    fireEvent.click(nav("Budgeted Attrition"))
    expect(screen.getByText("5.00%")).toBeInTheDocument()
    fireEvent.click(nav("Budgeted QCA %"))
    expect(screen.getByText("10.00%")).toBeInTheDocument()
  })
  it("normalises Hiring Type and the Apprvoed typo, and maps designation → user type", () => {
    renderIt("inputs")
    fireEvent.click(nav("Hiring (RR)"))
    expect(screen.getByText("Apprvoed")).toBeInTheDocument()
    expect(screen.getAllByText("Approved").length).toBeGreaterThanOrEqual(3)
    expect(screen.getAllByText("Lateral").length).toBeGreaterThan(0)
    expect(screen.getAllByText("QCA").length).toBeGreaterThan(0)
  })
  it("the Month filter narrows Forecast to that month's column", () => {
    renderIt("inputs")
    fireEvent.click(nav("Forecast Details"))
    expect(screen.getByRole("columnheader", { name: /Units _ Oct'26/ })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2026-09" } })
    expect(screen.queryByRole("columnheader", { name: /Units _ Oct'26/ })).toBeNull()
    expect(screen.getByRole("columnheader", { name: /Units _ Sep'26/ })).toBeInTheDocument()
  })
  it("editing a cell marks it and keeps the original value", () => {
    renderIt("inputs")
    fireEvent.click(nav("Budgeted Buffer"))
    const cell = screen.getAllByRole("cell").find((c) => c.textContent === "10.00%")!
    fireEvent.doubleClick(cell)
    const input = within(cell).getByRole("textbox")
    fireEvent.change(input, { target: { value: "0.2" } })
    fireEvent.blur(input)
    expect(screen.getByText("20.00%")).toHaveAttribute("title", "Edited — was 0.1")
    expect(screen.getByText(/1 edited cell/)).toBeInTheDocument()
  })
  it("read-only users can't import or edit", () => {
    useWfm.setState({ currentRole: "Read-Only Viewer" })
    renderIt("inputs")
    expect(screen.queryByRole("button", { name: /Import workbook/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Replace this sheet/ })).toBeNull()
    const cell = screen.getAllByRole("cell").find((c) => c.textContent === "PROJECT X")!
    fireEvent.doubleClick(cell)
    expect(within(cell).queryByRole("textbox")).toBeNull()
  })
})

describe("Calculations", () => {
  it("HC Based – Production shows P1…P18", () => {
    renderIt("calc")
    expect(screen.getByRole("columnheader", { name: "P10 Req HC Prod" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "P18 VA (HC)" })).toBeInTheDocument()
    expect(screen.getAllByText("11.30").length).toBeGreaterThan(0) // Req HC Sep'26
    expect(screen.getAllByText(/Base FTE blank: Task T-MISSING has no peak target/).length).toBe(1) // Oct'26
  })
  it("HC Based – QCA shows Q1…Q11", () => {
    renderIt("calc")
    fireEvent.click(nav("HC Based – QCA"))
    expect(screen.getByRole("columnheader", { name: "Q3 Req QCA" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "Q7 Attrition HC (QA × SNP)" })).toBeInTheDocument()
    expect(screen.getAllByText("1.10").length).toBeGreaterThan(0) // 11 projected × 10%
  })
  it("Volume Based shows V1…V18", () => {
    renderIt("calc")
    fireEvent.click(nav("Volume Based"))
    expect(screen.getByRole("columnheader", { name: "V11 Capacity %" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "V18 QCA Capacity %" })).toBeInTheDocument()
    expect(screen.getAllByText("2,100").length).toBeGreaterThan(0) // V1 Sep'26
  })
})

describe("Summary", () => {
  it("lists one row per key × month with totals and passing reconciliation", () => {
    renderIt("summary")
    expect(rowsShown()).toBe("2 rows")
    expect(screen.getByText("Total")).toBeInTheDocument()
    expect(screen.getByText(/Actual HC in Summary/).closest("div")!.querySelector("svg.text-emerald-600")).not.toBeNull()
  })
  it("filters by Month and clears", () => {
    renderIt("summary")
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2026-09" } })
    expect(rowsShown()).toBe("1 rows")
    fireEvent.click(screen.getByRole("button", { name: /Clear/ }))
    expect(rowsShown()).toBe("2 rows")
  })
  it("colours Capacity % by the thresholds", () => {
    renderIt("summary")
    const cap = screen.getAllByRole("cell").filter((c) => /^\d+\.\d{2}%$/.test(c.textContent ?? "") && /bg-(red|emerald|amber)/.test(c.className))
    expect(cap.length).toBeGreaterThan(0)
  })
  it("has an Excel / CSV export", () => {
    renderIt("summary")
    fireEvent.click(screen.getByRole("button", { name: /Export/ }))
    expect(screen.getByRole("button", { name: /Excel/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /CSV/ })).toBeInTheDocument()
  })
})

describe("Calculation & Logics", () => {
  it("passes every golden case with the sheet's values", () => {
    renderIt("logics")
    const golden = screen.getAllByRole("row").filter((tr) =>
      ["HC Based – Production", "HC Based – QCA", "Volume Based", "Other"].includes(tr.querySelector("td")?.textContent ?? ""))
    expect(golden).toHaveLength(33)
    for (const tr of golden) expect(tr.lastElementChild!.textContent, tr.textContent!).toBe("PASS")
    expect(screen.getAllByText("99.2063").length).toBeGreaterThan(0)
  })
  it("recalculates when an input changes, and resets to the sheet values", () => {
    renderIt("logics")
    fireEvent.change(screen.getAllByLabelText("Forecasted Volume")[0], { target: { value: "100000" } })
    expect(screen.getByText("198.4127")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Reset to sheet values/ }))
    expect(screen.getAllByText("99.2063").length).toBeGreaterThan(0)
  })
})

describe("Data Exceptions", () => {
  it("shows a card per issue type and filters the list by card and severity", () => {
    renderIt("exceptions")
    const total = Number(rowsShown()!.replace(/\D/g, ""))
    fireEvent.click(screen.getByRole("button", { name: /^Apprvoed typo in Approved Status/ }))
    expect(rowsShown()).toBe("1 rows")
    fireEvent.click(screen.getByRole("button", { name: /^Apprvoed typo in Approved Status/ }))
    expect(Number(rowsShown()!.replace(/\D/g, ""))).toBe(total)
    fireEvent.change(screen.getByDisplayValue("All severities"), { target: { value: "error" } })
    expect(screen.getAllByText("error").length).toBeGreaterThan(0)
    expect(screen.queryByText("warning")).toBeNull()
  })
})

describe("Switches (§7)", () => {
  it("lists Q1–Q7 and A1–A2, and a change flows into Calculations", () => {
    renderIt("switches")
    for (const id of ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "A1", "A2"]) expect(screen.getByText(id)).toBeInTheDocument()
    fireEvent.change(screen.getByDisplayValue("Actual QA × SNP % (sheet)"), { target: { value: "attrition" } })
    expect(useCapacity.getState().config.qcaAttritionMode).toBe("attrition")
    expect(screen.getByText("changed")).toBeInTheDocument()
    fireEvent.click(nav("Calculations"))
    fireEvent.click(nav("HC Based – QCA"))
    expect(screen.getByRole("columnheader", { name: "Q7 Attrition HC (QA × Attr %)" })).toBeInTheDocument()
  })
  it("resets everything to the workbook defaults", () => {
    useCapacity.setState({ config: { ...DEFAULT_CONFIG, rampMode: "flat", snpPct: 0.3 } })
    renderIt("switches")
    fireEvent.click(screen.getByRole("button", { name: /Reset all to workbook defaults/ }))
    expect(useCapacity.getState().config).toEqual(DEFAULT_CONFIG)
  })
})

describe("LOB monthly plan", () => {
  it("still shows the previous plan", () => {
    renderIt("lob")
    expect(screen.getByText("legacy LOB plan")).toBeInTheDocument()
  })
})
