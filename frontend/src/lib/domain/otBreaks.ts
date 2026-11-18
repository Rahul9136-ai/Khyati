// Overtime breaks: an organisation rule (Work rules → Compliance) that gives
// overtime its own breaks — one break of `breakMinutes` for every full
// `everyMinutes` of overtime, spaced evenly through it.
//
// They're worked out from the OT blocks, the way work-rule breaks come from a
// pattern, so they follow every OT edit. Touching OT blocks count as one
// stretch (17:00–18:00 Chat + 18:00–19:00 Phone = 2h of OT). The contracted
// shift isn't counted — only overtime earns these breaks.
//
// An OT break takes the agent off the channel (no coverage) and is never
// worked time. Paid OT breaks still count as paid overtime; unpaid ones don't.
// Reports show the three apart: OT scheduled, OT breaks, OT worked (and paid).

export interface OtBreakRule {
  /** One break per this many minutes of continuous overtime. */
  everyMinutes: number
  breakMinutes: number
  paid: boolean
}

export interface OtBreak {
  id: string
  start: number
  end: number
  paid: boolean
}

type Span = { start: number; end: number }

/** The compliance fields the rule lives in. */
export interface OtBreakSettings {
  /** null / absent = no OT breaks. */
  otBreakEveryMinutes?: number | null
  otBreakMinutes?: number
  otBreakPaid?: boolean
}

/** OT breaks' own colour (Rust), apart from in-shift breaks (Ochre) and OT (channel colours). */
export const OT_BREAK_COLOR = "#c2410c"

export const DEFAULT_OT_BREAK = { everyMinutes: 120, breakMinutes: 15, paid: false } as const

/** The rule as set in compliance, or undefined when it's switched off. */
export function otBreakRuleOf(c: OtBreakSettings | null | undefined): OtBreakRule | undefined {
  const every = c?.otBreakEveryMinutes
  const len = c?.otBreakMinutes ?? DEFAULT_OT_BREAK.breakMinutes
  if (!every || every < 30 || !(len >= 5) || len >= every) return undefined
  return { everyMinutes: every, breakMinutes: len, paid: !!c?.otBreakPaid }
}

/** OT blocks joined where they touch. */
export function otStretches(ot: Span[]): Span[] {
  const out: Span[] = []
  for (const o of [...ot].filter((x) => x.end > x.start).sort((a, b) => a.start - b.start)) {
    const last = out.at(-1)
    if (last && o.start <= last.end) last.end = Math.max(last.end, o.end)
    else out.push({ start: o.start, end: o.end })
  }
  return out
}

const snap5 = (m: number) => Math.round(m / 5) * 5

/** The OT breaks a day's overtime gets under the rule (none without one). */
export function otBreaksFor(ot: Span[], rule: OtBreakRule | undefined): OtBreak[] {
  if (!rule || !ot.length) return []
  const out: OtBreak[] = []
  for (const st of otStretches(ot)) {
    const len = st.end - st.start
    const n = Math.floor(len / rule.everyMinutes)
    if (n < 1 || n * rule.breakMinutes >= len) continue
    for (let i = 1; i <= n; i++) {
      const centre = st.start + (i * len) / (n + 1)
      const start = Math.min(st.end - rule.breakMinutes, Math.max(st.start, snap5(centre - rule.breakMinutes / 2)))
      out.push({ id: `otb-${st.start}-${i}`, start, end: start + rule.breakMinutes, paid: rule.paid })
    }
  }
  return out
}

/** A day's OT breaks: from the rule the day carries, else the one given. */
export function dayOtBreaks(day: { ot: Span[]; otBreakRule?: OtBreakRule }, fallback?: OtBreakRule): OtBreak[] {
  return otBreaksFor(day.ot, day.otBreakRule ?? fallback)
}

export interface OtMinutes {
  /** All overtime scheduled, breaks included. */
  scheduled: number
  /** Of which OT breaks. */
  breaks: number
  /** Overtime actually worked (scheduled − breaks). */
  worked: number
  /** Overtime paid (worked, plus breaks when they're paid). */
  paid: number
}

export function otMinutes(day: { ot: Span[]; otBreakRule?: OtBreakRule }, fallback?: OtBreakRule): OtMinutes {
  const scheduled = day.ot.reduce((t, o) => t + Math.max(0, o.end - o.start), 0)
  const brks = dayOtBreaks(day, fallback)
  const breaks = brks.reduce((t, b) => t + b.end - b.start, 0)
  const paidBreaks = brks.filter((b) => b.paid).reduce((t, b) => t + b.end - b.start, 0)
  return { scheduled, breaks, worked: scheduled - breaks, paid: scheduled - breaks + paidBreaks }
}

/** "15 min every 2h of OT (unpaid)" — for the rule's summary and report notes. */
export function describeOtBreakRule(rule: OtBreakRule | undefined): string {
  if (!rule) return "off"
  const every = rule.everyMinutes % 60 ? `${rule.everyMinutes} min` : `${rule.everyMinutes / 60}h`
  return `${rule.breakMinutes} min break for every ${every} of OT (${rule.paid ? "paid" : "unpaid"})`
}
