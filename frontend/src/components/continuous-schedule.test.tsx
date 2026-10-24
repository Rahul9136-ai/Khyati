import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ContinuousSchedule } from "@/components/continuous-schedule"
import * as activityImport from "@/lib/activityImport"
import { agentDay, dayToPatch, toMins } from "@/lib/domain/channels"
import { buildPlan } from "@/lib/domain/planning"
import { AGENTS, QUEUES, forecastFor } from "@/lib/domain/seed"
import { useWfm } from "@/store/wfm"

const agent = AGENTS[0] // 07:00–15:30 · break 09:00 (b1) · lunch 11:00–11:30 (b2) · break 13:00 (b3)
const queue = QUEUES[0]
const plan = buildPlan(forecastFor(queue.id), queue.aht, queue, 0.25, [agent])

beforeAll(() => {
  // Editable timeline for one agent spans 06:00–20:00 (operating day ± 1h) = 840 min;
  // make the track 840px so 1px = 1 min.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 840, height: 36, top: 0, left: 0, right: 840, bottom: 36, x: 0, y: 0, toJSON: () => ({}) })
  if (!("PointerEvent" in window)) {
    // jsdom may lack PointerEvent; a MouseEvent carries the clientX/button we need.
    ;(window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends MouseEvent {}
  }
})

beforeEach(() => {
  useWfm.setState({
    agents: AGENTS,
    breakOverrides: {},
    channelPlan: { [agent.id]: [{ id: "p", channel: "phone", start: toMins("07:00"), end: toMins("11:00") }, { id: "c", channel: "chat", start: toMins("11:00"), end: toMins("15:30") }] },
    overtimePlan: {},
    activityPlan: {},
  })
})

const renderSchedule = (canEdit = true) => {
  const a = useWfm.getState().agents.find((x) => x.id === agent.id)!
  return render(<ContinuousSchedule agents={[a]} queue={queue} plan={plan} onDuty={plan.map((p) => p.scheduled)} canEdit={canEdit} />)
}

/** Drag `el` horizontally by `dx` px (= minutes) and release. */
function drag(el: HTMLElement, dx: number) {
  fireEvent.pointerDown(el, { button: 0, clientX: 100 })
  fireEvent.pointerMove(window, { clientX: 100 + dx })
  fireEvent.pointerUp(window)
}

const lunch = () => useWfm.getState().breakOverrides[agent.id]?.find((b) => b.id === "b2")
const stored = () => useWfm.getState().agents.find((a) => a.id === agent.id)!

describe("moving AUX on the continuous schedule", () => {
  it("moves lunch by mouse drag, snapped to 5 min, and records it in the audit log", () => {
    renderSchedule()
    const el = screen.getByRole("slider", { name: /^Lunch for .*starts 11:00/ })
    fireEvent.pointerDown(el, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 162 }) // +62 min → snaps to +60
    expect(screen.getByText(/Lunch 12:00–12:30/)).toBeInTheDocument() // live label while dragging
    fireEvent.pointerUp(window)

    expect(lunch()).toMatchObject({ offsetMinutes: 5 * 60, durationMinutes: 30 })
    expect(useWfm.getState().auditLog[0]).toMatchObject({ action: "Edited schedule on timeline" })
    expect(useWfm.getState().auditLog[0].detail).toMatch(/Lunch 11:00–11:30 → 12:00–12:30/)
  })

  it("cannot drag past the next break", () => {
    renderSchedule()
    drag(screen.getByRole("slider", { name: /^Lunch for/ }), 400)
    expect(lunch()?.offsetMinutes).toBe(toMins("12:30") - toMins("07:00"))
  })

  it("Esc cancels a drag without saving", () => {
    renderSchedule()
    fireEvent.pointerDown(screen.getByRole("slider", { name: /^Lunch for/ }), { button: 0, clientX: 0 })
    fireEvent.pointerMove(window, { clientX: 45 })
    fireEvent.keyDown(window, { key: "Escape" })
    fireEvent.pointerUp(window)
    expect(lunch()).toBeUndefined()
  })

  it("nudges with arrow keys (Shift = 15 min)", () => {
    renderSchedule()
    fireEvent.keyDown(screen.getByRole("slider", { name: /^Lunch for/ }), { key: "ArrowRight", shiftKey: true })
    expect(lunch()?.offsetMinutes).toBe(toMins("11:15") - toMins("07:00"))
  })
})

describe("resizing on the continuous schedule", () => {
  it("lengthens lunch by dragging its end edge", () => {
    renderSchedule()
    drag(screen.getByRole("slider", { name: /^End of Lunch/ }), 15)
    expect(lunch()).toMatchObject({ offsetMinutes: 240, durationMinutes: 45 })
  })

  it("shortens a break from its start edge", () => {
    renderSchedule()
    drag(screen.getAllByRole("slider", { name: /^Start of Morning Break/ })[0], 5)
    const b1 = useWfm.getState().breakOverrides[agent.id].find((b) => b.id === "b1")
    expect(b1).toMatchObject({ offsetMinutes: 125, durationMinutes: 10 })
  })

  it("moves the Phone→Chat boundary, resizing both channel blocks", () => {
    renderSchedule()
    // Phone's real end is 11:00 (its 09:00 piece end is just the morning break cutting it).
    expect(screen.queryByRole("slider", { name: /^End of Phone.*\(09:00\)/ })).toBeNull()
    drag(screen.getByRole("slider", { name: /^End of Phone.*\(11:00\)/ }), -30)
    const [phone, chat] = useWfm.getState().channelPlan[agent.id]
    expect(phone.end).toBe(toMins("10:30"))
    expect(chat.start).toBe(toMins("10:30"))
  })

  it("lengthens the shift from its end edge; the last channel block follows", () => {
    renderSchedule()
    drag(screen.getByRole("slider", { name: /^Shift end/ }), 60)
    expect(stored().shift).toBe("07:00–16:30")
    expect(useWfm.getState().channelPlan[agent.id].at(-1)).toMatchObject({ channel: "chat", end: toMins("16:30") })
    expect(useWfm.getState().auditLog[0].detail).toMatch(/Shift 07:00–15:30 → 07:00–16:30/)
  })

  it("starts the shift later without moving breaks on the clock", () => {
    renderSchedule()
    drag(screen.getByRole("slider", { name: /^Shift start/ }), 30)
    expect(stored().shift).toBe("07:30–15:30")
    // Morning break still at 09:00 → offset is now 90 min from the 07:30 start.
    expect(useWfm.getState().breakOverrides[agent.id].find((b) => b.id === "b1")?.offsetMinutes).toBe(90)
  })

  it("is read-only without edit permission", () => {
    renderSchedule(false)
    expect(screen.queryByRole("slider")).toBeNull()
    expect(screen.queryByRole("button", { name: /Add OT/ })).toBeNull()
  })
})

describe("activities overlay (meeting, LOA, absence…)", () => {
  const acts = () => useWfm.getState().activityPlan[agent.id] ?? []

  it("adds a meeting with a note for an agent from the toolbar and draws it in the upper band", () => {
    renderSchedule()
    fireEvent.click(screen.getByRole("button", { name: /Add activity/ }))
    fireEvent.click(screen.getByRole("button", { name: /^Meeting/ }))
    fireEvent.change(screen.getByLabelText("Activity start"), { target: { value: "10:00" } })
    fireEvent.change(screen.getByLabelText("Activity end"), { target: { value: "10:45" } })
    fireEvent.change(screen.getByLabelText("Activity note"), { target: { value: "Q3 update" } })
    fireEvent.click(screen.getByLabelText(`Select ${agent.name}`))
    fireEvent.click(screen.getByRole("button", { name: /^Add Meeting · 1 agent/ }))

    expect(acts()).toEqual([expect.objectContaining({ type: "meeting", start: toMins("10:00"), end: toMins("10:45"), note: "Q3 update" })])
    expect(useWfm.getState().auditLog[0]).toMatchObject({ action: "Added activity" })
    expect(screen.getByRole("slider", { name: /^Meeting for .*10:00–10:45/ })).toBeInTheDocument()
  })

  it("LOA defaults to the full shift", () => {
    renderSchedule()
    fireEvent.click(screen.getByRole("button", { name: /Add activity/ }))
    fireEvent.click(screen.getByRole("button", { name: /^LOA/ }))
    fireEvent.click(screen.getByLabelText(`Select ${agent.name}`))
    fireEvent.click(screen.getByRole("button", { name: /^Add LOA/ }))
    expect(acts()[0]).toMatchObject({ type: "loa", start: toMins("07:00"), end: toMins("15:30") })
  })

  it("click edits, drag moves, and Delete removes an activity", async () => {
    useWfm.setState({ activityPlan: { [agent.id]: [{ id: "m", type: "training", start: toMins("10:00"), end: toMins("11:00") }] } })
    renderSchedule()
    const bar = screen.getByRole("slider", { name: /^Training for/ })

    drag(bar, 30)
    expect(acts()[0]).toMatchObject({ start: toMins("10:30"), end: toMins("11:30") })
    // The click that ends a drag is swallowed; a later, separate click opens the editor.
    fireEvent.click(screen.getByRole("slider", { name: /^Training for/ }))
    expect(screen.queryByRole("heading", { name: /Training — / })).toBeNull()
    await new Promise((r) => setTimeout(r, 0))

    fireEvent.click(screen.getByRole("slider", { name: /^Training for/ }))
    expect(screen.getByRole("heading", { name: new RegExp(`Training — ${agent.name}`) })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    expect(acts()).toEqual([])
    expect(useWfm.getState().auditLog[0]).toMatchObject({ action: "Removed activity" })
  })
})

describe("bulk activities", () => {
  const renderAll = () => {
    const all = useWfm.getState().agents
    return render(<ContinuousSchedule agents={all} queue={queue} plan={plan} onDuty={plan.map((p) => p.scheduled)} canEdit />)
  }

  it("selects a whole team by filter and staggers a meeting in waves", () => {
    renderAll()
    fireEvent.click(screen.getByRole("button", { name: /Add activity/ }))
    fireEvent.change(screen.getByLabelText("Team"), { target: { value: "Alpha" } })
    fireEvent.change(screen.getByLabelText("Shift"), { target: { value: "07:00–15:30" } })
    const alphaEarly = AGENTS.filter((a) => a.team === "Alpha" && a.shift === "07:00–15:30")
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`Select all matching \\(${alphaEarly.length}\\)`) }))
    fireEvent.change(screen.getByLabelText("Activity start"), { target: { value: "10:00" } })
    fireEvent.change(screen.getByLabelText("Activity end"), { target: { value: "10:30" } })
    fireEvent.click(screen.getByLabelText("Stagger in waves"))
    fireEvent.change(screen.getByLabelText("Agents per wave"), { target: { value: "3" } })
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Add Meeting · ${alphaEarly.length} agents`) }))

    const ap = useWfm.getState().activityPlan
    const starts = alphaEarly.map((a) => ap[a.id]?.[0]?.start)
    expect(starts).toEqual(alphaEarly.map((_, i) => toMins("10:00") + Math.floor(i / 3) * 30))
    expect(AGENTS.filter((a) => a.team !== "Alpha").every((a) => !ap[a.id])).toBe(true)
    expect(useWfm.getState().auditLog[0].detail).toMatch(/waves of 3 every 30m/)
  })

  it("adds activities in bulk from an uploaded file, skipping bad rows", async () => {
    vi.spyOn(activityImport, "readActivityFile").mockResolvedValue([
      { "Agent ID": AGENTS[0].id, Activity: "Training", Start: "13:30", End: "14:30" },
      { "Agent ID": AGENTS[1].id, Activity: "Absence", "Full Shift (Y/N)": "Y" },
      { "Agent ID": "nobody", Activity: "Meeting", Start: "10:00", End: "10:30" },
    ])
    renderAll()
    fireEvent.click(screen.getByRole("button", { name: /Add activity/ }))
    fireEvent.click(screen.getByRole("button", { name: /Upload file/ }))
    fireEvent.change(screen.getByLabelText("Activity file"), { target: { files: [new File(["x"], "aux.xlsx")] } })
    expect(await screen.findByText(/Unknown agent "nobody"/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Add 2 activities from file" }))

    const ap = useWfm.getState().activityPlan
    expect(ap[AGENTS[0].id]).toEqual([expect.objectContaining({ type: "training", start: toMins("13:30"), end: toMins("14:30") })])
    expect(ap[AGENTS[1].id]).toEqual([expect.objectContaining({ type: "absence", start: toMins("07:00"), end: toMins("15:30") })])
    expect(useWfm.getState().auditLog[0].detail).toMatch(/Bulk upload aux\.xlsx · 2 activities \(1 Training, 1 Absence\)/)
  })
})

describe("bulk-selecting schedules", () => {
  // The first three agents all work 07:00–15:30 on the Early pattern (lunch b2 11:00–11:30).
  // Read agents live from the store, as the Scheduling page does, so successive edits build on each other.
  function LiveThree() {
    const agents = useWfm((s) => s.agents).slice(0, 3)
    return <ContinuousSchedule agents={agents} queue={queue} plan={plan} onDuty={plan.map((p) => p.scheduled)} canEdit />
  }
  const renderThree = () => render(<LiveThree />)
  const row = (id: string) => document.querySelector(`[data-agent-row="${id}"]`) as HTMLElement
  const ids = AGENTS.slice(0, 3).map((a) => a.id)
  const shiftOf = (id: string) => useWfm.getState().agents.find((a) => a.id === id)!.shift
  const dayPatch = (id: string) => {
    const s = useWfm.getState()
    return dayToPatch(agentDay(s.agents.find((a) => a.id === id)!, s.shiftPatterns, s.breakOverrides, s.channelPlan, s.overtimePlan, s.activityPlan))
  }

  beforeEach(() => useWfm.setState({ channelPlan: {} }))

  it("Ctrl+click toggles, Shift+click selects a range, Esc clears", () => {
    renderThree()
    fireEvent.click(row(ids[0]), { ctrlKey: true })
    expect(screen.getByText("1 schedule selected")).toBeInTheDocument()
    expect(row(ids[0])).toHaveAttribute("aria-selected", "true")
    // Ctrl+click must not open the agent editor.
    expect(screen.queryByRole("heading", { name: /^Schedule — / })).toBeNull()

    fireEvent.click(row(ids[2]), { shiftKey: true })
    expect(screen.getByText("3 schedules selected")).toBeInTheDocument()
    fireEvent.click(row(ids[1]), { ctrlKey: true })
    expect(screen.getByText("2 schedules selected")).toBeInTheDocument()

    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByRole("toolbar", { name: "Bulk schedule actions" })).toBeNull()
  })

  it("Ctrl+←/→ moves every selected schedule (Shift = 15 min), leaving others alone", () => {
    renderThree()
    fireEvent.click(row(ids[0]), { ctrlKey: true })
    fireEvent.click(row(ids[1]), { ctrlKey: true })
    fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: "ArrowLeft", ctrlKey: true })
    expect(shiftOf(ids[0])).toBe("07:10–15:40")
    expect(shiftOf(ids[1])).toBe("07:10–15:40")
    expect(shiftOf(ids[2])).toBe("07:00–15:30")
    expect(useWfm.getState().auditLog[0]).toMatchObject({ action: "Bulk-edited schedules", detail: "2 schedules · moved 5 min earlier" })
  })

  it("Ctrl+A selects all; bulk bar adjusts shift ends for everyone", () => {
    renderThree()
    fireEvent.click(row(ids[0]), { ctrlKey: true })
    fireEvent.keyDown(window, { key: "a", ctrlKey: true })
    expect(screen.getByText("3 schedules selected")).toBeInTheDocument()
    const bar = screen.getByRole("toolbar", { name: "Bulk schedule actions" })
    fireEvent.click(within(bar).getAllByRole("button", { name: "+15m" })[1]) // End +15m
    expect(ids.map(shiftOf)).toEqual(["07:00–15:45", "07:00–15:45", "07:00–15:45"])
  })

  it("dragging lunch in one selected row moves lunch on every selected schedule", () => {
    renderThree()
    fireEvent.click(row(ids[0]), { ctrlKey: true })
    fireEvent.click(row(ids[1]), { ctrlKey: true })
    const lunch = within(row(ids[0])).getByRole("slider", { name: /^Lunch for/ })
    fireEvent.pointerDown(lunch, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 130 })
    expect(screen.getByText(/\+30m · \+1 selected/)).toBeInTheDocument()
    fireEvent.pointerUp(window)

    const lunchOf = (id: string) => useWfm.getState().breakOverrides[id]?.find((b) => b.id === "b2")?.offsetMinutes
    expect([lunchOf(ids[0]), lunchOf(ids[1]), lunchOf(ids[2])]).toEqual([270, 270, undefined])
    expect(useWfm.getState().auditLog[0].detail).toMatch(/^2 schedules · Lunch 11:00–11:30 → 11:30–12:00 \(from .*, applied to all selected\)/)
  })

  it("header checkbox selects all agents", () => {
    renderThree()
    fireEvent.click(screen.getByLabelText("Select all agents"))
    expect(screen.getByText("3 schedules selected")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Select all agents"))
    expect(screen.queryByRole("toolbar", { name: "Bulk schedule actions" })).toBeNull()
  })

  it("right-click on the selection shows every AUX and marks the chosen one on all selected", () => {
    renderThree()
    fireEvent.click(screen.getByLabelText("Select all agents"))
    // Track is 840px for 06:00–20:00 starting at x=0 (mocked rect) → clientX 255 ≈ 10:15.
    fireEvent.contextMenu(row(ids[1]), { clientX: 255, clientY: 100 })
    const menu = screen.getByRole("menu", { name: "Mark AUX" })
    expect(within(menu).getByText("Mark AUX for 3 schedules")).toBeInTheDocument()
    for (const label of ["Break", "Lunch", "Meeting", "Training", "Coaching", "LOA", "Absence", "Other"]) {
      expect(within(menu).getByRole("menuitem", { name: new RegExp(`^${label}`) })).toBeInTheDocument()
    }
    expect(within(menu).getByLabelText("AUX start")).toHaveValue("10:15")
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Meeting/ }))

    for (const id of ids) {
      expect(useWfm.getState().activityPlan[id]).toEqual([expect.objectContaining({ type: "meeting", start: toMins("10:15"), end: toMins("10:45") })])
    }
    expect(screen.queryByRole("menu")).toBeNull()
    expect(screen.getByRole("status")).toHaveTextContent("Meeting 10:15–10:45 marked for 3 agents")
    expect(useWfm.getState().auditLog[0]).toMatchObject({ action: "Bulk-edited schedules", detail: "3 schedules · Marked Meeting 10:15–10:45" })
  })

  it("marks an extra Break with a chosen length, skipping agents where it clashes", () => {
    useWfm.setState({ activityPlan: {} })
    renderThree()
    fireEvent.click(row(ids[0]), { ctrlKey: true })
    fireEvent.click(row(ids[1]), { ctrlKey: true })
    // Give the 2nd agent a break already at 14:00 so it clashes.
    useWfm.getState().updateAgentDay(ids[1], { ...dayPatch(ids[1]), breaks: [...dayPatch(ids[1]).breaks, { id: "z", type: "break", label: "Break", offsetMinutes: 420, durationMinutes: 15 }] }, "setup")
    fireEvent.contextMenu(row(ids[0]), { clientX: 480, clientY: 100 }) // 14:00
    fireEvent.click(screen.getByRole("button", { name: "15m" }))
    fireEvent.click(screen.getByRole("menuitem", { name: /^Break/ }))

    const extra = (id: string) => useWfm.getState().breakOverrides[id]?.filter((b) => b.offsetMinutes === 420)
    expect(extra(ids[0])).toEqual([expect.objectContaining({ type: "break", durationMinutes: 15 })])
    expect(extra(ids[1])).toHaveLength(1) // only the pre-existing one
    expect(screen.getByRole("status")).toHaveTextContent(/marked for 1 agent · 1 skipped — .*Clashes with Break 14:00–14:15/)
  })

  it("right-click on an unselected row targets just that agent; Esc closes the menu but keeps the selection", () => {
    renderThree()
    fireEvent.contextMenu(row(ids[2]), { clientX: 255, clientY: 100 })
    expect(screen.getByText("Mark AUX for 1 schedule")).toBeInTheDocument()
    expect(row(ids[2])).toHaveAttribute("aria-selected", "true")
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("menu")).toBeNull()
    expect(screen.getByText("1 schedule selected")).toBeInTheDocument()
  })

  it("bulk bar opens Add activity pre-selected with the chosen agents", () => {
    renderThree()
    fireEvent.click(row(ids[0]), { ctrlKey: true })
    fireEvent.click(row(ids[2]), { ctrlKey: true })
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Bulk schedule actions" })).getByRole("button", { name: /Activity/ }))
    expect(screen.getByText("2 selected")).toBeInTheDocument()
  })
})

describe("sorting schedules", () => {
  const renderAll = () => {
    const all = useWfm.getState().agents
    return render(<ContinuousSchedule agents={all} queue={queue} plan={plan} onDuty={plan.map((p) => p.scheduled)} canEdit />)
  }
  const drawnIds = () => [...document.querySelectorAll("[data-agent-row]")].map((el) => el.getAttribute("data-agent-row")!)
  const byId = (id: string) => AGENTS.find((a) => a.id === id)!
  const starts = () => drawnIds().map((id) => toMins(byId(id).shift.split("–")[0]))
  const names = () => drawnIds().map((id) => byId(id).name)

  it("sorts by name A→Z and Z→A from the dropdown (ungrouped)", () => {
    renderAll()
    fireEvent.click(screen.getByLabelText("Group by primary channel"))
    fireEvent.change(screen.getByLabelText("Sort schedules"), { target: { value: "name-asc" } })
    expect(names()).toEqual([...names()].sort((a, b) => a.localeCompare(b)))
    fireEvent.change(screen.getByLabelText("Sort schedules"), { target: { value: "name-desc" } })
    expect(names()).toEqual([...names()].sort((a, b) => b.localeCompare(a)))
  })

  it("header Start button sorts earliest first, then latest first", () => {
    renderAll()
    fireEvent.click(screen.getByLabelText("Group by primary channel"))
    fireEvent.click(screen.getByRole("button", { name: /^Sort by start time/ }))
    const asc = starts()
    expect(asc).toEqual([...asc].sort((a, b) => a - b))
    expect(screen.getByRole("button", { name: "Sort by start time (ascending)" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /^Sort by start time/ }))
    const desc = starts()
    expect(desc).toEqual([...desc].sort((a, b) => b - a))
  })

  it("sorts within each channel group, and Shift+click ranges follow the sorted order", () => {
    renderAll()
    fireEvent.click(screen.getByRole("button", { name: /^Sort by agent name/ }))
    const firstGroup = drawnIds().slice(0, 3)
    expect(firstGroup.map((id) => byId(id).name)).toEqual(firstGroup.map((id) => byId(id).name).sort((a, b) => a.localeCompare(b)))
    const row = (id: string) => document.querySelector(`[data-agent-row="${id}"]`) as HTMLElement
    fireEvent.click(row(firstGroup[0]), { ctrlKey: true })
    fireEvent.click(row(firstGroup[2]), { shiftKey: true })
    expect(screen.getByText("3 schedules selected")).toBeInTheDocument()
    expect(firstGroup.every((id) => row(id).getAttribute("aria-selected") === "true")).toBe(true)
  })
})

describe("adding OT for a channel", () => {
  const renderTwo = () => {
    const two = useWfm.getState().agents.slice(0, 2) // both 07:00–15:30
    return render(<ContinuousSchedule agents={two} queue={queue} plan={plan} onDuty={plan.map((p) => p.scheduled)} canEdit />)
  }

  it("adds Email OT after the shift for several agents from the toolbar", () => {
    renderTwo()
    fireEvent.click(screen.getByRole("button", { name: /Add OT/ }))
    fireEvent.click(screen.getByRole("button", { name: /^Email OT/ }))
    fireEvent.click(screen.getByRole("button", { name: "1.5h" }))
    fireEvent.click(screen.getByRole("button", { name: "All agents" }))
    fireEvent.click(screen.getByRole("button", { name: /Select all eligible/ }))
    expect(screen.getAllByText("15:30–17:00")).toHaveLength(2) // per-agent preview
    fireEvent.click(screen.getByRole("button", { name: /Add 3h OT · 2 agents/ }))

    const plan = useWfm.getState().overtimePlan
    for (const a of useWfm.getState().agents.slice(0, 2)) {
      expect(plan[a.id]).toEqual([expect.objectContaining({ channel: "email", start: toMins("15:30"), end: toMins("17:00") })])
    }
    expect(useWfm.getState().auditLog[0]).toMatchObject({ action: "Added OT" })
    expect(useWfm.getState().auditLog[0].detail).toMatch(/^Email · 1\.5h after shift · 2 agent\(s\), 3h total/)
  })

  it("shows why an agent can't take custom OT and skips them", () => {
    useWfm.setState({ overtimePlan: { [agent.id]: [{ id: "x", channel: "phone", start: toMins("17:00"), end: toMins("18:00") }] } })
    renderTwo()
    fireEvent.click(screen.getByRole("button", { name: /Add OT/ }))
    fireEvent.click(screen.getByRole("button", { name: "Set times" }))
    fireEvent.change(screen.getByLabelText("OT start"), { target: { value: "17:30" } })
    fireEvent.change(screen.getByLabelText("OT end"), { target: { value: "18:30" } })
    fireEvent.click(screen.getByRole("button", { name: "All agents" }))
    fireEvent.click(screen.getByLabelText(`Select ${agent.name}`))
    expect(screen.getByText(/Clashes with OT 17:00–18:00/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Add 0h OT/ })).toBeDisabled()
  })

  it("double-clicking an agent's row opens Add OT pre-selected for them", () => {
    renderTwo()
    fireEvent.doubleClick(document.querySelectorAll("[data-track]")[0], { clientX: 800 })
    expect(screen.getByRole("heading", { name: "Add overtime" })).toBeInTheDocument()
    expect(screen.getByLabelText(/^Select /, { selector: "input:checked" })).toBeInTheDocument()
  })
})
