import { create } from "zustand"

import { api, setSessionExpiredHandler, tokenStore } from "@/lib/api"
import type { SessionUser } from "@/lib/auth"
import { apiLogin, apiLogout, designationFor, fetchMe } from "@/lib/auth"
import { localISODate } from "@/lib/domain/horizon"
import { useWfm } from "@/store/wfm"

type AuthStatus = "booting" | "anonymous" | "authenticated"

interface AuthState {
  status: AuthStatus
  user: SessionUser | null
  error: string | null
  bootstrap: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

/** Push the server identity into the WFM store so RoleGuards/PermissionGates
 * across the app enforce the real designation. */
function applyIdentity(user: SessionUser) {
  const role = designationFor(user)
  useWfm.getState().setCurrentRole(role)
  if (role === "Agent" && !user.is_superuser) void linkRosterAgent()
}

/** A signed-in agent's self-service view follows the roster row linked to
 *  their employee record (roster id = employee code) rather than a preview pick. */
async function linkRosterAgent() {
  try {
    const today = localISODate()
    const res = await api.get("/scheduling/my-schedule", { params: { start: today, end: today } })
    const keys = (res.data.data as { agent_keys: string[] }).agent_keys
    const wfm = useWfm.getState()
    const match = keys.find((k) => wfm.agents.some((a) => a.id === k))
    if (match) wfm.setCurrentAgentId(match)
  } catch {
    /* offline / older backend — keep the current pick */
  }
}

export const useAuth = create<AuthState>((set) => ({
  status: "booting",
  user: null,
  error: null,

  bootstrap: async () => {
    if (!tokenStore.access && !tokenStore.refresh) {
      set({ status: "anonymous" })
      return
    }
    try {
      const user = await fetchMe()
      applyIdentity(user)
      set({ status: "authenticated", user, error: null })
    } catch {
      tokenStore.clear()
      set({ status: "anonymous", user: null })
    }
  },

  login: async (email, password) => {
    set({ error: null })
    try {
      const user = await apiLogin(email, password)
      applyIdentity(user)
      set({ status: "authenticated", user })
    } catch (err) {
      const message = (err as { message?: string }).message ?? "Login failed"
      set({ error: message, status: "anonymous", user: null })
      throw err
    }
  },

  logout: async () => {
    await apiLogout()
    set({ status: "anonymous", user: null, error: null })
  },
}))

setSessionExpiredHandler(() => {
  useAuth.setState({ status: "anonymous", user: null, error: "Session expired — sign in again." })
})
