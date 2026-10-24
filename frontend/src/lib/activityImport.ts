// Bulk activity import — Excel (.xlsx / .csv) rows of
// Agent · Activity · Start · End (or Full shift) · Note, validated per row.
import * as XLSX from "xlsx"

import {
  ACTIVITIES,
  ACTIVITY_BY_ID,
  proposeActivity,
  toMins,
  type ActivityPlan,
  type ActivitySegment,
  type ActivityType,
} from "@/lib/domain/channels"
import type { Agent } from "@/lib/domain/types"
import { hhmm, pick } from "@/lib/schedule"

export interface ActivityImportRow {
  /** Spreadsheet row number (header is row 1). */
  row: number
  agentCell: string
  agent?: Agent
  type?: ActivityType
  ok: boolean
  reason?: string
  segment?: Omit<ActivitySegment, "id">
}

/** Accepts an activity id, label or code, plus common AUX wording. */
export function matchActivityType(cell: unknown): ActivityType | undefined {
  const s = String(cell ?? "").trim().toLowerCase()
  if (!s) return undefined
  const direct = ACTIVITIES.find((a) => a.id === s || a.label.toLowerCase() === s || a.short.toLowerCase() === s)
  if (direct) return direct.id
  if (/meet|huddle|aux3/.test(s)) return "meeting"
  if (/train|aux4|nesting/.test(s)) return "training"
  if (/coach|1:1|one.?to.?one|aux5/.test(s)) return "coaching"
  if (/leave|loa/.test(s)) return "loa"
  if (/absen|sick|no.?show|unplanned/.test(s)) return "absence"
  return undefined
}

const truthy = (v: unknown) => /^(y|yes|true|1|full|full shift)$/i.test(String(v ?? "").trim())

/** Validate spreadsheet rows against the roster and existing activities.
 *  Rows earlier in the file count as existing for later rows (no self-clashes). */
export function resolveActivityRows(rows: Record<string, unknown>[], agents: Agent[], plan: ActivityPlan): ActivityImportRow[] {
  const accepted: ActivityPlan = {}
  const out: ActivityImportRow[] = []
  rows.forEach((r, i) => {
    const row = i + 2
    const agentCell = String(pick(r, ["agentid", "id", "eid", "agent", "name", "agentname"]) ?? "").trim()
    const typeCell = pick(r, ["activity", "aux", "auxcode", "type", "code"])
    if (!agentCell && !String(typeCell ?? "").trim()) return // blank line / unused template row
    if (!String(typeCell ?? "").trim()) return // template row left without an activity

    const lc = agentCell.toLowerCase()
    const agent = agents.find((a) => a.id.toLowerCase() === lc) ?? agents.find((a) => a.name.toLowerCase() === lc)
    if (!agent) return void out.push({ row, agentCell, ok: false, reason: `Unknown agent "${agentCell}"` })
    const type = matchActivityType(typeCell)
    if (!type) return void out.push({ row, agentCell, agent, ok: false, reason: `Unknown activity "${String(typeCell)}" (use ${ACTIVITIES.map((a) => a.label).join(" / ")})` })

    const start = hhmm(pick(r, ["start", "starttime", "from"]))
    const end = hhmm(pick(r, ["end", "endtime", "to"]))
    const full = truthy(pick(r, ["fullshift", "fullday", "allday"])) || (!start && !end && !!ACTIVITY_BY_ID[type].fullShift)
    if (!full && (!start || !end)) return void out.push({ row, agentCell, agent, type, ok: false, reason: "Missing start/end time (or set Full Shift = Y)" })

    const note = String(pick(r, ["note", "notes", "comment", "description"]) ?? "").trim() || undefined
    const existing = [...(plan[agent.id] ?? []), ...(accepted[agent.id] ?? [])]
    const p = proposeActivity(agent, existing, { type, fullShift: full, start: start ? toMins(start) : undefined, end: end ? toMins(end) : undefined, note })
    if (!p.ok) return void out.push({ row, agentCell, agent, type, ok: false, reason: p.reason })
    accepted[agent.id] = [...(accepted[agent.id] ?? []), { ...p.segment, id: `row${row}` }]
    out.push({ row, agentCell, agent, type, ok: true, segment: p.segment })
  })
  return out
}

export async function readActivityFile(file: File): Promise<Record<string, unknown>[]> {
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: false })
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: "" })
}

/** Template pre-filled with every agent (fill Activity on the rows you need;
 *  copy a row to give someone several activities). */
export function downloadActivityTemplate(agents: Agent[]) {
  const data = agents.map((a, i) => ({
    "Agent ID": a.id,
    "Agent Name": a.name,
    Team: a.team,
    Shift: a.shift,
    Activity: i === 0 ? "Meeting" : "",
    Start: i === 0 ? "10:00" : "",
    End: i === 0 ? "10:30" : "",
    "Full Shift (Y/N)": "",
    Note: i === 0 ? "Example — clear or overwrite" : "",
  }))
  const ws = XLSX.utils.json_to_sheet(data)
  ws["!cols"] = [{ wch: 9 }, { wch: 18 }, { wch: 9 }, { wch: 12 }, { wch: 12 }, { wch: 7 }, { wch: 7 }, { wch: 15 }, { wch: 28 }]
  const help = XLSX.utils.json_to_sheet([
    ...ACTIVITIES.map((a) => ({ Activity: a.label, Code: a.short, "Default": a.fullShift ? "Full shift if no times" : "Needs Start/End" })),
  ])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "Activities")
  XLSX.utils.book_append_sheet(wb, help, "Activity codes")
  XLSX.writeFile(wb, "wfm-activity-bulk-template.xlsx")
}
