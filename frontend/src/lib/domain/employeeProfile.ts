// Employee profile — the HR / administrative record behind each roster agent:
// job title, employment dates and type, effective-dated wage / quality score /
// rank / organisation, reporting line, home address, the agent's IDs in each
// connected data source (ACD, screens, WFM, adherence, quality) and
// user-defined fields. Kept apart from the Agent itself (lib/domain/types.ts)
// so scheduling stays lean; saving a profile updates the agent's team lead.
import { addDays } from "@/lib/domain/horizon"
import type { Agent } from "@/lib/domain/types"
import type { Sheet } from "@/lib/export"

/** Job titles an employee can hold. Not access roles — those live in roles.ts. */
export const JOB_TITLES = [
  "Agent",
  "Senior Agent",
  "Team Leader",
  "Supervisor",
  "Trainer",
  "Quality Analyst",
  "Scheduler",
  "Real-Time Analyst",
  "WFM Analyst",
  "Operations Manager",
] as const
export type JobTitle = (typeof JOB_TITLES)[number]

export const EMPLOYEE_TYPES = ["Full-time", "Part-time", "Contractor", "Temporary"] as const
export type EmployeeType = (typeof EMPLOYEE_TYPES)[number]

/** phone / screen / wfm / adherence carry an Employee ID (phone also an
 *  Extension); quality is an enrolment tick. */
export type DataSourceKind = "phone" | "screen" | "wfm" | "adherence" | "quality"
export const DATA_SOURCE_KINDS: { value: DataSourceKind; label: string }[] = [
  { value: "phone", label: "Phone / ACD" },
  { value: "screen", label: "Screen recording" },
  { value: "wfm", label: "WFM" },
  { value: "adherence", label: "Adherence feed" },
  { value: "quality", label: "Quality (enrol)" },
]

export interface DataSource {
  id: string
  name: string
  kind: DataSourceKind
}

export const DEFAULT_DATA_SOURCES: DataSource[] = [
  { id: "cg-phone", name: "CG_Phone", kind: "phone" },
  { id: "contentguru-wfm", name: "ContentGuru WFM", kind: "wfm" },
  { id: "dpa", name: "DPA", kind: "adherence" },
  { id: "dpa-adh-feed", name: "DPA_Adh Feed", kind: "adherence" },
  { id: "mexico-phones", name: "Mexico Phones", kind: "phone" },
  { id: "mexico-screens", name: "Mexico Screens", kind: "screen" },
  { id: "mexico-wfm", name: "Mexico WFM", kind: "wfm" },
  { id: "prod-parham2-screens", name: "Prod_Parham2_Screens", kind: "screen" },
  { id: "prod-parham-phone", name: "Prod_Parham_Phone", kind: "phone" },
  { id: "prod-parham-wfm", name: "Prod_Parham_WFM", kind: "wfm" },
  { id: "qmdata", name: "QMData", kind: "quality" },
  { id: "richmond", name: "Richmond", kind: "phone" },
  { id: "v11-prod-hds", name: "V11_Prod HDS", kind: "phone" },
  { id: "zcontentguru-wfm-test", name: "zContentGuru WFM_Test", kind: "wfm" },
  { id: "ztest-cg", name: "zTest_CG", kind: "phone" },
  { id: "zzdpa-adherence", name: "zzDPA Adherence", kind: "adherence" },
]

/** A value that holds from `from` through `to` (inclusive; null = open-ended). */
export interface Dated<T> {
  value: T
  from: string
  to: string | null
}

export interface HomeAddress {
  line1: string
  line2: string
  city: string
  state: string
  postalCode: string
  country: string
}

export interface SourceLink {
  employeeId: string
  extension: string
  /** Quality sources: enrolled or not. */
  enabled: boolean
}

export interface EmployeeProfile {
  jobTitle: JobTitle
  startDate: string
  endDate: string | null
  isSupervisor: boolean
  isTeamLead: boolean
  employeeType: EmployeeType
  employeeNumber: string
  taxId: string
  wage: Dated<number>[]
  qualityScore: Dated<number>[]
  rank: Dated<number>[]
  organization: Dated<string>[]
  supervisor: string
  teamLead: string
  address: HomeAddress
  sources: Record<string, SourceLink>
  userFields: { label: string; value: string }[]
}

const EMPTY_ADDRESS: HomeAddress = { line1: "", line2: "", city: "", state: "", postalCode: "", country: "" }
export const EMPTY_LINK: SourceLink = { employeeId: "", extension: "", enabled: false }

/** Stable per-agent number, so defaults don't change between renders. */
function hashOf(id: string): number {
  return [...id].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7)
}

/** The profile an agent has until someone saves one: started 3 months – 3 years
 *  ago, reporting to their team lead, organisation = their team. */
export function defaultProfile(agent: Agent, today: string): EmployeeProfile {
  const start = addDays(today, -(90 + (hashOf(agent.id) % 1000)))
  return {
    jobTitle: "Agent",
    startDate: start,
    endDate: null,
    isSupervisor: false,
    isTeamLead: false,
    employeeType: "Full-time",
    employeeNumber: "",
    taxId: "",
    wage: [{ value: 0, from: start, to: null }],
    qualityScore: [{ value: 0, from: start, to: null }],
    rank: [{ value: 1, from: start, to: null }],
    organization: [{ value: agent.team, from: start, to: null }],
    supervisor: agent.tl,
    teamLead: agent.tl,
    address: { ...EMPTY_ADDRESS },
    sources: {},
    userFields: [],
  }
}

/** People who can be picked as a supervisor / team lead: every team's lead plus
 *  anyone whose profile is flagged as one. */
export function leaderNames(agents: Agent[], profiles: Record<string, EmployeeProfile>, teamLeads: string[], extra: string[] = []): string[] {
  const names = new Set<string>([...teamLeads, ...agents.map((a) => a.tl), ...extra])
  for (const a of agents) {
    const p = profiles[a.id]
    if (p?.isSupervisor || p?.isTeamLead) names.add(a.name)
  }
  return [...names].filter(Boolean).sort()
}

/** The entry in effect on `asOf` (or, before the first one starts, the first). */
export function valueAsOf<T>(history: Dated<T>[], asOf: string): Dated<T> | undefined {
  const sorted = [...history].sort((a, b) => a.from.localeCompare(b.from))
  return sorted.find((h) => h.from <= asOf && (h.to === null || h.to >= asOf)) ?? (asOf < (sorted[0]?.from ?? "") ? sorted[0] : sorted.at(-1))
}

/** A new value from `from` onward: the entry it interrupts ends the day before,
 *  later entries are replaced. */
export function setEffective<T>(history: Dated<T>[], value: T, from: string): Dated<T>[] {
  const before = history
    .filter((h) => h.from < from)
    .map((h) => (h.to === null || h.to >= from ? { ...h, to: addDays(from, -1) } : h))
  return [...before, { value, from, to: null }].sort((a, b) => a.from.localeCompare(b.from))
}

/** Gone: the end date is the last working day, so they've left from the day after. */
export const isTerminated = (p: EmployeeProfile, asOf: string) => p.endDate !== null && p.endDate < asOf

/** On the books that day: joined, and not past their last working day. */
export const employedOn = (p: EmployeeProfile, date: string) => p.startDate <= date && (p.endDate === null || date <= p.endDate)

export type HcStatus = "Active" | "Notice period" | "Exited" | "Joining"

/** Headcount status on `today`. */
export function hcStatus(p: EmployeeProfile, today: string): HcStatus {
  if (isTerminated(p, today)) return "Exited"
  if (p.startDate > today) return "Joining"
  return p.endDate ? "Notice period" : "Active"
}

/** One entry in an employee's change log (who changed what, when). */
export interface EmployeeChange {
  id: string
  agentId: string
  name: string
  /** epoch ms */
  at: number
  by: string
  action: "Onboarded" | "Updated" | "Exited" | "Rehired" | "Deleted"
  detail: string
}

/** What changed between two versions of a profile, in words. */
export function describeChanges(before: EmployeeProfile, after: EmployeeProfile): string[] {
  const out: string[] = []
  const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v))
  const field = (label: string, a: unknown, b: unknown) => {
    if (show(a) !== show(b)) out.push(`${label} ${show(a)} → ${show(b)}`)
  }
  field("Job title", before.jobTitle, after.jobTitle)
  field("Join date", before.startDate, after.startDate)
  field("Last working day", before.endDate, after.endDate)
  field("Employee type", before.employeeType, after.employeeType)
  field("Employee number", before.employeeNumber, after.employeeNumber)
  field("Supervisor", before.supervisor, after.supervisor)
  field("Team lead", before.teamLead, after.teamLead)
  field("Is supervisor", before.isSupervisor ? "Yes" : "No", after.isSupervisor ? "Yes" : "No")
  field("Is team lead", before.isTeamLead ? "Yes" : "No", after.isTeamLead ? "Yes" : "No")
  if (before.taxId !== after.taxId) out.push("Tax ID updated")
  for (const [label, key] of [["Wage", "wage"], ["Quality score", "qualityScore"], ["Rank", "rank"], ["Organization", "organization"]] as const) {
    const a = before[key] as Dated<unknown>[]
    const b = after[key] as Dated<unknown>[]
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    const added = b.filter((x) => !a.some((y) => y.from === x.from && y.value === x.value))
    out.push(added.length ? added.map((x) => `${label} → ${show(x.value)} from ${x.from}`).join("; ") : `${label} history edited`)
  }
  if (JSON.stringify(before.address) !== JSON.stringify(after.address)) out.push("Home address updated")
  if (JSON.stringify(before.sources) !== JSON.stringify(after.sources)) out.push("Data-source IDs updated")
  if (JSON.stringify(before.userFields) !== JSON.stringify(after.userFields)) out.push("User defined fields updated")
  return out
}

/** "123-45-6789" → "•••-••-6789". */
export function maskTaxId(taxId: string): string {
  const digits = taxId.replace(/\D/g, "")
  if (!digits) return ""
  return digits.length > 4 ? `•••-••-${digits.slice(-4)}` : "••••"
}

/** "Siro Sothing" → "Sothing, Siro". */
export function lastFirst(name: string): string {
  const parts = name.trim().split(/\s+/)
  return parts.length > 1 ? `${parts.at(-1)}, ${parts.slice(0, -1).join(" ")}` : name
}

/** The profile as worksheets — what Export writes and Import reads back. */
export function profileSheets(agent: Agent, p: EmployeeProfile, sources: DataSource[], asOf: string): Sheet[] {
  const cur = <T,>(h: Dated<T>[]) => valueAsOf(h, asOf)?.value ?? ""
  return [
    {
      name: "Administrative",
      rows: [
        ["Agent ID", agent.id], ["Name", agent.name], ["Job Title", p.jobTitle], ["Start Date", p.startDate],
        ["End Date", p.endDate ?? ""], ["Is Supervisor", p.isSupervisor ? "Yes" : "No"], ["Is Team Lead", p.isTeamLead ? "Yes" : "No"],
        ["Employee Type", p.employeeType], ["Employee Number", p.employeeNumber], ["Wage Amount", cur(p.wage)],
        ["Quality Score", cur(p.qualityScore)], ["Rank", cur(p.rank)], ["Organization", cur(p.organization)],
        ["Supervisor", p.supervisor], ["Team Lead", p.teamLead], ["As of", asOf],
      ].map(([Field, Value]) => ({ Field, Value })),
    },
    {
      name: "Data sources",
      rows: sources.map((s) => {
        const l = p.sources[s.id] ?? EMPTY_LINK
        return { "Data Source": s.name, Kind: s.kind, "Employee ID": l.employeeId, Extension: l.extension, Enrolled: s.kind === "quality" ? (l.enabled ? "Yes" : "No") : "" }
      }),
    },
    {
      name: "Home address",
      rows: [{ "Address 1": p.address.line1, "Address 2": p.address.line2, City: p.address.city, State: p.address.state, "Postal code": p.address.postalCode, Country: p.address.country }],
    },
    { name: "User defined fields", rows: p.userFields.map((f) => ({ Field: f.label, Value: f.value })) },
  ]
}
