import { describe, expect, it } from "vitest"

import {
  DEFAULT_DATA_SOURCES,
  defaultProfile,
  describeChanges,
  employedOn,
  hcStatus,
  isTerminated,
  JOB_TITLES,
  lastFirst,
  maskTaxId,
  profileSheets,
  setEffective,
  valueAsOf,
  type Dated,
} from "@/lib/domain/employeeProfile"
import { addDays } from "@/lib/domain/horizon"
import { AGENTS } from "@/lib/domain/seed"
import { applyProfileRows } from "@/lib/profileImport"

const agent = AGENTS[0]
const TODAY = "2026-11-04"

describe("employee profile", () => {
  it("offers Trainer and Quality Analyst as job titles", () => {
    expect(JOB_TITLES).toContain("Trainer")
    expect(JOB_TITLES).toContain("Quality Analyst")
  })

  it("defaults to the agent's team lead and team, started before today", () => {
    const p = defaultProfile(agent, TODAY)
    expect(p).toMatchObject({ jobTitle: "Agent", teamLead: agent.tl, supervisor: agent.tl, endDate: null })
    expect(p.startDate < TODAY).toBe(true)
    expect(valueAsOf(p.organization, TODAY)?.value).toBe(agent.team)
    expect(defaultProfile(agent, TODAY)).toEqual(p) // stable
  })

  it("keeps effective-dated history: a new value closes the one it interrupts", () => {
    let wage: Dated<number>[] = [{ value: 15, from: "2024-03-21", to: null }]
    wage = setEffective(wage, 17.5, "2025-01-01")
    expect(wage).toEqual([
      { value: 15, from: "2024-03-21", to: "2024-12-31" },
      { value: 17.5, from: "2025-01-01", to: null },
    ])
    expect(valueAsOf(wage, "2024-06-01")?.value).toBe(15)
    expect(valueAsOf(wage, "2026-06-01")?.value).toBe(17.5)
    expect(valueAsOf(wage, "2020-01-01")?.value).toBe(15) // before it all began → the first
    // A correction from an earlier date replaces what came after it.
    wage = setEffective(wage, 16, "2024-10-01")
    expect(wage.map((w) => [w.value, w.from, w.to])).toEqual([[15, "2024-03-21", "2024-09-30"], [16, "2024-10-01", null]])
  })

  it("masks the tax ID, formats names and knows when someone has left", () => {
    expect(maskTaxId("123-45-6789")).toBe("•••-••-6789")
    expect(maskTaxId("")).toBe("")
    expect(lastFirst("Siro Sothing")).toBe("Sothing, Siro")
    const p = { ...defaultProfile(agent, TODAY), endDate: "2026-11-10" }
    // The end date is the last working day: still employed on it, gone the day after.
    expect([isTerminated(p, TODAY), isTerminated(p, "2026-11-10"), isTerminated(p, "2026-11-11")]).toEqual([false, false, true])
    expect([employedOn(p, "2026-11-10"), employedOn(p, "2026-11-11"), employedOn(p, addDays(p.startDate, -1))]).toEqual([true, false, false])
    expect([hcStatus(p, TODAY), hcStatus(p, "2026-11-11"), hcStatus({ ...p, endDate: null }, TODAY), hcStatus({ ...p, startDate: "2027-01-01" }, TODAY)])
      .toEqual(["Notice period", "Exited", "Active", "Joining"])
  })

  it("describes what changed between two versions of a profile", () => {
    const before = defaultProfile(agent, TODAY)
    const after = { ...before, jobTitle: "Trainer" as const, endDate: "2026-12-31", teamLead: "Elena Faro", wage: setEffective(before.wage, 18, "2026-11-01"), taxId: "123" }
    expect(describeChanges(before, after)).toEqual([
      "Job title Agent → Trainer", "Last working day — → 2026-12-31", `Team lead ${agent.tl} → Elena Faro`, "Tax ID updated", "Wage → 18 from 2026-11-01",
    ])
    expect(describeChanges(before, before)).toEqual([])
  })

  it("round-trips through the export layout on import", () => {
    const p = {
      ...defaultProfile(agent, TODAY),
      jobTitle: "Quality Analyst" as const,
      employeeNumber: "E-1001",
      sources: { "prod-parham-phone": { employeeId: "13670", extension: "4411", enabled: false }, qmdata: { employeeId: "", extension: "", enabled: true } },
    }
    const [admin, sources] = profileSheets(agent, p, DEFAULT_DATA_SOURCES, TODAY)
    const res = applyProfileRows(defaultProfile(agent, TODAY), admin.rows, sources.rows, DEFAULT_DATA_SOURCES, TODAY)
    expect(res.errors).toEqual([])
    expect(res.profile.jobTitle).toBe("Quality Analyst")
    expect(res.profile.employeeNumber).toBe("E-1001")
    expect(res.profile.sources["prod-parham-phone"]).toEqual({ employeeId: "13670", extension: "4411", enabled: false })
    expect(res.profile.sources.qmdata.enabled).toBe(true)
  })

  it("imports a new wage from the as-of date and reports bad values", () => {
    const base = defaultProfile(agent, TODAY)
    const res = applyProfileRows(base, [
      { Field: "Wage Amount", Value: "21.25" }, { Field: "Job Title", Value: "Astronaut" }, { Field: "Start Date", Value: "03/21/2024" },
    ], [{ "Data Source": "Nope" }], DEFAULT_DATA_SOURCES, TODAY)
    expect(res.profile.wage.at(-1)).toEqual({ value: 21.25, from: TODAY, to: null })
    expect(res.profile.jobTitle).toBe("Agent")
    expect(res.errors).toHaveLength(3)
    expect(res.changed).toEqual(["wage"])
  })
})
