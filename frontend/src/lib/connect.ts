// API keys and webhooks for connecting a CRM or other tool (/api/v1/connect).
import { api } from "@/lib/api"

export interface ApiKey {
  id: string
  name: string
  prefix: string
  scopes: string[]
  created_by_email: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
}
export interface Webhook {
  id: string
  url: string
  description: string
  events: string[]
  active: boolean
  secret: string
  created_by_email: string
  created_at: string
  last_success_at: string | null
  last_failure_at: string | null
  consecutive_failures: number
}
export interface Delivery {
  id: string
  event_id: string
  event_type: string
  status: "pending" | "retrying" | "delivered" | "failed"
  attempts: number
  next_attempt_at: string
  last_attempt_at: string | null
  response_status: number | null
  response_body: string
  error: string
  duration_ms: number | null
  created_at: string
  payload: Record<string, unknown>
}
export interface Described {
  code?: string
  type?: string
  description: string
}

const data = <T,>(p: Promise<{ data: { data: T } }>) => p.then((r) => r.data.data)

export const API_BASE: string = api.defaults.baseURL ?? ""
export const CONNECT_KEYS = { keys: ["connect", "keys"], hooks: ["connect", "webhooks"] } as const

export const connectApi = {
  scopes: () => data<{ code: string; description: string }[]>(api.get("/connect/scopes")),
  events: () => data<{ type: string; description: string }[]>(api.get("/connect/events")),
  keys: () => data<ApiKey[]>(api.get("/connect/api-keys")),
  createKey: (body: { name: string; scopes: string[]; expires_in_days: number | null }) =>
    data<ApiKey & { key: string }>(api.post("/connect/api-keys", body)),
  revokeKey: (id: string) => data<ApiKey>(api.delete(`/connect/api-keys/${id}`)),
  hooks: () => data<Webhook[]>(api.get("/connect/webhooks")),
  createHook: (body: { url: string; description: string; events: string[] }) => data<Webhook>(api.post("/connect/webhooks", body)),
  updateHook: (id: string, body: Partial<Pick<Webhook, "url" | "description" | "events" | "active">>) =>
    data<Webhook>(api.patch(`/connect/webhooks/${id}`, body)),
  deleteHook: (id: string) => data<unknown>(api.delete(`/connect/webhooks/${id}`)),
  rotateSecret: (id: string) => data<Webhook>(api.post(`/connect/webhooks/${id}/rotate-secret`)),
  testHook: (id: string) => data<Delivery>(api.post(`/connect/webhooks/${id}/test`)),
  deliveries: (id: string) => data<Delivery[]>(api.get(`/connect/webhooks/${id}/deliveries`, { params: { limit: 50 } })),
  redeliver: (id: string) => data<Delivery>(api.post(`/connect/deliveries/${id}/redeliver`)),
}

/** Ready-made scope sets for the "New API key" form. */
export const SCOPE_PRESETS: { id: string; label: string; scopes: string[] }[] = [
  { id: "read", label: "Read schedules & work rules", scopes: ["schedule:read", "employee:read"] },
  { id: "write", label: "Read & update schedules (leave, absence, week offs)", scopes: ["schedule:read", "schedule:write", "employee:read"] },
  { id: "publish", label: "Read, update & publish schedules", scopes: ["schedule:read", "schedule:write", "schedule:publish", "employee:read"] },
]
