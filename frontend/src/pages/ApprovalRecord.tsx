import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft, Bot, Check, Copy, ShieldCheck, ThumbsDown, ThumbsUp,
} from "lucide-react"
import { useState } from "react"
import { useNavigate, useParams } from "react-router-dom"

import { ApprovalTimeline } from "@/components/approval-timeline"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { decideApproval, getApproval } from "@/lib/integrations"
import { cn } from "@/lib/utils"
import { useAuth } from "@/store/auth"

const STATUS_VARIANT: Record<string, "warning" | "success" | "destructive" | "secondary" | "default"> = {
  pending: "warning",
  approved: "default",
  applied: "success",
  rejected: "destructive",
  failed: "destructive",
  expired: "secondary",
  cancelled: "secondary",
}

const CHANNEL_LABEL: Record<string, string> = {
  slack: "Slack", teams: "Teams", in_app: "in-app", auto: "automation",
}

// Known keys from the automation-parsed payload (see backend automation.py
// `_title_and_summary`) get a friendly label; anything else (e.g. a payload
// from the in-app "Request OM sign-off" dialog) falls back to its raw key.
const PAYLOAD_LABELS: Record<string, string> = {
  employee_code: "Employee code",
  employee_name: "Employee name",
  action: "Action",
  date_or_week: "Date / week",
  field_to_change: "Field changed",
  new_value: "New value",
  raw_message: "Original message",
  confidence: "Parser confidence",
  parser: "Parsed by",
  raised_from: "Raised from",
  date: "Date",
}

// Known keys from apply_result's before/after (see backend
// _apply_shift_change) get a friendly label and format.
const DIFF_LABELS: Record<string, string> = {
  start_ts: "Start", end_ts: "End", activities: "Activities",
}

function titleize(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function fmtValue(key: string, value: unknown): string {
  if (value == null) return "—"
  if ((key === "start_ts" || key === "end_ts") && typeof value === "string") {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? value : d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    })
  }
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—"
  return String(value)
}

function relTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
  })
}

export function ApprovalRecord() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [note, setNote] = useState("")
  const [copied, setCopied] = useState(false)
  const perms = useAuth((s) => s.user?.permission_codes ?? [])
  const canApprove = perms.includes("request:approve_manager")

  const { data: a, isLoading, isError } = useQuery({
    queryKey: ["approval", id], queryFn: () => getApproval(id), enabled: !!id,
  })
  const decide = useMutation({
    mutationFn: (approve: boolean) => decideApproval(id, approve, note.trim() || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["approval", id] })
      qc.invalidateQueries({ queryKey: ["approvals"] })
    },
  })

  function copyLink() {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>
  }
  if (isError || !a) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">This change record couldn't be found.</p>
        <Button variant="ghost" className="mt-3" onClick={() => navigate("/approvals")}>
          <ArrowLeft className="h-4 w-4" /> Back to Approval Bridge
        </Button>
      </div>
    )
  }

  const wasAutomated = a.decided_via === "auto"
  const result = (a.apply_result ?? {}) as Record<string, unknown>
  const before = result.before as Record<string, unknown> | undefined
  const after = result.after as Record<string, unknown> | undefined
  const hasDiff = !!(before && after)
  const payloadEntries = Object.entries(a.payload ?? {}).filter(([, v]) => v !== null && v !== "")

  return (
    <>
      <PageHeader
        title="Change record"
        subtitle={`#${a.id.slice(0, 8)} · raised ${relTime(a.created_at)}`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={copyLink}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate("/approvals")}>
              <ArrowLeft className="h-3.5 w-3.5" /> All approvals
            </Button>
          </div>
        }
      />

      <Card className="glass">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <CardTitle className="text-base">{a.title}</CardTitle>
              {a.summary && <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{a.summary}</p>}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <Badge variant="outline">{a.source}</Badge>
              <Badge variant="secondary">{a.kind.replace(/_/g, " ")}</Badge>
              <Badge variant={STATUS_VARIANT[a.status] ?? "secondary"}>{a.status}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            {wasAutomated ? (
              <span className="flex items-center gap-1">
                <Bot className="h-3.5 w-3.5 text-primary" /> Auto-applied by automation
                {a.decision_note ? ` — ${a.decision_note}` : ""}
              </span>
            ) : a.decided_at ? (
              <span>
                Decided via {CHANNEL_LABEL[a.decided_via ?? ""] ?? a.decided_via} · {relTime(a.decided_at)}
                {a.decision_note ? ` — ${a.decision_note}` : ""}
              </span>
            ) : (
              <span>Awaiting {a.approver_role} · dispatched to {a.channel === "in_app" ? "in-app" : a.channel}</span>
            )}
          </div>

          {a.status === "pending" && (
            <PermissionGate module="approvals"
              fallback={<p className="text-sm text-muted-foreground">Awaiting {a.approver_role} decision.</p>}>
              {canApprove ? (
                <div className="space-y-2 rounded-lg border p-3">
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                    placeholder="Optional note for the record…" />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate(true)}>
                      <ThumbsUp className="h-3.5 w-3.5" /> Approve
                    </Button>
                    <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
                      <ThumbsDown className="h-3.5 w-3.5" /> Reject
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Awaiting {a.approver_role} decision — you can view this record but not decide it.
                </p>
              )}
            </PermissionGate>
          )}

          {hasDiff && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">What changed</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <DiffSide label="Before" data={before!} against={after!} />
                <DiffSide label="After" data={after!} against={before!} highlight />
              </div>
            </section>
          )}

          {!hasDiff && a.status !== "pending" && Object.keys(result).length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Result</h3>
              <ResultCard result={result} />
            </section>
          )}

          {payloadEntries.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Request details</h3>
              <dl className="grid gap-x-4 gap-y-1.5 rounded-lg border p-3 text-sm sm:grid-cols-2">
                {payloadEntries.map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{PAYLOAD_LABELS[k] ?? titleize(k)}</dt>
                    <dd className="max-w-[60%] truncate text-right" title={String(v)}>{fmtValue(k, v)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-sm font-semibold">Timeline</h3>
            <ApprovalTimeline approval={a} />
          </section>
        </CardContent>
      </Card>
    </>
  )
}

function DiffSide({
  label, data, against, highlight,
}: { label: string; data: Record<string, unknown>; against: Record<string, unknown>; highlight?: boolean }) {
  const keys = Object.keys(data)
  return (
    <div className={cn("rounded-lg border p-3", highlight && "border-primary/40 bg-primary/5")}>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <dl className="space-y-1.5 text-sm">
        {keys.map((k) => {
          const changed = fmtValue(k, data[k]) !== fmtValue(k, against[k])
          return (
            <div key={k} className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{DIFF_LABELS[k] ?? titleize(k)}</dt>
              <dd className={cn("text-right", changed && (highlight ? "font-semibold text-emerald-600" : "line-through text-muted-foreground"))}>
                {fmtValue(k, data[k])}
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}

function ResultCard({ result }: { result: Record<string, unknown> }) {
  if (result.error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        {String(result.error)}
      </div>
    )
  }
  // `applied`/`target`/`payload`/`before`/`after`/`detail` are shown elsewhere
  // (status badge, diff, request-details section, headline) — this shows
  // whatever's left (employee_id, date, code, record_id, shifts…).
  const skip = new Set(["applied", "target", "payload", "before", "after", "detail"])
  const rest = Object.entries(result).filter(([k, v]) => !skip.has(k) && v != null)
  return (
    <div className="rounded-lg border p-3 text-sm">
      {result.detail != null && <p className="mb-2 font-medium text-emerald-600">✓ {String(result.detail)}</p>}
      {rest.length > 0 && (
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {rest.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{titleize(k)}</dt>
              <dd className="text-right">{fmtValue(k, v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
