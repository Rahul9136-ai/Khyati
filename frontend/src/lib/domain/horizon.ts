// Calendar helpers for multi-week scheduling. Dates are local ISO strings
// ("2026-10-26") — the same keys the backend's day plans use.

export const localISODate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

/** Noon local time, so adding days never trips over a DST change. */
export const parseISODate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(y, m - 1, d, 12)
}

export const addDays = (iso: string, n: number) => {
  const d = parseISODate(iso)
  d.setDate(d.getDate() + n)
  return localISODate(d)
}

export const isISODate = (s: string | null | undefined): s is string =>
  !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && localISODate(parseISODate(s)) === s

/** The next three months: today through the same day three months on, minus
 *  one (≈ 13 weeks). Matches the backend's `default_horizon`. */
export function scheduleHorizon(today = localISODate()): { start: string; end: string } {
  const t = parseISODate(today)
  const [y, m] = [t.getFullYear(), t.getMonth() + 3]
  // Clamp to the target month's last day (e.g. 30 Nov → 28 Feb) before stepping back a day.
  const last = new Date(y, m + 1, 0, 12).getDate()
  return { start: today, end: addDays(localISODate(new Date(y, m, Math.min(t.getDate(), last), 12)), -1) }
}

export function datesBetween(start: string, end: string): string[] {
  const out: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}

/** Monday of the week containing `iso`. */
export const weekStart = (iso: string) => addDays(iso, -((parseISODate(iso).getDay() + 6) % 7))

export const isWeekend = (iso: string) => [0, 6].includes(parseISODate(iso).getDay())

/** "Mon 26 Oct" */
export const fmtDay = (iso: string) =>
  parseISODate(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })

/** "Monday 26 October 2026" */
export const fmtDayLong = (iso: string) =>
  parseISODate(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
