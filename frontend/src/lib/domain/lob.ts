// Lines of business: LOB → Channel → Queue.
//
// A queue (the unit forecasts, skills and schedules work on) belongs to one LOB
// and one of that LOB's channels. Queues saved before LOBs existed (no lobId /
// channel) are shown under the first LOB's first channel until they're moved,
// and with no LOBs saved yet there is one default LOB — so the tree is never
// empty and nothing needs migrating.
import type { Queue } from "./types"

export interface Lob {
  id: string
  name: string
  color: string
  /** Channel names, in display order (e.g. Phone, Chat, Email). */
  channels: string[]
}

export const DEFAULT_CHANNELS = ["Phone", "Chat", "Email"]
export const DEFAULT_LOB: Lob = { id: "customer-care", name: "Customer Care", color: "#6366f1", channels: [...DEFAULT_CHANNELS] }

/** The LOBs to show / edit: the saved ones, or the default one. */
export const effectiveLobs = (lobs: Lob[] | undefined): Lob[] => (lobs && lobs.length ? lobs : [DEFAULT_LOB])

/** Where a queue sits in the tree. */
export function placeOf(lobs: Lob[] | undefined, q: Pick<Queue, "lobId" | "channel">): { lob: Lob; channel: string } {
  const all = effectiveLobs(lobs)
  const lob = all.find((l) => l.id === q.lobId) ?? all[0]
  const channel = q.channel && q.channel.trim() ? q.channel : (lob.channels[0] ?? DEFAULT_CHANNELS[0])
  return { lob, channel }
}

export interface LobNode {
  lob: Lob
  channels: { name: string; queues: Queue[] }[]
  queueCount: number
}

/** The whole tree: every LOB, its channels (plus any a queue uses that isn't listed), their queues. */
export function lobTree(lobs: Lob[] | undefined, queues: Queue[]): LobNode[] {
  const all = effectiveLobs(lobs)
  const nodes = all.map((lob) => ({ lob, channels: lob.channels.map((name) => ({ name, queues: [] as Queue[] })), queueCount: 0 }))
  for (const q of queues) {
    const { lob, channel } = placeOf(all, q)
    const node = nodes.find((n) => n.lob.id === lob.id)!
    let ch = node.channels.find((c) => c.name.toLowerCase() === channel.toLowerCase())
    if (!ch) node.channels.push((ch = { name: channel, queues: [] }))
    ch.queues.push(q)
    node.queueCount++
  }
  return nodes
}

export const slug = (name: string) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")

/** A short, unique id from a name. */
export function uniqueId(name: string, taken: (id: string) => boolean, fallback = "item"): string {
  const base = slug(name) || fallback
  if (!taken(base)) return base
  let n = 2
  while (taken(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/** Why a name can't be used (empty / duplicate), or null. */
export function nameProblem(name: string, existing: string[], what: string): string | null {
  const n = name.trim()
  if (!n) return `Give the ${what} a name.`
  if (n.length > 60) return `Keep the ${what} name under 60 characters.`
  if (existing.some((e) => e.toLowerCase() === n.toLowerCase())) return `There's already a ${what} called "${n}".`
  return null
}
