import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Eye, Loader2, Mail, Pause, Pencil, Play, Plus, Send, Trash2, Users, X } from "lucide-react"
import { useEffect, useState } from "react"

import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { type ApiError } from "@/lib/api"
import {
  blankSchedule, FREQUENCY, parseEmails, reportsApi, WEEKDAYS, type Frequency, type RecipientList, type ReportRun, type ReportSchedule, type ScheduleInput,
} from "@/lib/scheduledReports"
import { cn } from "@/lib/utils"
import { useAuth } from "@/store/auth"
import { useWfm } from "@/store/wfm"

const KEYS = { subs: ["report-schedules"], lists: ["report-lists"], status: ["report-email-status"] }
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—")
const errText = (e: unknown) => {
  const err = e as ApiError
  const details = err?.details as { msg?: string }[] | undefined
  return Array.isArray(details) && details[0]?.msg ? details[0].msg.replace(/^Value error, /, "") : (err?.message ?? "Something went wrong")
}

function Recipients({ label, value, onChange, lists }: { label: string; value: string[]; onChange: (v: string[]) => void; lists: RecipientList[] }) {
  const [text, setText] = useState("")
  const [error, setError] = useState("")
  const add = () => {
    const { valid, invalid } = parseEmails(text)
    if (valid.length) onChange([...new Set([...value, ...valid])])
    setText(invalid.join(", "))
    setError(invalid.length ? `Not valid: ${invalid.join(", ")}` : "")
  }
  const name = (entry: string) => (entry.startsWith("list:") ? (lists.find((l) => `list:${l.id}` === entry)?.name ?? "Removed list") : entry)
  const unused = lists.filter((l) => !value.includes(`list:${l.id}`))
  return (
    <div>
      <span className="mb-1 block text-xs font-semibold">{label}</span>
      {value.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {value.map((v) => (
            <span key={v} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs", v.startsWith("list:") && "border-primary/50 bg-primary/10")}>
              {v.startsWith("list:") && <Users className="h-3 w-3" />}{name(v)}
              <button type="button" aria-label={`Remove ${name(v)} from ${label}`} onClick={() => onChange(value.filter((x) => x !== v))}><X className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Input aria-label={`${label} email`} className="h-8 min-w-[14rem] flex-1 text-xs" placeholder="name@company.com, or paste several" value={text}
          onChange={(e) => { setText(e.target.value); setError("") }}
          onBlur={add}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add() } }} />
        {unused.length > 0 && (
          <Select aria-label={`Add a distribution list to ${label}`} className="h-8 text-xs" value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}
            options={[{ value: "", label: "Add a distribution list…" }, ...unused.map((l) => ({ value: `list:${l.id}`, label: `${l.name} (${l.emails.length})` }))]} />
        )}
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

function Editor({ initial, id, onClose }: { initial: ScheduleInput; id: string | null; onClose: () => void }) {
  const qc = useQueryClient()
  const queues = useWfm((s) => s.queues)
  const { data: lists = [] } = useQuery({ queryKey: KEYS.lists, queryFn: reportsApi.lists })
  const [d, setD] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const setFrequency = (frequency: Frequency) =>
    setD({ ...d, frequency, weekdays: frequency === "weekly" ? [d.weekdays[0] ?? 0] : d.weekdays.length > 1 ? d.weekdays : [0, 1, 2, 3, 4] })
  const toggleDay = (i: number) => {
    if (d.frequency === "weekly") return setD({ ...d, weekdays: [i] })
    setD({ ...d, weekdays: d.weekdays.includes(i) ? d.weekdays.filter((x) => x !== i) : [...d.weekdays, i].sort() })
  }
  const save = useMutation({
    mutationFn: () => (id ? reportsApi.update(id, d) : reportsApi.create(d)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.subs })
      onClose()
    },
    onError: (e) => setError(errText(e)),
  })
  const submit = () => {
    if (!d.name.trim()) return setError("Give the report a name.")
    if (!d.to_recipients.length) return setError("Add at least one recipient in To.")
    if (!d.weekdays.length) return setError("Pick at least one day.")
    setError(null)
    save.mutate()
  }
  return (
    <Dialog open onClose={onClose} title={id ? "Edit report schedule" : "New report schedule"} description="It's sent automatically on the days and time you choose." className="max-w-2xl"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={save.isPending} onClick={submit}>{id ? "Save changes" : "Create schedule"}</Button></>}>
      <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1 text-sm">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold">Report name</span>
          <Input aria-label="Report name" value={d.name} placeholder="e.g. Operations daily" onChange={(e) => setD({ ...d, name: e.target.value })} />
        </label>
        <div>
          <span className="mb-1 block text-xs font-semibold">Frequency</span>
          <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="Frequency">
            {(Object.keys(FREQUENCY) as Frequency[]).map((f) => (
              <button key={f} type="button" aria-pressed={d.frequency === f} onClick={() => setFrequency(f)}
                className={cn("rounded-lg border p-2.5 text-left", d.frequency === f ? "border-primary bg-primary/10" : "hover:bg-muted/50")}>
                <div className="font-semibold">{FREQUENCY[f].label}</div>
                <div className="text-xs text-muted-foreground">{FREQUENCY[f].covers}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <span className="mb-1 block text-xs font-semibold">{d.frequency === "weekly" ? "Send on" : "Send on these days"}</span>
            <div className="inline-flex flex-wrap gap-0.5" role="group" aria-label="Days to send">
              {WEEKDAYS.map((w, i) => (
                <button key={w} type="button" aria-pressed={d.weekdays.includes(i)} onClick={() => toggleDay(i)}
                  className={cn("h-8 w-10 rounded border text-xs font-medium", d.weekdays.includes(i) ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/50")}>{w}</button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold">Time</span>
            <Input type="time" aria-label="Send time" className="h-8 w-28 text-xs" value={d.send_time} onChange={(e) => e.target.value && setD({ ...d, send_time: e.target.value })} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold">Time zone</span>
            <Input aria-label="Time zone" className="h-8 w-44 text-xs" value={d.timezone} onChange={(e) => setD({ ...d, timezone: e.target.value })} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold">LOB</span>
            <Select aria-label="LOB" className="h-8 text-xs" value={d.lob} onChange={(e) => setD({ ...d, lob: e.target.value })}
              options={[{ value: "", label: "All LOBs" }, ...queues.map((q) => ({ value: q.name, label: q.name }))]} />
          </label>
        </div>
        <Recipients label="To" value={d.to_recipients} lists={lists} onChange={(to_recipients) => setD({ ...d, to_recipients })} />
        <Recipients label="CC" value={d.cc_recipients} lists={lists} onChange={(cc_recipients) => setD({ ...d, cc_recipients })} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    </Dialog>
  )
}

function Lists() {
  const qc = useQueryClient()
  const { data: lists = [] } = useQuery({ queryKey: KEYS.lists, queryFn: reportsApi.lists })
  const [name, setName] = useState("")
  const [emails, setEmails] = useState("")
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = () => void qc.invalidateQueries({ queryKey: KEYS.lists })
  const save = useMutation({
    mutationFn: ({ valid }: { valid: string[] }) => (editing ? reportsApi.updateList(editing, { name: name.trim(), emails: valid }) : reportsApi.createList({ name: name.trim(), emails: valid })),
    onSuccess: () => {
      setName("")
      setEmails("")
      setEditing(null)
      setError(null)
      refresh()
    },
    onError: (e) => setError(errText(e)),
  })
  const remove = useMutation({ mutationFn: reportsApi.deleteList, onSuccess: () => { setError(null); refresh() }, onError: (e) => setError(errText(e)) })
  const submit = () => {
    const { valid, invalid } = parseEmails(emails)
    if (!name.trim()) return setError("Give the list a name.")
    if (invalid.length) return setError(`Not valid: ${invalid.join(", ")}`)
    if (!valid.length) return setError("Add at least one email address.")
    save.mutate({ valid })
  }
  return (
    <Card className="glass">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Users className="h-4 w-4 text-primary" /> Distribution lists</CardTitle>
        <p className="text-xs text-muted-foreground">Groups you can add to To or CC in one click. If your email system already has a list address, you can just use that address as a recipient.</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="space-y-2 rounded-lg border p-3">
          <Input aria-label="List name" className="h-8 text-xs" placeholder="List name, e.g. Team leaders" value={name} onChange={(e) => setName(e.target.value)} />
          <Textarea aria-label="List emails" rows={2} className="text-xs" placeholder="Emails, separated by commas or new lines" value={emails} onChange={(e) => setEmails(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" disabled={save.isPending} onClick={submit}><Plus className="h-3.5 w-3.5" /> {editing ? "Save list" : "Add list"}</Button>
            {editing && <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setName(""); setEmails("") }}>Cancel</Button>}
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </div>
        {lists.map((l) => (
          <div key={l.id} className="flex items-start gap-2 rounded-lg border px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{l.name} <span className="text-xs font-normal text-muted-foreground">· {l.emails.length} people</span></div>
              <div className="truncate text-xs text-muted-foreground" title={l.emails.join(", ")}>{l.emails.join(", ")}</div>
            </div>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={`Edit ${l.name}`} onClick={() => { setEditing(l.id); setName(l.name); setEmails(l.emails.join(", ")); setError(null) }}><Pencil className="h-3.5 w-3.5" /></Button>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={`Delete ${l.name}`} onClick={() => remove.mutate(l.id)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
          </div>
        ))}
        {!lists.length && <p className="text-xs text-muted-foreground">No lists yet.</p>}
      </CardContent>
    </Card>
  )
}

function Runs({ id }: { id: string }) {
  const { data: runs = [] } = useQuery({ queryKey: [...KEYS.subs, id, "runs"], queryFn: () => reportsApi.runs(id), refetchInterval: 30_000 })
  if (!runs.length) return <p className="text-xs text-muted-foreground">Not sent yet.</p>
  return (
    <div className="max-h-52 overflow-auto rounded border">
      <table className="w-full text-xs" aria-label="Send history">
        <thead className="sticky top-0 bg-muted/60 text-left text-muted-foreground">
          <tr><th className="px-2 py-1">When</th><th className="px-2 py-1">Period</th><th className="px-2 py-1">Sent</th><th className="px-2 py-1">Status</th><th className="px-2 py-1">Recipients</th></tr>
        </thead>
        <tbody>
          {runs.map((r: ReportRun) => (
            <tr key={r.id} className="border-t align-top">
              <td className="whitespace-nowrap px-2 py-1">{when(r.created_at)}</td>
              <td className="whitespace-nowrap px-2 py-1">{r.period_start === r.period_end ? r.period_start : `${r.period_start} → ${r.period_end}`}</td>
              <td className="px-2 py-1">{r.trigger === "manual" ? "By hand" : "On schedule"}</td>
              <td className={cn("px-2 py-1 font-medium", r.status === "sent" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
                {r.status === "sent" ? "✓ Sent" : "✕ Failed"}{r.error && <div className="font-normal">{r.error}</div>}
              </td>
              <td className="px-2 py-1">To: {r.to_recipients.join(", ") || "—"}{r.cc_recipients.length > 0 && <div>CC: {r.cc_recipients.join(", ")}</div>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Preview({ frequency, lob, name, timezone, onClose }: { frequency: Frequency; lob: string; name: string; timezone: string; onClose: () => void }) {
  const { data, isLoading, isError } = useQuery({ queryKey: ["report-preview", frequency, lob, name, timezone], queryFn: () => reportsApi.preview({ frequency, lob, name, timezone }) })
  return (
    <Dialog open onClose={onClose} title="Report preview" description={data ? `Subject: ${data.subject}. Exactly what would be emailed now; nothing is sent.` : undefined} className="max-w-3xl">
      {isLoading ? <p className="text-sm text-muted-foreground">Building…</p> : isError ? <p className="text-sm text-destructive">Couldn't build the preview.</p> : (
        <iframe title="Report preview" sandbox="" srcDoc={data?.html} className="h-[65vh] w-full rounded-lg border bg-white" />
      )}
    </Dialog>
  )
}

function ScheduleCard({ s, lists, onEdit }: { s: ReportSchedule; lists: RecipientList[]; onEdit: () => void }) {
  const qc = useQueryClient()
  const [confirmSend, setConfirmSend] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [preview, setPreview] = useState(false)
  const [showRuns, setShowRuns] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const refresh = () => void qc.invalidateQueries({ queryKey: KEYS.subs })
  const send = useMutation({
    mutationFn: () => reportsApi.send(s.id),
    onSuccess: (r) => {
      setConfirmSend(false)
      setMsg(r.status === "sent" ? { ok: true, text: `Sent to ${r.to_recipients.length} in To and ${r.cc_recipients.length} in CC.` } : { ok: false, text: r.error })
      setShowRuns(true)
      refresh()
    },
    onError: (e) => setMsg({ ok: false, text: errText(e) }),
  })
  const toggle = useMutation({
    mutationFn: () => reportsApi.update(s.id, { name: s.name, frequency: s.frequency, weekdays: s.weekdays, send_time: s.send_time, timezone: s.timezone, lob: s.lob, to_recipients: s.to_recipients, cc_recipients: s.cc_recipients, active: !s.active }),
    onSuccess: refresh,
  })
  const remove = useMutation({ mutationFn: () => reportsApi.remove(s.id), onSuccess: refresh })
  const who = (entries: string[]) => entries.map((e) => (e.startsWith("list:") ? (lists.find((l) => `list:${l.id}` === e)?.name ?? "Removed list") : e)).join(", ") || "—"
  return (
    <>
      <Card className={cn("glass", !s.active && "opacity-70")}>
      <CardContent className="space-y-2 p-4 text-sm">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-[14rem] flex-1">
            <div className="flex flex-wrap items-center gap-2 font-semibold">
              {s.name}
              <Badge variant="secondary">{FREQUENCY[s.frequency].label}</Badge>
              {!s.active && <Badge variant="warning">Paused</Badge>}
              {s.last_status === "failed" && <Badge variant="destructive">Last send failed</Badge>}
            </div>
            <div className="text-xs text-muted-foreground">
              {FREQUENCY[s.frequency].covers} · {s.lob || "All LOBs"} · {s.weekdays.length === 7 ? "every day" : s.weekdays.map((d) => WEEKDAYS[d]).join(", ")} at {s.send_time} ({s.timezone})
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setPreview(true)}><Eye className="h-3 w-3" /> Preview</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={send.isPending} onClick={() => setConfirmSend(true)}><Send className="h-3 w-3" /> Send now</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" aria-label={s.active ? `Pause ${s.name}` : `Resume ${s.name}`} onClick={() => toggle.mutate()}>{s.active ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" aria-label={`Edit ${s.name}`} onClick={onEdit}><Pencil className="h-3 w-3" /></Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" aria-label={`Delete ${s.name}`} onClick={() => setConfirmDelete(true)}><Trash2 className="h-3 w-3 text-destructive" /></Button>
          </div>
        </div>
        <div className="text-xs"><b>To:</b> {who(s.to_recipients)}</div>
        {s.cc_recipients.length > 0 && <div className="text-xs"><b>CC:</b> {who(s.cc_recipients)}</div>}
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span>Next: {s.active ? when(s.next_run_at) : "paused"}</span>
          <span>Last: {when(s.last_run_at)}</span>
          <button type="button" className="text-primary hover:underline" onClick={() => setShowRuns((v) => !v)}>{showRuns ? "Hide history" : "Show history"}</button>
        </div>
        {confirmSend && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
            This emails the real To and CC now.
            <Button size="sm" className="h-7 text-xs" disabled={send.isPending} onClick={() => send.mutate()}>{send.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Send it</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmSend(false)}>Cancel</Button>
          </div>
        )}
        {confirmDelete && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/50 p-2 text-xs">
            Delete this schedule and its history?
            <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => remove.mutate()}>Delete</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmDelete(false)}>Keep</Button>
          </div>
        )}
        {msg && <p role="status" className={cn("text-xs", msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>{msg.ok ? "✓ " : "✕ "}{msg.text}</p>}
        {showRuns && <Runs id={s.id} />}
      </CardContent>
      </Card>
      {preview && <Preview frequency={s.frequency} lob={s.lob} name={s.name} timezone={s.timezone} onClose={() => setPreview(false)} />}
    </>
  )
}

export function ScheduledReports() {
  const user = useAuth((s) => s.user)
  const allowed = !!user && (user.is_superuser || user.permission_codes.includes("report:export"))
  const { data: status } = useQuery({ queryKey: KEYS.status, queryFn: reportsApi.status, enabled: allowed })
  const { data: subs = [], isLoading } = useQuery({ queryKey: KEYS.subs, queryFn: reportsApi.list, enabled: allowed })
  const { data: lists = [] } = useQuery({ queryKey: KEYS.lists, queryFn: reportsApi.lists, enabled: allowed })
  const [editing, setEditing] = useState<{ id: string | null; input: ScheduleInput } | null>(null)
  const [sample, setSample] = useState<Frequency | null>(null)
  const [tz, setTz] = useState("UTC")
  useEffect(() => setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"), [])

  if (!allowed) {
    return (
      <>
        <PageHeader title="Scheduled Reports" subtitle="Email a dashboard automatically" />
        <p className="text-sm text-muted-foreground">You need the “report:export” permission to manage report emails.</p>
      </>
    )
  }
  return (
    <>
      <PageHeader title="Scheduled Reports" subtitle="Email a dashboard daily, weekly or month to date, to the people you choose"
        actions={<Button onClick={() => setEditing({ id: null, input: blankSchedule(tz) })}><Plus className="h-4 w-4" /> New schedule</Button>} />
      {status && !status.configured && (
        <p role="alert" className="mb-4 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          <b>Email isn't set up on the server yet.</b> You can create schedules and preview them, but sends will be recorded as failed until the server has a sender address and an email service.
        </p>
      )}
      {status?.configured && <p className="mb-4 flex items-center gap-1.5 text-xs text-muted-foreground"><Mail className="h-3.5 w-3.5" /> Sending from {status.from}</p>}
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-3 xl:col-span-2">
          <Card className="glass">
            <CardContent className="flex flex-wrap items-center gap-2 p-3 text-sm">
              <span className="text-muted-foreground">See the dashboard:</span>
              {(Object.keys(FREQUENCY) as Frequency[]).map((f) => (
                <Button key={f} size="sm" variant="outline" className="h-8 text-xs" onClick={() => setSample(f)}><Eye className="h-3.5 w-3.5" /> {FREQUENCY[f].label}</Button>
              ))}
            </CardContent>
          </Card>
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!isLoading && !subs.length && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No report schedules yet. Create one to start emailing the dashboard.</p>}
          {subs.map((s) => (
            <ScheduleCard key={s.id} s={s} lists={lists} onEdit={() => setEditing({ id: s.id, input: { name: s.name, frequency: s.frequency, weekdays: s.weekdays, send_time: s.send_time, timezone: s.timezone, lob: s.lob, to_recipients: s.to_recipients, cc_recipients: s.cc_recipients, active: s.active } })} />
          ))}
        </div>
        <Lists />
      </div>
      {editing && <Editor initial={editing.input} id={editing.id} onClose={() => setEditing(null)} />}
      {sample && <Preview frequency={sample} lob="" name={`${FREQUENCY[sample].label} report`} timezone={tz} onClose={() => setSample(null)} />}
    </>
  )
}
