import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { AGENTS, QUEUES } from "@/lib/domain/seed"
import { useWfm } from "@/store/wfm"

import { CurrentQueue, LobTree } from "./lob-tree"

beforeEach(() => {
  useWfm.setState({ lobs: [], queues: QUEUES.map((q) => ({ ...q })), agents: AGENTS.slice(0, 5), queueId: QUEUES[0].id, currentRole: "Super Admin" })
})
const show = () => render(<><CurrentQueue /><LobTree /></>)
const item = (name: string) => screen.getByRole("treeitem", { name })
const type = (label: string, text: string) => {
  const box = screen.getByRole("textbox", { name: label })
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: "Enter" })
}

describe("Lines of business in the left pane", () => {
  it("shows the LOB; clicking opens channels, then queues; clicking a queue selects it", () => {
    show()
    // the selected queue's path is open
    expect(item("Customer Care")).toHaveAttribute("aria-expanded", "true")
    expect(item("Phone")).toHaveAttribute("aria-expanded", "true")
    expect(item(QUEUES[0].name)).toHaveAttribute("aria-selected", "true")

    fireEvent.click(screen.getByRole("button", { name: /^Customer Care, 3 queues/ }))
    expect(item("Customer Care")).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("treeitem", { name: "Phone" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /^Customer Care/ }))
    fireEvent.click(screen.getByRole("button", { name: /^Chat, 0 queues/ }))
    expect(within(item("Chat")).getByText("No queues yet")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: QUEUES[2].name }))
    expect(useWfm.getState().queueId).toBe(QUEUES[2].id)
    expect(screen.getByLabelText("Current queue")).toHaveTextContent(`Customer Care › Phone › ${QUEUES[2].name}`)
  })

  it("adds a LOB, a channel and a queue (which becomes the selected one)", () => {
    show()
    fireEvent.click(screen.getByRole("button", { name: "Add LOB" }))
    type("New LOB name", "Retail Banking")
    expect(item("Retail Banking")).toHaveAttribute("aria-expanded", "true")

    const lob = item("Retail Banking")
    fireEvent.click(within(lob).getByRole("button", { name: "Add channel" }))
    type("New channel name", "WhatsApp")
    const wa = item("WhatsApp")
    fireEvent.click(within(wa).getByRole("button", { name: "Add queue" }))
    type("New queue name", "Card Disputes")

    expect(item("Card Disputes")).toHaveAttribute("aria-selected", "true")
    expect(screen.getByLabelText("Current queue")).toHaveTextContent("Retail Banking › WhatsApp › Card Disputes")
  })

  it("refuses empty or duplicate names and says why", () => {
    show()
    fireEvent.click(within(item("Phone")).getByRole("button", { name: "Add queue" }))
    type("New queue name", QUEUES[1].name.toUpperCase())
    expect(screen.getByRole("alert")).toHaveTextContent(/already a queue/)
    fireEvent.keyDown(screen.getByRole("textbox", { name: "New queue name" }), { key: "Escape" })
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("renames inline and blocks removing things that are in use", () => {
    show()
    fireEvent.click(screen.getByRole("button", { name: "Rename LOB Customer Care" }))
    type("LOB name", "Consumer")
    expect(item("Consumer")).toBeInTheDocument()
    // the LOB and Phone have queues; the queue has skilled agents
    expect(screen.getByRole("button", { name: "Remove LOB Consumer" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Remove channel Phone" })).toBeDisabled()
    expect(screen.getByRole("button", { name: `Remove queue ${QUEUES[0].name}` })).toHaveAttribute("title", expect.stringMatching(/agents? ha/))

    // an empty channel can go
    vi.spyOn(window, "confirm").mockReturnValue(true)
    fireEvent.click(screen.getByRole("button", { name: "Remove channel Email" }))
    expect(screen.queryByRole("treeitem", { name: "Email" })).toBeNull()
  })

  it("people without edit access can browse and select, not change", () => {
    useWfm.setState({ currentRole: "Agent" })
    show()
    expect(screen.queryByRole("button", { name: "Add LOB" })).toBeNull()
    expect(screen.queryByRole("button", { name: /^Rename/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Add queue" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: QUEUES[1].name }))
    expect(useWfm.getState().queueId).toBe(QUEUES[1].id)
  })
})
