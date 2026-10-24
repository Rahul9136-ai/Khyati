import { Loader2 } from "lucide-react"
import { useEffect } from "react"

import { startScheduleSync, stopScheduleSync } from "@/lib/scheduleSync"
import { Login } from "@/pages/Login"
import { useAuth } from "@/store/auth"

/** Blocks the app behind a real backend session. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const status = useAuth((s) => s.status)
  const user = useAuth((s) => s.user)
  const bootstrap = useAuth((s) => s.bootstrap)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  // Keep the Scheduling timeline in sync with the backend while signed in.
  // Write access follows the server's own permission, not the UI role matrix.
  const canWrite = !!user && (user.is_superuser || user.permission_codes.includes("schedule:write"))
  useEffect(() => {
    if (status !== "authenticated") return
    void startScheduleSync({ canWrite })
    return () => stopScheduleSync()
  }, [status, canWrite])

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
