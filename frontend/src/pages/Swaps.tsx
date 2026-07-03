import { useMemo, useState } from "react"
import { ArrowLeftRight, CheckCircle2, Clock3, Repeat, ShieldAlert } from "lucide-react"

import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fmtPct } from "@/lib/domain/planning"
import { swapImpact } from "@/lib/domain/swaps"
import type { SwapStatus } from "@/store/wfm"
import { useWfm } from "@/store/wfm"

const variant: Record<SwapStatus, "success" | "warning" | "default" | "destructive"> = {
  "Auto-Approved": "success",
  Pending: "warning",
  Approved: "default",
  Denied: "destructive",
}

export function Swaps() {
  const { agents, queues, forecasts, shrinkage, swaps, proposeSwap, setSwapStatus } = useWfm()
  const byId = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents])

  const [open, setOpen] = useState(false)
  const [fromId, setFromId] = useState(agents[0]?.id ?? "")
  const [toId, setToId] = useState(agents[1]?.id ?? "")
  const [error, setError] = useState("")

  // Live SL-impact preview while the dialog is open.
  const preview = useMemo(
    () => (fromId && toId && fromId !== toId ? swapImpact(fromId, toId, agents, queues, forecasts, shrinkage) : null),
    [fromId, toId, agents, queues, forecasts, shrinkage],
  )

  const autoCount = swaps.filter((s) => s.status === "Auto-Approved").length
  const pendingCount = swaps.filter((s) => s.status === "Pending").length

  const agentOpts = agents.map((a) => ({ value: a.id, label: `${a.name} · ${a.shift}` }))

  function reset() {
    setFromId(agents[0]?.id ?? "")
    setToId(agents[1]?.id ?? "")
    setError("")
  }

  function submit() {
    if (!fromId || !toId) return setError("Pick both agents.")
    if (fromId === toId) return setError("Pick two different agents.")
    if (byId[fromId].shift === byId[toId].shift) return setError("Both agents already work the same shift — nothing to swap.")
    const imp = swapImpact(fromId, toId, agents, queues, forecasts, shrinkage)
    proposeSwap(fromId, toId, imp.impact, imp.neutral)
    reset()
    setOpen(false)
  }

  return (
    <>
      <PageHeader
        title="Shift-Swap Marketplace"
        subtitle="SL-neutral swaps auto-approve · risky ones escalate to a Team Leader"
        actions={
          <>
            <ExportButton
              filename="shift-swaps"
              sheets={() => [
                {
                  name: "Swaps",
                  rows: swaps.map((s) => ({
                    From: byId[s.fromAgentId]?.name ?? s.fromAgentId,
                    To: byId[s.toAgentId]?.name ?? s.toAgentId,
                    "SL impact (pp)": (s.slImpact * 100).toFixed(2),
                    Status: s.status,
                    Applied: s.applied ? "Yes" : "No",
                    When: new Date(s.ts).toLocaleString(),
                  })),
                },
              ]}
            />
            <PermissionGate module="swaps">
              <Button onClick={() => { reset(); setOpen(true) }}>
                <Repeat className="h-4 w-4" /> Propose swap
              </Button>
            </PermissionGate>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Total swaps" value={swaps.length} hint="all time" icon={ArrowLeftRight} />
        <KpiCard label="Auto-approved" value={autoCount} hint="SL-neutral, applied instantly" tone="good" icon={CheckCircle2} />
        <KpiCard label="Pending approval" value={pendingCount} hint="escalated to Team Leader" tone={pendingCount ? "warn" : undefined} icon={Clock3} />
        <KpiCard label="Auto-approve rule" value="−0.5pp" hint="max allowed SL drop" icon={ShieldAlert} />
      </div>

      <Card className="glass">
        <CardContent className="pt-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>SL impact</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {swaps.map((s) => {
                const a = byId[s.fromAgentId]
                const b = byId[s.toAgentId]
                return (
                  <TableRow key={s.id}>
                    <TableCell className="text-left">
                      <div className="font-medium">{a?.name ?? s.fromAgentId}</div>
                      <div className="text-xs text-muted-foreground">{a?.shift}</div>
                    </TableCell>
                    <TableCell className="text-left">
                      <div className="font-medium">{b?.name ?? s.toAgentId}</div>
                      <div className="text-xs text-muted-foreground">{b?.shift}</div>
                    </TableCell>
                    <TableCell>
                      <span className={s.slImpact < -0.005 ? "font-semibold text-destructive" : "text-emerald-500"}>
                        {s.slImpact >= 0 ? "+" : ""}{(s.slImpact * 100).toFixed(2)}pp
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={variant[s.status]}>{s.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {s.status === "Pending" ? (
                        <PermissionGate module="swaps" fallback={<span className="text-xs text-muted-foreground">—</span>}>
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="outline" onClick={() => setSwapStatus(s.id, "Approved")}>Approve</Button>
                            <Button size="sm" variant="ghost" onClick={() => setSwapStatus(s.id, "Denied")}>Deny</Button>
                          </div>
                        </PermissionGate>
                      ) : (
                        <span className="text-xs text-muted-foreground">{s.applied ? "shifts exchanged" : "—"}</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
              {swaps.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No swap requests yet. Agents propose a swap; harmless ones apply themselves.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Propose shift swap"
        description="The engine simulates the exchange against the live Erlang C plan. SL-neutral swaps apply immediately; anything riskier goes to a Team Leader."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit}><Repeat className="h-4 w-4" /> Submit swap</Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Agent A</span>
            <Select value={fromId} onChange={(e) => { setFromId(e.target.value); setError("") }} options={agentOpts} className="w-full" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Agent B</span>
            <Select value={toId} onChange={(e) => { setToId(e.target.value); setError("") }} options={agentOpts} className="w-full" />
          </label>
          {preview && (
            <div className="rounded-lg border bg-background/40 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Projected SL (affected queues)</span>
                <span className="tabular-nums">
                  {fmtPct(preview.before)} → {fmtPct(preview.after)}{" "}
                  <span className={preview.neutral ? "font-semibold text-emerald-500" : "font-semibold text-destructive"}>
                    ({preview.impact >= 0 ? "+" : ""}{(preview.impact * 100).toFixed(2)}pp)
                  </span>
                </span>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {preview.neutral
                  ? "SL-neutral — this swap will auto-approve and apply instantly."
                  : "SL drops beyond the −0.5pp rule — this swap will be escalated to a Team Leader."}
              </p>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </Dialog>
    </>
  )
}
