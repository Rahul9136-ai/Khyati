import { api } from "@/lib/api"

/** Slack/Teams approval-bridge API client + types (backend module: integrations). */

export type ApprovalSource = "intraday" | "scheduling"
export type ApprovalStatus =
  | "pending" | "approved" | "rejected" | "applied" | "failed" | "expired" | "cancelled"
export type Channel = "slack" | "teams" | "in_app"

export interface ApprovalEvent {
  at: string
  type: string
  channel: string | null
  actor_email: string
  detail: string
}

export interface Approval {
  id: string
  source: ApprovalSource
  kind: string
  title: string
  summary: string
  payload: Record<string, unknown>
  status: ApprovalStatus
  channel: string
  approver_role: string
  assigned_om_id: string | null
  employee_id: string | null
  queue_id: string | null
  requested_by: string | null
  external_refs: Record<string, unknown>
  decided_by: string | null
  decided_via: string | null
  decided_at: string | null
  decision_note: string | null
  applied_at: string | null
  apply_result: Record<string, unknown> | null
  created_at: string
  events?: ApprovalEvent[]
}

export interface IntegrationConfig {
  slack_enabled: boolean
  slack_configured: boolean
  slack_channel: string
  slack_webhook_set: boolean
  slack_bot_token_set: boolean
  slack_signing_secret_set: boolean
  teams_enabled: boolean
  teams_configured: boolean
  teams_webhook_set: boolean
  teams_security_token_set: boolean
  default_approver_id: string | null
  auto_apply_on_approve: boolean
  any_channel_live: boolean
}

export interface ConfigPatch {
  slack_enabled?: boolean
  slack_webhook_url?: string
  slack_bot_token?: string
  slack_signing_secret?: string
  slack_channel?: string
  teams_enabled?: boolean
  teams_webhook_url?: string
  teams_security_token?: string
  auto_apply_on_approve?: boolean
}

export interface RaiseApproval {
  source: ApprovalSource
  kind: string
  title: string
  summary?: string
  payload?: Record<string, unknown>
  channels?: Channel[]
}

// Kinds the UI offers per source (mirrors the backend's KINDS catalogue).
export const KINDS_BY_SOURCE: Record<ApprovalSource, { value: string; label: string }[]> = {
  intraday: [
    { value: "overtime", label: "Overtime offer" },
    { value: "vto", label: "Voluntary time off (VTO)" },
    { value: "reforecast_publish", label: "Publish intraday reforecast" },
    { value: "break_recovery", label: "Break recovery (recall)" },
    { value: "skill_rebalance", label: "Skill re-balance" },
  ],
  scheduling: [
    { value: "shift_change", label: "Shift change" },
    { value: "break_move", label: "Break move" },
    { value: "shift_swap", label: "Shift swap" },
    { value: "extra_shift", label: "Extra shift" },
  ],
}

export async function listApprovals(params?: { status?: string; source?: string }) {
  const res = await api.get("/integrations/approvals", { params: { size: 200, ...params } })
  return res.data.data.items as Approval[]
}

export async function getApproval(id: string) {
  return (await api.get(`/integrations/approvals/${id}`)).data.data as Approval
}

export async function raiseApproval(body: RaiseApproval) {
  return (await api.post("/integrations/approvals", body)).data.data as Approval
}

export async function decideApproval(id: string, approve: boolean, note?: string) {
  return (
    await api.post(`/integrations/approvals/${id}/decision`, { approve, note })
  ).data.data as Approval
}

export async function getConfig() {
  return (await api.get("/integrations/config")).data.data as IntegrationConfig
}

export async function updateConfig(patch: ConfigPatch) {
  return (await api.put("/integrations/config", patch)).data.data as IntegrationConfig
}

export async function testDispatch() {
  return (await api.post("/integrations/config/test", {})).data.data as {
    results: { channel: string; ok: boolean; simulated: boolean; detail: string }[]
  }
}
