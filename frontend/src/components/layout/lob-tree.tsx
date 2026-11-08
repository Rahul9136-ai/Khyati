import { Building2, Check, ChevronRight, Hash, Mail, MessageSquare, Pencil, Phone, Plus, Trash2, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { nextFreeColour } from "@/lib/domain/colours"
import { lobTree, nameProblem, placeOf } from "@/lib/domain/lob"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"


function channelIcon(name: string) {
  const n = name.toLowerCase()
  if (/phone|voice|call/.test(n)) return Phone
  if (/chat|message|whatsapp|sms/.test(n)) return MessageSquare
  if (/mail/.test(n)) return Mail
  return Hash
}

/** A name box: Enter saves, Escape cancels. */
function NameInput({ initial = "", placeholder, label, check, onSave, onCancel, indent }: {
  initial?: string; placeholder: string; label: string; indent: string
  check: (name: string) => string | null; onSave: (name: string) => void; onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  const save = () => {
    const problem = check(value)
    if (problem) return setError(problem)
    onSave(value.trim())
  }
  return (
    <div className={cn("py-0.5 pr-1", indent)}>
      <div className="flex items-center gap-1">
        <input
          ref={ref}
          aria-label={label}
          value={value}
          placeholder={placeholder}
          onChange={(e) => { setValue(e.target.value); setError(null) }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); save() }
            if (e.key === "Escape") { e.preventDefault(); onCancel() }
          }}
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button type="button" aria-label="Save" onClick={save} className="grid h-6 w-6 place-items-center rounded text-emerald-600 hover:bg-accent"><Check className="h-3.5 w-3.5" /></button>
        <button type="button" aria-label="Cancel" onClick={onCancel} className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent"><X className="h-3.5 w-3.5" /></button>
      </div>
      {error && <p role="alert" className="pt-0.5 text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

/** Edit / delete buttons that appear on hover (always reachable by keyboard). */
function RowActions({ what, name, onRename, onDelete, blocked }: {
  what: string; name: string; onRename: () => void; onDelete: () => void; blocked: string | null
}) {
  return (
    <span className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center rounded-md bg-card/95 opacity-0 shadow-sm ring-1 ring-border/60 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100">
      <button type="button" aria-label={`Rename ${what} ${name}`} title="Rename" onClick={(e) => { e.stopPropagation(); onRename() }}
        className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil className="h-3 w-3" /></button>
      <button type="button" aria-label={`Remove ${what} ${name}`} title={blocked ?? "Remove"} disabled={!!blocked}
        onClick={(e) => { e.stopPropagation(); if (window.confirm(`Remove the ${what} "${name}"?`)) onDelete() }}
        className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground"><Trash2 className="h-3 w-3" /></button>
    </span>
  )
}

const AddButton = ({ label, onClick, indent }: { label: string; onClick: () => void; indent: string }) => (
  <button type="button" onClick={onClick}
    className={cn("flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-[11px] font-medium text-muted-foreground/80 hover:bg-accent/50 hover:text-foreground", indent)}>
    <Plus className="h-3 w-3" /> {label}
  </button>
)

type Editing =
  | { kind: "addLob" }
  | { kind: "renameLob"; lobId: string }
  | { kind: "addChannel"; lobId: string }
  | { kind: "renameChannel"; lobId: string; channel: string }
  | { kind: "addQueue"; lobId: string; channel: string }
  | { kind: "renameQueue"; queueId: string }
  | null

/**
 * Lines of business in the left pane: LOB → Channel → Queue. Clicking a LOB
 * shows its channels, a channel its queues, and a queue makes it the one every
 * page works on. People who can edit skills can add, rename and remove them.
 */
export function LobTree() {
  const { lobs, queues, agents, queueId, setQueueId, addLob, renameLob, removeLob, addChannel, renameChannel, removeChannel, addQueue, renameQueue, removeQueue } = useWfm()
  const canEdit = useWfm((s) => s.can("skills", "edit"))
  const tree = useMemo(() => lobTree(lobs, queues), [lobs, queues])
  const current = queues.find((q) => q.id === queueId) ?? queues[0]
  const here = current ? placeOf(lobs, current) : null

  const [openLobs, setOpenLobs] = useState<Set<string>>(() => new Set(here ? [here.lob.id] : []))
  const [openChannels, setOpenChannels] = useState<Set<string>>(() => new Set(here ? [`${here.lob.id}|${here.channel}`] : []))
  const [editing, setEditing] = useState<Editing>(null)
  // open the path to the selected queue
  useEffect(() => {
    if (!here) return
    setOpenLobs((s) => (s.has(here.lob.id) ? s : new Set([...s, here.lob.id])))
    const key = `${here.lob.id}|${here.channel}`
    setOpenChannels((s) => (s.has(key) ? s : new Set([...s, key])))
  }, [here?.lob.id, here?.channel]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) =>
    set((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })
  const done = () => setEditing(null)
  const skilled = (id: string) => agents.filter((a) => a.skills.includes(id)).length

  return (
    <section aria-label="Lines of business" className="pb-2">
      <div className="flex items-center justify-between px-2 pb-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">Lines of business</p>
        {canEdit && (
          <button type="button" aria-label="Add LOB" title="Add a line of business" onClick={() => setEditing({ kind: "addLob" })}
            className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"><Plus className="h-3.5 w-3.5" /></button>
        )}
      </div>

      <ul role="tree" aria-label="LOB, channel and queue" className="space-y-0.5">
        {tree.map(({ lob, channels, queueCount }) => {
          const lobOpen = openLobs.has(lob.id)
          const lobActive = here?.lob.id === lob.id
          return (
            <li key={lob.id} role="treeitem" aria-expanded={lobOpen} aria-label={lob.name}>
              {editing?.kind === "renameLob" && editing.lobId === lob.id ? (
                <NameInput initial={lob.name} placeholder="LOB name" label="LOB name" indent="pl-2"
                  check={(n) => nameProblem(n, tree.filter((t) => t.lob.id !== lob.id).map((t) => t.lob.name), "LOB")}
                  onSave={(n) => { renameLob(lob.id, n); done() }} onCancel={done} />
              ) : (
                <div className={cn("group/row relative flex items-center rounded-lg pr-1 transition-colors", lobActive ? "bg-accent/40" : "hover:bg-accent/40")}>
                  <button type="button" onClick={() => toggle(setOpenLobs, lob.id)} aria-label={`${lob.name}, ${queueCount} queues`}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm font-medium">
                    <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform", lobOpen && "rotate-90")} />
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-white" style={{ background: lob.color }}><Building2 className="h-3.5 w-3.5" /></span>
                    <span className={cn("truncate", lobActive ? "text-foreground" : "text-foreground/80")}>{lob.name}</span>
                    <span className="ml-auto pl-1 text-[10px] tabular-nums text-muted-foreground/70">{queueCount}</span>
                  </button>
                  {canEdit && (
                    <RowActions what="LOB" name={lob.name} onRename={() => setEditing({ kind: "renameLob", lobId: lob.id })} onDelete={() => removeLob(lob.id)}
                      blocked={queueCount ? "Move or remove its queues first" : tree.length < 2 ? "Keep at least one LOB" : null} />
                  )}
                </div>
              )}

              {lobOpen && (
                <ul role="group" className="ml-[1.05rem] space-y-0.5 border-l border-border/60 pl-1.5 animate-fade-in">
                  {channels.map((ch) => {
                    const key = `${lob.id}|${ch.name}`
                    const chOpen = openChannels.has(key)
                    const Icon = channelIcon(ch.name)
                    return (
                      <li key={ch.name} role="treeitem" aria-expanded={chOpen} aria-label={ch.name}>
                        {editing?.kind === "renameChannel" && editing.lobId === lob.id && editing.channel === ch.name ? (
                          <NameInput initial={ch.name} placeholder="Channel name" label="Channel name" indent="pl-1"
                            check={(n) => nameProblem(n, channels.filter((c) => c.name !== ch.name).map((c) => c.name), "channel")}
                            onSave={(n) => { renameChannel(lob.id, ch.name, n); done() }} onCancel={done} />
                        ) : (
                          <div className="group/row relative flex items-center rounded-md pr-1 hover:bg-accent/40">
                            <button type="button" onClick={() => toggle(setOpenChannels, key)} aria-label={`${ch.name}, ${ch.queues.length} queues`}
                              className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left text-[13px] text-foreground/80">
                              <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform", chOpen && "rotate-90")} />
                              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span className="truncate">{ch.name}</span>
                              <span className="ml-auto pl-1 text-[10px] tabular-nums text-muted-foreground/70">{ch.queues.length}</span>
                            </button>
                            {canEdit && (
                              <RowActions what="channel" name={ch.name} onRename={() => setEditing({ kind: "renameChannel", lobId: lob.id, channel: ch.name })}
                                onDelete={() => removeChannel(lob.id, ch.name)} blocked={ch.queues.length ? "Move or remove its queues first" : null} />
                            )}
                          </div>
                        )}

                        {chOpen && (
                          <ul role="group" className="ml-[0.9rem] space-y-0.5 border-l border-border/60 pl-1.5 animate-fade-in">
                            {ch.queues.length === 0 && !(editing?.kind === "addQueue" && editing.lobId === lob.id && editing.channel === ch.name) && (
                              <li className="px-2 py-1 text-[11px] text-muted-foreground/70">No queues yet</li>
                            )}
                            {ch.queues.map((q) => {
                              const active = q.id === current?.id
                              const n = skilled(q.id)
                              return (
                                <li key={q.id} role="treeitem" aria-selected={active} aria-label={q.name}>
                                  {editing?.kind === "renameQueue" && editing.queueId === q.id ? (
                                    <NameInput initial={q.name} placeholder="Queue name" label="Queue name" indent="pl-1"
                                      check={(name) => nameProblem(name, queues.filter((x) => x.id !== q.id).map((x) => x.name), "queue")}
                                      onSave={(name) => { renameQueue(q.id, name); done() }} onCancel={done} />
                                  ) : (
                                    <div className={cn("group/row relative flex items-center rounded-md pr-1 transition-colors",
                                      active ? "bg-primary/10" : "hover:bg-accent/40")}>
                                      <button type="button" onClick={() => setQueueId(q.id)} aria-current={active ? "true" : undefined}
                                        className={cn("flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-[13px]",
                                          active ? "font-semibold text-primary" : "text-foreground/70 hover:text-foreground")}>
                                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: q.color }} />
                                        <span className="truncate">{q.name}</span>
                                      </button>
                                      {canEdit && (
                                        <RowActions what="queue" name={q.name} onRename={() => setEditing({ kind: "renameQueue", queueId: q.id })} onDelete={() => removeQueue(q.id)}
                                          blocked={n ? `${n} agent${n > 1 ? "s have" : " has"} this skill. Change their skills first.` : queues.length < 2 ? "Keep at least one queue" : null} />
                                      )}
                                    </div>
                                  )}
                                </li>
                              )
                            })}
                            {canEdit && (editing?.kind === "addQueue" && editing.lobId === lob.id && editing.channel === ch.name ? (
                              <li><NameInput placeholder="New queue" label="New queue name" indent="pl-1"
                                check={(name) => nameProblem(name, queues.map((x) => x.name), "queue")}
                                onSave={(name) => {
                                  const id = addQueue({ name, color: nextFreeColour([...tree.map((t) => t.lob.color), ...queues.map((x) => x.color)]), aht: 300, slTarget: 0.8, targetTime: 20, lobId: lob.id, channel: ch.name })
                                  setQueueId(id); done()
                                }} onCancel={done} /></li>
                            ) : canEdit && (
                              <li><AddButton label="Add queue" indent="pl-2" onClick={() => setEditing({ kind: "addQueue", lobId: lob.id, channel: ch.name })} /></li>
                            ))}
                          </ul>
                        )}
                      </li>
                    )
                  })}
                  {canEdit && (editing?.kind === "addChannel" && editing.lobId === lob.id ? (
                    <li><NameInput placeholder="New channel (e.g. WhatsApp)" label="New channel name" indent="pl-1"
                      check={(n) => nameProblem(n, channels.map((c) => c.name), "channel")}
                      onSave={(n) => { addChannel(lob.id, n); setOpenChannels((s) => new Set([...s, `${lob.id}|${n}`])); done() }} onCancel={done} /></li>
                  ) : canEdit && (
                    <li><AddButton label="Add channel" indent="pl-1.5" onClick={() => setEditing({ kind: "addChannel", lobId: lob.id })} /></li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>

      {canEdit && editing?.kind === "addLob" && (
        <NameInput placeholder="New line of business" label="New LOB name" indent="pl-2 pt-1"
          check={(n) => nameProblem(n, tree.map((t) => t.lob.name), "LOB")}
          onSave={(n) => { const id = addLob(n); setOpenLobs((s) => new Set([...s, id])); done() }} onCancel={done} />
      )}
    </section>
  )
}

/** "Customer Care › Phone › Sales" for the top bar. */
export function CurrentQueue() {
  const { lobs, queues, queueId } = useWfm()
  const q = queues.find((x) => x.id === queueId) ?? queues[0]
  if (!q) return null
  const { lob, channel } = placeOf(lobs, q)
  return (
    <span aria-label="Current queue" title={`${lob.name} › ${channel} › ${q.name} · change it in Lines of business on the left`}
      className="hidden min-w-0 max-w-[24rem] shrink items-center gap-1.5 rounded-full border bg-card/60 px-2.5 py-1 text-xs lg:inline-flex">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: q.color }} />
      <span className="sr-only truncate text-muted-foreground 2xl:not-sr-only">{`${lob.name} › ${channel} › `}</span>
      <span className="whitespace-nowrap font-semibold">{q.name}</span>
    </span>
  )
}
