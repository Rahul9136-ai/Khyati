import { beforeEach, describe, expect, it } from "vitest"

import { AGENTS, QUEUES } from "@/lib/domain/seed"
import { useWfm } from "@/store/wfm"

import { DEFAULT_LOB, lobTree, nameProblem, placeOf } from "./lob"

beforeEach(() => {
  useWfm.setState({ lobs: [], queues: QUEUES.map((q) => ({ ...q })), agents: AGENTS.slice(0, 5), queueId: QUEUES[0].id })
})
const st = () => useWfm.getState()
const tree = () => lobTree(st().lobs, st().queues)

describe("LOB → Channel → Queue", () => {
  it("queues saved before LOBs existed sit under the default LOB's first channel", () => {
    const t = tree()
    expect(t).toHaveLength(1)
    expect(t[0].lob.name).toBe(DEFAULT_LOB.name)
    expect(t[0].channels.map((c) => c.name)).toEqual(["Phone", "Chat", "Email"])
    expect(t[0].channels[0].queues.map((q) => q.id)).toEqual(QUEUES.map((q) => q.id))
    expect(placeOf([], {})).toEqual({ lob: DEFAULT_LOB, channel: "Phone" })
  })

  it("add a LOB, a channel in it and a queue in that channel", () => {
    const lob = st().addLob("Retail Banking")
    st().addChannel(lob, "WhatsApp")
    const q = st().addQueue({ name: "Card Disputes", color: "#000", aht: 300, slTarget: 0.8, targetTime: 20, lobId: lob, channel: "WhatsApp" })
    const node = tree().find((n) => n.lob.id === lob)!
    expect(node.lob.channels).toEqual(["Phone", "Chat", "Email", "WhatsApp"])
    expect(node.channels.find((c) => c.name === "WhatsApp")!.queues.map((x) => x.name)).toEqual(["Card Disputes"])
    expect(st().queues.find((x) => x.id === q)).toMatchObject({ lobId: lob, channel: "WhatsApp" })
    // the default LOB is now a saved one, so it stays put
    expect(st().lobs.map((l) => l.name)).toEqual(["Customer Care", "Retail Banking"])
    expect(st().forecasts[q]).toBeDefined()
    expect(st().auditLog[0].action).toBe("Added skill")
  })

  it("renaming a channel moves its queues with it", () => {
    st().renameChannel(DEFAULT_LOB.id, "Phone", "Voice")
    expect(tree()[0].channels.map((c) => c.name)).toEqual(["Voice", "Chat", "Email"])
    expect(tree()[0].channels[0].queues).toHaveLength(QUEUES.length)
    expect(st().queues.every((q) => q.channel === "Voice")).toBe(true)
  })

  it("rename a LOB and a queue", () => {
    st().renameLob(DEFAULT_LOB.id, "Consumer")
    st().renameQueue(QUEUES[0].id, "Inbound Sales")
    expect(tree()[0].lob.name).toBe("Consumer")
    expect(st().queues[0].name).toBe("Inbound Sales")
    st().renameQueue(QUEUES[0].id, QUEUES[1].name) // a duplicate name is refused
    expect(st().queues[0].name).toBe("Inbound Sales")
  })

  it("only empty LOBs and channels can be removed, and never the last LOB", () => {
    st().removeChannel(DEFAULT_LOB.id, "Phone") // has queues
    expect(tree()[0].lob.channels).toContain("Phone")
    st().removeChannel(DEFAULT_LOB.id, "Email")
    expect(tree()[0].lob.channels).toEqual(["Phone", "Chat"])
    st().removeLob(DEFAULT_LOB.id) // last LOB, with queues
    expect(tree()).toHaveLength(1)
    const empty = st().addLob("Temp")
    st().removeLob(empty)
    expect(tree().map((n) => n.lob.name)).toEqual(["Customer Care"])
  })

  it("a queue agents are skilled on can't be removed; an unused one can, with its forecast", () => {
    const used = QUEUES[0].id
    st().removeQueue(used)
    expect(st().queues.some((q) => q.id === used)).toBe(true)
    const q = st().addQueue({ name: "Overflow", color: "#000", aht: 300, slTarget: 0.8, targetTime: 20 })
    st().setQueueId(q)
    st().removeQueue(q)
    expect(st().queues.some((x) => x.id === q)).toBe(false)
    expect(st().forecasts[q]).toBeUndefined()
    expect(st().queueId).toBe(QUEUES[0].id) // moved off the removed queue
    expect(st().queue().id).toBe(QUEUES[0].id)
  })

  it("checks names", () => {
    expect(nameProblem(" ", [], "LOB")).toMatch(/name/)
    expect(nameProblem("sales", ["Sales"], "queue")).toMatch(/already/)
    expect(nameProblem("New", ["Sales"], "queue")).toBeNull()
  })
})
