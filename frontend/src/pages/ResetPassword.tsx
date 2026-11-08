import { CheckCircle2, KeyRound, Loader2, TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"

import { PasswordField, PasswordRules } from "@/components/password-field"
import { PurviLogo } from "@/components/purvi-logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { tokenStore, type ApiError } from "@/lib/api"
import { checkResetLink, passwordOk, resetPassword } from "@/lib/passwords"

/** Where a reset link lands (/reset-password?token=…): choose a new password. */
export function ResetPassword() {
  const token = new URLSearchParams(window.location.search).get("token") ?? ""
  const [state, setState] = useState<{ kind: "checking" } | { kind: "ready"; email: string } | { kind: "invalid"; message: string } | { kind: "done" }>({ kind: "checking" })
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return setState({ kind: "invalid", message: "This link is incomplete. Open the link from the email again, or ask for a new one." })
    checkResetLink(token)
      .then((r) => setState({ kind: "ready", email: r.email }))
      .catch((e: ApiError) => setState({ kind: "invalid", message: e.status ? e.message : "Can't reach the server. Try again in a minute." }))
  }, [token])

  const email = state.kind === "ready" ? state.email : ""
  const valid = passwordOk(password, email) && password === confirm

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      await resetPassword(token, password)
      tokenStore.clear() // every session of this account was signed out
      setState({ kind: "done" })
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  const toSignIn = () => window.location.assign("/")

  return (
    <div className="grid min-h-screen place-items-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <PurviLogo size="lg" />
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">A Product of Purvi Technology</p>
        </div>
        <Card className="glass">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4 text-primary" /> Set a new password</CardTitle>
          </CardHeader>
          <CardContent>
            {state.kind === "checking" && (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking your link…</p>
            )}
            {state.kind === "invalid" && (
              <div className="space-y-3">
                <p role="alert" className="flex gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {state.message}</p>
                <Button className="w-full" onClick={toSignIn}>Back to sign in</Button>
              </div>
            )}
            {state.kind === "done" && (
              <div className="space-y-3">
                <p role="status" className="flex gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> Your password has been changed. You've been signed out everywhere; sign in with your new password.
                </p>
                <Button className="w-full" onClick={toSignIn}>Sign in</Button>
              </div>
            )}
            {state.kind === "ready" && (
              <form className="space-y-3" onSubmit={(e) => void submit(e)}>
                <p className="text-sm text-muted-foreground">For <span className="font-medium text-foreground">{state.email}</span></p>
                <PasswordField label="New password" value={password} onChange={setPassword} autoFocus />
                <PasswordField label="Confirm new password" value={confirm} onChange={setConfirm} />
                <PasswordRules password={password} confirm={confirm} email={state.email} />
                {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
                <Button type="submit" className="w-full" disabled={!valid || busy}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />} Save new password
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
