import { Loader2 } from "lucide-react"
import { useEffect } from "react"

import { Login } from "@/pages/Login"
import { useAuth } from "@/store/auth"

/** Blocks the app behind a real backend session. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const status = useAuth((s) => s.status)
  const bootstrap = useAuth((s) => s.bootstrap)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

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
