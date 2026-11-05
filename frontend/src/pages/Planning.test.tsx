import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

import { useCapacity } from "@/lib/capacity/store"
import { Planning } from "@/pages/Planning"

vi.mock("@/lib/hcplanning", async (orig) => ({
  ...(await orig<typeof import("@/lib/hcplanning")>()),
  listLobs: vi.fn(async () => [{ id: "l1", name: "Support" }]),
  getCapacity: vi.fn(async () => ({ lob_name: "Support", agent_count: 0, results: [], config: { ooo_shrinkage: 0, io_shrinkage: 0, attrition: 0 } })),
}))

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

describe("Planning page", () => {
  it("shows only Capacity Planning — no New Hire, Movement, Seasonality or Summary tabs", async () => {
    useCapacity.setState({ dataset: {}, hydrated: true })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={["/planning"]}><Planning /></MemoryRouter></QueryClientProvider>)
    expect(await screen.findByText("Capacity Planning", { selector: "div" })).toBeInTheDocument()
    for (const gone of ["New Hire Planning", "Agent Movement", "Seasonality", "Connected inputs:", "Scenario planning"])
      expect(screen.queryByText(gone)).toBeNull()
    expect(screen.queryByRole("tab")).toBeNull()
  })
})
