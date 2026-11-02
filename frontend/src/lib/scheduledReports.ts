// Scheduled report emails (/api/v1/reports/scheduled).
import { api } from "@/lib/api"

export type Frequency = "daily" | "weekly" | "mtd"
export const FREQUENCY: Record<Frequency, { label: string; covers: string }> = {
  daily: { label: "Daily", covers: "Covers yesterday" },
  weekly: { label: "Weekly", covers: "Covers the last 7 days" },
  mtd: { label: "MTD", covers: "Covers this month so far" },
}
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

export interface ScheduleInput {
  name: string
  frequency: Frequency
  weekdays: number[]
  send_time: string
  timezone: string
  lob: string
  to_recipients: string[]
  cc_recipients: string[]
  active: boolean
}
export interface ReportSchedule extends ScheduleInput {
  id: string
  next_run_at: string | null
  last_run_at: string | null
  last_status: string
}
export interface RecipientList {
  id: string
  name: string
  emails: string[]
}
export interface ReportRun {
  id: string
  trigger: string
  period_start: string
  period_end: string
  to_recipients: string[]
  cc_recipients: string[]
  status: "sent" | "failed"
  error: string
  created_at: string
}

export const blankSchedule = (timezone: string): ScheduleInput => ({
  name: "", frequency: "daily", weekdays: [0, 1, 2, 3, 4], send_time: "08:00", timezone, lob: "", to_recipients: [], cc_recipients: [], active: true,
})

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/

/** Split pasted text (commas, semicolons, spaces, new lines; "Name <a@b.c>" too) into addresses. */
export function parseEmails(text: string): { valid: string[]; invalid: string[] } {
  const parts = text.split(/[,;\n\r]+/).map((x) => x.trim()).filter(Boolean)
  const valid: string[] = []
  const invalid: string[] = []
  for (const part of parts) {
    const named = part.match(/<([^>]+)>\s*$/)
    for (const piece of named ? [named[1]] : part.split(/\s+/)) (EMAIL.test(piece) ? valid : invalid).push(piece)
  }
  return { valid: [...new Set(valid)], invalid }
}

const data = <T,>(p: Promise<{ data: { data: T } }>) => p.then((r) => r.data.data)
const BASE = "/reports/scheduled"

export const reportsApi = {
  status: () => data<{ configured: boolean; provider: string; from: string }>(api.get(`${BASE}/status`)),
  list: () => data<ReportSchedule[]>(api.get(BASE)),
  create: (body: ScheduleInput) => data<ReportSchedule>(api.post(BASE, body)),
  update: (id: string, body: ScheduleInput) => data<ReportSchedule>(api.put(`${BASE}/${id}`, body)),
  remove: (id: string) => data<unknown>(api.delete(`${BASE}/${id}`)),
  send: (id: string) => data<ReportRun>(api.post(`${BASE}/${id}/send`)),
  runs: (id: string) => data<ReportRun[]>(api.get(`${BASE}/${id}/runs`)),
  preview: (params: { frequency: Frequency; lob: string; name: string; timezone: string }) =>
    data<{ subject: string; html: string }>(api.get(`${BASE}/preview`, { params })),
  lists: () => data<RecipientList[]>(api.get(`${BASE}/lists`)),
  createList: (body: { name: string; emails: string[] }) => data<RecipientList>(api.post(`${BASE}/lists`, body)),
  updateList: (id: string, body: { name: string; emails: string[] }) => data<RecipientList>(api.put(`${BASE}/lists/${id}`, body)),
  deleteList: (id: string) => data<unknown>(api.delete(`${BASE}/lists/${id}`)),
}
