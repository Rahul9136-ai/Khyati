import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Copy, Eye, EyeOff, KeyRound, Plug, RefreshCw, RotateCcw, Send, Trash2, Webhook as WebhookIcon } from "lucide-react"
import { Fragment, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { type ApiError } from "@/lib/api"
import { API_BASE, CONNECT_KEYS, connectApi, SCOPE_PRESETS, type Delivery, type Webhook } from "@/lib/connect"
import { cn } from "@/lib/utils"
import { useAuth } from "@/store/auth"

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—")
const errText = (e: unknown) => (e as ApiError)?.message ?? "Something went wrong"

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-7 text-xs"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }}
    >
      <Copy className="h-3 w-3" /> {done ? "Copied" : label}
    </Button>
  )
}

function Code({ children }: { children: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 pr-20 text-[11px] leading-relaxed"><code>{children}</code></pre>
      <span className="absolute right-2 top-2"><CopyButton text={children} /></span>
    </div>
  )
}

// ------------------------------------------------------------------ API keys

function ApiKeys() {
  const qc = useQueryClient()
  const { data: keys = [] } = useQuery({ queryKey: CONNECT_KEYS.keys, queryFn: connectApi.keys })
  const { data: scopes = [] } = useQuery({ queryKey: ["connect", "scopes"], queryFn: connectApi.scopes })
  const [name, setName] = useState("")
  const [preset, setPreset] = useState("write")
  const [custom, setCustom] = useState<string[]>([])
  const [expiry, setExpiry] = useState("")
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const chosen = preset === "custom" ? custom : (SCOPE_PRESETS.find((p) => p.id === preset)?.scopes ?? []).filter((s) => scopes.some((x) => x.code === s))

  const create = useMutation({
    mutationFn: () => connectApi.createKey({ name: name.trim(), scopes: chosen, expires_in_days: expiry ? Number(expiry) : null }),
    onSuccess: (k) => {
      setCreated({ name: k.name, key: k.key })
      setName("")
      setError(null)
      void qc.invalidateQueries({ queryKey: CONNECT_KEYS.keys })
    },
    onError: (e) => setError(errText(e)),
  })
  const revoke = useMutation({
    mutationFn: connectApi.revokeKey,
    onSuccess: () => void qc.invalidateQueries({ queryKey: CONNECT_KEYS.keys }),
  })

  return (
    <Card className="glass">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4 text-primary" /> API keys</CardTitle>
        <p className="text-xs text-muted-foreground">
          Give a CRM or other tool its own key instead of a login. It sends the key as <code>X-API-Key</code> and can only do what the key allows —
          never more than you can. Revoke a key to cut it off immediately.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
          <label className="block">
            <span className="mb-1 block text-muted-foreground">Name</span>
            <Input aria-label="Key name" className="h-8 w-52 text-xs" placeholder="e.g. Salesforce sync" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-muted-foreground">Can</span>
            <Select aria-label="Key access" className="h-8 text-xs" value={preset} onChange={(e) => setPreset(e.target.value)}
              options={[...SCOPE_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: "custom", label: "Choose permissions…" }]} />
          </label>
          <label className="block">
            <span className="mb-1 block text-muted-foreground">Expires</span>
            <Select aria-label="Key expiry" className="h-8 text-xs" value={expiry} onChange={(e) => setExpiry(e.target.value)}
              options={[{ value: "", label: "Never" }, { value: "30", label: "In 30 days" }, { value: "90", label: "In 90 days" }, { value: "365", label: "In a year" }]} />
          </label>
          <Button size="sm" className="h-8" disabled={!name.trim() || !chosen.length || create.isPending} onClick={() => create.mutate()}>
            <KeyRound className="h-3.5 w-3.5" /> Create key
          </Button>
          {preset === "custom" && (
            <div className="grid basis-full gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {scopes.map((s) => (
                <label key={s.code} className="flex items-start gap-1.5" title={s.description}>
                  <input type="checkbox" className="mt-0.5 accent-primary" checked={custom.includes(s.code)}
                    onChange={(e) => setCustom(e.target.checked ? [...custom, s.code] : custom.filter((x) => x !== s.code))} />
                  <span><code>{s.code}</code> <span className="text-muted-foreground">— {s.description}</span></span>
                </label>
              ))}
            </div>
          )}
          {error && <p className="basis-full text-destructive">{error}</p>}
        </div>

        {created && (
          <div role="alert" className="space-y-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
            <p className="font-semibold">Copy the key for “{created.name}” now — it won't be shown again.</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-background px-2 py-1" data-testid="new-api-key">{created.key}</code>
              <CopyButton text={created.key} />
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setCreated(null)}>Done</Button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full" aria-label="API keys">
            <thead className="bg-muted/40 text-left text-muted-foreground">
              <tr><th className="px-3 py-1.5">Name</th><th className="px-3 py-1.5">Key</th><th className="px-3 py-1.5">Can</th><th className="px-3 py-1.5">Last used</th><th className="px-3 py-1.5">Status</th><th /></tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const expired = !!k.expires_at && new Date(k.expires_at) < new Date()
                const state = k.revoked_at ? "Revoked" : expired ? "Expired" : "Active"
                return (
                  <tr key={k.id} className={cn("border-t", state !== "Active" && "text-muted-foreground")}>
                    <td className="px-3 py-1.5 font-medium">{k.name}<div className="text-[10px] font-normal text-muted-foreground">by {k.created_by_email} · {when(k.created_at)}</div></td>
                    <td className="px-3 py-1.5"><code>{k.prefix}…</code></td>
                    <td className="px-3 py-1.5"><span className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>)}</span></td>
                    <td className="px-3 py-1.5">{when(k.last_used_at)}</td>
                    <td className="px-3 py-1.5">
                      <span className={cn(state === "Active" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>{state}</span>
                      {k.expires_at && state === "Active" && <div className="text-[10px] text-muted-foreground">until {when(k.expires_at)}</div>}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {state === "Active" && (
                        <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => revoke.mutate(k.id)} aria-label={`Revoke ${k.name}`}>
                          <Trash2 className="h-3 w-3" /> Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!keys.length && <tr><td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">No API keys yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ webhooks

const STATUS_TONE: Record<Delivery["status"], string> = {
  delivered: "text-emerald-600 dark:text-emerald-400",
  pending: "text-primary",
  retrying: "text-amber-600",
  failed: "text-destructive",
}

function Deliveries({ hook }: { hook: Webhook }) {
  const qc = useQueryClient()
  const { data: rows = [], refetch, isFetching } = useQuery({ queryKey: [...CONNECT_KEYS.hooks, hook.id, "deliveries"], queryFn: () => connectApi.deliveries(hook.id), refetchInterval: 10_000 })
  const [open, setOpen] = useState<string | null>(null)
  const redeliver = useMutation({
    mutationFn: connectApi.redeliver,
    onSuccess: () => {
      void refetch()
      void qc.invalidateQueries({ queryKey: CONNECT_KEYS.hooks })
    },
  })
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-medium">Recent deliveries</span>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => void refetch()}><RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} /> Refresh</Button>
      </div>
      <div className="max-h-72 overflow-auto rounded border">
        <table className="w-full" aria-label={`Deliveries to ${hook.url}`}>
          <thead className="sticky top-0 bg-muted/60 text-left text-muted-foreground">
            <tr><th className="px-2 py-1">When</th><th className="px-2 py-1">Event</th><th className="px-2 py-1">Status</th><th className="px-2 py-1">Response</th><th className="px-2 py-1">Tries</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <Fragment key={d.id}>
                <tr className="border-t">
                  <td className="px-2 py-1 tabular-nums">{when(d.last_attempt_at ?? d.created_at)}</td>
                  <td className="px-2 py-1"><code>{d.event_type}</code></td>
                  <td className={cn("px-2 py-1 font-medium", STATUS_TONE[d.status])}>
                    {d.status}
                    {d.status === "retrying" && <div className="text-[10px] font-normal text-muted-foreground">next {when(d.next_attempt_at)}</div>}
                  </td>
                  <td className="px-2 py-1">{d.response_status ?? "—"}{d.error && d.error !== `HTTP ${d.response_status}` && <div className="max-w-[16rem] truncate text-[10px] text-destructive" title={d.error}>{d.error}</div>}{d.duration_ms != null && <div className="text-[10px] text-muted-foreground">{d.duration_ms} ms</div>}</td>
                  <td className="px-2 py-1 tabular-nums">{d.attempts}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right">
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? "Hide" : "Payload"}</Button>
                    {d.status !== "delivered" && (
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={redeliver.isPending} onClick={() => redeliver.mutate(d.id)}>
                        <RotateCcw className="h-3 w-3" /> Redeliver
                      </Button>
                    )}
                  </td>
                </tr>
                {open === d.id && (
                  <tr><td colSpan={6} className="p-2"><Code>{JSON.stringify(d.payload, null, 2)}</Code></td></tr>
                )}
              </Fragment>
            ))}
            {!rows.length && <tr><td colSpan={6} className="px-2 py-3 text-center text-muted-foreground">Nothing sent yet — use “Send test”.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function WebhookCard({ hook, events }: { hook: Webhook; events: { type: string; description: string }[] }) {
  const qc = useQueryClient()
  const [show, setShow] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: CONNECT_KEYS.hooks })
  }
  const update = useMutation({ mutationFn: (b: Parameters<typeof connectApi.updateHook>[1]) => connectApi.updateHook(hook.id, b), onSuccess: refresh })
  const rotate = useMutation({ mutationFn: () => connectApi.rotateSecret(hook.id), onSuccess: refresh })
  const remove = useMutation({ mutationFn: () => connectApi.deleteHook(hook.id), onSuccess: refresh })
  const test = useMutation({
    mutationFn: () => connectApi.testHook(hook.id),
    onSuccess: (d) => {
      setMsg(d.status === "delivered"
        ? { ok: true, text: `Test delivered — HTTP ${d.response_status} in ${d.duration_ms} ms.` }
        : { ok: false, text: `Test failed — ${d.error || `HTTP ${d.response_status}`}. It will be retried; check the URL and that it returns 2xx.` })
      refresh()
    },
    onError: (e) => setMsg({ ok: false, text: errText(e) }),
  })
  const all = hook.events.includes("*")
  const listed = events.filter((e) => e.type !== "ping") // ping is only sent by "Send test"
  const toggleEvent = (t: string, on: boolean) => {
    const current = all ? listed.map((e) => e.type) : hook.events
    const next = on ? [...new Set([...current, t])] : current.filter((x) => x !== t)
    if (next.length) update.mutate({ events: next.length === listed.length ? ["*"] : next })
  }

  return (
    <div className={cn("space-y-2 rounded-lg border p-3", !hook.active && "opacity-70", hook.consecutive_failures >= 3 && "border-destructive/50")}>
      <div className="flex flex-wrap items-center gap-2">
        <WebhookIcon className="h-4 w-4 text-primary" />
        <code className="break-all font-semibold">{hook.url}</code>
        {hook.description && <span className="text-muted-foreground">· {hook.description}</span>}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <label className="flex items-center gap-1">
            <input type="checkbox" className="accent-primary" checked={hook.active} aria-label={`Active: ${hook.url}`} onChange={(e) => update.mutate({ active: e.target.checked })} /> Active
          </label>
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={test.isPending} onClick={() => test.mutate()}><Send className="h-3 w-3" /> Send test</Button>
          {confirmDelete ? (
            <>
              <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => remove.mutate()}>Delete</Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmDelete(false)}>Keep</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" aria-label={`Delete ${hook.url}`} onClick={() => setConfirmDelete(true)}><Trash2 className="h-3 w-3" /></Button>
          )}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>Last success: {when(hook.last_success_at)}</span>
        <span className={cn(hook.consecutive_failures && "text-destructive")}>Last failure: {when(hook.last_failure_at)}{hook.consecutive_failures ? ` · ${hook.consecutive_failures} failing in a row` : ""}</span>
      </div>
      {msg && <p role="status" className={cn(msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>{msg.ok ? "✓ " : "✕ "}{msg.text}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Signing secret</span>
        <code className="rounded bg-muted px-2 py-0.5">{show ? hook.secret : `${hook.secret.slice(0, 10)}••••••••`}</code>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShow(!show)} aria-label={show ? "Hide secret" : "Show secret"}>{show ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}</Button>
        <CopyButton text={hook.secret} />
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => rotate.mutate()}><RefreshCw className="h-3 w-3" /> Rotate</Button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <span className="font-medium">Events</span>
        {listed.map((e) => (
          <label key={e.type} className="flex items-center gap-1" title={e.description}>
            <input type="checkbox" className="accent-primary" checked={all || hook.events.includes(e.type)} onChange={(ev) => toggleEvent(e.type, ev.target.checked)} />
            <code>{e.type}</code>
          </label>
        ))}
      </div>
      <Deliveries hook={hook} />
    </div>
  )
}

function Webhooks() {
  const qc = useQueryClient()
  const { data: hooks = [] } = useQuery({ queryKey: CONNECT_KEYS.hooks, queryFn: connectApi.hooks, refetchInterval: 15_000 })
  const { data: events = [] } = useQuery({ queryKey: ["connect", "events"], queryFn: connectApi.events })
  const [url, setUrl] = useState("")
  const [description, setDescription] = useState("")
  const [error, setError] = useState<string | null>(null)
  const add = useMutation({
    mutationFn: () => connectApi.createHook({ url: url.trim(), description: description.trim(), events: ["*"] }),
    onSuccess: () => {
      setUrl("")
      setDescription("")
      setError(null)
      void qc.invalidateQueries({ queryKey: CONNECT_KEYS.hooks })
    },
    onError: (e) => setError(errText(e)),
  })
  return (
    <Card className="glass">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><WebhookIcon className="h-4 w-4 text-primary" /> Webhooks</CardTitle>
        <p className="text-xs text-muted-foreground">
          We POST a signed JSON event to your URL whenever a schedule changes or is published, a slot is opened / taken / given back, or the work rules
          change. Failed deliveries are retried (30 s, 2 min, 10 min, 1 h, 6 h) and can be redelivered from here.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
          <label className="block flex-1">
            <span className="mb-1 block text-muted-foreground">Endpoint URL</span>
            <Input aria-label="Webhook URL" className="h-8 min-w-[16rem] text-xs" placeholder="https://your-crm.example.com/wfm/webhook" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-muted-foreground">Description</span>
            <Input aria-label="Webhook description" className="h-8 w-48 text-xs" placeholder="e.g. HubSpot" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <Button size="sm" className="h-8" disabled={!url.trim() || add.isPending} onClick={() => add.mutate()}><Plug className="h-3.5 w-3.5" /> Add webhook</Button>
          {error && <p className="basis-full text-destructive">{error}</p>}
        </div>
        {hooks.map((h) => <WebhookCard key={h.id} hook={h} events={events} />)}
        {!hooks.length && <p className="text-muted-foreground">No webhooks yet.</p>}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ docs

function HowToConnect() {
  const base = API_BASE.replace(/\/$/, "")
  return (
    <Card className="glass">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Plug className="h-4 w-4 text-primary" /> How to connect a CRM</CardTitle>
        <p className="text-xs text-muted-foreground">
          Every screen in this app uses the same REST API, so a tool with a key can read and change what you can. Full reference:{" "}
          <a className="text-primary hover:underline" href={base.replace(/\/api\/v1$/, "/docs")} target="_blank" rel="noreferrer">{base.replace(/\/api\/v1$/, "/docs")}</a>
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <p className="font-medium">Read schedules for a week (shift, breaks, channels, leave / absence / week off):</p>
        <Code>{`curl -H "X-API-Key: wfm_…" \\\n  "${base}/scheduling/day-plans/range?start=2026-11-02&end=2026-11-08"`}</Code>
        <p className="font-medium">Mark leave from your CRM (send the same external_id again to update it, or "action": "remove" to cancel):</p>
        <Code>{`curl -X POST -H "X-API-Key: wfm_…" -H "Content-Type: application/json" \\\n  "${base}/connect/inbound/time-off" \\\n  -d '{"agent_key": "a01", "start_date": "2026-11-09", "end_date": "2026-11-11",\n       "type": "leave", "note": "Annual leave", "external_id": "LV-1001"}'`}</Code>
        <p className="font-medium">Read or change work rules and agents' week offs:</p>
        <Code>{`curl -H "X-API-Key: wfm_…" "${base}/scheduling/settings"\ncurl -X PUT -H "X-API-Key: wfm_…" -H "Content-Type: application/json" \\\n  "${base}/scheduling/settings/agent_rules" \\\n  -d '{"value": {"a01": {"shiftPatternId": "wr:wr-8h@09:00", "weekOff": [5, 6], "weekOffMode": "fixed"}}, "base_version": 3}'`}</Code>
        <p className="font-medium">Check a webhook really came from us (Node.js):</p>
        <Code>{`const crypto = require("crypto")
// raw = the request body exactly as received (a Buffer / string)
const ts = req.headers["x-wfm-timestamp"]
const expected = "sha256=" + crypto.createHmac("sha256", process.env.WFM_WEBHOOK_SECRET)
  .update(ts + "." + raw).digest("hex")
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-wfm-signature"]))
  && Math.abs(Date.now() / 1000 - Number(ts)) < 300   // reject old replays`}</Code>
        <p className="text-muted-foreground">
          Headers on every webhook: <code>X-WFM-Event</code>, <code>X-WFM-Delivery</code> (unique — use it to ignore duplicates), <code>X-WFM-Timestamp</code>,{" "}
          <code>X-WFM-Signature</code>. Reply with any 2xx within 10 seconds.
        </p>
      </CardContent>
    </Card>
  )
}

/** Settings → API & Webhooks. Needs the backend `integration:manage` permission. */
export function ConnectSettings() {
  const user = useAuth((s) => s.user)
  const canManage = !!user && (user.is_superuser || user.permission_codes.includes("integration:manage"))
  if (!canManage) {
    return <p className="text-sm text-muted-foreground">You need the “integration:manage” permission to manage API keys and webhooks.</p>
  }
  return (
    <div className="space-y-4">
      <ApiKeys />
      <Webhooks />
      <HowToConnect />
    </div>
  )
}
