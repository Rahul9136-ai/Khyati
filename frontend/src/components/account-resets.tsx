import { useQuery } from "@tanstack/react-query"
import { Check, Copy, KeyRound, Loader2, MailCheck, Search, TriangleAlert } from "lucide-react"
import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { ApiError } from "@/lib/api"
import { listAccounts, resetLinkFor, type Account, type ResetLink } from "@/lib/passwords"

/** Settings → Sign-in accounts: admins make a one-time reset link for someone. */
export function AccountResets() {
  const [search, setSearch] = useState("")
  const { data, isLoading, error } = useQuery({
    queryKey: ["accounts", search.trim()],
    queryFn: () => listAccounts(search),
  })
  const [target, setTarget] = useState<Account | null>(null)
  const [result, setResult] = useState<ResetLink | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function make(a: Account) {
    setTarget(a)
    setResult(null)
    setProblem(null)
    setBusy(true)
    try {
      setResult(await resetLinkFor(a.id))
    } catch (e) {
      setProblem((e as ApiError).message)
    } finally {
      setBusy(false)
    }
  }
  const close = () => { setTarget(null); setResult(null); setProblem(null); setCopied(false) }

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-primary" /> Sign-in accounts</CardTitle>
        <p className="text-sm text-muted-foreground">
          Someone locked out? Make them a one-time link to set a new password (valid 24 hours). It's emailed to them when email is set up on the server;
          you can always copy it and send it yourself. Their current password keeps working until they use the link.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="relative block max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search accounts" placeholder="Search by name or email" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-destructive">{(error as unknown as ApiError).message}</p>
        ) : isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading accounts…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Name</th>
                  <th className="py-1.5 pr-3 font-medium">Email</th>
                  <th className="py-1.5 pr-3 font-medium">Role</th>
                  <th className="py-1.5 pr-3 font-medium">Last sign-in</th>
                  <th className="py-1.5 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {(data?.items ?? []).map((a) => (
                  <tr key={a.id} className="border-t border-border/50">
                    <td className="py-2 pr-3 font-medium">{a.full_name || "—"}</td>
                    <td className="py-2 pr-3">{a.email}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{(a.role_names ?? []).join(", ") || "—"}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{a.last_login_at ? new Date(a.last_login_at).toLocaleString() : "Never"}</td>
                    <td className="py-2 text-right">
                      {a.is_active ? (
                        <Button size="sm" variant="outline" onClick={() => void make(a)} aria-label={`Reset password for ${a.email}`}>
                          <KeyRound className="h-3.5 w-3.5" /> Reset password
                        </Button>
                      ) : <Badge variant="secondary">Disabled</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data && data.items.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No accounts match "{search}".</p>}
            {data && data.total > data.items.length && <p className="pt-2 text-xs text-muted-foreground">Showing {data.items.length} of {data.total}; search to narrow it down.</p>}
          </div>
        )}
      </CardContent>

      <Dialog open={!!target} onClose={close} title="Reset password" description={target ? `For ${target.full_name || target.email} (${target.email})` : undefined}
        footer={<Button onClick={close}>Done</Button>}>
        {busy && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Making a reset link…</p>}
        {problem && <p role="alert" className="flex gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {problem}</p>}
        {result && (
          <div className="space-y-3 text-sm">
            {result.emailed ? (
              <p role="status" className="flex gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-emerald-700 dark:text-emerald-400">
                <MailCheck className="mt-0.5 h-4 w-4 shrink-0" /> Emailed to {target?.email}. You can also send them the link below.
              </p>
            ) : (
              <p role="status" className="flex gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> Not emailed ({result.email_problem}). Copy the link and send it to them yourself.
              </p>
            )}
            <div className="flex items-center gap-2">
              <Input readOnly value={result.link} aria-label="Reset link" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(result.link); setCopied(true) }}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Works once, until {new Date(result.expires_at).toLocaleString()}. Treat it like a password: send it only to this person.
            </p>
          </div>
        )}
      </Dialog>
    </Card>
  )
}
