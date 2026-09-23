import { api } from "@/lib/api"
import type { RaiseApproval } from "@/lib/integrations"
import type { ApprovalSource } from "@/lib/integrations"

/** Schedule-change request parser (backend: POST /ai/parse-schedule-request) and how a
 * parsed request becomes an Operations Manager approval. */

export const SCHEDULE_ACTIONS = [
  "Mark Leave", "Shift Swap", "Change Shift Timing", "Mark Absence", "Cancel Leave", "Other",
] as const
export type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number]
export type Confidence = "High" | "Medium" | "Low"

/** The parser's output contract — the exact fields, in this order. */
export interface ParsedRequest {
  employee_name: string | null
  employee_id: string | null
  action: ScheduleAction
  date_or_week: string | null
  field_to_change: string
  new_value: string
  raw_message: string
  confidence: Confidence
}

export interface MatchedEmployee {
  id: string
  employee_code: string
  name: string
  team_id: string | null
}

export interface ParseResult {
  parsed: ParsedRequest
  parser: "claude" | "rules"
  matched_employee: MatchedEmployee | null
}

export async function parseScheduleRequest(message: string, currentDate: string): Promise<ParseResult> {
  const res = await api.post("/ai/parse-schedule-request", { message, current_date: currentDate })
  return res.data.data as ParseResult
}

// Default schedule field + value for each action (mirrors the backend parser).
export const FIELD_FOR_ACTION: Record<ScheduleAction, string> = {
  "Mark Leave": "Planned Leave (HC)",
  "Cancel Leave": "Planned Leave (HC)",
  "Mark Absence": "Absence & Sickness (HC)",
  "Change Shift Timing": "Shift Length (Hours)",
  "Shift Swap": "Shift Assignment",
  Other: "",
}
export const DEFAULT_VALUE_FOR_ACTION: Record<ScheduleAction, string> = {
  "Mark Leave": "1",
  "Mark Absence": "1",
  "Cancel Leave": "0",
  "Change Shift Timing": "",
  "Shift Swap": "",
  Other: "",
}

// Approval kind each action is raised as (must exist in the backend's KINDS).
export const KIND_FOR_ACTION: Record<ScheduleAction, string> = {
  "Mark Leave": "leave_mark",
  "Cancel Leave": "leave_cancel",
  "Mark Absence": "absence_mark",
  "Change Shift Timing": "shift_change",
  "Shift Swap": "shift_swap",
  Other: "schedule_request",
}

export function approvalFromRequest(
  p: ParsedRequest,
  source: ApprovalSource,
  opts: { parser: ParseResult["parser"]; employeeUuid?: string | null },
): RaiseApproval {
  const who = [p.employee_name, p.employee_id && `(${p.employee_id})`].filter(Boolean).join(" ")
  const title = `${p.action} — ${who || "employee"}${p.date_or_week ? ` · ${p.date_or_week}` : ""}`.slice(0, 200)
  const summary = [
    `Requested by message: "${p.raw_message.trim()}"`,
    `Employee: ${who || "—"}`,
    `Action: ${p.action}${p.date_or_week ? ` on ${p.date_or_week}` : ""}`,
    p.field_to_change ? `Change: ${p.field_to_change} → ${p.new_value || "(no value)"}` : null,
    `Parsed by ${opts.parser === "claude" ? "Claude" : "rules"} · confidence ${p.confidence}`,
  ].filter(Boolean).join("\n")
  return {
    source,
    kind: KIND_FOR_ACTION[p.action],
    title,
    summary,
    employee_id: opts.employeeUuid ?? undefined,
    payload: {
      employee_code: p.employee_id,
      employee_name: p.employee_name,
      action: p.action,
      date_or_week: p.date_or_week,
      field_to_change: p.field_to_change,
      new_value: p.new_value,
      raw_message: p.raw_message,
      confidence: p.confidence,
      parser: opts.parser,
      raised_from: source === "intraday" ? "realtime" : "scheduling",
    },
  }
}

export function apiErrorMessage(e: unknown): string {
  const r = e as { response?: { data?: { error?: { message?: string }; detail?: unknown } }; message?: string }
  return r.response?.data?.error?.message ?? (typeof r.response?.data?.detail === "string" ? r.response.data.detail : undefined) ?? r.message ?? "Something went wrong"
}
