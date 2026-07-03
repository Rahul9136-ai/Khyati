import { useMemo, useState } from "react"

import { ExportButton } from "@/components/export-button"
import { PermissionGate } from "@/components/permission-gate"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { History, ShieldCheck, Trash2, UserCog } from "lucide-react"
import type { AuditCategory } from "@/store/wfm"
import { useWfm } from "@/store/wfm"

const CATS: AuditCategory[] = ["Employee", "Schedule", "Forecast", "Real-Time", "Config", "PTO"]
const variant: Record<AuditCategory, "default" | "warning" | "secondary" | "success" | "outline"> = {
  Employee: "default",
  Schedule: "warning",
  Forecast: "secondary",
  "Real-Time": "success",
  Config: "outline",
  PTO: "warning",
}
const fmtTs = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })

export function Audit() {
  const { auditLog, currentUser, clearAudit } = useWfm()
  const [q, setQ] = useState("")
  const [cat, setCat] = useState<string>("all")

  const rows = useMemo(
    () =>
      auditLog.filter(
        (e) =>
          (cat === "all" || e.category === cat) &&
          (q === "" ||
            `${e.user} ${e.action} ${e.detail} ${e.category}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [auditLog, q, cat],
  )
  const today = auditLog.filter((e) => Date.now() - e.ts < 86_400_000).length
  const users = new Set(auditLog.map((e) => e.user)).size

  return (
    <>
      <PageHeader
        title="Audit Trail"
        subtitle="Who changed what, and when — full change history"
        actions={
          <>
            <ExportButton
              filename="audit-trail"
              sheets={() => [
                {
                  name: "Audit Trail",
                  rows: rows.map((e) => ({
                    Timestamp: new Date(e.ts).toISOString(),
                    User: e.user,
                    Category: e.category,
                    Action: e.action,
                    Detail: e.detail,
                  })),
                },
              ]}
            />
            <PermissionGate module="audit">
              <Button variant="outline" onClick={() => confirm("Clear all audit entries?") && clearAudit()}>
                <Trash2 className="h-4 w-4" /> Clear
              </Button>
            </PermissionGate>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Total events" value={auditLog.length} hint="all time" icon={History} />
        <KpiCard label="Last 24h" value={today} hint="recent activity" tone="good" icon={ShieldCheck} />
        <KpiCard label="Active users" value={users} hint="making changes" icon={UserCog} />
        <KpiCard label="Signed in as" value={currentUser.split(" ")[0]} hint={currentUser} icon={UserCog} />
      </div>

      <Card className="glass">
        <CardContent className="pt-5">
          <div className="mb-4 flex flex-wrap gap-2">
            <Input placeholder="Search user, action, detail…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
            <Select
              value={cat}
              onChange={(e) => setCat(e.target.value)}
              options={[{ value: "all", label: "All categories" }, ...CATS.map((c) => ({ value: c, label: c }))]}
            />
            <span className="ml-auto self-center text-xs text-muted-foreground">{rows.length} of {auditLog.length} entries</span>
          </div>
          <div className="max-h-[60vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead className="!text-left">User</TableHead>
                  <TableHead className="!text-left">Category</TableHead>
                  <TableHead className="!text-left">Action</TableHead>
                  <TableHead className="!text-left">Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">{fmtTs(e.ts)}</TableCell>
                    <TableCell className="!text-left font-medium">{e.user}</TableCell>
                    <TableCell className="!text-left"><Badge variant={variant[e.category]}>{e.category}</Badge></TableCell>
                    <TableCell className="!text-left">{e.action}</TableCell>
                    <TableCell className="!text-left text-muted-foreground">{e.detail}</TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No matching audit entries.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  )
}
