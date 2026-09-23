import { useQuery } from "@tanstack/react-query"
import { Bot, CheckCircle2, ChevronDown, Copy, MessageSquareText, Send, Sparkles, TriangleAlert } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"

import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { TODAY, ymd } from "@/lib/domain/dates"
import { getConfig, raiseApproval, type Approval, type ApprovalSource } from "@/lib/integrations"
import {
  apiErrorMessage, approvalFromRequest, DEFAULT_VALUE_FOR_ACTION, FIELD_FOR_ACTION, parseScheduleRequest,
  SCHEDULE_ACTIONS, type ParseResult, type ParsedRequest, type ScheduleAction,
} from "@/lib/scheduleRequest"
import { cn } from "@/lib/utils"
import { useAuth } from "@/store/auth"
import { useWfm } from "@/store/wfm"

const EXAMPLE = "Priya Sharma (ID E1004) called in sick today"

/** Whether the inbound Slack/Teams automation is live, for the status strip below —
 *  only fetched for roles that hold `integration:manage` (the same gate the Settings
 *  page uses), so most designations just see the paste box with no extra call. */
function useAutomationStatus() {
  const canSeeConfig = useAuth((s) => s.user?.permission_codes.includes("integration:manage") ?? false)
  return useQuery({ queryKey: ["integration-config"], queryFn: getConfig, enabled: canSeeConfig, retry: false })
}

/**
 * Paste a schedule-change message → see it parsed into structured fields → fix anything
 * wrong → raise it for Operations Manager approval. Used on both the Scheduling and the
 * Real-Time tab; `source` decides which one the approval is raised from.
 */
export function ScheduleRequestCard({ source }: { source: ApprovalSource }) {
  const agents = useWfm((s) => s.agents)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState<"parse" | "raise" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ParseResult | null>(null)
  const [form, setForm] = useState<ParsedRequest | null>(null)
  const [raised, setRaised] = useState<Approval | null>(null)
  const [copied, setCopied] = useState(false)

  const tab = source === "intraday" ? "Real-Time" : "Scheduling"
  const { data: config } = useAutomationStatus()
  const automationLive = !!config?.automation_enabled && !!(config.slack_command_channel || config.teams_command_channel)

  async function parse() {
    setBusy("parse"); setError(null); setRaised(null)
    try {
      const r = await parseScheduleRequest(message, ymd(TODAY)) // the app's "today", not the server's
      setResult(r)
      setForm(r.parsed)
    } catch (e) {
      setError(apiErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function raise() {
    if (!form || !result) return
    setBusy("raise"); setError(null)
    try {
      setRaised(await raiseApproval(approvalFromRequest(form, source, { parser: result.parser, employeeUuid: result.matched_employee?.id })))
    } catch (e) {
      setError(apiErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  function reset() {
    setMessage(""); setResult(null); setForm(null); setRaised(null); setError(null)
  }

  const set = <K extends keyof ParsedRequest>(k: K, v: ParsedRequest[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))
  function setAction(a: ScheduleAction) {
    setForm((f) => (f ? { ...f, action: a, field_to_change: FIELD_FOR_ACTION[a], new_value: DEFAULT_VALUE_FOR_ACTION[a] } : f))
  }

  // is the parsed person on the roster this tab is showing? (informational — the ID is never guessed)
  const rosterMatch = useMemo(() => {
    if (!form) return null
    const id = form.employee_id?.toLowerCase()
    const byId = id ? agents.find((a) => a.id.toLowerCase() === id) : undefined
    if (byId) return { agent: byId, exact: true }
    const name = form.employee_name?.toLowerCase()
    const byName = name ? agents.find((a) => a.name.toLowerCase() === name) : undefined
    return byName ? { agent: byName, exact: false } : null
  }, [agents, form])

  const idMissing = !form?.employee_id?.trim()
  const canRaise = !!form && !idMissing && !busy && !raised
  const json = form ? JSON.stringify(form, null, 2) : ""

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable — the JSON is visible below anyway */ }
  }

  return (
    <PermissionGate module="approvals">
      <Card className="glass mb-4">
        {config && (
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
            <Bot className="h-3.5 w-3.5 text-muted-foreground" />
            {automationLive ? (
              <>
                <Badge variant="success">Automation connected</Badge>
                <span className="text-muted-foreground">
                  @mention the bot in{" "}
                  {[config.slack_command_channel && "Slack", config.teams_command_channel && "Teams"].filter(Boolean).join(" / ")}{" "}
                  and it's parsed automatically — {config.auto_apply_min_confidence === "Off"
                    ? "always sent to the OM (auto-apply is off)"
                    : `${config.auto_apply_min_confidence.toLowerCase()}-confidence requests apply immediately`}, with a
                  reply in the same thread either way.
                </span>
              </>
            ) : (
              <>
                <Badge variant="outline">Automation not connected</Badge>
                <span className="text-muted-foreground">Only the paste box below works right now.</span>
              </>
            )}
            <Link to="/settings" className="ml-auto shrink-0 underline underline-offset-2">
              Configure in Settings → Integrations
            </Link>
          </div>
        )}
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <button className="flex flex-1 items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
            <CardTitle className="flex items-center gap-2">
              <MessageSquareText className="h-4 w-4 text-primary" /> Schedule change request
            </CardTitle>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Paste a message (leave, sickness, swap, shift change) → parse → send for OM approval
            </span>
            <ChevronDown className={cn("ml-auto h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
          </button>
        </CardHeader>

        {open && (
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Textarea
                rows={3}
                value={message}
                maxLength={2000}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={`e.g. "${EXAMPLE}"`}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={!message.trim() || busy !== null} onClick={parse}>
                  <Sparkles className="h-4 w-4" /> {busy === "parse" ? "Parsing…" : "Parse message"}
                </Button>
                <Button variant="ghost" onClick={() => setMessage(EXAMPLE)}>Use example</Button>
                {(result || message) && <Button variant="ghost" onClick={reset}>Clear</Button>}
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
              </div>
            )}

            {raised && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/40 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                Sent to the Operations Manager for approval from {tab}.
                <Link to={`/approvals?focus=${raised.id}`} className="ml-auto underline underline-offset-2">Open in Approvals</Link>
              </div>
            )}

            {form && result && !raised && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant={form.confidence === "High" ? "success" : form.confidence === "Medium" ? "warning" : "destructive"}>
                    {form.confidence} confidence
                  </Badge>
                  <Badge variant="outline">parsed by {result.parser === "claude" ? "Claude" : "rules"}</Badge>
                  {result.matched_employee && (
                    <Badge variant="success">directory: {result.matched_employee.name} ({result.matched_employee.employee_code})</Badge>
                  )}
                  {rosterMatch && (
                    <Badge variant={rosterMatch.exact ? "success" : "warning"}>
                      {rosterMatch.exact ? "on roster" : `name matches roster agent ${rosterMatch.agent.id}`}: {rosterMatch.agent.name} · {rosterMatch.agent.team}
                    </Badge>
                  )}
                </div>

                {idMissing && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 px-3 py-2 text-sm text-amber-600 dark:text-amber-500">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    No employee ID was found in the message, so none was guessed. Enter the ID below to send this for approval.
                  </div>
                )}
                {!idMissing && !result.matched_employee && !rosterMatch && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 px-3 py-2 text-sm text-amber-600 dark:text-amber-500">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    “{form.employee_id}” isn't in the employee directory or on this roster — check the ID. It will still be sent with the ID in the request details.
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Employee name">
                    <Input value={form.employee_name ?? ""} onChange={(e) => set("employee_name", e.target.value || null)} />
                  </Field>
                  <Field label="Employee ID">
                    <Input value={form.employee_id ?? ""} onChange={(e) => set("employee_id", e.target.value.trim() || null)} className={cn(idMissing && "border-amber-500/60")} />
                  </Field>
                  <Field label="Action">
                    <Select value={form.action} onChange={(e) => setAction(e.target.value as ScheduleAction)} options={SCHEDULE_ACTIONS.map((a) => ({ value: a, label: a }))} className="w-full" />
                  </Field>
                  <Field label="Date or week">
                    <Input value={form.date_or_week ?? ""} onChange={(e) => set("date_or_week", e.target.value || null)} placeholder="2026-07-03 or WK-3" />
                  </Field>
                  <Field label="Field to change">
                    <Input value={form.field_to_change} onChange={(e) => set("field_to_change", e.target.value)} />
                  </Field>
                  <Field label="New value">
                    <Input value={form.new_value} onChange={(e) => set("new_value", e.target.value)} />
                  </Field>
                </div>

                <details className="rounded-lg border px-3 py-2 text-xs">
                  <summary className="cursor-pointer select-none text-muted-foreground">Parsed JSON</summary>
                  <div className="mt-2 flex items-start gap-2">
                    <pre className="max-h-56 flex-1 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-[11px]">{json}</pre>
                    <Button variant="outline" size="sm" onClick={copyJson}><Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}</Button>
                  </div>
                </details>

                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={!canRaise} onClick={raise}>
                    <Send className="h-4 w-4" /> {busy === "raise" ? "Sending…" : `Send for OM approval (${tab})`}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Nothing changes on the roster until the Operations Manager approves.
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </PermissionGate>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}
