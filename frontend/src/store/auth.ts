import { create } from "zustand"

import { setSessionExpiredHandler, tokenStore } from "@/lib/api"
import type { SessionUser } from "@/lib/auth"
import { apiLogin, apiLogout, designationFor, fetchMe } from "@/lib/auth"
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
  useWfm.getState().setCurrentRole(designationFor(user))
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
