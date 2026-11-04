// Import an employee profile from Excel / CSV — the same layout Export writes
// (lib/domain/employeeProfile.ts profileSheets): an "Administrative" sheet of
// Field / Value rows and a "Data sources" sheet of Data Source / Employee ID /
// Extension / Enrolled. A CSV (one sheet) is read as whichever of the two its
// columns match. Changed wage / quality / rank / organisation values take
// effect from the profile's "as of" date.
import * as XLSX from "xlsx"

import {
  EMPLOYEE_TYPES,
  EMPTY_LINK,
  JOB_TITLES,
  setEffective,
  valueAsOf,
  type DataSource,
  type Dated,
  type EmployeeProfile,
} from "@/lib/domain/employeeProfile"
import { isISODate } from "@/lib/domain/horizon"

type Raw = Record<string, unknown>
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
const str = (v: unknown) => (v == null ? "" : String(v).trim())
const yes = (v: unknown) => ["yes", "y", "true", "1", "x"].includes(str(v).toLowerCase())
const pick = (row: Raw, names: string[]) => {
  for (const [k, v] of Object.entries(row)) if (names.includes(key(k))) return v
  return undefined
}

export interface ProfileImportResult {
  profile: EmployeeProfile
  changed: string[]
  errors: string[]
}

export function applyProfileRows(
  profile: EmployeeProfile,
  admin: Raw[],
  sourceRows: Raw[],
  sources: DataSource[],
  asOf: string,
): ProfileImportResult {
  let p: EmployeeProfile = { ...profile, sources: { ...profile.sources } }
  const changed: string[] = []
  const errors: string[] = []
  const fields = new Map(admin.map((r) => [key(str(pick(r, ["field"]))), str(pick(r, ["value"]))]))
  const text = (name: string) => fields.get(key(name))

  const jobTitle = text("Job Title")
  if (jobTitle) {
    const match = JOB_TITLES.find((t) => t.toLowerCase() === jobTitle.toLowerCase())
    if (match) p = { ...p, jobTitle: match }
    else errors.push(`"${jobTitle}" isn't a job title — use one of ${JOB_TITLES.join(", ")}.`)
  }
  const type = text("Employee Type")
  if (type) {
    const match = EMPLOYEE_TYPES.find((t) => t.toLowerCase() === type.toLowerCase())
    if (match) p = { ...p, employeeType: match }
    else errors.push(`"${type}" isn't an employee type — use one of ${EMPLOYEE_TYPES.join(", ")}.`)
  }
  for (const [name, field] of [["Start Date", "startDate"], ["End Date", "endDate"]] as const) {
    const v = text(name)
    if (v === undefined) continue
    if (!v && field === "endDate") p = { ...p, endDate: null }
    else if (isISODate(v)) p = { ...p, [field]: v }
    else errors.push(`${name} "${v}" isn't a date (use YYYY-MM-DD).`)
  }
  for (const [name, field] of [["Employee Number", "employeeNumber"], ["Supervisor", "supervisor"], ["Team Lead", "teamLead"]] as const) {
    const v = text(name)
    if (v !== undefined) p = { ...p, [field]: v }
  }
  for (const [name, field] of [["Is Supervisor", "isSupervisor"], ["Is Team Lead", "isTeamLead"]] as const) {
    const v = text(name)
    if (v !== undefined) p = { ...p, [field]: yes(v) }
  }
  const dated = <T,>(name: string, field: "wage" | "qualityScore" | "rank" | "organization", parse: (v: string) => T | null) => {
    const v = text(name)
    if (!v) return
    const value = parse(v)
    if (value === null) return errors.push(`${name} "${v}" isn't valid.`)
    const history = p[field] as Dated<T>[]
    if (valueAsOf(history, asOf)?.value !== value) p = { ...p, [field]: setEffective(history, value, asOf) }
  }
  const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : null)
  dated("Wage Amount", "wage", num)
  dated("Quality Score", "qualityScore", num)
  dated("Rank", "rank", num)
  dated("Organization", "organization", (v) => v)

  for (const row of sourceRows) {
    const name = str(pick(row, ["datasource", "source"]))
    if (!name) continue
    const src = sources.find((s) => s.name.toLowerCase() === name.toLowerCase())
    if (!src) {
      errors.push(`Data source "${name}" isn't set up — add it on the profile first.`)
      continue
    }
    const link = { ...EMPTY_LINK, ...p.sources[src.id] }
    const id = pick(row, ["employeeid", "id"])
    const ext = pick(row, ["extension", "ext"])
    const enrolled = pick(row, ["enrolled", "enabled"])
    if (id !== undefined) link.employeeId = str(id)
    if (ext !== undefined && src.kind === "phone") link.extension = str(ext)
    if (enrolled !== undefined && src.kind === "quality") link.enabled = yes(enrolled)
    p.sources[src.id] = link
  }

  for (const k of Object.keys(p) as (keyof EmployeeProfile)[]) {
    if (JSON.stringify(p[k]) !== JSON.stringify(profile[k])) changed.push(k)
  }
  return { profile: p, changed, errors }
}

export async function parseProfileFile(
  file: File,
  profile: EmployeeProfile,
  sources: DataSource[],
  asOf: string,
): Promise<ProfileImportResult> {
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: false, raw: false })
  const sheet = (name: string) => {
    const ws = wb.Sheets[wb.SheetNames.find((n) => key(n) === key(name)) ?? ""]
    return ws ? XLSX.utils.sheet_to_json<Raw>(ws, { defval: "", raw: false }) : null
  }
  let admin = sheet("Administrative") ?? []
  let rows = sheet("Data sources") ?? []
  if (!admin.length && !rows.length) {
    const only = XLSX.utils.sheet_to_json<Raw>(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false })
    if (only.some((r) => pick(r, ["datasource", "source"]) !== undefined)) rows = only
    else admin = only
  }
  return applyProfileRows(profile, admin, rows, sources, asOf)
}
