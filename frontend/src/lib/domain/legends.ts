// Every legend the tool uses, in one place: colour codes, agent states,
// schedule activities, statuses, colour bands and abbreviations. Built from the
// same definitions the screens draw with (so it can't drift from them), plus
// the organisation's own LOBs and queues.
import type { Row, Sheet } from "@/lib/export"

import { ACTIVITIES, CHANNELS } from "./channels"
import { colourName } from "./colours"
import { METHODS } from "./forecast"
import { lobTree, type Lob } from "./lob"
import { ROLE_DESCRIPTIONS, ROLES } from "./roles"
import { AUX } from "./seed"
import { SLOT_KINDS } from "./slots"
import type { Queue } from "./types"

export interface LegendItem {
  /** Short code shown on screen (e.g. AUX1, PH, OT), if any. */
  code?: string
  label: string
  /** Swatch colour (hex), if the legend is a colour. */
  color?: string
  /** The colour's name (e.g. "Ochre"). Filled in by buildLegends. */
  colorName?: string
  meaning: string
  /** What it is, when the same thing appears in more than one group (e.g. "break"). */
  concept?: string
  /** "Same colour as Break in Schedule activities" (it's the same thing). Filled in by buildLegends. */
  sameAs?: string
}

export interface LegendGroup {
  id: string
  title: string
  /** Where you'll see it. */
  where: string
  /** Colours mean something (traffic light) rather than tell segments apart. */
  semantic?: boolean
  note?: string
  items: LegendItem[]
}

/** AUX code → the schedule activity it is. */
const AUX_CONCEPT: Record<string, string> = { AUX1: "break", AUX2: "lunch", AUX3: "meeting", AUX4: "training", AUX5: "coaching" }

const AUX_CAT: Record<string, string> = {
  productive: "Productive: counts as working",
  break: "Break",
  shrink: "Shrinkage: planned time away from queues",
  offline: "Not logged in",
}

/** Abbreviations and terms used across the tool. */
export const GLOSSARY: LegendItem[] = [
  { code: "ACW", label: "After-Call Work", meaning: "Wrap-up time after a contact (notes, dispositions) before taking the next one." },
  { code: "AHT", label: "Average Handle Time", meaning: "Talk + hold + after-call work per contact, in seconds." },
  { code: "ASA", label: "Average Speed of Answer", meaning: "Average time a contact waits in queue before it's answered." },
  { code: "AUX", label: "Auxiliary state", meaning: "A non-productive agent state (break, lunch, meeting, training …)." },
  { code: "Attrition %", label: "Attrition", meaning: "Share of headcount expected to leave in the month (budgeted or actual)." },
  { code: "Base FTE", label: "Base FTE", meaning: "Volume ÷ working days ÷ peak target (transaction work), or the FTE billed (flat FTE)." },
  { code: "Buffer", label: "Overall buffer", meaning: "Shrinkage + glide path + growth added on top of Base FTE to get Required HC." },
  { code: "Capacity %", label: "Capacity %", meaning: "Projected HC ÷ Required HC: whether you'll have enough people." },
  { code: "Erlang C", label: "Erlang C", meaning: "Queueing formula that turns volume, AHT and the service-level target into agents needed." },
  { code: "FTE", label: "Full-Time Equivalent", meaning: "One full-time person's worth of hours (e.g. two half-time agents = 1 FTE)." },
  { code: "Glide path", label: "Glide path", meaning: "Extra buffer while new hires ramp up to full productivity." },
  { code: "HC", label: "Headcount", meaning: "Number of people (not hours)." },
  { code: "LOA", label: "Leave of Absence", meaning: "Extended time away; the agent is off for whole shifts." },
  { code: "LOB", label: "Line of Business", meaning: "A client, product or department; holds channels, which hold queues." },
  { code: "MAPE", label: "Mean Absolute Percentage Error", meaning: "Forecast accuracy: average % gap between forecast and actual (lower is better)." },
  { code: "Occupancy", label: "Occupancy", meaning: "Share of logged-in time agents spend handling contacts." },
  { code: "OT", label: "Overtime", meaning: "Extra hours worked outside the scheduled shift." },
  { code: "Peak Target", label: "Peak target productivity", meaning: "Units an agent is expected to complete per day at full productivity." },
  { code: "Projected HC", label: "Projected headcount", meaning: "Actual HC − expected attrition + planned additions (hiring)." },
  { code: "PTO", label: "Paid Time Off", meaning: "Paid time away taken in hours or days." },
  { code: "QA / QCA", label: "Quality analyst / Quality check", meaning: "People who audit a sample of the work; QCA % is their share of production HC." },
  { code: "Ramp", label: "Ramp-up", meaning: "A new hire's productivity curve from training to full target." },
  { code: "Req HC", label: "Required headcount", meaning: "Base FTE grossed up by the overall buffer: the people you need." },
  { code: "RR", label: "Resource Request", meaning: "A hiring requisition (number of openings, designation, due month)." },
  { code: "RTA", label: "Real-Time Analyst", meaning: "Watches the floor live and moves people to protect service level." },
  { code: "Sampling %", label: "Sampling", meaning: "Share of production that QA audits." },
  { code: "Shrinkage", label: "Shrinkage", meaning: "Paid time agents aren't available for contacts (breaks, meetings, leave, training)." },
  { code: "SL", label: "Service Level", meaning: "Share of contacts answered within the target time (e.g. 80% in 20 s)." },
  { code: "SLA", label: "Service Level Agreement", meaning: "The service level promised to the client." },
  { code: "SNP %", label: "Separation / attrition share", meaning: "Share of QA headcount expected to leave in the month (switchable in Capacity Planning)." },
  { code: "TL", label: "Team Leader", meaning: "Leads a team of agents; approves requests and sends messages." },
  { code: "VA", label: "Variance", meaning: "Projected HC − Required HC (negative = short of people)." },
  { code: "VTO", label: "Voluntary Time Off", meaning: "Unpaid time off offered when there are more agents than needed." },
  { code: "W.days", label: "Working days", meaning: "Working days in the month, used to turn monthly volume into daily need." },
  { code: "WFM", label: "Workforce Management", meaning: "Forecasting, planning, scheduling and real-time management of contact-centre staff." },
]

const pct = (v: number) => `${Math.round(v * 100)}%`

/** Every legend group. `queues` / `lobs` are the organisation's; thresholds from Capacity Planning's switches. */
export function buildLegends(opts: { queues: Queue[]; lobs: Lob[]; capacityLow?: number; capacityHigh?: number }): LegendGroup[] {
  return finish(rawLegends(opts))
}

/** Colour names, and "same colour as …" where one thing appears in two groups. */
function finish(groups: LegendGroup[]): LegendGroup[] {
  const firstByColour = new Map<string, { group: LegendGroup; item: LegendItem }>()
  return groups.map((g) => ({
    ...g,
    items: g.items.map((i) => {
      if (!i.color) return i
      const out: LegendItem = { ...i, colorName: colourName(i.color) }
      if (!g.semantic) {
        const key = i.color.toLowerCase()
        const first = firstByColour.get(key)
        if (!first) firstByColour.set(key, { group: g, item: i })
        else if (i.concept && first.item.concept === i.concept)
          out.sameAs = `Same colour as ${first.item.label} in ${first.group.title} (it's the same thing)`
      }
      return out
    }),
  }))
}

function rawLegends(opts: { queues: Queue[]; lobs: Lob[]; capacityLow?: number; capacityHigh?: number }): LegendGroup[] {
  const low = opts.capacityLow ?? 0.95
  const high = opts.capacityHigh ?? 1.05
  const tree = lobTree(opts.lobs, opts.queues)
  return [
    {
      id: "lobs",
      title: "Lines of business & queues",
      where: "Left pane (Lines of business), top bar, Forecasting, Scheduling, Real-time",
      items: tree.flatMap(({ lob, channels }) => [
        { code: "LOB", label: lob.name, color: lob.color, meaning: `Line of business · channels: ${lob.channels.join(", ") || "none"}` },
        ...channels.flatMap((c) => c.queues.map((q) => ({
          code: "Queue",
          label: q.name,
          color: q.color,
          meaning: `${lob.name} › ${c.name} · AHT ${q.aht}s · SL target ${pct(q.slTarget)} in ${q.targetTime}s`,
        }))),
      ]),
    },
    {
      id: "aux",
      title: "Agent states (AUX codes)",
      where: "Real-Time Monitor, Adherence, Intraday",
      items: AUX.map((a) => ({
        concept: AUX_CONCEPT[a.code],
        code: a.code,
        label: a.label,
        color: a.color,
        meaning: AUX_CAT[a.cat] + (a.deferrable === true ? " · can be moved by the RTA" : a.deferrable === false ? " · fixed time" : ""),
      })),
    },
    {
      id: "activities",
      title: "Schedule activities",
      where: "Scheduling timeline, My schedule, Multi-week view",
      items: [
        { concept: "break", code: "BRK", label: "Break", color: "#d97706", meaning: "Short paid break inside the shift." },
        { concept: "lunch", code: "LUN", label: "Lunch", color: "#b45309", meaning: "Meal break inside the shift." },
        ...ACTIVITIES.map((a) => ({
          concept: a.id as string,
          code: a.short,
          label: a.label,
          color: a.color,
          meaning: a.fullShift ? "Takes the whole shift: the agent isn't available that day." : "Time inside the shift away from queues.",
        })),
      ],
    },
    {
      id: "channels",
      title: "Contact channels",
      where: "Scheduling (channel blocks), Lines of business",
      items: CHANNELS.map((c) => ({ code: c.short, label: c.label, color: c.color, meaning: `The agent handles ${c.label.toLowerCase()} contacts in this block.` })),
    },
    {
      id: "slots",
      title: "Time-off & overtime slots",
      where: "Scheduling → Open slots, agents' My schedule",
      items: SLOT_KINDS.map((k) => ({ concept: k.id as string, code: k.label, label: k.long, color: k.color, meaning: `Slots opened for agents to claim (${k.long.toLowerCase()}).` })),
    },
    {
      id: "capacity",
      title: "Capacity % colours",
      where: "Capacity Planning (Summary, Calculations), Dashboard",
      semantic: true,
      note: "Traffic-light colours: green = on target, amber = attention, red = action needed.",
      items: [
        { label: `Below ${pct(low)}`, color: "#ef4444", meaning: "Under capacity: not enough people; hire, add overtime or move people." },
        { label: `${pct(low)} – ${pct(high)}`, color: "#10b981", meaning: "On target." },
        { label: `Above ${pct(high)}`, color: "#f59e0b", meaning: "Over capacity: more people than needed; consider VTO or moving people." },
      ],
    },
    {
      id: "status",
      title: "Statuses & indicators",
      where: "Top bar, Capacity Planning, PTO & Leave, Data Exceptions",
      semantic: true,
      note: "Traffic-light colours: green = good, sky blue = in progress / information, amber = attention, red = action needed.",
      items: [
        { code: "Saved", label: "All changes saved", color: "#10b981", meaning: "Everything you've added is saved for your organisation." },
        { code: "Saving", label: "Saving…", color: "#0ea5e9", meaning: "Your latest change is being saved." },
        { code: "Offline", label: "Offline", color: "#f59e0b", meaning: "Server unreachable: changes are kept in this browser and saved when it's back." },
        { code: "Updated", label: "Updated by someone else", color: "#f59e0b", meaning: "Someone saved the same thing first; their version is loaded." },
        { code: "Live", label: "Shared · live", color: "#10b981", meaning: "Capacity Planning: changes from anyone arrive within a second." },
        { code: "Pending", label: "Pending", color: "#f59e0b", meaning: "A request waiting for approval." },
        { code: "Approved", label: "Approved", color: "#10b981", meaning: "A request that was approved (and applied)." },
        { code: "Denied", label: "Denied", color: "#ef4444", meaning: "A request that was turned down." },
        { code: "Error", label: "Data exception: error", color: "#ef4444", meaning: "A row can't be calculated until the data is fixed." },
        { code: "Warning", label: "Data exception: warning", color: "#f59e0b", meaning: "Calculated, but a value was assumed or looks wrong." },
        { code: "Info", label: "Data exception: info", color: "#0ea5e9", meaning: "For information; nothing to fix." },
      ],
    },
    {
      id: "models",
      title: "Forecast models",
      where: "Forecasting → Model selection",
      items: METHODS.map((m) => ({ code: m.kind, label: m.name, meaning: `${m.kind} model; back-tested and ranked by MAPE.` })),
    },
    {
      id: "roles",
      title: "Roles",
      where: "Settings & RBAC, top bar (preview a role)",
      items: ROLES.map((r) => ({ label: r, meaning: ROLE_DESCRIPTIONS[r] })),
    },
    { id: "glossary", title: "Abbreviations & terms", where: "Everywhere", items: GLOSSARY },
  ]
}

const row = (g: LegendGroup, i: LegendItem): Row => ({
  Code: i.code ?? "",
  Name: i.label,
  "Colour name": i.colorName ?? "",
  Colour: i.color ?? "",
  Meaning: i.sameAs ? `${i.meaning} ${i.sameAs}.` : i.meaning,
  "Where you see it": g.where,
})

/** "All legends" first, then one worksheet per group (Excel) / section (CSV). */
export function legendSheets(groups: LegendGroup[]): Sheet[] {
  return [
    { name: "All legends", rows: groups.flatMap((g) => g.items.map((i) => ({ Group: g.title, ...row(g, i) }))) },
    ...groups.map((g) => ({ name: g.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31), rows: g.items.map((i) => row(g, i)) })),
  ]
}
