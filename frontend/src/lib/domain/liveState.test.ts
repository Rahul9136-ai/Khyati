import { beforeEach, describe, expect, it } from "vitest"

import { applyRemoteState } from "@/lib/crossTabSync"
import { DAY_START } from "@/lib/domain/adherence"
import type { AgentDay } from "@/lib/domain/channels"
import { addDays, localISODate } from "@/lib/domain/horizon"
import { liveMinute, liveSecs, scheduledAux } from "@/lib/domain/liveState"
import { AGENTS } from "@/lib/domain/seed"
import { useWfm } from "@/store/wfm"

const day = (over: Partial<AgentDay> = {}): AgentDay => ({
  shift: [420, 930], // 07:00–15:30
  breaks: [
    { id: "b1", type: "break", label: "Break", start: 540, end: 555 },
    { id: "l1", type: "lunch", label: "Lunch", start: 690, end: 720 },
  ],
  channels: [],
  ot: [],
  activities: [],
  ...over,
})

describe("scheduled state from the timeline", () => {
  it("reads shift, breaks, lunch and activities at a minute", () => {
    expect(scheduledAux(day(), 400)).toBe("OFFLINE") // before the shift
    expect(scheduledAux(day(), 480)).toBe("AVAIL")
    expect(scheduledAux(day(), 545)).toBe("AUX1") // break
    expect(scheduledAux(day(), 700)).toBe("AUX2") // lunch
    expect(scheduledAux(day(), 940)).toBe("OFFLINE") // after the shift
    expect(scheduledAux(day({ ot: [{ id: "o", channel: "phone", start: 930, end: 990 }] }), 940)).toBe("AVAIL") // overtime
    const act = (type: AgentDay["activities"][number]["type"]) => scheduledAux(day({ activities: [{ id: "x", type, start: 600, end: 660 }] }), 610)
    expect([act("meeting"), act("training"), act("coaching"), act("off"), act("leave"), act("absence")]).toEqual(["AUX3", "AUX4", "AUX5", "OFFLINE", "OFFLINE", "OFFLINE"])
  })

  it("puts 'now' inside the Intraday clock's interval and counts time in state from a timestamp", () => {
    const at = new Date(2026, 10, 4, 9, 47)
    expect(liveMinute(13, at)).toBe(DAY_START + 13 * 30 + 17)
    expect(liveSecs({ id: "a", actual: "AVAIL", scheduled: "AVAIL", secs: 999, since: 1_000_000 }, 1_090_000)).toBe(90)
    expect(liveSecs({ id: "a", actual: "AVAIL", scheduled: "AVAIL", secs: 42 })).toBe(42) // older data without a timestamp
  })
})

describe("real-time board follows the schedule", () => {
  const [a, b] = AGENTS
  // The whole current half-hour, whatever minute the test runs at.
  const interval = (idx: number) => ({ start: DAY_START + idx * 30, end: DAY_START + idx * 30 + 30 })

  beforeEach(() => {
    useWfm.setState({
      agents: AGENTS.slice(0, 2), scheduleDate: localISODate(), dayStore: {}, breakOverrides: {}, overtimePlan: {}, activityPlan: {}, employeeProfiles: {},
      nowIdx: 6, // 10:00 — on shift, between breaks for the default patterns
      rta: [
        { id: a.id, actual: "AVAIL", scheduled: "AVAIL", secs: 10, since: Date.now() - 10_000 },
        { id: b.id, actual: "OFFLINE", scheduled: "AVAIL", secs: 300, since: Date.now() - 300_000 }, // off plan
      ],
    })
  })

  it("moves on-plan agents into a meeting added on the timeline, and keeps off-plan agents flagged", () => {
    useWfm.setState({ activityPlan: { [a.id]: [{ id: "m", type: "meeting", ...interval(6) }], [b.id]: [{ id: "m2", type: "training", ...interval(6) }] } })
    useWfm.getState().syncRealTime()
    const [ra, rb] = useWfm.getState().rta
    expect(ra).toMatchObject({ scheduled: "AUX3", actual: "AUX3" }) // followed the plan into the meeting
    expect(liveSecs(ra)).toBeLessThan(2) // new state, fresh timer
    expect(rb).toMatchObject({ scheduled: "AUX4", actual: "OFFLINE" }) // still an exception, now against training
    expect(liveSecs(rb)).toBeGreaterThanOrEqual(299) // same exception, timer keeps running
  })

  it("follows the Intraday clock out of the shift", () => {
    useWfm.setState({ nowIdx: 23 }) // 18:30 — after a 07:00–15:30 shift
    useWfm.getState().syncRealTime()
    expect(useWfm.getState().rta.find((r) => r.id === a.id)).toMatchObject({ scheduled: "OFFLINE", actual: "OFFLINE" })
  })

  it("uses today's schedule while Scheduling shows another day, and adds new agents", () => {
    useWfm.getState().setScheduleDate(addDays(localISODate(), 3)) // today's day is parked in dayStore
    useWfm.setState({ agents: [...useWfm.getState().agents, { ...AGENTS[2] }] })
    useWfm.getState().syncRealTime()
    const s = useWfm.getState()
    expect(s.rta.map((r) => r.id)).toEqual([a.id, b.id, AGENTS[2].id])
    expect(s.rta[0].scheduled).toBe("AVAIL")
  })

  it("changes nothing when the schedule and clock haven't moved", () => {
    useWfm.getState().syncRealTime()
    const before = useWfm.getState().rta
    useWfm.getState().syncRealTime()
    expect(useWfm.getState().rta).toBe(before)
  })
})

describe("browser tabs stay in step", () => {
  it("takes shared data from another tab but keeps this tab's own view", () => {
    useWfm.setState({ nowIdx: 6, scheduleDate: localISODate() })
    const other = { state: { ...useWfm.getState(), nowIdx: 18, scheduleDate: "2030-01-01", rta: [{ id: "zz", actual: "AUX1", scheduled: "AVAIL", secs: 0, since: 1 }] } }
    const changed = applyRemoteState(JSON.stringify(other))
    expect(changed.sort()).toEqual(["dayStore", "nowIdx", "rta"]) // their open day (2030-01-01) is kept for us too
    expect(useWfm.getState().dayStore["2030-01-01"]).toBeDefined()
    expect(useWfm.getState().nowIdx).toBe(18)
    expect(useWfm.getState().rta[0].id).toBe("zz")
    expect(useWfm.getState().scheduleDate).toBe(localISODate()) // view stays
    expect(applyRemoteState(JSON.stringify(other))).toEqual([]) // nothing new → nothing written back
    expect(applyRemoteState("not json")).toEqual([])
  })

  it("takes another tab's schedule for each day, wherever this tab keeps that day", () => {
    const today = localISODate()
    const later = addDays(today, 3)
    const [a] = AGENTS
    const training = { [a.id]: [{ id: "t", type: "training" as const, start: 600, end: 660 }] }
    useWfm.setState({ agents: AGENTS.slice(0, 2), scheduleDate: today, dayStore: {}, activityPlan: {}, breakOverrides: {}, channelPlan: {}, overtimePlan: {} })

    // The other tab is looking at a later day, with today parked — and adds training today.
    const base = useWfm.getState()
    const remoteToday = { shifts: { [a.id]: "07:00–15:30", [AGENTS[1].id]: AGENTS[1].shift }, breakOverrides: {}, channelPlan: {}, overtimePlan: {}, activityPlan: training }
    const remote = {
      ...base, scheduleDate: later, dayStore: { [today]: remoteToday },
      agents: base.agents.map((x) => ({ ...x, shift: "10:00–18:30" })), // their open day's shifts
      activityPlan: { [a.id]: [{ id: "m", type: "meeting" as const, start: 700, end: 730 }] }, // their later day
    }
    applyRemoteState(JSON.stringify({ state: remote }))
    const s = useWfm.getState()
    expect(s.scheduleDate).toBe(today) // our view stays on today
    expect(s.activityPlan).toEqual(training) // today's change lands on our open day
    expect(s.agents.map((x) => x.shift)).toEqual(AGENTS.slice(0, 2).map((x) => x.shift)) // not their later day's shifts
    expect(s.dayStore[later].activityPlan[a.id][0].type).toBe("meeting") // their later day is kept for when we open it
    expect(applyRemoteState(JSON.stringify({ state: remote }))).toEqual([]) // settles: nothing left to apply
  })
})
