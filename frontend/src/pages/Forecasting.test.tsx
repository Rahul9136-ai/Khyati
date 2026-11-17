import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it } from "vitest"

import { addDays, TODAY, ymd } from "@/lib/domain/dates"
import { planValues } from "@/lib/domain/drivers"
import { DEFAULT_TARGETS } from "@/lib/domain/publishedForecast"
import { useWfm } from "@/store/wfm"

import { PublishedForecastCard } from "@/components/published-forecast-card"
import { Forecasting } from "./Forecasting"

// the charts (recharts) size themselves with a ResizeObserver, which jsdom doesn't have
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const start = ymd(TODAY)
const end = ymd(addDays(TODAY, 6))

beforeEach(() => {
  useWfm.setState({
    forecastDrivers: [], externalFactors: [], publishedForecasts: {}, forecastTargets: DEFAULT_TARGETS,
    forecastPeriod: { start, end }, forecastAutomation: { autoSelectBest: true, autoPublish: false },
  })
})
const page = () => render(<MemoryRouter><Forecasting /></MemoryRouter>)
const queueId = () => useWfm.getState().queueId

describe("Forecasting", () => {
  it("has one period (start + end date) and no Daily / Weekly / Monthly modes", () => {
    page()
    expect(screen.getByLabelText("Forecast start date")).toHaveValue(start)
    expect(screen.getByLabelText("Forecast end date")).toHaveValue(end)
    for (const name of ["Daily", "Weekly", "Monthly", "Next 7 days", "Next 30 days"])
      expect(screen.queryByRole("button", { name })).toBeNull()
    expect(screen.getByText(/shown by day/)).toBeInTheDocument()

    // a longer period switches the rows to weeks by itself
    fireEvent.change(screen.getByLabelText("Forecast end date"), { target: { value: ymd(addDays(TODAY, 59)) } })
    expect(useWfm.getState().forecastPeriod.end).toBe(ymd(addDays(TODAY, 59)))
    expect(screen.getByText(/shown by week/)).toBeInTheDocument()
  })

  it("shows only the chosen targets", () => {
    page()
    const headers = () => screen.getAllByRole("columnheader").map((h) => h.textContent)
    expect(headers()).toContain("Required FTE")
    expect(headers()).not.toContain("Occupancy")
    fireEvent.click(screen.getByRole("button", { name: "Occupancy" }))
    fireEvent.click(screen.getByRole("button", { name: "Required FTE" }))
    expect(useWfm.getState().forecastTargets).toEqual(["volume", "aht", "required", "projSL", "occupancy"])
    expect(headers()).toContain("Occupancy")
  })

  it("adds a driver from the dialog and the forecast moves with it", () => {
    page()
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }))
    const before = useWfm.getState().publishedForecasts[queueId()].totals.volume

    fireEvent.click(screen.getByRole("button", { name: "Add driver" }))
    const dialog = screen.getByRole("dialog")
    fireEvent.change(within(dialog).getByPlaceholderText("e.g. Paid search spend"), { target: { value: "Paid search" } })
    fireEvent.change(within(dialog).getByPlaceholderText("e.g. 120"), { target: { value: "150" } }) // +50% over the period
    fireEvent.click(within(dialog).getByRole("button", { name: "Add driver" }))

    const [d] = useWfm.getState().forecastDrivers
    expect(d).toMatchObject({ name: "Paid search", target: "volume", reference: 100, elasticity: 0.3, enabled: true })
    expect(screen.getByText("Changes not published")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }))
    const after = useWfm.getState().publishedForecasts[queueId()]
    expect(after.totals.volume / before).toBeCloseTo(Math.pow(1.5, 0.3), 1)
    expect(after.drivers).toEqual([{ id: d.id, name: "Paid search", target: "volume", elasticity: 0.3 }])
    expect(screen.getByText("Published · in sync")).toBeInTheDocument()
  })

  it("auto-publishes the period, republishes on a change, and the Dashboard shows it", async () => {
    useWfm.setState({ forecastAutomation: { autoSelectBest: true, autoPublish: true } })
    const view = page()
    await waitFor(() => expect(useWfm.getState().publishedForecasts[queueId()]).toBeTruthy(), { timeout: 4000 })
    const first = useWfm.getState().publishedForecasts[queueId()]
    expect(first).toMatchObject({ start, end, auto: true })
    expect(first.days).toHaveLength(7)
    expect(useWfm.getState().forecastMethod[queueId()]).toBe(first.methodId) // the best model was applied

    useWfm.getState().addForecastDriver({
      name: "Orders", kind: "Orders / transactions", unit: "", queueId: "all", target: "volume", reference: 100, elasticity: 1,
      elasticitySource: "manual", values: planValues(start, end, 120), enabled: true,
    })
    await waitFor(() => expect(useWfm.getState().publishedForecasts[queueId()].totals.volume).toBeGreaterThan(first.totals.volume * 1.15), { timeout: 4000 })

    view.unmount()
    render(<MemoryRouter><PublishedForecastCard queueId={queueId()} /></MemoryRouter>)
    expect(screen.getByText("Published forecast")).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`${start} → ${end}`))).toBeInTheDocument()
  })
})
