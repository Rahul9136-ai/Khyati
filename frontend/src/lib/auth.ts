import { api, tokenStore } from "@/lib/api"
import type { Role } from "@/lib/domain/roles"

/** The authenticated identity as the backend reports it (GET /auth/me). */
export interface SessionUser {
  id: string
  email: string
  full_name: string
  is_superuser: boolean
  role_names: string[]
  permission_codes: string[]
}

/** Backend system roles → the frontend designation driving RoleGuards. */
const SERVER_ROLE_MAP: Record<string, Role> = {
  "Super Admin": "Super Admin",
  "WFM Director": "WFM Director",
  "Planning Manager": "WFM Manager",
  "Forecasting Analyst": "Forecasting Manager",
  Scheduler: "Scheduler",
  "Real-Time Analyst": "RTA",
  "Operations Manager": "Operations Manager",
  "Team Leader": "Team Leader",
  Employee: "Agent",
  HR: "Read-Only Viewer",
  "Reporting Analyst": "Read-Only Viewer",
}

export function designationFor(user: SessionUser): Role {
  if (user.is_superuser) return "Super Admin"
  for (const name of user.role_names) {
    const mapped = SERVER_ROLE_MAP[name]
    if (mapped) return mapped
  }
  return "Read-Only Viewer"
}

export function initialsOf(user: SessionUser): string {
  const source = user.full_name.trim() || user.email
  return source
    .split(/[\s.@_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("")
}

export async function apiLogin(email: string, password: string): Promise<SessionUser> {
  const res = await api.post("/auth/login", { email, password })
  const pair = res.data.data as { access_token: string; refresh_token: string }
  tokenStore.set(pair.access_token, pair.refresh_token)
  return fetchMe()
}

export async function fetchMe(): Promise<SessionUser> {
  const res = await api.get("/auth/me")
  return res.data.data as SessionUser
}

export async function apiLogout(): Promise<void> {
  const refresh = tokenStore.refresh
  if (refresh) {
    try {
      await api.post("/auth/logout", { refresh_token: refresh })
    } catch {
      // token already dead server-side — local clear is what matters
    }
  }
  tokenStore.clear()
}
