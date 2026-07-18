import { KeyRound, Loader2, LogIn } from "lucide-react"
import { useState } from "react"

import { PurviLogo } from "@/components/purvi-logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/store/auth"

const DEMO_ACCOUNTS = [
  { email: "admin@flowforce.dev", password: "Admin@12345", label: "Super Admin" },
  { email: "planner@flowforce.dev", password: "Demo@12345", label: "Planning Manager" },
  { email: "scheduler@flowforce.dev", password: "Demo@12345", label: "Scheduler" },
  { email: "rta@flowforce.dev", password: "Demo@12345", label: "Real-Time Analyst" },
  { email: "agent@flowforce.dev", password: "Demo@12345", label: "Agent" },
]

export function Login() {
  const { login, error } = useAuth()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(userEmail: string, userPassword: string) {
    setBusy(true)
    try {
      await login(userEmail, userPassword)
    } catch {
      // error surface handled by the store
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <PurviLogo size="lg" />
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
            A Product of Purvi Technology
          </p>
        </div>

        <Card className="glass">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4 text-primary" /> Sign in
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                void submit(email, password)
              }}
            >
              <Input
                type="email"
                placeholder="you@company.com"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <Input
                type="password"
                placeholder="Password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              {error && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogIn className="mr-2 h-4 w-4" />}
                Sign in
              </Button>
            </form>

            <div className="mt-5 border-t pt-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Demo accounts (seeded)
              </p>
              <div className="flex flex-wrap gap-1.5">
                {DEMO_ACCOUNTS.map((account) => (
                  <button
                    key={account.email}
                    type="button"
                    disabled={busy}
                    onClick={() => void submit(account.email, account.password)}
                    className="rounded-full border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title={account.email}
                  >
                    {account.label}
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          Powered by FlowForce WFM · JWT + RBAC · run <code>python -m app.db.seed</code> if accounts are missing
        </p>
      </div>
    </div>
  )
}
