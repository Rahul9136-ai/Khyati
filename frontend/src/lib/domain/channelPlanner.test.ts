import { describe, expect, it } from "vitest"

import { describeLanes, lanes, planChannelDay } from "@/lib/domain/channelPlanner"
import type { AgentDay, Channel } from "@/lib/domain/channels"

const at = (h: number, m = 0) => h * 60 + m
/** 09:00–11:00 shift on one channel, no breaks. */
function day(channel: Channel, over: Partial<AgentDay> = {}): AgentDay {
  return { shift: [at(9), at(11)], breaks: [], channels: [{ id: "x", channel, start: at(9), end: at(11) }], ot: [], activities: [], ...over }
}
const plan = (agents: Record<string, AgentDay>, need: number[], chatMin = 1) =>
  planChannelDay(Object.entries(agents).map(([key, d]) => ({ key, day: d })), need, at(9), { chatMin })
const after = (p: ReturnType<typeof plan>, key: string) => describeLanes(p.agents.find((a) => a.key === key)!.after)

describe("phone-first channel planning", () => {
  it("covers phone first, then the chat minimum, and email takes the rest", () => {
    // Intervals 09:00, 09:30, 10:00, 10:30 — phone need drops from 2 to 1 at 10:00.
    const p = plan({ a: day("email"), b: day("email"), c: day("email") }, [2, 2, 1, 1])
    expect(after(p, "a")).toBe("Phone 09:00–11:00")
    expect(after(p, "b")).toBe("Phone 09:00–10:00 · Email 10:00–11:00")
    expect(after(p, "c")).toBe("Chat 09:00–11:00")
    expect(p.after.phone).toEqual([2, 2, 1, 1])
    // Before: phone 2+2+1+1 heads short = 3 head-hours; chat 1 short all 2 hours.
    expect(p.phoneGap).toEqual({ before: 3, after: 0 })
    expect(p.chatGap).toEqual({ before: 2, after: 0 })
  })

  it("leaves agents where they are when the need is already met", () => {
    const p = plan({ a: day("phone"), b: day("chat"), c: day("email") }, [1, 1, 1, 1])
    expect(p.agents.every((x) => !x.changed)).toBe(true)
    expect(p.agents[0].after).toBe(p.agents[0].before) // untouched, ids and all
  })

  it("prefers agents already on the channel, so fewer people move", () => {
    const p = plan({ a: day("email"), b: day("phone"), c: day("email") }, [1, 1, 1, 1], 0)
    expect(p.agents.filter((x) => x.changed).map((x) => x.key)).toEqual([])
    const more = plan({ a: day("email"), b: day("phone"), c: day("email") }, [2, 2, 2, 2], 0)
    expect(more.agents.filter((x) => x.changed).map((x) => x.key)).toEqual(["a"]) // b stays, a joins phone
  })

  it("doesn't count agents on a break or activity, and keeps their channel through it", () => {
    const busy = day("email", { breaks: [{ id: "b", type: "break", label: "Break", start: at(10), end: at(10, 30) }] })
    const p = plan({ a: busy, b: day("email") }, [1, 1, 1, 1], 0)
    // 10:00 a is on break → b covers phone then; a keeps phone around the break.
    expect(after(p, "a")).toBe("Phone 09:00–11:00")
    expect(after(p, "b")).toBe("Email 09:00–10:00 · Phone 10:00–10:30 · Email 10:30–11:00")
    const away = plan({ a: day("email", { activities: [{ id: "l", type: "leave", start: at(9), end: at(11) }] }) }, [1, 1, 1, 1])
    expect(away.agents[0].changed).toBe(false) // never free — left alone
  })

  it("counts OT already on a channel towards it", () => {
    const withOt = day("email", { ot: [{ id: "o", channel: "phone", start: at(11), end: at(12) }] })
    const p = plan({ a: day("email"), b: day("email") }, [1, 1, 1, 1], 0)
    expect(p.after.phone).toEqual([1, 1, 1, 1])
    const ot = planChannelDay(
      [{ key: "a", day: day("email") }, { key: "z", day: { ...withOt, shift: [at(7), at(9)], channels: [{ id: "y", channel: "email", start: at(7), end: at(9) }], ot: [{ id: "o", channel: "phone", start: at(9), end: at(11) }] } }],
      [1, 1, 1, 1], at(9), { chatMin: 0 },
    )
    expect(describeLanes(ot.agents[0].after)).toBe("Email 09:00–11:00") // z's phone OT already covers it
  })

  it("compares plans by content, joining neighbouring blocks", () => {
    expect(lanes([{ id: "1", channel: "phone", start: 0, end: 30 }, { id: "2", channel: "phone", start: 30, end: 60 }])).toEqual([["phone", 0, 60]])
  })
})
