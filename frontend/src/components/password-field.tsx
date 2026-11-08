import { Check, Eye, EyeOff, X } from "lucide-react"
import { useState } from "react"

import { Input } from "@/components/ui/input"
import { PASSWORD_RULES } from "@/lib/passwords"
import { cn } from "@/lib/utils"

/** A password box with a show / hide button. */
export function PasswordField({ label, value, onChange, autoComplete = "new-password", autoFocus }: {
  label: string; value: string; onChange: (v: string) => void; autoComplete?: string; autoFocus?: boolean
}) {
  const [shown, setShown] = useState(false)
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <span className="relative block">
        <Input
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          className="pr-9"
          aria-label={label}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </span>
    </label>
  )
}

/** Live checklist of the password rules (and whether the two boxes match). */
export function PasswordRules({ password, confirm, email = "" }: { password: string; confirm?: string; email?: string }) {
  const rules = [
    ...PASSWORD_RULES.map((r) => ({ label: r.label, ok: r.ok(password, email) })),
    ...(confirm !== undefined ? [{ label: "Both passwords match", ok: !!password && password === confirm }] : []),
  ]
  return (
    <ul aria-label="Password rules" className="space-y-0.5 text-xs">
      {rules.map((r) => (
        <li key={r.label} className={cn("flex items-center gap-1.5", r.ok ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
          {r.ok ? <Check className="h-3.5 w-3.5" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
          <span>{r.label}</span>
          <span className="sr-only">{r.ok ? "(done)" : "(not yet)"}</span>
        </li>
      ))}
    </ul>
  )
}
