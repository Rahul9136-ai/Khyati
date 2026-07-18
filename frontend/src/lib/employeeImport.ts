// Bulk employee onboarding — Excel (.xlsx) / CSV import that creates real
// backend accounts (Employee roster row + linked User login, real hashed
// password) via POST /employees/bulk-import. Parsing happens client-side
// with the same `xlsx` library and tolerant-column pattern as lib/schedule.ts,
// so validation errors are attributed to the exact spreadsheet row before
// anything is sent to the server.
import * as XLSX from "xlsx"

import { SERVER_ROLE_MAP } from "@/lib/auth"

export const VALID_ROLES = Object.keys(SERVER_ROLE_MAP)

export interface EmployeeImportRow {
  employee_code?: string
  first_name: string
  last_name?: string
  email: string
  team?: string
  role: string
  employment_type?: string
  weekly_hours?: number
  hire_date?: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EMPLOYMENT_TYPES = new Set(["full_time", "part_time", "contract"])

// Tolerant column lookup (case/spacing/punctuation-insensitive) — same
// approach as schedule.ts's `pick()`.
function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of Object.keys(row)) {
    const norm = k.toLowerCase().replace(/[^a-z]/g, "")
    if (keys.includes(norm)) return row[k]
  }
  return undefined
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim()
}

// Excel may hand back a day-fraction serial number for date cells.
function toISODate(v: unknown): string | undefined {
  if (v == null || v === "") return undefined
  if (typeof v === "number") {
    const epoch = new Date(Date.UTC(1899, 11, 30))
    const d = new Date(epoch.getTime() + v * 86400000)
    return d.toISOString().slice(0, 10)
  }
  const s = String(v).trim()
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined
}

function normaliseRole(v: unknown): string | null {
  const s = str(v)
  const match = VALID_ROLES.find((r) => r.toLowerCase() === s.toLowerCase())
  return match ?? null
}

function normaliseEmploymentType(v: unknown): string {
  const s = str(v).toLowerCase().replace(/[\s-]+/g, "_")
  return EMPLOYMENT_TYPES.has(s) ? s : "full_time"
}

export interface EmployeeImportParseResult {
  rows: EmployeeImportRow[]
  errors: string[]
}

export async function parseEmployeeImportFile(file: File): Promise<EmployeeImportParseResult> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { cellDates: false })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" })

  const rows: EmployeeImportRow[] = []
  const errors: string[] = []

  raw.forEach((row, i) => {
    const line = i + 2 // header is row 1
    const firstName = str(pick(row, ["firstname", "first"]))
    const email = str(pick(row, ["email", "loginemail", "workemail"])).toLowerCase()
    const roleCell = pick(row, ["role", "designation", "accessrole"])
    const role = normaliseRole(roleCell)

    if (!firstName) return errors.push(`Row ${line}: missing first name.`)
    if (!email || !EMAIL_RE.test(email)) return errors.push(`Row ${line}: missing or invalid email.`)
    if (!role) {
      return errors.push(
        `Row ${line}: "${str(roleCell) || "(blank)"}" isn't a valid role — use one of ${VALID_ROLES.join(", ")}.`,
      )
    }

    const weeklyHoursCell = pick(row, ["weeklyhours", "hoursperweek", "hours"])
    rows.push({
      employee_code: str(pick(row, ["employeecode", "empcode", "id", "employeeid"])) || undefined,
      first_name: firstName,
      last_name: str(pick(row, ["lastname", "last"])) || undefined,
      email,
      team: str(pick(row, ["team"])) || undefined,
      role,
      employment_type: normaliseEmploymentType(pick(row, ["employmenttype", "type"])),
      weekly_hours: weeklyHoursCell ? Number(weeklyHoursCell) || undefined : undefined,
      hire_date: toISODate(pick(row, ["hiredate", "startdate", "joindate"])),
    })
  })

  return { rows, errors }
}

export function downloadEmployeeImportTemplate() {
  const data = [
    {
      "Employee Code": "",
      "First Name": "Priya",
      "Last Name": "Sharma",
      Email: "priya.sharma@yourcompany.com",
      Team: "Alpha",
      Role: "Team Leader",
      "Employment Type": "full_time",
      "Weekly Hours": 40,
      "Hire Date": "",
    },
    {
      "Employee Code": "",
      "First Name": "Arjun",
      "Last Name": "Verma",
      Email: "arjun.verma@yourcompany.com",
      Team: "Alpha",
      Role: "Employee",
      "Employment Type": "full_time",
      "Weekly Hours": 40,
      "Hire Date": "",
    },
  ]
  const ws = XLSX.utils.json_to_sheet(data)
  ws["!cols"] = [
    { wch: 13 }, { wch: 14 }, { wch: 14 }, { wch: 28 }, { wch: 10 },
    { wch: 16 }, { wch: 15 }, { wch: 12 }, { wch: 11 },
  ]
  const notes = XLSX.utils.aoa_to_sheet([
    ["Employee Code and Team are optional — leave blank and a code is generated / no team is assigned."],
    ["Role must be exactly one of:"],
    ...VALID_ROLES.map((r) => [r]),
    [""],
    ["Employment Type: full_time, part_time, or contract (defaults to full_time)."],
    ["Each row creates a real login account with a generated temporary password — distribute it securely."],
  ])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "Employees")
  XLSX.utils.book_append_sheet(wb, notes, "Read me")
  XLSX.writeFile(wb, "employee-bulk-import-template.xlsx")
}
