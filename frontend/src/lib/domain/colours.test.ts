import { beforeEach, describe, expect, it } from "vitest"

import { useWfm } from "@/store/wfm"

import { colourName, FIXED, fixColourClashes, nextFreeColour, STATUS, USER_PALETTE } from "./colours"
import { buildLegends } from "./legends"
import { DEFAULT_LOB } from "./lob"
import { QUEUES } from "./seed"

const all = [...FIXED, ...USER_PALETTE, ...STATUS]

describe("named colours", () => {
  it("every colour and every name is used once", () => {
    expect(new Set(all.map((c) => c.hex.toLowerCase())).size).toBe(all.length)
    expect(new Set(all.map((c) => c.name)).size).toBe(all.length)
  })

  it("names a colour; a custom one gets the nearest name", () => {
    expect(colourName("#D97706")).toBe("Ochre")
    expect(colourName("#2564eb")).toBe("Close to Royal Blue")
    expect(colourName(undefined)).toBe("")
  })
})

describe("each segment has its own colour", () => {
  const groups = buildLegends({ queues: QUEUES, lobs: [] })

  it("no two different segments share a colour (the same thing in two places may)", () => {
    const seen = new Map<string, { label: string; concept?: string; group: string }>()
    for (const g of groups.filter((x) => !x.semantic))
      for (const i of g.items.filter((x) => x.color)) {
        const prev = seen.get(i.color!.toLowerCase())
        if (prev) expect({ colour: i.color, a: prev.concept ?? prev.label, b: i.concept ?? i.label })
          .toEqual({ colour: i.color, a: i.concept, b: i.concept })
        else seen.set(i.color!.toLowerCase(), { label: i.label, concept: i.concept, group: g.title })
      }
  })

  it("every colour has a proper name, and shared ones say why", () => {
    for (const g of groups) for (const i of g.items.filter((x) => x.color)) expect(i.colorName, `${g.title}: ${i.label}`).not.toMatch(/^Close to|^#|^$/)
    const brk = groups.find((g) => g.id === "activities")!.items.find((i) => i.code === "BRK")!
    expect(brk).toMatchObject({ colorName: "Ochre", sameAs: "Same colour as Break in Agent states (AUX codes) (it's the same thing)" })
  })

  it("the shipped queues and default LOB use palette colours nothing else uses", () => {
    expect(fixColourClashes([DEFAULT_LOB], QUEUES)).toBeNull()
  })
})

describe("LOB and queue colours stay unique", () => {
  beforeEach(() => useWfm.setState({ lobs: [], queues: QUEUES.map((q) => ({ ...q })) }))

  it("a clash (with a segment or another queue) gets the next free colour; the first keeps its own", () => {
    const fixed = fixColourClashes(
      [{ id: "a", color: "#6366f1" }],
      [{ id: "q1", color: "#3b82f6" }, { id: "q2", color: "#3b82f6" }, { id: "q3", color: "#d97706" /* Break */ }],
    )!
    expect(fixed.lobs[0].color).toBe("#6366f1")
    expect(fixed.queues[0].color).toBe("#3b82f6")
    expect(new Set([fixed.lobs[0].color, ...fixed.queues.map((q) => q.color)]).size).toBe(4)
    expect(FIXED.map((c) => c.hex)).not.toContain(fixed.queues[2].color)
  })

  it("new LOBs and queues get an unused colour; saved clashes are fixed in the store", () => {
    const lob = useWfm.getState().addLob("Retail")
    const lobColour = useWfm.getState().lobs.find((l) => l.id === lob)!.color
    expect([DEFAULT_LOB.color, ...QUEUES.map((q) => q.color)]).not.toContain(lobColour)
    expect(nextFreeColour(["#6366f1"])).toBe("#3b82f6")

    useWfm.setState({ queues: QUEUES.map((q) => ({ ...q, color: "#2563eb" })) }) // old saved data: all Royal Blue (= Phone)
    useWfm.getState().fixColours()
    const colours = useWfm.getState().queues.map((q) => q.color)
    expect(new Set(colours).size).toBe(colours.length)
    expect(colours).not.toContain("#2563eb")
  })
})
