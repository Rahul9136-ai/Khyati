import { Check, Cloud, Copy, ExternalLink, KeyRound, Webhook } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { api } from "@/lib/api"
import { SHEETS } from "@/lib/capacity/schema"
import { useCapacitySync } from "@/lib/capacity/sync"

/** Business keys a CRM can use to find a row (mirrors backend SUGGESTED_KEYS). */
const MATCH_KEYS: Record<string, string> = {
  userMapping: "Emp Id", forecast: "TASK_NUMBER (New) + Location", target: "TaskNo", ramp: "TaskNo + User Type",
  hiring: "RR Number", budgetBuffer: "Customer Name + SL + Location + Month", actualShrinkage: "Customer Name + Service Line + Location",
  actualAttrition: "Desg + Customer Name + Vertical + Location", budgetAttrition: "Customer Name + SL + Location + Month",
  budgetQca: "Customer Name + SL + Month", trainingDays: "Customer Name + Vertical", designationType: "Designation",
  sampling: "User Type + Customer Name + Service Line + Specialty", workingDays: "Month",
}

const EVENTS = [
  ["capacity.inputs.updated", "A sheet was imported, replaced, edited (includes the changed rows) or cleared — in the app or by another tool."],
  ["capacity.config.updated", "The switches changed (includes what changed)."],
  ["capacity.results.updated", "Results were recalculated — monthly Req HC, Projected HC, Capacity %, QCA and volume totals included."],
] as const

function Snippet({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{title}</span>
        <button type="button" className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          onClick={() => { void navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 text-[11px] leading-relaxed"><code>{code}</code></pre>
    </div>
  )
}

export function ConnectView() {
  const base = (api.defaults.baseURL ?? "").replace(/\/$/, "")
  const { status, resultsVersion, lastSyncedAt } = useCapacitySync()
  const [state, setState] = useState<{ sheets: Record<string, { version: number; rows: number; updatedBy: string } | null> } | null>(null)
  const shared = status !== "local"

  useEffect(() => {
    if (!shared) return
    api.get("/capacity/state").then((r) => setState(r.data.data)).catch(() => setState(null))
  }, [shared, resultsVersion])

  const H = `-H "X-API-Key: $WFM_KEY"`
  return (
    <div className="space-y-4">
      <Card className="glass">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm"><Cloud className="h-4 w-4 text-primary" /> Connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <p>
            API base URL: <code className="rounded bg-muted px-1">{base}/capacity</code>
            {" · "}status: <Badge variant={status === "synced" || status === "readonly" ? "success" : status === "local" ? "secondary" : "warning"}>{status}</Badge>
            {lastSyncedAt && <span className="text-muted-foreground"> · last synced {new Date(lastSyncedAt).toLocaleTimeString()}</span>}
            {resultsVersion && <span className="text-muted-foreground"> · results version <code>{resultsVersion}</code></span>}
          </p>
          {!shared && <p className="text-amber-600">You're not signed in to the server, so this plan lives only in this browser and connected tools can't see it.</p>}
          <p className="text-muted-foreground">
            Everything on this tab — the 14 input sheets, the switches and the calculated results — is stored on the server for your
            organisation. A CRM reads and changes the same data through the REST API and hears about every change through webhooks; edits it
            makes show up here within 20 seconds, and edits made here reach it as webhook events within seconds. Results from the API come from
            the same formulas as this screen (checked by automated tests).
          </p>
          {state && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs tabular-nums">
                <thead><tr className="text-left text-muted-foreground"><th className="py-1">Sheet</th><th>Sheet id</th><th className="text-right">Rows</th><th className="text-right">Version</th><th className="pl-3">Last changed by</th><th className="pl-3">Match rows by</th></tr></thead>
                <tbody>
                  {SHEETS.map((s) => {
                    const v = state.sheets[s.id]
                    return (
                      <tr key={s.id} className="border-t border-border/40">
                        <td className="py-1">{s.label}</td><td><code>{s.id}</code></td>
                        <td className="text-right">{v?.rows ?? "—"}</td><td className="text-right">{v?.version ?? "—"}</td>
                        <td className="pl-3 text-muted-foreground">{v?.updatedBy ?? "not loaded"}</td>
                        <td className="pl-3 text-muted-foreground">{MATCH_KEYS[s.id]}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="glass">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><KeyRound className="h-4 w-4 text-primary" /> 1 · Create an API key</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs">
            <p>
              In <Link to="/settings" className="inline-flex items-center gap-0.5 text-primary hover:underline">Settings <ExternalLink className="h-3 w-3" /></Link> → <b>API &amp; Webhooks</b>, create a key with
              {" "}<code>planning:read</code> (read sheets, results, exceptions) and, to send changes, <code>planning:write</code>. It's shown once —
              store it in your CRM as a secret and send it as <code>X-API-Key</code>.
            </p>
            <p className="text-muted-foreground">Full interactive reference: <a className="text-primary hover:underline" href={`${base.replace(/\/api\/v1$/, "")}/docs#/capacity%20planning`} target="_blank" rel="noreferrer">API docs → capacity planning</a>.</p>
          </CardContent>
        </Card>

        <Card className="glass">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Webhook className="h-4 w-4 text-primary" /> 4 · Hear about changes (webhooks)</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs">
            <p>In Settings → API &amp; Webhooks, add your CRM's URL and pick these events (or <code>*</code>):</p>
            <ul className="space-y-1">
              {EVENTS.map(([e, d]) => <li key={e}><code className="font-semibold">{e}</code> — <span className="text-muted-foreground">{d}</span></li>)}
            </ul>
            <p className="text-muted-foreground">
              Each delivery is signed: <code>X-WFM-Signature: sha256=HMAC(secret, "{"{timestamp}.{body}"}")</code> with <code>X-WFM-Timestamp</code>.
              Failed deliveries retry after 30 s, 2 min, 10 min, 1 h and 6 h.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="glass">
        <CardHeader className="pb-2"><CardTitle className="text-sm">2 · Read the plan</CardTitle></CardHeader>
        <CardContent className="grid gap-3 xl:grid-cols-2">
          <Snippet title="Summary for a month (Capacity %, VA, QCA…)" code={`curl ${H} \\\n  "${base}/capacity/results?month=Sep'26&customer=PROJECT%20A"`} />
          <Snippet title="Every P / Q / V field, nested" code={`curl ${H} "${base}/capacity/results?view=full&limit=500"`} />
          <Snippet title="Data Exceptions (errors only)" code={`curl ${H} "${base}/capacity/exceptions?severity=error"`} />
          <Snippet title="Has anything changed? (cheap to poll)" code={`curl ${H} "${base}/capacity/state"\n# → resultsVersion changes whenever the results do`} />
        </CardContent>
      </Card>

      <Card className="glass">
        <CardHeader className="pb-2"><CardTitle className="text-sm">3 · Send changes from your CRM</CardTitle></CardHeader>
        <CardContent className="grid gap-3 xl:grid-cols-2">
          <Snippet title="Update one employee by Emp Id (adds the row if it's new)" code={`curl -X PATCH ${H} -H "Content-Type: application/json" \\
  "${base}/capacity/sheets/userMapping/rows" -d '{
  "upsert": [{ "match": { "Emp Id": "1001" },
               "values": { "City": "Chennai", "Employment Status": "ACTIVE" } }]
}'`} />
          <Snippet title="Open a hiring requisition / remove one" code={`curl -X PATCH ${H} -H "Content-Type: application/json" \\
  "${base}/capacity/sheets/hiring/rows" -d '{
  "upsert": [{ "match": { "RR Number": "RR-2041" }, "values": {
      "Customer Name": "PROJECT A", "SL-As Per EM": "Coding", "Location": "Chennai",
      "Opening": 3, "Designation": "TRAINEE CODER", "Approved Status": "Approved",
      "Status": "OPEN", "Due to delivery month": "Oct'26" } }],
  "deleteMatch": [{ "RR Number": "RR-1999" }]
}'`} />
          <Snippet title="Set a peak target" code={`curl -X PATCH ${H} -H "Content-Type: application/json" \\
  "${base}/capacity/sheets/target/rows" -d '{
  "upsert": [{ "match": { "TaskNo": "CBP1001104-UPMCE-CD-CODS-IPD-04-T024" },
               "values": { "Peak Target Prod": 14 } }]
}'`} />
          <Snippet title="Replace a whole sheet (with the version you read → 409 if someone changed it)" code={`curl -X PUT ${H} -H "Content-Type: application/json" \\
  "${base}/capacity/sheets/workingDays" -d '{
  "rows": [{ "Month": "Sep'\\''26", "Days": 21 }, { "Month": "Oct'\\''26", "Days": 22 }],
  "base_version": 3
}'`} />
          <Snippet title="Change a switch" code={`curl -X PATCH ${H} -H "Content-Type: application/json" \\
  "${base}/capacity/config" -d '{ "config": { "qcaAttritionMode": "attrition" } }'`} />
          <Snippet title="Column names and types for every sheet" code={`curl ${H} "${base}/capacity/schema"`} />
        </CardContent>
      </Card>
    </div>
  )
}
