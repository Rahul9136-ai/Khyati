import { CheckCircle2, ClipboardPaste, FileDown, Upload, XCircle } from "lucide-react"
import { useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { fmtDuration } from "@/lib/domain/labourLaw"
import { describeBreaks, describeWeekOff } from "@/lib/domain/workRules"
import { cn } from "@/lib/utils"
import {
  downloadWorkRuleTemplate,
  readPastedRows,
  readWorkRuleFile,
  resolveAgentRows,
  resolveRuleRows,
  type AgentImportRow,
  type RuleImportRow,
} from "@/lib/workRuleImport"
import { useWfm } from "@/store/wfm"

type Parsed = { source: string; rules: RuleImportRow[]; agents: AgentImportRow[] }

function Status({ ok, reason }: { ok: boolean; reason?: string }) {
  return ok
    ? <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> OK</span>
    : <span className="inline-flex items-center gap-1 text-destructive"><XCircle className="h-3.5 w-3.5 shrink-0" /> {reason}</span>
}

/** Bulk-add work rules and agents' rule / start / week off from Excel, CSV or pasted rows. */
export function WorkRuleImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (text: string) => void }) {
  const { agents, workRules, importWorkRules } = useWfm()
  const fileRef = useRef<HTMLInputElement>(null)
  const [pasted, setPasted] = useState("")
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [error, setError] = useState<string | null>(null)

  function resolve(source: string, raw: { rules: Record<string, unknown>[]; agents: Record<string, unknown>[] }) {
    const rules = resolveRuleRows(raw.rules, workRules)
    // Agents can use rules from the app and ones this file adds or changes.
    const known = new Map(workRules.map((r) => [r.name.toLowerCase(), { id: r.id, name: r.name, rule: r }]))
    for (const r of rules) {
      if (!r.ok) continue
      known.set(r.name.toLowerCase(), { id: r.existingId ?? `new:${r.name.toLowerCase()}`, name: r.name, rule: { ...r.rule!, id: r.existingId ?? "" } })
    }
    const all = [...known.values()].map((k) => ({ id: k.id, name: k.name, rule: k.rule }))
    const agentRows = resolveAgentRows(raw.agents, agents, all)
    if (!rules.length && !agentRows.length) {
      setParsed(null)
      setError(`Nothing to import in ${source} — fill the Work rules sheet (Name, Shift Hours, Breaks…) and/or the Agents sheet (Agent ID, Work Rule, Week Off…).`)
      return
    }
    setError(null)
    setParsed({ source, rules, agents: agentRows })
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    try {
      resolve(file.name, await readWorkRuleFile(file))
    } catch (err) {
      setParsed(null)
      setError(`Could not read ${file.name}: ${(err as Error).message}`)
    }
  }

  function onPaste() {
    try {
      resolve("the pasted rows", readPastedRows(pasted))
    } catch (err) {
      setParsed(null)
      setError(`Could not read the pasted rows: ${(err as Error).message}`)
    }
  }

  const okRules = parsed?.rules.filter((r) => r.ok) ?? []
  const okAgents = parsed?.agents.filter((r) => r.ok) ?? []
  const bad = (parsed?.rules.filter((r) => !r.ok).length ?? 0) + (parsed?.agents.filter((r) => !r.ok).length ?? 0)

  function doImport() {
    importWorkRules(
      okRules.map((r) => ({ existingId: r.existingId, rule: r.rule! })),
      okAgents.map((r) => ({ agentId: r.agent!.id, ruleId: r.ruleId, start: r.start, weekOff: r.weekOff, weekOffMode: r.weekOffMode })),
    )
    const added = okRules.filter((r) => !r.existingId).length
    onImported(
      [
        added && `${added} new work rule${added === 1 ? "" : "s"}`,
        okRules.length - added && `${okRules.length - added} rule${okRules.length - added === 1 ? "" : "s"} updated`,
        okAgents.length && `${okAgents.length} agent${okAgents.length === 1 ? "" : "s"} set`,
      ].filter(Boolean).join(" · ") +
        (bad ? ` (${bad} row${bad === 1 ? "" : "s"} skipped)` : "") +
        ". Use “Apply to schedules” to write them into days already saved.",
    )
    setParsed(null)
    setPasted("")
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Bulk import work rules & week offs"
      description="Add or change many work rules, and set many agents' rule, start time and week off at once, from Excel / CSV or rows pasted from a spreadsheet."
      className="max-w-4xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!okRules.length && !okAgents.length} onClick={doImport}>
            Import {okRules.length ? `${okRules.length} rule${okRules.length === 1 ? "" : "s"}` : ""}{okRules.length && okAgents.length ? " and " : ""}{okAgents.length ? `${okAgents.length} agent${okAgents.length === 1 ? "" : "s"}` : ""}
          </Button>
        </>
      }
    >
      <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li><b className="text-foreground">Download the template</b> — it already has today's rules and every agent, with a "How to fill" sheet.</li>
          <li>Edit the <b className="text-foreground">Work rules</b> sheet (Name · Shift Hours · Breaks e.g. <i>Break 15; Lunch 30; Break 15</i> · Week Off e.g. <i>Sat, Sun</i> · Fixed / Rotating · Usual Start) and/or the <b className="text-foreground">Agents</b> sheet (Work Rule · Start · Week Off · Fixed / Rotating). Blank agent rows are left as they are.</li>
          <li><b className="text-foreground">Upload</b> it, or paste rows copied from Excel (with the header row) below. Check the preview, then import.</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => downloadWorkRuleTemplate(agents, workRules)}><FileDown className="h-4 w-4" /> Download template</Button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" aria-label="Work rules file" onChange={onFile} />
          <Button onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" /> Upload filled file</Button>
        </div>
        <div className="space-y-1.5">
          <Textarea
            aria-label="Paste rows"
            rows={4}
            className="font-mono text-xs"
            placeholder={"Agent ID\tWork Rule\tStart\tWeek Off\tWeek Off Type\na01\t9h · 1h lunch + 2×15m breaks\t08:00\tSat, Sun\tFixed"}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <Button size="sm" variant="outline" disabled={!pasted.trim()} onClick={onPaste}><ClipboardPaste className="h-3.5 w-3.5" /> Check pasted rows</Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}

        {parsed && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              From {parsed.source}: <b className="text-foreground">{okRules.length + okAgents.length} ready</b>
              {bad > 0 && <span className="text-destructive"> · {bad} with problems (skipped)</span>}
            </p>
            {parsed.rules.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-xs" aria-label="Imported work rules">
                  <thead className="bg-muted/40 text-left text-muted-foreground">
                    <tr><th className="px-3 py-1.5">Row</th><th className="px-3 py-1.5">Work rule</th><th className="px-3 py-1.5">Shift & breaks</th><th className="px-3 py-1.5">Week off</th><th className="px-3 py-1.5">Status</th></tr>
                  </thead>
                  <tbody>
                    {parsed.rules.map((r) => (
                      <tr key={r.row} className={cn("border-t", !r.ok && "bg-destructive/5")}>
                        <td className="px-3 py-1.5 tabular-nums">{r.row}</td>
                        <td className="px-3 py-1.5 font-medium">{r.name || "—"} {r.ok && <span className="font-normal text-muted-foreground">({r.existingId ? "update" : "new"})</span>}</td>
                        <td className="px-3 py-1.5">{r.rule ? `${fmtDuration(r.rule.shiftMinutes)} · ${describeBreaks(r.rule.breaks)} · from ${r.rule.defaultStart}` : ""}</td>
                        <td className="px-3 py-1.5">{r.rule ? describeWeekOff(r.rule.weekOff, r.rule.weekOffMode) : ""}</td>
                        <td className="px-3 py-1.5"><Status ok={r.ok} reason={r.reason} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {parsed.agents.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-xs" aria-label="Imported agents">
                  <thead className="bg-muted/40 text-left text-muted-foreground">
                    <tr><th className="px-3 py-1.5">Row</th><th className="px-3 py-1.5">Agent</th><th className="px-3 py-1.5">Change</th><th className="px-3 py-1.5">Status</th></tr>
                  </thead>
                  <tbody>
                    {parsed.agents.map((r) => (
                      <tr key={r.row} className={cn("border-t", !r.ok && "bg-destructive/5")}>
                        <td className="px-3 py-1.5 tabular-nums">{r.row}</td>
                        <td className="px-3 py-1.5 font-medium">{r.agent?.name ?? r.agentCell}</td>
                        <td className="px-3 py-1.5">{r.summary}</td>
                        <td className="px-3 py-1.5"><Status ok={r.ok} reason={r.reason} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}
