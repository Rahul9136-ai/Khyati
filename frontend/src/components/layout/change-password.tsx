import { CheckCircle2, KeyRound, Loader2 } from "lucide-react"
import { useState } from "react"

import { PasswordField, PasswordRules } from "@/components/password-field"
import { Button } from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import type { ApiError } from "@/lib/api"
import { changePassword, passwordOk } from "@/lib/passwords"
import { useAuth } from "@/store/auth"

/** Top-bar button: change your own password (needs the current one). */
export function ChangePasswordButton() {
  const user = useAuth((s) => s.user)
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  if (!user) return null

  const email = user.email
  const valid = !!current && passwordOk(next, email) && next === confirm && next !== current
  const close = () => { setOpen(false); setCurrent(""); setNext(""); setConfirm(""); setError(null); setDone(false) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      await changePassword(current, next)
      setDone(true)
    } catch (err) {
      const x = err as ApiError
      setError(x.status === 401 ? "Your current password isn't right." : x.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Change password"
        title="Change password"
      >
        <KeyRound className="h-4 w-4" />
      </button>
      <Dialog
        open={open}
        onClose={close}
        title="Change password"
        description={`For ${email}. Forgot your current password? Sign out and use "Forgot password?" on the sign-in page.`}
        footer={done ? <Button onClick={close}>Done</Button> : (
          <>
            <Button variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" form="change-password" disabled={!valid || busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Change password
            </Button>
          </>
        )}
      >
        {done ? (
          <p role="status" className="flex gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> Password changed. Use the new one next time you sign in.
          </p>
        ) : (
          <form id="change-password" className="space-y-3" onSubmit={(e) => void submit(e)}>
            <PasswordField label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />
            <PasswordField label="New password" value={next} onChange={setNext} />
            <PasswordField label="Confirm new password" value={confirm} onChange={setConfirm} />
            <PasswordRules password={next} confirm={confirm} email={email} />
            {next && current && next === current && <p className="text-xs text-amber-600">Choose a password different from your current one.</p>}
            {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
          </form>
        )}
      </Dialog>
    </>
  )
}
