import { ArrowLeft, KeyRound, Loader2, LogIn, Mail, MailCheck } from "lucide-react"
import { useState } from "react"

import { PurviLogo } from "@/components/purvi-logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import type { ApiError } from "@/lib/api"
import { forgotPassword } from "@/lib/passwords"
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
  const [mode, setMode] = useState<"signin" | "forgot">("signin")
  const [sent, setSent] = useState<string | null>(null)
  const [forgotError, setForgotError] = useState<string | null>(null)

  async function sendReset(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setForgotError(null)
    try {
      const r = await forgotPassword(email.trim())
      setSent(`${r.detail} The link works once and expires in ${r.valid_minutes} minutes. Check your spam folder if it doesn't arrive.`)
    } catch (err) {
      const e2 = err as ApiError
      setForgotError(e2.status ? e2.message : "Can't reach the server. Try again in a minute.")
    } finally {
      setBusy(false)
    }
  }

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

        {mode === "forgot" ? (
          <Card className="glass">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Mail className="h-4 w-4 text-primary" /> Forgot your password?
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {sent ? (
                <p role="status" className="flex gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
                  <MailCheck className="mt-0.5 h-4 w-4 shrink-0" /> {sent}
                </p>
              ) : (
                <form className="space-y-3" onSubmit={(e) => void sendReset(e)}>
                  <p className="text-sm text-muted-foreground">Enter the email you sign in with and we'll send you a link to set a new password.</p>
                  <Input type="email" placeholder="you@company.com" autoComplete="username" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
                  {forgotError && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{forgotError}</p>}
                  <Button type="submit" className="w-full" disabled={busy || !email.trim()}>
                    {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
                    Email me a reset link
                  </Button>
                </form>
              )}
              <p className="text-xs text-muted-foreground">No email? Ask your administrator: they can make you a reset link in Settings → Sign-in accounts.</p>
              <button type="button" onClick={() => { setMode("signin"); setSent(null); setForgotError(null) }}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
              </button>
            </CardContent>
          </Card>
        ) : (
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
              <div className="flex justify-end">
                <button type="button" onClick={() => setMode("forgot")} className="text-xs font-medium text-primary hover:underline">
                  Forgot password?
                </button>
              </div>
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
        )}
      </div>
    </div>
  )
}
