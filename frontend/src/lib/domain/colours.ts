// Named colours. Every kind of segment the tool draws (agent states, schedule
// activities, channels, slots, LOBs, queues) has its own colour, so no two
// different things look alike; something that is the same thing in two places
// (Break on the real-time board and on the schedule) keeps one colour.
//
// FIXED: colours of built-in segments (see channels.ts, seed.ts, slots.ts).
// USER_PALETTE: colours handed out to LOBs and queues people create — none of
// them is a FIXED colour, and each is given to one LOB/queue only.
// STATUS: traffic-light colours for statuses and Capacity % bands (meaning, not identity).

export interface NamedColour {
  hex: string
  name: string
}

export const FIXED: NamedColour[] = [
  { hex: "#0d9488", name: "Teal" },
  { hex: "#0369a1", name: "Ocean Blue" },
  { hex: "#d97706", name: "Ochre" },
  { hex: "#b45309", name: "Bronze" },
  { hex: "#0891b2", name: "Cyan" },
  { hex: "#db2777", name: "Pink" },
  { hex: "#65a30d", name: "Olive Green" },
  { hex: "#dc2626", name: "Red" },
  { hex: "#475569", name: "Slate" },
  { hex: "#9f1239", name: "Crimson" },
  { hex: "#78716c", name: "Stone Grey" },
  { hex: "#0f766e", name: "Dark Teal" },
  { hex: "#4f46e5", name: "Indigo" },
  { hex: "#c026d3", name: "Magenta" },
  { hex: "#94a3b8", name: "Silver" },
  { hex: "#2563eb", name: "Royal Blue" },
  { hex: "#7c3aed", name: "Violet" },
  { hex: "#059669", name: "Emerald" },
  { hex: "#ea580c", name: "Orange" },
]

export const USER_PALETTE: NamedColour[] = [
  { hex: "#6366f1", name: "Periwinkle" },
  { hex: "#3b82f6", name: "Cornflower Blue" },
  { hex: "#14b8a6", name: "Aquamarine" },
  { hex: "#f43f5e", name: "Rose" },
  { hex: "#a855f7", name: "Purple" },
  { hex: "#84cc16", name: "Chartreuse" },
  { hex: "#eab308", name: "Mustard" },
  { hex: "#06b6d4", name: "Turquoise" },
  { hex: "#ec4899", name: "Hot Pink" },
  { hex: "#1d4ed8", name: "Navy Blue" },
  { hex: "#16a34a", name: "Forest Green" },
  { hex: "#be123c", name: "Ruby" },
  { hex: "#8b5cf6", name: "Lavender" },
  { hex: "#a16207", name: "Mocha" },
  { hex: "#0284c7", name: "Azure" },
  { hex: "#4d7c0f", name: "Moss Green" },
  { hex: "#e11d48", name: "Raspberry" },
  { hex: "#7e22ce", name: "Plum" },
  { hex: "#0e7490", name: "Petrol Blue" },
  { hex: "#ca8a04", name: "Gold" },
  { hex: "#9333ea", name: "Amethyst" },
  { hex: "#15803d", name: "Pine Green" },
  { hex: "#1e40af", name: "Sapphire" },
  { hex: "#f472b6", name: "Blush Pink" },
]

export const STATUS: NamedColour[] = [
  { hex: "#10b981", name: "Green" },
  { hex: "#0ea5e9", name: "Sky Blue" },
  { hex: "#f59e0b", name: "Amber" },
  { hex: "#ef4444", name: "Coral Red" },
]

const ALL = [...FIXED, ...USER_PALETTE, ...STATUS]
const BY_HEX = new Map(ALL.map((c) => [c.hex.toLowerCase(), c.name]))
const FIXED_HEX = new Set(FIXED.map((c) => c.hex.toLowerCase()))

const rgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** A colour's name; a custom colour gets the nearest named one ("Close to Rose"). */
export function colourName(hex: string | undefined): string {
  if (!hex) return ""
  const exact = BY_HEX.get(hex.toLowerCase())
  if (exact) return exact
  const c = rgb(hex)
  if (!c) return hex
  let best = ALL[0], d = Infinity
  for (const x of ALL) {
    const y = rgb(x.hex)!
    const dist = (c[0] - y[0]) ** 2 + (c[1] - y[1]) ** 2 + (c[2] - y[2]) ** 2
    if (dist < d) { d = dist; best = x }
  }
  return `Close to ${best.name}`
}

const norm = (hex: string) => hex.toLowerCase()

/** The first palette colour nobody uses yet (built-in segments count as used). */
export function nextFreeColour(used: Iterable<string>): string {
  const taken = new Set([...FIXED_HEX, ...[...used].map(norm)])
  return (USER_PALETTE.find((c) => !taken.has(norm(c.hex))) ?? USER_PALETTE[[...taken].length % USER_PALETTE.length]).hex
}

/**
 * Give every LOB and every queue a colour of its own: the first one keeps a
 * colour, a later one sharing it — or one using a built-in segment's colour —
 * gets the next free palette colour. Returns null when nothing needs changing.
 */
export function fixColourClashes<L extends { color: string }, Q extends { color: string }>(lobs: L[], queues: Q[]): { lobs: L[]; queues: Q[] } | null {
  const taken = new Set<string>()
  let changed = false
  const take = <T extends { color: string }>(x: T): T => {
    const c = norm(x.color || "")
    if (c && !FIXED_HEX.has(c) && !taken.has(c)) { taken.add(c); return x }
    const color = nextFreeColour(taken)
    taken.add(norm(color))
    changed = true
    return { ...x, color }
  }
  const outLobs = lobs.map(take)
  const outQueues = queues.map(take)
  return changed ? { lobs: outLobs, queues: outQueues } : null
}
