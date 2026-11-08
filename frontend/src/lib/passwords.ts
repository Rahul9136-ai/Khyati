// Password reset, forgot password and change password (backend: /auth, /users).
import { api } from "@/lib/api"

/** The same rules the server applies (app/modules/identity/password_reset.py). */
export const PASSWORD_RULES: { label: string; ok: (pw: string, email: string) => boolean }[] = [
  { label: "At least 8 characters", ok: (pw) => pw.length >= 8 && pw.length <= 128 },
  { label: "At least one letter and one number", ok: (pw) => /[A-Za-z]/.test(pw) && /\d/.test(pw) },
  { label: "Not your email address", ok: (pw, email) => !email || pw.trim().toLowerCase() !== email.trim().toLowerCase() },
]

export const passwordOk = (pw: string, email = "") => PASSWORD_RULES.every((r) => r.ok(pw, email))

const data = <T>(p: Promise<{ data: { data: T } }>) => p.then((r) => r.data.data)

/** Emails a reset link if the account exists; the answer is the same either way. */
export const forgotPassword = (email: string) =>
  data<{ detail: string; valid_minutes: number }>(api.post("/auth/forgot-password", { email }))

/** Whether a reset link still works, and for which email. */
export const checkResetLink = (token: string) => data<{ email: string }>(api.get("/auth/reset-password", { params: { token } }))

export const resetPassword = (token: string, newPassword: string) =>
  data<{ detail: string }>(api.post("/auth/reset-password", { token, new_password: newPassword }))

export const changePassword = (currentPassword: string, newPassword: string) =>
  data<{ detail: string }>(api.post("/auth/change-password", { current_password: currentPassword, new_password: newPassword }))

export interface Account {
  id: string
  email: string
  full_name: string
  is_active: boolean
  roles?: string[]
  role_names?: string[]
  last_login_at?: string | null
}

export const listAccounts = (search: string) =>
  data<{ items: Account[]; total: number }>(api.get("/users", { params: { size: 50, search: search.trim() || undefined } }))

export interface ResetLink {
  link: string
  expires_at: string
  emailed: boolean
  email_problem: string | null
}

/** Admin: a one-time link (24 h) for someone to set a new password. */
export const resetLinkFor = (userId: string) => data<ResetLink>(api.post(`/users/${userId}/reset-password-link`))
