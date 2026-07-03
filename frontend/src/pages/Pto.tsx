import { useMemo, useState } from "react"
import { CalendarCheck, CalendarClock, CalendarX, PlaneTakeoff } from "lucide-react"

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
import { addDays, daysBetween, TODAY, ymd } from "@/lib/domain/dates"
import type { PtoStatus } from "@/store/wfm"
import { useWfm } from "@/store/wfm"

const TYPES = ["Annual Leave", "Sick", "Personal", "Unpaid", "Bereavement"]
const variant: Record<PtoStatus, "warning" | "success" | "destructive"> = { Pending: "warning", Approved: "success", Denied: "destructive" }

export function Pto() {
  const { agents, ptoRequests, addPtoRequest, setPtoStatus } = useWfm()
  const byId = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents])

  const [open, setOpen] = useState(false)
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "")
  const [type, setType] = useState(TYPES[0])
  const [from, setFrom] = useState(ymd(TODAY))
  const [to, setTo] = useState(ymd(addDays(TODAY, 1)))
  const [error, setError] = useState("")

  const rows = useMemo(
    () => ptoRequests.map((r) => ({ ...r, agentName: byId[r.agentId]?.name ?? r.agentId })),
    [ptoRequests, byId],
  )
  const pending = rows.filter((r) => r.status === "Pending").length
  const approved = rows.filter((r) => r.status === "Approved").length
  const onLeaveToday = rows.filter((r) => r.status === "Approved" && r.from <= ymd(TODAY) && r.to >= ymd(TODAY)).length

  function reset() {
    setAgentId(agents[0]?.id ?? "")
    setType(TYPES[0])
    setFrom(ymd(TODAY))
    setTo(ymd(addDays(TODAY, 1)))
    setError("")
  }

  function submit() {
    if (!agentId) return setError("Select an employee.")
    if (to < from) return setError("End date must be on or after the start date.")
    const days = daysBetween(new Date(from), new Date(to)) + 1
    addPtoRequest({ agentId, type, from, to, days })
    reset()
    setOpen(false)
  }

  return (
    <>
      <PageHeader
        title="PTO & Leave Management"
        subtitle="Requests · balances · approvals"
        actions={
          <>
            <ExportButton
              filename="pto-leave"
              sheets={() => [
                { name: "Leave Requests", rows: rows.map((r) => ({ Employee: r.agentName, Type: r.type, From: r.from, To: r.to, Days: r.days, Status: r.status })) },
              ]}
            />
            <PermissionGate module="pto">
              <Button onClick={() => { reset(); setOpen(true) }}>
                <PlaneTakeoff className="h-4 w-4" /> New request
              </Button>
            </PermissionGate>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Pending" value={pending} hint="awaiting approval" tone="warn" icon={CalendarClock} />
        <KpiCard label="Approved" value={approved} hint="this month" tone="good" icon={CalendarCheck} />
        <KpiCard label="On leave today" value={onLeaveToday} hint="impacts coverage" icon={CalendarX} />
        <KpiCard label="Avg balance" value="14.5d" hint="annual entitlement" icon={PlaneTakeoff} />
      </div>

      <Card className="glass">
        <CardContent className="pt-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Days</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-left font-medium">{r.agentName}</TableCell>
                  <TableCell>{r.type}</TableCell>
                  <TableCell className="tabular-nums">{r.from}</TableCell>
                  <TableCell className="tabular-nums">{r.to}</TableCell>
                  <TableCell>{r.days}</TableCell>
                  <TableCell>
                    <Badge variant={variant[r.status]}>{r.status}</Badge>
                  </TableCell>
                  <TableCell>
                    {r.status === "Pending" ? (
                      <PermissionGate module="pto" fallback={<span className="text-xs text-muted-foreground">—</span>}>
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" onClick={() => setPtoStatus(r.id, "Approved")}>Approve</Button>
                          <Button size="sm" variant="ghost" onClick={() => setPtoStatus(r.id, "Denied")}>Deny</Button>
                        </div>
                      </PermissionGate>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No leave requests yet.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New leave request"
        description="Submitted requests start as Pending until a Team Leader or Operations Manager approves them."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit}><PlaneTakeoff className="h-4 w-4" /> Submit request</Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Employee</span>
            <Select value={agentId} onChange={(e) => { setAgentId(e.target.value); setError("") }} options={agents.map((a) => ({ value: a.id, label: `${a.name} · ${a.team}` }))} className="w-full" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Leave type</span>
            <Select value={type} onChange={(e) => setType(e.target.value)} options={TYPES.map((t) => ({ value: t, label: t }))} className="w-full" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">From</span>
              <input
                type="date"
                value={from}
                min={ymd(TODAY)}
                onChange={(e) => { setFrom(e.target.value); setError("") }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">To</span>
              <input
                type="date"
                value={to}
                min={from}
                onChange={(e) => { setTo(e.target.value); setError("") }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm [color-scheme:dark] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </Dialog>
    </>
  )
}
