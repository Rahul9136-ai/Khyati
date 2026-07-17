import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, CheckCircle2, Play, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react"
import { useState } from "react"

import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { KpiCard } from "@/components/kpi-card"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

interface AgentInfo {
  key: string
  label: string
  description: string
  enabled: boolean
  auto_apply: boolean
}

interface PolicyOut {
  autonomy_level: "manual" | "assisted" | "autonomous"
  auto_apply_threshold: number
  agents: AgentInfo[]
}

interface ActionOut {
  id: string
  agent: string
  action_type: string
  title: string
  rationale: string
  confidence: number
  severity: string
  status: string
  target_label: string | null
  decided_at: string | null
  applied_at: string | null
  result_note: string | null
  created_at: string
}

interface RunResult {
  dry_run: boolean
  autonomy_level: string
  auto_apply_threshold: number
  proposed: number
  auto_applied: number
  pending_review: number
  actions: ActionOut[]
}

const STATUS_VARIANT: Record<string, "warning" | "success" | "destructive" | "default"> = {
  pending_review: "warning",
  auto_applied: "success",
  applied: "default",
  rejected: "destructive",
}

const SEVERITY_CLS: Record<string, string> = {
  critical: "text-destructive",
  warning: "text-amber-600",
  info: "text-primary",
}

/** Frontend for the backend's real /autonomy agents system: server-side
 *  observers that read live platform data and propose actions, auto-applying
 *  the ones that clear the confidence threshold under the current policy. */
export function Autonomy() {
  const queryClient = useQueryClient()
  const [lastRun, setLastRun] = useState<RunResult | null>(null)
  const [busy, setBusy] = useState(false)

  const { data: policy } = useQuery({
    queryKey: ["autonomy-policy"],
    queryFn: async () => (await api.get("/autonomy/policy")).data.data as PolicyOut,
  })
  const { data: actions = [] } = useQuery({
    queryKey: ["autonomy-actions"],
    queryFn: async () => (await api.get("/autonomy/actions")).data.data as ActionOut[],
    refetchInterval: 30_000,
  })

  const pending = actions.filter((a) => a.status === "pending_review")
  const applied = actions.filter((a) => a.status === "applied" || a.status === "auto_applied")

  async function refreshAll() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["autonomy-policy"] }),
      queryClient.invalidateQueries({ queryKey: ["autonomy-actions"] }),
    ])
  }

  async function runNow(dryRun: boolean) {
    setBusy(true)
    try {
      const res = (await api.post("/autonomy/run", { dry_run: dryRun })).data.data as RunResult
      setLastRun(res)
      if (!dryRun) await refreshAll()
    } finally {
      setBusy(false)
    }
  }

  async function decide(id: string, approve: boolean) {
    await api.post(`/autonomy/actions/${id}/${approve ? "approve" : "reject"}`, {})
    await refreshAll()
  }

  async function updatePolicy(patch: Partial<{ autonomy_level: string; auto_apply_threshold: number }>) {
    await api.put("/autonomy/policy", patch)
    await refreshAll()
  }

  async function toggleAgent(key: string, field: "enabled" | "auto_apply", value: boolean) {
    await api.put("/autonomy/policy", { agent_config: { [key]: { [field]: value } } })
    await refreshAll()
  }

  return (
    <>
      <PageHeader
        title="Autonomous Agents"
        subtitle="Server-side observers that propose — and, above the confidence threshold, apply — real actions"
        actions={
          <PermissionGate module="automation">
            <Button variant="outline" disabled={busy} onClick={() => runNow(true)}>
              <Sparkles className="h-4 w-4" /> Preview run
            </Button>
            <Button disabled={busy} onClick={() => runNow(false)}>
              <Play className="h-4 w-4" /> Run now
            </Button>
          </PermissionGate>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Autonomy level" value={policy?.autonomy_level ?? "…"} hint="manual · assisted · autonomous" icon={Bot} />
        <KpiCard label="Auto-apply threshold" value={policy ? `${Math.round(policy.auto_apply_threshold * 100)}%` : "…"} hint="min. confidence to self-apply" icon={CheckCircle2} />
        <KpiCard label="Pending review" value={pending.length} hint="proposals awaiting a decision" tone={pending.length ? "warn" : "good"} icon={ThumbsUp} />
        <KpiCard label="Applied" value={applied.length} hint="auto + human approved" tone="good" icon={Sparkles} />
      </div>

      {lastRun && (
        <div className="mb-4 rounded-lg border border-primary/40 px-4 py-2.5 text-sm text-primary">
          ✦ {lastRun.dry_run ? "Preview" : "Run"} complete: {lastRun.proposed} proposal(s) · {lastRun.auto_applied} auto-applied · {lastRun.pending_review} pending review.
        </div>
      )}

      <Card className="glass mb-4">
        <CardHeader>
          <CardTitle>Policy</CardTitle>
          <p className="text-xs text-muted-foreground">Governs which agents run and how aggressively they self-apply.</p>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4">
          <PermissionGate module="automation" fallback={<Badge variant="secondary">{policy?.autonomy_level ?? "…"} · read-only</Badge>}>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Level</span>
              <Select
                value={policy?.autonomy_level ?? "manual"}
                onChange={(e) => updatePolicy({ autonomy_level: e.target.value })}
                options={[
                  { value: "manual", label: "Manual — propose only" },
                  { value: "assisted", label: "Assisted — human approves each" },
                  { value: "autonomous", label: "Autonomous — auto-apply above threshold" },
                ]}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Threshold</span>
              <input
                type="number"
                min={0}
                max={100}
                className="h-9 w-20 rounded-md border bg-background px-2 tabular-nums"
                value={policy ? Math.round(policy.auto_apply_threshold * 100) : 90}
                onChange={(e) => updatePolicy({ auto_apply_threshold: +e.target.value / 100 })}
              />
              <span className="text-muted-foreground">%</span>
            </label>
          </PermissionGate>
        </CardContent>
      </Card>

      <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {(policy?.agents ?? []).map((agent) => (
          <Card key={agent.key} className="glass">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm"><Bot className="h-4 w-4 text-primary" /> {agent.label}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <p className="text-muted-foreground">{agent.description}</p>
              <PermissionGate module="automation" fallback={<Badge variant={agent.enabled ? "success" : "secondary"}>{agent.enabled ? "on" : "off"}</Badge>}>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={agent.enabled} onChange={(e) => toggleAgent(agent.key, "enabled", e.target.checked)} className="accent-primary" /> enabled
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={agent.auto_apply} onChange={(e) => toggleAgent(agent.key, "auto_apply", e.target.checked)} className="accent-primary" /> auto-apply
                  </label>
                </div>
              </PermissionGate>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="glass">
        <CardHeader>
          <CardTitle>Actions</CardTitle>
          <p className="text-xs text-muted-foreground">Every proposal an agent has made, with its rationale and disposition.</p>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Proposal</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {actions.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="text-left">
                    <Badge variant="outline">{a.agent}</Badge>
                  </TableCell>
                  <TableCell className="max-w-xs text-left">
                    <div className={cn("font-medium", SEVERITY_CLS[a.severity])}>{a.title}</div>
                    <div className="truncate text-xs text-muted-foreground" title={a.rationale}>{a.rationale}</div>
                  </TableCell>
                  <TableCell className="tabular-nums">{Math.round(a.confidence * 100)}%</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[a.status] ?? "secondary"}>{a.status.replace("_", " ")}</Badge>
                  </TableCell>
                  <TableCell>
                    {a.status === "pending_review" ? (
                      <PermissionGate module="automation" fallback={<span className="text-xs text-muted-foreground">—</span>}>
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" onClick={() => decide(a.id, true)}><ThumbsUp className="h-3.5 w-3.5" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => decide(a.id, false)}><ThumbsDown className="h-3.5 w-3.5" /></Button>
                        </div>
                    </PermissionGate>
                    ) : (
                      <span className="text-xs text-muted-foreground">{a.result_note ?? "—"}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {actions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No proposals yet — run the agents to see what they'd recommend.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  )
}
