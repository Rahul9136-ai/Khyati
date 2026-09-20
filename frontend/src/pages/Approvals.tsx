import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CheckCircle2, ChevronDown, ChevronRight, Clock, MessageSquare,
  Plus, Send, ShieldCheck, ThumbsDown, ThumbsUp,
} from "lucide-react"
import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"

import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  type Approval, type ApprovalSource, KINDS_BY_SOURCE,
  decideApproval, getConfig, listApprovals, raiseApproval,
} from "@/lib/integrations"
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

const CHANNEL_ICON: Record<string, string> = { slack: "Slack", teams: "Teams", in_app: "In-app" }

function relTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function Timeline({ approval }: { approval: Approval }) {
  return (
    <div className="mt-3 space-y-1.5 border-l-2 border-border pl-3">
      {(approval.events ?? []).map((e, i) => (
        <div key={i} className="flex items-start gap-2 text-xs">
          <span className="mt-0.5 font-mono text-muted-foreground">{relTime(e.at).split(", ")[1] ?? ""}</span>
          <Badge variant="outline" className="shrink-0">{e.type}</Badge>
          {e.channel && <span className="shrink-0 text-muted-foreground">via {CHANNEL_ICON[e.channel] ?? e.channel}</span>}
          <span className="text-muted-foreground">{e.detail}</span>
        </div>
      ))}
    </div>
  )
}

export function Approvals() {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState("pending")
  const [expanded, setExpanded] = useState<string | null>(params.get("focus"))
  const [raiseOpen, setRaiseOpen] = useState(false)
  // only a backend Operations Manager (request:approve_manager) — or a superuser —
  // may actually decide; everyone with page access can view and raise.
  const perms = useAuth((s) => s.user?.permission_codes ?? [])
  const canApprove = perms.includes("request:approve_manager")

  const { data: approvals = [] } = useQuery({
    queryKey: ["approvals"],
    queryFn: () => listApprovals(),
    refetchInterval: 20_000,
  })
  const { data: config } = useQuery({ queryKey: ["integration-config-status"], queryFn: getConfig, retry: false })

  // open the raise dialog when navigated to with ?raise=1 (e.g. from RTA/Scheduling)
  useEffect(() => {
    if (params.get("raise") === "1") {
      setRaiseOpen(true)
      params.delete("raise")
      setParams(params, { replace: true })
    }
  }, [params, setParams])

  const decide = useMutation({
    mutationFn: ({ id, approve, note }: { id: string; approve: boolean; note?: string }) =>
      decideApproval(id, approve, note),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["approvals"] }),
  })

  const pending = approvals.filter((a) => a.status === "pending")
  const history = approvals.filter((a) => a.status !== "pending")
  const applied = approvals.filter((a) => a.status === "applied")
  const shown = tab === "pending" ? pending : history

  return (
    <>
      <PageHeader
        title="Approval Bridge"
        subtitle="Real-time & scheduling changes routed to the respective OM via Slack / Teams, applied on approval"
        actions={
          <PermissionGate module="approvals">
            <Button onClick={() => setRaiseOpen(true)}>
              <Plus className="h-4 w-4" /> Request OM sign-off
            </Button>
          </PermissionGate>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Pending sign-off" value={pending.length} hint="awaiting the OM" tone={pending.length ? "warn" : "good"} icon={Clock} />
        <KpiCard label="Applied" value={applied.length} hint="approved & pushed to the plan" tone="good" icon={CheckCircle2} />
        <KpiCard label="Slack" value={config?.slack_enabled ? (config.slack_configured ? "Live" : "Simulated") : "Off"} hint={config?.slack_channel || "not connected"} icon={MessageSquare} tone={config?.slack_enabled ? "good" : "neutral"} />
        <KpiCard label="Teams" value={config?.teams_enabled ? (config.teams_configured ? "Live" : "Simulated") : "Off"} hint={config?.teams_configured ? "webhook set" : "not connected"} icon={MessageSquare} tone={config?.teams_enabled ? "good" : "neutral"} />
      </div>

      {config && !config.any_channel_live && (config.slack_enabled || config.teams_enabled) && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-600 dark:text-amber-500">
          Channels are in <b>simulated</b> mode — cards are generated and the flow works end-to-end, but nothing is
          sent externally. Add a real Slack/Teams webhook in <b>Settings → Integrations</b> to go live.
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="pending">Pending ({pending.length})</TabsTrigger>
          <TabsTrigger value="history">History ({history.length})</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="mt-4 space-y-3">
        {shown.map((a) => {
          const isOpen = expanded === a.id
          return (
            <Card key={a.id} className="glass">
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <button onClick={() => setExpanded(isOpen ? null : a.id)} className="text-muted-foreground hover:text-foreground">
                        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                      {a.title}
                    </CardTitle>
                    <p className="mt-1 pl-6 text-xs text-muted-foreground">{a.summary}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge variant="outline">{a.source}</Badge>
                    <Badge variant="secondary">{a.kind.replace(/_/g, " ")}</Badge>
                    <Badge variant={STATUS_VARIANT[a.status] ?? "secondary"}>{a.status}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pl-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5" /> Awaiting {a.approver_role}
                    <span>· dispatched to {a.channel === "in_app" ? "in-app" : a.channel}</span>
                    {a.decided_via && <span>· decided via {CHANNEL_ICON[a.decided_via] ?? a.decided_via}</span>}
                  </div>
                  {a.status === "pending" && (
                    canApprove ? (
                      <div className="flex gap-1.5">
                        <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, approve: true })}>
                          <ThumbsUp className="h-3.5 w-3.5" /> Approve
                        </Button>
                        <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, approve: false })}>
                          <ThumbsDown className="h-3.5 w-3.5" /> Reject
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">Awaiting Operations Manager decision</span>
                    )
                  )}
                  {a.apply_result?.detail != null && (
                    <span className="text-xs text-emerald-500">✓ {String(a.apply_result.detail)}</span>
                  )}
                </div>
                {isOpen && <Timeline approval={a} />}
              </CardContent>
            </Card>
          )
        })}
        {shown.length === 0 && (
          <Card className="glass">
            <CardContent className="py-10 text-center text-muted-foreground">
              {tab === "pending"
                ? "No approvals awaiting sign-off. Raise one from Real-Time or Scheduling."
                : "No decided approvals yet."}
            </CardContent>
          </Card>
        )}
      </div>

      <RaiseDialog open={raiseOpen} onClose={() => setRaiseOpen(false)}
        initialSource={(params.get("source") as ApprovalSource) || "intraday"}
        onDone={() => qc.invalidateQueries({ queryKey: ["approvals"] })} />
    </>
  )
}

function RaiseDialog({
  open, onClose, initialSource, onDone,
}: {
  open: boolean
  onClose: () => void
  initialSource: ApprovalSource
  onDone: () => void
}) {
  const [source, setSource] = useState<ApprovalSource>(initialSource)
  const [kind, setKind] = useState(KINDS_BY_SOURCE[initialSource][0].value)
  const [title, setTitle] = useState("")
  const [summary, setSummary] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) { setSource(initialSource); setKind(KINDS_BY_SOURCE[initialSource][0].value) }
  }, [open, initialSource])

  async function submit() {
    if (!title.trim()) return
    setBusy(true)
    try {
      await raiseApproval({ source, kind, title: title.trim(), summary: summary.trim() })
      onDone()
      onClose()
      setTitle(""); setSummary("")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Request OM sign-off"
      description="Raise a real-time or scheduling change for the Operations Manager to approve in Slack / Teams."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !title.trim()} onClick={submit}>
            <Send className="h-4 w-4" /> Send for approval
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Source</span>
            <Select
              value={source}
              onChange={(e) => {
                const s = e.target.value as ApprovalSource
                setSource(s); setKind(KINDS_BY_SOURCE[s][0].value)
              }}
              options={[
                { value: "intraday", label: "Real-time (intraday)" },
                { value: "scheduling", label: "Scheduling" },
              ]}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Change type</span>
            <Select value={kind} onChange={(e) => setKind(e.target.value)} options={KINDS_BY_SOURCE[source]} />
          </label>
        </div>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Title</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Offer 2h OT on Voice — SL at risk" />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Details for the OM</span>
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3}
            placeholder="Why this change is needed and its expected impact." />
        </label>
        <p className={cn("text-xs text-muted-foreground")}>
          On approval, the change is applied to the live plan and logged to the audit trail.
        </p>
      </div>
    </Dialog>
  )
}
