import { useRef, useState } from "react"
import * as XLSX from "xlsx"
import { AlertTriangle, CheckCircle2, Copy, FileDown, ShieldCheck, Trash2, Upload, XCircle } from "lucide-react"

import { PermissionGate } from "@/components/permission-gate"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, type ApiError } from "@/lib/api"
import { SERVER_ROLE_MAP } from "@/lib/auth"
import { THRESHOLD_META } from "@/lib/domain/automation"
import { type AccessLevel, effectiveLevel, MODULES, ROLE_DESCRIPTIONS, ROLES, type Role } from "@/lib/domain/roles"
import {
  downloadEmployeeImportTemplate,
  parseEmployeeImportFile,
  type EmployeeImportRow,
} from "@/lib/employeeImport"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface BulkImportRowResult {
  row: number
  status: "created" | "error"
  employee_code?: string
  email?: string
  full_name?: string
  role?: string
  team_matched?: boolean
  temp_password?: string
  error?: string
}
interface BulkImportResult {
  total: number
  created: number
  failed: number
  results: BulkImportRowResult[]
}

const NEXT: Record<AccessLevel, AccessLevel> = { none: "view", view: "edit", edit: "none" }
const CELL_STYLE: Record<AccessLevel, string> = {
  none: "text-muted-foreground/30",
  view: "bg-primary/10 text-primary",
  edit: "bg-emerald-500/15 text-emerald-500",
}
const CELL_LABEL: Record<AccessLevel, string> = { none: "—", view: "View", edit: "Edit" }

export function Settings() {
  const {
    permissions, setPermission, can, users, inviteUser, setUserRole, removeUser,
    thresholds, setThreshold, addAgent, shiftPatterns,
  } = useWfm()
  const editable = can("settings", "edit")

  // invite-user form state
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("Agent")
  const [error, setError] = useState("")

  function resetForm() {
    setName("")
    setEmail("")
    setRole("Agent")
    setError("")
  }

  function submit() {
    if (!name.trim()) return setError("Name is required.")
    if (!EMAIL_RE.test(email.trim())) return setError("Enter a valid email address.")
    if (users.some((u) => u.email.toLowerCase() === email.trim().toLowerCase())) {
      return setError("A user with that email already exists.")
    }
    inviteUser({ name: name.trim(), email: email.trim().toLowerCase(), role })
    resetForm()
    setOpen(false)
  }

  // bulk employee import — real backend accounts (Employee + linked User),
  // see lib/employeeImport.ts and POST /employees/bulk-import.
  const bulkFileRef = useRef<HTMLInputElement>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkRows, setBulkRows] = useState<EmployeeImportRow[]>([])
  const [bulkParseErrors, setBulkParseErrors] = useState<string[]>([])
  const [bulkFileName, setBulkFileName] = useState("")
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkApiError, setBulkApiError] = useState("")
  const [bulkResult, setBulkResult] = useState<BulkImportResult | null>(null)

  function resetBulk() {
    setBulkRows([])
    setBulkParseErrors([])
    setBulkFileName("")
    setBulkApiError("")
    setBulkResult(null)
  }

  async function onBulkFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    setBulkResult(null)
    setBulkApiError("")
    setBulkFileName(file.name)
    const { rows, errors } = await parseEmployeeImportFile(file)
    setBulkRows(rows)
    setBulkParseErrors(errors)
  }

  async function submitBulkImport() {
    if (!bulkRows.length) return
    setBulkBusy(true)
    setBulkApiError("")
    try {
      const res = await api.post("/employees/bulk-import", { rows: bulkRows })
      const result = res.data.data as BulkImportResult
      setBulkResult(result)
      // Mirror successful rows into this demo's own roster/RBAC preview so
      // they show up immediately in Scheduling/Adherence/Settings > Users —
      // the real accounts already exist on the backend regardless.
      result.results.forEach((r, i) => {
        if (r.status !== "created") return
        const source = bulkRows[i]
        addAgent({
          name: r.full_name ?? `${source.first_name} ${source.last_name ?? ""}`.trim(),
          skills: [],
          shiftPatternId: shiftPatterns[0]?.id ?? "",
          team: source.team || "Imported",
        })
        const frontendRole = (r.role && SERVER_ROLE_MAP[r.role]) || "Agent"
        if (r.email && !users.some((u) => u.email.toLowerCase() === r.email!.toLowerCase())) {
          inviteUser({ name: r.full_name ?? source.first_name, email: r.email, role: frontendRole })
        }
      })
    } catch (err) {
      setBulkApiError((err as ApiError).message ?? "Import failed — is the backend running?")
    } finally {
      setBulkBusy(false)
    }
  }

  function downloadCredentials() {
    if (!bulkResult) return
    const created = bulkResult.results.filter((r) => r.status === "created")
    const ws = XLSX.utils.json_to_sheet(
      created.map((r) => ({
        Email: r.email, "Temporary Password": r.temp_password, Role: r.role,
        "Employee Code": r.employee_code,
      })),
    )
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, "Credentials")
    XLSX.writeFile(wb, "new-employee-credentials.xlsx")
  }

  return (
    <>
      <PageHeader
        title="Settings & RBAC"
        subtitle="Users · designation-level access · organisation"
        actions={
          <PermissionGate module="settings">
            <Button variant="outline" onClick={() => { resetBulk(); setBulkOpen(true) }}>
              <Upload className="h-4 w-4" /> Bulk import employees
            </Button>
            <Button onClick={() => { resetForm(); setOpen(true) }}>
              <ShieldCheck className="h-4 w-4" /> Invite user
            </Button>
          </PermissionGate>
        }
      />

      <Tabs defaultValue="roles">
        <TabsList>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="roles">Roles & Permissions</TabsTrigger>
          <TabsTrigger value="thresholds">Thresholds</TabsTrigger>
          <TabsTrigger value="org">Organisation</TabsTrigger>
        </TabsList>

        <TabsContent value="thresholds">
          <Card className="glass max-w-3xl">
            <CardHeader>
              <CardTitle>Automation thresholds</CardTitle>
              <p className="text-sm text-muted-foreground">
                These drive the rules engine: reforecast triggers, variance alerts, adherence flagging and auto-approvals.
                Every change is written to the audit trail.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {THRESHOLD_META.map((meta) => {
                const raw = thresholds[meta.key]
                const shown = meta.kind === "pct" ? Math.round(raw * 100) : raw
                return (
                  <div key={meta.key} className="flex flex-wrap items-center gap-3 border-b pb-3 last:border-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{meta.label}</div>
                      <p className="text-xs text-muted-foreground">{meta.help}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        disabled={!editable}
                        className="h-8 w-24 tabular-nums"
                        min={meta.kind === "pct" ? meta.min * 100 : meta.min}
                        max={meta.kind === "pct" ? meta.max * 100 : meta.max}
                        step={meta.kind === "pct" ? meta.step * 100 : meta.step}
                        value={shown}
                        onChange={(e) => {
                          const v = +e.target.value
                          if (Number.isFinite(v)) setThreshold(meta.key, meta.kind === "pct" ? v / 100 : v)
                        }}
                      />
                      <span className="w-14 text-xs text-muted-foreground">
                        {meta.kind === "pct" ? "%" : meta.kind === "mins" ? "minutes" : "SL pp"}
                      </span>
                    </div>
                  </div>
                )
              })}
              {!editable && <Badge variant="secondary">read-only for your designation</Badge>}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="users">
          <Card className="glass">
            <CardContent className="pt-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Designation</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="text-left">
                        <div className="font-medium">{u.name}</div>
                        <div className="text-xs text-muted-foreground">{u.email}</div>
                      </TableCell>
                      <TableCell>
                        {editable ? (
                          <Select
                            value={u.role}
                            onChange={(e) => setUserRole(u.id, e.target.value as Role)}
                            options={ROLES.map((r) => ({ value: r, label: r }))}
                            className="h-8 text-xs"
                          />
                        ) : (
                          u.role
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={u.status === "Active" ? "success" : "warning"}>{u.status}</Badge>
                      </TableCell>
                      <TableCell>
                        <PermissionGate module="settings" fallback={<span className="text-xs text-muted-foreground">—</span>}>
                          <Button size="sm" variant="ghost" onClick={() => removeUser(u.id)} aria-label={`Remove ${u.name}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </PermissionGate>
                      </TableCell>
                    </TableRow>
                  ))}
                  {users.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No users yet — invite the first one.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="roles">
          <Card className="glass mb-4">
            <CardContent className="grid gap-x-6 gap-y-2 pt-5 sm:grid-cols-2 lg:grid-cols-3">
              {ROLES.map((r) => (
                <div key={r} className="text-xs">
                  <span className="font-semibold text-foreground">{r}</span>
                  <span className="text-muted-foreground"> — {ROLE_DESCRIPTIONS[r]}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="glass">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Permission matrix</CardTitle>
              {!editable && <Badge variant="secondary">read-only for your designation</Badge>}
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-sm text-muted-foreground">
                {editable ? "Click a cell to cycle none → view → edit." : "Switch to a designation with Settings edit access to change this matrix."}
              </p>
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left text-xs font-semibold uppercase">Designation</th>
                      {MODULES.map((m) => (
                        <th key={m.id} className="whitespace-nowrap px-2 py-2 text-center text-[10px] font-semibold uppercase">{m.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ROLES.map((role) => (
                      <tr key={role} className="border-b hover:bg-muted/30">
                        <td className="sticky left-0 z-10 bg-card px-3 py-1.5 font-medium">{role}</td>
                        {MODULES.map((m) => {
                          const level = effectiveLevel(permissions, role, m.id)
                          return (
                            <td key={m.id} className="p-1 text-center">
                              <button
                                type="button"
                                disabled={!editable}
                                onClick={() => setPermission(role, m.id, NEXT[level])}
                                className={cn(
                                  "w-14 rounded-md px-1.5 py-1 text-[10px] font-semibold transition-colors",
                                  CELL_STYLE[level],
                                  editable ? "hover:brightness-125" : "cursor-default",
                                )}
                              >
                                {CELL_LABEL[level]}
                              </button>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="org">
          <Card className="glass max-w-xl">
            <CardHeader>
              <CardTitle>Organisation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Organisation" value="FlowForce Contact Centre" />
              <Row label="Plan" value="Enterprise" />
              <Row label="Timezone" value="UTC" />
              <Row label="Service window" value="07:00 – 19:00" />
              <Row label="Interval length" value="30 minutes" />
              <Row label="Default shrinkage" value="25%" />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title="Bulk import employees"
        description="Each row creates a real backend account — an Employee roster record and a linked User login with a generated temporary password. Requires the backend API to be running."
        className="max-w-2xl"
        footer={
          bulkResult ? (
            <>
              <Button variant="outline" onClick={downloadCredentials} disabled={!bulkResult.created}>
                <FileDown className="h-4 w-4" /> Download credentials
              </Button>
              <Button onClick={() => setBulkOpen(false)}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setBulkOpen(false)}>Cancel</Button>
              <Button onClick={submitBulkImport} disabled={!bulkRows.length || bulkBusy}>
                <Upload className="h-4 w-4" /> {bulkBusy ? "Importing…" : `Import ${bulkRows.length || ""} employee${bulkRows.length === 1 ? "" : "s"}`}
              </Button>
            </>
          )
        }
      >
        <div className="space-y-4">
          {!bulkResult && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={bulkFileRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={onBulkFile}
                />
                <Button variant="outline" onClick={() => downloadEmployeeImportTemplate()}>
                  <FileDown className="h-4 w-4" /> Download template
                </Button>
                <Button variant="outline" onClick={() => bulkFileRef.current?.click()}>
                  <Upload className="h-4 w-4" /> Choose file
                </Button>
                {bulkFileName && <span className="text-xs text-muted-foreground">{bulkFileName}</span>}
              </div>

              {bulkParseErrors.length > 0 && (
                <div className="max-h-32 space-y-1 overflow-auto rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
                  {bulkParseErrors.map((e, i) => <p key={i}>{e}</p>)}
                </div>
              )}
              {bulkRows.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {bulkRows.length} row{bulkRows.length === 1 ? "" : "s"} parsed and ready to import
                  {bulkParseErrors.length > 0 && ` (${bulkParseErrors.length} row${bulkParseErrors.length === 1 ? "" : "s"} skipped — see above)`}.
                </p>
              )}
              {bulkApiError && (
                <p className="flex items-center gap-1.5 text-sm text-destructive">
                  <AlertTriangle className="h-4 w-4 shrink-0" /> {bulkApiError}
                </p>
              )}
            </>
          )}

          {bulkResult && (
            <>
              <div className="flex items-center gap-3 text-sm">
                <Badge variant="success">{bulkResult.created} created</Badge>
                {bulkResult.failed > 0 && <Badge variant="destructive">{bulkResult.failed} failed</Badge>}
                <span className="text-muted-foreground">of {bulkResult.total} rows</span>
              </div>
              <div className="max-h-80 space-y-1.5 overflow-auto pr-1">
                {bulkResult.results.map((r) => (
                  <div key={r.row} className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
                    {r.status === "created"
                      ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-500" />
                      : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{r.email ?? `Row ${r.row}`}</div>
                      {r.status === "created" ? (
                        <div className="truncate text-xs text-muted-foreground">
                          {r.role} · {r.employee_code}
                          {r.team_matched === false && " · team not matched"}
                        </div>
                      ) : (
                        <div className="truncate text-xs text-destructive">{r.error}</div>
                      )}
                    </div>
                    {r.status === "created" && r.temp_password && (
                      <button
                        type="button"
                        title="Copy temporary password"
                        onClick={() => navigator.clipboard.writeText(r.temp_password!)}
                        className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 font-mono text-xs text-muted-foreground hover:bg-accent"
                      >
                        <Copy className="h-3 w-3" /> {r.temp_password}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Temporary passwords are shown once, here, and never stored in this browser — download or copy them now.
              </p>
            </>
          )}
        </div>
      </Dialog>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Invite user"
        description="Invited users appear with Invited status and get the access of their designation immediately."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit}><ShieldCheck className="h-4 w-4" /> Send invite</Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Full name</span>
            <Input value={name} onChange={(e) => { setName(e.target.value); setError("") }} placeholder="e.g. Jordan Blake" autoFocus />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Work email</span>
            <Input type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError("") }} placeholder="jordan.blake@flowforce.io" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Designation</span>
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)} options={ROLES.map((r) => ({ value: r, label: r }))} className="w-full" />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </Dialog>
    </>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}
