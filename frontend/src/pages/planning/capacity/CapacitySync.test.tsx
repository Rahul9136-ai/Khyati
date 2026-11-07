// 1) The sub-tabs stay in sync with each other: one change on Inputs or
//    Switches shows up in Calculations, Summary, Data Exceptions and the header.
// 2) The tab stays in sync with the server (and so with connected CRMs).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { api, tokenStore } from "@/lib/api"
import { DEFAULT_CONFIG } from "@/lib/capacity/config"
import { type Dataset, parseWorkbook } from "@/lib/capacity/parse"
import { useCapacity } from "@/lib/capacity/store"
import { flush, poll, startCapacitySync, stopCapacitySync, streamTransport, useCapacitySync } from "@/lib/capacity/sync"
import { miniWorkbook } from "@/lib/capacity/testWorkbook"
import { useWfm } from "@/store/wfm"

import { CapacityModule } from "./CapacityModule"

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), defaults: { baseURL: "http://srv/api/v1" } },
  setSessionExpiredHandler: vi.fn(),
  tokenStore: { access: null, refresh: null, set: vi.fn(), clear: vi.fn() },
}))
const get = vi.mocked(api.get), put = vi.mocked(api.put), patch = vi.mocked(api.patch), del = vi.mocked(api.delete)
const ok = <T,>(data: T) => Promise.resolve({ data: { data } }) as never

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\%&§]/g, "\\$&")
const nav = (label: string) => screen.getByRole("button", { name: new RegExp(`^${esc(label)}`) })
const rowsShown = () => screen.getByText(/^[\d,]+ rows$/).textContent

function mini(): Dataset {
  return Object.fromEntries(parseWorkbook(miniWorkbook(), "mini.xlsx").sheets.map((s) => [s.id, s]))
}
function editCell(match: (c: HTMLElement) => boolean, value: string) {
  const cell = screen.getAllByRole("cell").find(match)!
  fireEvent.doubleClick(cell)
  const input = within(cell).getByRole("textbox")
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}
const renderIt = (cp = "summary") => render(
  <MemoryRouter initialEntries={[`/planning?cp=${cp}`]}><CapacityModule legacy={<p>legacy</p>} /></MemoryRouter>,
)

beforeEach(() => {
  vi.clearAllMocks()
  stopCapacitySync()
  useCapacity.setState({ dataset: mini(), config: DEFAULT_CONFIG, edits: {}, lastImport: null, hydrated: true })
  useWfm.setState({ currentRole: "Super Admin" })
})
afterEach(() => stopCapacitySync())

describe("sub-tabs stay in sync with each other", () => {
  it("an Inputs edit flows to Calculations (Production + Volume), Summary and the test report", () => {
    renderIt("summary")
    expect(screen.getAllByText("11.30").length).toBeGreaterThan(0) // Req HC Sep'26

    fireEvent.click(nav("Inputs"))
    fireEvent.click(nav("Working Days"))
    editCell((c) => c.textContent === "21", "42") // Sep'26 W.days 21 → 42

    fireEvent.click(nav("Calculations"))
    const sepRow = () => screen.getAllByRole("row").find((r) => r.textContent?.includes("Sep'26"))!
    expect(within(sepRow()).getAllByText("5.00").length).toBeGreaterThan(0) // P4 Base FTE halves
    expect(within(sepRow()).getByText("5.65")).toBeInTheDocument() // P10 Req HC

    fireEvent.click(nav("Volume Based"))
    expect(within(sepRow()).getAllByText("4,200")).toHaveLength(2) // V8 BAU = 10 × Peak 10 × 42 days; V9 raw = same (no ramp)

    fireEvent.click(nav("Summary"))
    expect(screen.getAllByText("5.65").length).toBeGreaterThan(0)
    expect(screen.queryByText("11.30")).toBeNull()

    fireEvent.click(nav("Calculation & Logics"))
    const add = screen.getAllByRole("row").find((r) => r.textContent?.includes("Σ Additions"))!
    expect(add.lastElementChild!.textContent).toBe("PASS")
  })

  it("filters carry across sub-tabs", () => {
    renderIt("summary")
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2026-09" } })
    expect(rowsShown()).toBe("1 rows")
    fireEvent.click(nav("Calculations"))
    expect(rowsShown()).toBe("1 rows")
    fireEvent.click(nav("Inputs"))
    fireEvent.click(nav("Budgeted Buffer"))
    expect((screen.getByLabelText("Month") as HTMLSelectElement).value).toBe("2026-09")
  })

  it("fixing the data on Inputs clears the error in the header, Calculations and Data Exceptions", () => {
    renderIt("exceptions")
    expect(screen.getByRole("button", { name: /1 row can't be calculated/ })).toBeInTheDocument()
    fireEvent.change(screen.getByDisplayValue("All severities"), { target: { value: "error" } })
    expect(rowsShown()).toBe("1 rows")

    // the missing task is billed per FTE, so it needs no peak target
    fireEvent.click(nav("Inputs"))
    fireEvent.click(nav("Forecast Details"))
    editCell((c) => c.textContent === "Transaction based - Hourly TAT" && c.closest("tr")!.textContent!.includes("T-MISSING"), "Flat FTE")

    expect(screen.getByRole("button", { name: /All rows calculated/ })).toBeInTheDocument()
    fireEvent.click(nav("Calculations"))
    expect(screen.queryByText(/Base FTE blank/)).toBeNull()
    fireEvent.click(nav("Data Exceptions"))
    fireEvent.change(screen.getByDisplayValue("All severities"), { target: { value: "error" } })
    expect(rowsShown()).toBe("0 rows")
  })

  it("a switch change flows to Calculations and Summary", () => {
    renderIt("summary")
    const sepRow = () => screen.getAllByRole("row").find((r) => r.textContent?.includes("Sep'26"))!
    expect(within(sepRow()).getByText("1.80")).toBeInTheDocument() // Projected QCA = 1 − 1×SNP 0.2 + 1 hire
    fireEvent.click(nav("Switches (§7)"))
    fireEvent.change(screen.getByDisplayValue("Actual QA × SNP % (sheet)"), { target: { value: "attrition" } })
    fireEvent.click(nav("Summary"))
    expect(within(sepRow()).getByText("1.95")).toBeInTheDocument() // 1 − 1×5% + 1
    fireEvent.click(nav("Calculations"))
    fireEvent.click(nav("HC Based – QCA"))
    expect(screen.getByRole("columnheader", { name: "Q7 Attrition HC (QA × Attr %)" })).toBeInTheDocument()
  })
})

describe("sync with the server (and connected tools)", () => {
  const serverSheet = (id: string, version: number, ds: Dataset) => ({
    id, version, updatedAt: "2026-11-06T00:00:00Z", updatedBy: "crm (API key: CRM)", fileName: "API", sheetName: id,
    columns: ds[id as keyof Dataset]!.columns, monthColumns: ds[id as keyof Dataset]!.monthColumns ?? null,
    rows: ds[id as keyof Dataset]!.rows,
  })
  const state = (versions: Record<string, number>, cfg = 1) => ({
    sheets: Object.fromEntries(Object.keys(mini()).map((id) => [id, versions[id] ? { version: versions[id], rows: 1 } : null])),
    config: cfg ? { version: cfg } : null, resultsVersion: `rv-${JSON.stringify(versions)}-${cfg}`,
  })

  it("loads the shared plan on open; another browser's / CRM's change appears on the next check", async () => {
    const server = mini()
    server.workingDays!.rows[0]["Days"] = 30
    const versions = Object.fromEntries(Object.keys(server).map((id) => [id, 1]))
    get.mockImplementation((url: string) => {
      if (url === "/capacity/state") return ok(state(versions))
      if (url === "/capacity/sheets") return ok(Object.keys(server).map((id) => serverSheet(id, versions[id], server)))
      if (url === "/capacity/config") return ok({ config: { ...DEFAULT_CONFIG, snpPct: 0.25 }, version: 1 })
      const id = url.split("/").pop()!
      return ok(serverSheet(id, versions[id], server))
    })
    useCapacity.setState({ dataset: {} })
    await startCapacitySync(true)
    expect(useCapacitySync.getState().status).toBe("synced")
    expect(useCapacity.getState().dataset.workingDays!.rows[0]["Days"]).toBe(30)
    expect(useCapacity.getState().config.snpPct).toBe(0.25)

    // a CRM changes Sep'26 working days through the API
    server.workingDays!.rows[0] = { ...server.workingDays!.rows[0], Days: 10 }
    versions.workingDays = 2
    await act(() => poll())
    expect(useCapacity.getState().dataset.workingDays!.rows[0]["Days"]).toBe(10)
    expect(useCapacitySync.getState().message).toMatch(/Updated from the server: Working Days/)
    expect(get).toHaveBeenCalledWith("/capacity/sheets/workingDays", expect.anything())
  })

  it("uploads this browser's workbook when the server has none yet", async () => {
    get.mockImplementation((url: string) => (url === "/capacity/state" ? ok(state({}, 0)) : ok({})))
    put.mockImplementation((url: string, body: unknown) => (url === "/capacity/workbook"
      ? ok(Object.keys((body as { sheets: object }).sheets).map((id) => ({ id, version: 1 })))
      : ok({ config: DEFAULT_CONFIG, version: 1 })))
    await startCapacitySync(true)
    const [url, body] = put.mock.calls.find((c) => c[0] === "/capacity/workbook")!
    expect(url).toBe("/capacity/workbook")
    const sheets = (body as { sheets: Record<string, { rows: unknown[]; base_version: number }> }).sheets
    expect(Object.keys(sheets)).toHaveLength(14)
    expect(sheets.userMapping.rows).toHaveLength(11)
    expect(sheets.userMapping.base_version).toBe(0)
    expect(put).toHaveBeenCalledWith("/capacity/config", expect.objectContaining({ base_version: 0 }))
  })

  it("sends a cell edit as one row update with the version it was based on; a 409 reloads theirs", async () => {
    const server = mini()
    const versions = Object.fromEntries(Object.keys(server).map((id) => [id, 3]))
    get.mockImplementation((url: string) => {
      if (url === "/capacity/state") return ok(state(versions))
      if (url === "/capacity/sheets") return ok(Object.keys(server).map((id) => serverSheet(id, versions[id], server)))
      if (url === "/capacity/config") return ok({ config: DEFAULT_CONFIG, version: 1 })
      const id = url.split("/").pop()!
      return ok(serverSheet(id, versions[id], server))
    })
    patch.mockImplementation(() => ok({ version: 4 }))
    await startCapacitySync(true)

    useCapacity.getState().editCell("workingDays", 2, "Days", 42)
    await flush()
    expect(patch).toHaveBeenCalledWith("/capacity/sheets/workingDays/rows",
      { upsert: [{ row: 2, values: { Days: 42 } }], base_version: 3 })

    // next edit races someone else's save
    patch.mockImplementationOnce(() => Promise.reject({ status: 409, code: "conflict", message: "changed" }))
    server.workingDays!.rows[0] = { ...server.workingDays!.rows[0], Days: 25 }
    useCapacity.getState().editCell("workingDays", 2, "Days", 50)
    await flush()
    expect(useCapacitySync.getState().status).toBe("conflict")
    expect(useCapacity.getState().dataset.workingDays!.rows[0]["Days"]).toBe(25)
  })

  it("keeps working offline and uploads when the server is back", async () => {
    get.mockImplementation(() => Promise.reject({ code: "network", message: "Network Error" }))
    await startCapacitySync(true)
    expect(useCapacitySync.getState().status).toBe("offline")
    useCapacity.getState().setConfig({ rampMode: "flat" })
    expect(useCapacity.getState().config.rampMode).toBe("flat") // still works locally

    get.mockImplementation((url: string) => (url === "/capacity/state" ? ok(state({}, 0)) : ok({})))
    put.mockImplementation(() => ok({ config: { ...DEFAULT_CONFIG, rampMode: "flat" }, version: 1 }))
    await act(() => poll())
    expect(put).toHaveBeenCalledWith("/capacity/config", expect.objectContaining({ config: expect.objectContaining({ rampMode: "flat" }) }))
    await waitFor(() => expect(useCapacitySync.getState().status).toBe("synced"))
  })

  it("Remove data clears it on the server too", async () => {
    get.mockImplementation((url: string) => (url === "/capacity/state" ? ok(state({ workingDays: 1 })) :
      url === "/capacity/sheets" ? ok([serverSheet("workingDays", 1, mini())]) : ok({ config: DEFAULT_CONFIG, version: 1 })))
    del.mockImplementation(() => ok({ removed: 1 }))
    await startCapacitySync(true)
    useCapacity.getState().clearData()
    await flush()
    expect(del).toHaveBeenCalledWith("/capacity/sheets")
  })

  it("shows where the data lives in the header", async () => {
    renderIt("summary")
    expect(screen.getByRole("status")).toHaveTextContent("This browser only")
    act(() => useCapacitySync.setState({ status: "synced" }))
    expect(screen.getByRole("status")).toHaveTextContent("Shared · synced")
    act(() => useCapacitySync.setState({ live: true }))
    expect(screen.getByRole("status")).toHaveTextContent("Shared · live")
  })
})

describe("live updates (server push)", () => {
  /** A fake event stream the test writes into. */
  function fakeStream() {
    const queue: string[] = []
    let wake: (() => void) | null = null
    let closed = false
    const opened: { url: string; token: string }[] = []
    const open = async function* (url: string, token: string, signal: AbortSignal) {
      opened.push({ url, token })
      signal.addEventListener("abort", () => { closed = true; wake?.() })
      while (!closed) {
        if (!queue.length) await new Promise<void>((r) => { wake = r })
        while (queue.length) yield queue.shift()!
      }
    }
    const send = (chunk: string) => { queue.push(chunk); wake?.() }
    return { open, send, opened, isClosed: () => closed }
  }
  const event = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const original = streamTransport.open

  beforeEach(() => { (tokenStore as { access: string | null }).access = "tok" })
  afterEach(() => { streamTransport.open = original; (tokenStore as { access: string | null }).access = null })

  it("opens the live stream, and a change pushed by the server is loaded at once", async () => {
    const server = mini()
    const versions: Record<string, number> = Object.fromEntries(Object.keys(server).map((id) => [id, 1]))
    const rv = () => `rv-${versions.workingDays}`
    get.mockImplementation((url: string) => {
      if (url === "/capacity/state") return ok({ sheets: Object.fromEntries(Object.keys(server).map((id) => [id, { version: versions[id] }])), config: { version: 1 }, resultsVersion: rv() })
      if (url === "/capacity/sheets") return ok(Object.keys(server).map((id) => ({ id, version: versions[id], columns: server[id as keyof Dataset]!.columns, rows: server[id as keyof Dataset]!.rows, updatedAt: "", updatedBy: "", fileName: "x", sheetName: id, monthColumns: null })))
      if (url === "/capacity/config") return ok({ config: DEFAULT_CONFIG, version: 1 })
      const id = url.split("/").pop()! as keyof Dataset
      return ok({ id, version: versions[id], columns: server[id]!.columns, rows: server[id]!.rows, updatedAt: "", updatedBy: "", fileName: "x", sheetName: id, monthColumns: null })
    })
    const s = fakeStream()
    streamTransport.open = s.open
    await startCapacitySync(true)
    await waitFor(() => expect(s.opened).toHaveLength(1))
    expect(s.opened[0]).toEqual({ url: "http://srv/api/v1/capacity/stream", token: "tok" })

    s.send(": ping\n\n")
    s.send(event("hello", { resultsVersion: rv(), activity: [] }))
    await waitFor(() => expect(useCapacitySync.getState().live).toBe(true))
    expect(get).not.toHaveBeenCalledWith("/capacity/sheets/workingDays", expect.anything()) // nothing new

    // a CRM pushes Sep'26 working days = 10; the server announces it (split across chunks)
    server.workingDays!.rows[0] = { ...server.workingDays!.rows[0], Days: 10 }
    versions.workingDays = 2
    const msg = event("change", { resultsVersion: rv(), activity: [{ id: "a1", at: "2026-11-06T10:00:00Z", by: "ops@x.dev", source: "api", apiKey: "HubSpot", action: "capacity.sheet.edit", verb: "edited", sheet: "workingDays", label: "Working Days", version: 2, summary: "1 updated" }] })
    s.send(msg.slice(0, 20))
    s.send(msg.slice(20))
    await waitFor(() => expect(useCapacity.getState().dataset.workingDays!.rows[0]["Days"]).toBe(10))
    expect(useCapacitySync.getState().message).toMatch(/Working Days \(latest: HubSpot via API\)/)
    expect(useCapacitySync.getState().activity[0].apiKey).toBe("HubSpot")
    expect(useCapacitySync.getState().resultsVersion).toBe("rv-2")

    stopCapacitySync()
    expect(s.isClosed()).toBe(true)
    expect(useCapacitySync.getState().live).toBe(false)
  })

  it("reconnects when the live connection drops, and stays usable meanwhile", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      get.mockImplementation((url: string) => (url === "/capacity/state"
        ? ok({ sheets: {}, config: { version: 1 }, resultsVersion: "empty" })
        : ok({ config: DEFAULT_CONFIG, version: 1 })))
      useCapacity.setState({ dataset: {} })
      let calls = 0
      streamTransport.open = async function* () {
        calls++
        if (calls === 1) throw Object.assign(new Error("gone"), { status: 502 })
        yield event("hello", { resultsVersion: "empty", activity: [] })
        await new Promise(() => {}) // stays open
      }
      await startCapacitySync(true)
      await vi.advanceTimersByTimeAsync(10)
      expect(useCapacitySync.getState().live).toBe(false)
      expect(useCapacitySync.getState().status).toBe("synced")
      await vi.advanceTimersByTimeAsync(1_100) // first retry after 1 s
      expect(calls).toBe(2)
      expect(useCapacitySync.getState().live).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("without a login token it doesn't try to stream (polling only)", async () => {
    (tokenStore as { access: string | null }).access = null
    get.mockImplementation((url: string) => (url === "/capacity/state"
      ? ok({ sheets: {}, config: { version: 1 }, resultsVersion: "empty" })
      : ok({ config: DEFAULT_CONFIG, version: 1 })))
    const s = fakeStream()
    streamTransport.open = s.open
    useCapacity.setState({ dataset: {} })
    await startCapacitySync(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(s.opened).toHaveLength(0)
  })
})
