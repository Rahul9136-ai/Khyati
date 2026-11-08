import { Loader2 } from "lucide-react"
import { useEffect } from "react"
import { useLocation } from "react-router-dom"

import { startScheduleSync, stopScheduleSync } from "@/lib/scheduleSync"
import { startSettingsSync, stopSettingsSync } from "@/lib/settingsSync"
import { startWorkspaceSync, stopWorkspaceSync } from "@/lib/workspaceSync"
import { Login } from "@/pages/Login"
import { ResetPassword } from "@/pages/ResetPassword"
import { useAuth } from "@/store/auth"

/** Blocks the app behind a real backend session. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const status = useAuth((s) => s.status)
  const user = useAuth((s) => s.user)
  const bootstrap = useAuth((s) => s.bootstrap)
  const { pathname } = useLocation()

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  // Keep the Scheduling timeline in sync with the backend while signed in.
  // Write access follows the server's own permission, not the UI role matrix.
  const canWrite = !!user && (user.is_superuser || user.permission_codes.includes("schedule:write"))
  useEffect(() => {
    if (status !== "authenticated") return
    let cancelled = false
    void (async () => {
      // Everything people add (roster, forecasts, PTO, scenarios …) first, so the
      // schedules and work rules below land on the organisation's roster.
      await startWorkspaceSync()
      if (cancelled) return
      void startScheduleSync({ canWrite })
      // Work rules, compliance, shift patterns and agents' week offs are shared too.
      void startSettingsSync({ canWrite })
    })()
    return () => {
      cancelled = true
      stopWorkspaceSync()
      stopScheduleSync()
      stopSettingsSync()
    }
  }, [status, canWrite])

  // A password-reset link works whether or not someone is signed in here.
  if (pathname === "/reset-password") return <ResetPassword />
  if (status === "booting") {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Restoring session…
        </div>
      </div>
    )
  }
  if (status === "anonymous") return <Login />
  return <>{children}</>
}
