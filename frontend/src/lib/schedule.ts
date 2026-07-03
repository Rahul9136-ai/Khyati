// Bulk schedule import / export (IEX-style) — Excel (.xlsx / .csv) roster files.
import * as XLSX from "xlsx"

import { TEAMS } from "@/lib/domain/seed"
import type { Agent, Queue } from "@/lib/domain/types"

const DASH = "–" // en-dash — matches the shift parser in planning.ts

// Map a free-text skill cell to canonical queue ids (accepts id or name).
function normaliseSkills(cell: unknown, queues: Queue[]): string[] {
  if (!cell) return []
  return String(cell)
    .split(/[,;/|]+/)
    .map((s) => s.trim().toLowerCase())
    .map((s) => {
      const q = queues.find((q) => q.id === s || q.name.toLowerCase() === s || q.name.toLowerCase().startsWith(s))
      return q?.id
    })
    .filter((x): x is string => Boolean(x))
}

// Normalise a time cell to "HH:MM" (Excel may hand back a day-fraction number).
function hhmm(v: unknown): string | null {
  if (v == null || v === "") return null
  if (typeof v === "number") {
    const mins = Math.round(v * 24 * 60)
    return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`
  }
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})/)
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null
}

// Tolerant column lookup (case/spacing/punctuation-insensitive).
function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of Object.keys(row)) {
    const norm = k.toLowerCase().replace(/[^a-z]/g, "")
    if (keys.includes(norm)) return row[k]
  }
  return undefined
}

export interface ParseResult {
  agents: Agent[]
  errors: string[]
}

export async function parseScheduleFile(file: File, queues: Queue[]): Promise<ParseResult> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { cellDates: false })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" })
  const agents: Agent[] = []
  const errors: string[] = []

  rows.forEach((row, i) => {
    const name = pick(row, ["name", "agent", "agentname", "fullname"])
    const shiftCell = pick(row, ["shift"])
    const start = hhmm(pick(row, ["shiftstart", "start", "starttime", "login"]) ?? (shiftCell ? String(shiftCell).split(/[-–—]/)[0] : ""))
    const end = hhmm(pick(row, ["shiftend", "end", "endtime", "logout"]) ?? (shiftCell ? String(shiftCell).split(/[-–—]/)[1] : ""))
    const skills = normaliseSkills(pick(row, ["skills", "skill", "queues", "queue"]), queues)
    const team = String(pick(row, ["team"]) || "Imported")

    if (!name || !start || !end) {
      errors.push(`Row ${i + 2}: missing name or shift times`)
      return
    }
    if (!skills.length) {
      errors.push(`Row ${i + 2}: no recognised skills (use ${queues.map((q) => q.name).join(" / ")})`)
      return
    }
    const tlCell = pick(row, ["tl", "teamlead", "teamleader", "supervisor"])
    agents.push({
      id: pick(row, ["agentid", "id", "eid"]) ? String(pick(row, ["agentid", "id", "eid"])) : "imp" + (i + 1),
      name: String(name),
      skills,
      shift: `${start}${DASH}${end}`,
      team,
      tl: String(tlCell || TEAMS[team]?.tl || "Unassigned"),
    })
  })

  return { agents, errors }
}

// Download a template pre-filled with the current roster for the user to edit.
export function downloadTemplate(agents: Agent[]) {
  const data = agents.map((a) => ({
    "Agent ID": a.id,
    Name: a.name,
    Skills: a.skills.join(", "),
    "Shift Start": a.shift.split(DASH)[0],
    "Shift End": a.shift.split(DASH)[1],
    Team: a.team,
    TL: a.tl ?? "",
  }))
  const ws = XLSX.utils.json_to_sheet(data)
  ws["!cols"] = [{ wch: 9 }, { wch: 18 }, { wch: 20 }, { wch: 11 }, { wch: 11 }, { wch: 10 }, { wch: 14 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "Schedule")
  XLSX.writeFile(wb, "wfm-schedule-template.xlsx")
}
