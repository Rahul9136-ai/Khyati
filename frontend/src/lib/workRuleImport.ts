// Bulk work rules — an Excel / CSV file (or rows pasted from Excel) with:
//   "Work rules" sheet: Name · Shift Hours · Breaks · Week Off · Week Off Type · Usual Start
//   "Agents" sheet:     Agent ID · Agent Name · Work Rule · Start · Week Off · Week Off Type
// Rules are matched by name (updated) or created; agents get their rule,
// start time and week off. Every row is validated before anything changes.
import * as XLSX from "xlsx"

import { hhmm, pick } from "@/lib/schedule"
import { fmtDuration } from "@/lib/domain/labourLaw"
import type { Agent } from "@/lib/domain/types"
import {
  describeBreaks,
  describeWeekOff,
  parseWorkRulePatternId,
  WEEK_OFF_PRESETS,
  WEEKDAYS,
  type BreakStep,
  type WeekOffMode,
  type WorkRule,
} from "@/lib/domain/workRules"

export type RuleDraft = Omit<WorkRule, "id">

export interface RuleImportRow {
  row: number
  name: string
  ok: boolean
  reason?: string
  rule?: RuleDraft
  /** Id of the existing rule with this name (updated), else a new rule. */
  existingId?: string
}

export interface AgentImportRow {
  row: number
  agentCell: string
  agent?: Agent
  ok: boolean
  reason?: string
  /** Rule name as written (matched against existing + imported rules). */
  ruleName?: string
  /** null = take the agent off any rule; undefined = leave the rule as is. */
  ruleId?: string | null
  start?: string
  weekOff?: number[]
  weekOffMode?: WeekOffMode
  summary?: string
}

const DAY_WORDS: Record<string, number> = {
  mon: 0, monday: 0, tue: 1, tues: 1, tuesday: 1, wed: 2, wednesday: 2, thu: 3, thur: 3, thurs: 3, thursday: 3,
  fri: 4, friday: 4, sat: 5, saturday: 5, sun: 6, sunday: 6,
}
const dayOf = (w: string) => DAY_WORDS[w.toLowerCase().replace(/\./g, "")]

/** "Sat, Sun" · "Sat-Sun" · "Fri–Sun" · "Saturday Sunday" · "Fixed Sat–Sun" ·
 *  "Rotating Sat, Sun" · "none". Returns the days and, if the cell says, the type. */
export function parseWeekOff(cell: unknown): { days: number[]; mode?: WeekOffMode } | { error: string } {
  const raw = String(cell ?? "").trim()
  if (!raw || /^(none|no|-|0|nil)$/i.test(raw)) return { days: [] }
  const preset = WEEK_OFF_PRESETS.find((p) => p.label.toLowerCase() === raw.toLowerCase() || p.id === raw.toLowerCase())
  if (preset) return { days: [...preset.days], mode: preset.mode }
  let s = raw.toLowerCase()
  let mode: WeekOffMode | undefined
  if (/\brotat/.test(s)) mode = "rotating"
  else if (/\bfixed\b/.test(s)) mode = "fixed"
  s = s.replace(/\b(rotating|rotation|rotate|fixed|week ?off|off|days?|from|every|week)\b/g, " ")
  const days = new Set<number>()
  for (const part of s.split(/[,;/&+]|\band\b/)) {
    const words = part.split(/\s*(?:-|–|—|\bto\b)\s*|\s+/).filter(Boolean)
    const range = part.match(/([a-z.]+)\s*(?:-|–|—|\bto\b)\s*([a-z.]+)/)
    if (range) {
      const [a, b] = [dayOf(range[1]), dayOf(range[2])]
      if (a == null || b == null) return { error: `Unknown day in "${raw}"` }
      for (let d = a; ; d = (d + 1) % 7) {
        days.add(d)
        if (d === b) break
      }
      continue
    }
    for (const w of words) {
      const d = dayOf(w)
      if (d == null) return { error: `Unknown day "${w}" in "${raw}" (use Mon, Tue … Sun)` }
      days.add(d)
    }
  }
  if (days.size === 7) return { error: "Week off can't be every day" }
  return { days: [...days].sort(), mode }
}

/** "15, 30L, 15" · "Break 15; Lunch 30; Break 15" · "15m break + 1h lunch + 15m break" · "2x15" */
export function parseBreaks(cell: unknown): BreakStep[] | { error: string } {
  const raw = String(cell ?? "").trim()
  if (!raw || /^(none|no|-|0)$/i.test(raw)) return []
  const out: BreakStep[] = []
  for (const part of raw.split(/[,;+|]/).map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    const m = part.match(/^(?:(\d+)\s*[x×*]\s*)?(?:(break|lunch|l|b)\s*)?(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)?\s*(break|breaks|lunch|lunches|l|b)?$/)
    if (!m) return { error: `Can't read break "${part}" (e.g. "15, 30L, 15" or "Break 15; Lunch 30")` }
    const [, times, before, num, unit, after] = m
    const minutes = Math.round(Number(num) * (unit && unit.startsWith("h") ? 60 : 1))
    if (minutes < 5) return { error: `Break "${part}" is shorter than 5 min` }
    const word = after ?? before ?? ""
    const type: BreakStep["type"] = word.startsWith("l") ? "lunch" : "break"
    for (let i = 0; i < Number(times ?? 1); i++) out.push({ type, minutes })
  }
  return out
}

const describeBreakCell = (breaks: BreakStep[]) => breaks.map((b) => (b.type === "lunch" ? `Lunch ${b.minutes}` : `Break ${b.minutes}`)).join("; ")
const modeOf = (cell: unknown): WeekOffMode | undefined => {
  const s = String(cell ?? "").trim().toLowerCase()
  return /^rot/.test(s) ? "rotating" : /^fix/.test(s) ? "fixed" : undefined
}

export function resolveRuleRows(rows: Record<string, unknown>[], existing: WorkRule[]): RuleImportRow[] {
  const out: RuleImportRow[] = []
  const seen = new Set<string>()
  rows.forEach((r, i) => {
    const row = i + 2
    const name = String(pick(r, ["name", "rule", "workrule", "rulename"]) ?? "").trim()
    const hoursCell = pick(r, ["shifthours", "hours", "length", "shiftlength", "shift"])
    if (!name && !String(hoursCell ?? "").trim()) return
    if (!name) return void out.push({ row, name, ok: false, reason: "Missing rule name" })
    const key = name.toLowerCase()
    if (seen.has(key)) return void out.push({ row, name, ok: false, reason: `"${name}" appears twice in the file` })
    seen.add(key)
    const hours = Number(String(hoursCell ?? "").replace(/h(ours?)?$/i, "").trim())
    if (!Number.isFinite(hours) || hours < 1 || hours > 16) return void out.push({ row, name, ok: false, reason: `Shift hours must be 1–16 (got "${String(hoursCell)}")` })
    const shiftMinutes = Math.round(hours * 60)
    const breaks = parseBreaks(pick(r, ["breaks", "breakpattern", "break"]))
    if ("error" in breaks) return void out.push({ row, name, ok: false, reason: breaks.error })
    if (breaks.reduce((t, b) => t + b.minutes, 0) >= shiftMinutes) return void out.push({ row, name, ok: false, reason: "Breaks take up the whole shift" })
    const off = parseWeekOff(pick(r, ["weekoff", "daysoff", "off", "weekoffs"]))
    if ("error" in off) return void out.push({ row, name, ok: false, reason: off.error })
    const startCell = pick(r, ["usualstart", "start", "defaultstart", "starttime"])
    const start = hhmm(startCell)
    if (String(startCell ?? "").trim() && !start) return void out.push({ row, name, ok: false, reason: `Can't read start time "${String(startCell)}" (use HH:MM)` })
    const match = existing.find((x) => x.name.toLowerCase() === key || x.id.toLowerCase() === key)
    out.push({
      row,
      name,
      ok: true,
      existingId: match?.id,
      rule: {
        name,
        shiftMinutes,
        breaks,
        weekOff: off.days,
        weekOffMode: modeOf(pick(r, ["weekofftype", "offtype", "type", "mode"])) ?? off.mode ?? "fixed",
        defaultStart: start ?? match?.defaultStart ?? "09:00",
      },
    })
  })
  return out
}

/** Agents rows, matched against the roster and the rules (existing + this file's). */
export function resolveAgentRows(rows: Record<string, unknown>[], agents: Agent[], rules: { id: string; name: string; rule: RuleDraft }[]): AgentImportRow[] {
  const out: AgentImportRow[] = []
  const seen = new Set<string>()
  rows.forEach((r, i) => {
    const row = i + 2
    const agentCell = String(pick(r, ["agentid", "id", "eid", "employeeid", "agent", "name", "agentname"]) ?? "").trim()
    const ruleCell = String(pick(r, ["workrule", "rule", "pattern", "workpattern"]) ?? "").trim()
    const offCell = pick(r, ["weekoff", "daysoff", "off", "weekoffs"])
    const typeCell = pick(r, ["weekofftype", "offtype", "type", "mode"])
    const startCell = pick(r, ["start", "starttime", "shiftstart"])
    if (!agentCell && !ruleCell && !String(offCell ?? "").trim()) return
    if (!ruleCell && !String(offCell ?? "").trim() && !String(typeCell ?? "").trim()) return // nothing to change on this row

    const lc = agentCell.toLowerCase()
    const agent = agents.find((a) => a.id.toLowerCase() === lc) ?? agents.find((a) => a.name.toLowerCase() === lc)
    if (!agent) return void out.push({ row, agentCell, ok: false, reason: `Unknown agent "${agentCell}"` })
    if (seen.has(agent.id)) return void out.push({ row, agentCell, agent, ok: false, reason: `${agent.name} appears twice in the file` })
    seen.add(agent.id)

    let ruleId: string | null | undefined
    let rule: RuleDraft | undefined
    if (/^(none|no rule|-)$/i.test(ruleCell)) ruleId = null
    else if (ruleCell) {
      const m = rules.find((x) => x.name.toLowerCase() === ruleCell.toLowerCase() || x.id.toLowerCase() === ruleCell.toLowerCase())
      if (!m) return void out.push({ row, agentCell, agent, ok: false, reason: `Unknown work rule "${ruleCell}" (add it on the Work rules sheet)` })
      ruleId = m.id
      rule = m.rule
    } else {
      // Keep their current rule (if any) for the start-time default below.
      const ref = parseWorkRulePatternId(agent.shiftPatternId)
      const cur = ref && rules.find((x) => x.id === ref.ruleId)
      if (cur) rule = cur.rule
    }

    const start = hhmm(startCell)
    if (String(startCell ?? "").trim() && !start) return void out.push({ row, agentCell, agent, ok: false, reason: `Can't read start time "${String(startCell)}" (use HH:MM)` })
    if (start && ruleId === null) return void out.push({ row, agentCell, agent, ok: false, reason: "A start time needs a work rule" })

    let weekOff: number[] | undefined
    let weekOffMode: WeekOffMode | undefined = modeOf(typeCell)
    if (String(offCell ?? "").trim()) {
      const off = parseWeekOff(offCell)
      if ("error" in off) return void out.push({ row, agentCell, agent, ok: false, reason: off.error })
      weekOff = off.days
      weekOffMode = weekOffMode ?? off.mode
    } else if (ruleId) {
      weekOff = rule!.weekOff // a new rule without a week off brings the rule's usual days
      weekOffMode = weekOffMode ?? rule!.weekOffMode
    } else if (weekOffMode) {
      weekOff = agent.weekOff ?? []
    }
    const ref = parseWorkRulePatternId(agent.shiftPatternId)
    const finalStart = ruleId ? (start ?? (ref?.ruleId === ruleId ? ref.start : rule!.defaultStart)) : ruleId === undefined && start && ref ? start : undefined
    if (start && ruleId === undefined && !ref) return void out.push({ row, agentCell, agent, ok: false, reason: "A start time needs a work rule" })
    const mode = weekOffMode ?? agent.weekOffMode ?? "fixed"
    const parts = [
      ruleId === null ? "No rule" : ruleId ? `${rules.find((x) => x.id === ruleId)!.name} from ${finalStart}` : finalStart ? `Start ${finalStart}` : null,
      weekOff ? `week off ${describeWeekOff(weekOff, mode)}` : null,
    ].filter(Boolean)
    out.push({ row, agentCell, agent, ok: true, ruleName: ruleCell || undefined, ruleId, start: finalStart, weekOff, weekOffMode: weekOff ? mode : undefined, summary: parts.join(" · ") })
  })
  return out
}

/** Read every sheet; a sheet with Shift Hours / Breaks columns is the rules
 *  sheet, one with an agent column is the agents sheet. Also takes text
 *  pasted from Excel (tab-separated) or CSV. */
export function readWorkbook(wb: XLSX.WorkBook): { rules: Record<string, unknown>[]; agents: Record<string, unknown>[] } {
  const res = { rules: [] as Record<string, unknown>[], agents: [] as Record<string, unknown>[] }
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[name], { defval: "" })
    if (!rows.length) continue
    const cols = Object.keys(rows[0]).map((k) => k.toLowerCase().replace(/[^a-z]/g, ""))
    if (cols.some((c) => ["agentid", "agent", "agentname", "eid", "employeeid"].includes(c))) res.agents.push(...rows)
    else if (cols.some((c) => ["shifthours", "breaks", "breakpattern"].includes(c))) res.rules.push(...rows)
  }
  return res
}

export async function readWorkRuleFile(file: File) {
  return readWorkbook(XLSX.read(await file.arrayBuffer(), { cellDates: false }))
}

export function readPastedRows(text: string) {
  return readWorkbook(XLSX.read(text.trim(), { type: "string", raw: true }))
}

/** Template pre-filled with today's rules and every agent's current setup —
 *  edit and upload it back. */
export function downloadWorkRuleTemplate(agents: Agent[], rules: WorkRule[]) {
  const ruleSheet = XLSX.utils.json_to_sheet(
    rules.map((r) => ({
      Name: r.name,
      "Shift Hours": r.shiftMinutes / 60,
      Breaks: describeBreakCell(r.breaks),
      "Week Off": r.weekOff.map((d) => WEEKDAYS[d]).join(", "),
      "Week Off Type": r.weekOffMode === "rotating" ? "Rotating" : "Fixed",
      "Usual Start": r.defaultStart,
      "Worked (info)": `${fmtDuration(r.shiftMinutes - r.breaks.reduce((t, b) => t + b.minutes, 0))} · ${describeBreaks(r.breaks)}`,
    })),
  )
  ruleSheet["!cols"] = [{ wch: 38 }, { wch: 11 }, { wch: 32 }, { wch: 14 }, { wch: 14 }, { wch: 11 }, { wch: 36 }]
  const agentSheet = XLSX.utils.json_to_sheet(
    agents.map((a) => {
      const ref = parseWorkRulePatternId(a.shiftPatternId)
      return {
        "Agent ID": a.id,
        "Agent Name": a.name,
        Team: a.team,
        "Work Rule": (ref && rules.find((r) => r.id === ref.ruleId)?.name) ?? "",
        Start: ref?.start ?? "",
        "Week Off": a.weekOff ? (a.weekOff.length ? a.weekOff.map((d) => WEEKDAYS[d]).join(", ") : "none") : "",
        "Week Off Type": a.weekOff ? (a.weekOffMode === "rotating" ? "Rotating" : "Fixed") : "",
      }
    }),
  )
  agentSheet["!cols"] = [{ wch: 9 }, { wch: 18 }, { wch: 10 }, { wch: 38 }, { wch: 7 }, { wch: 14 }, { wch: 14 }]
  const help = XLSX.utils.json_to_sheet([
    { Column: "Shift Hours", Example: "8 or 8.5", Notes: "Shift length including breaks, 1–16 hours" },
    { Column: "Breaks", Example: "Break 15; Lunch 30; Break 15", Notes: 'In the order taken. Also "15, 30L, 15", "2x15 + 1h lunch". Spread evenly through the shift' },
    { Column: "Week Off", Example: "Sat, Sun", Notes: 'Days or a range ("Fri-Sun"), a preset ("Fixed Sat–Sun"), or "none"' },
    { Column: "Week Off Type", Example: "Fixed", Notes: "Fixed = same days every week · Rotating = the days move one day later each week" },
    { Column: "Work Rule (Agents)", Example: "9h · 1h lunch + 2×15m breaks", Notes: 'A rule name from the Work rules sheet or the app; "none" takes the agent off their rule' },
    { Column: "Start (Agents)", Example: "08:30", Notes: "Shift start; blank = the rule's usual start" },
    { Column: "Blank cells", Example: "", Notes: "Agents with no Work Rule and no Week Off are left as they are" },
    ...WEEK_OFF_PRESETS.map((p) => ({ Column: "Week off preset", Example: p.label, Notes: describeWeekOff(p.days, p.mode) })),
  ])
  help["!cols"] = [{ wch: 20 }, { wch: 40 }, { wch: 90 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ruleSheet, "Work rules")
  XLSX.utils.book_append_sheet(wb, agentSheet, "Agents")
  XLSX.utils.book_append_sheet(wb, help, "How to fill")
  XLSX.writeFile(wb, "wfm-work-rules-bulk.xlsx")
}
