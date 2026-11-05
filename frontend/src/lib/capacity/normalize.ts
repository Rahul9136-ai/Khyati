// Normalisation rules (build prompt §3). Applied to join keys only — the
// original text is always kept for display.

/** Trim + upper-case. The basis of every join in the module. */
export function keyOf(v: unknown): string {
  return v == null ? "" : String(v).trim().replace(/\s+/g, " ").toUpperCase()
}

/** Canonical location values (§3.2). Keys are already keyOf()'d. */
const LOCATION_MAP: Record<string, string> = {
  CHENNAI: "Chennai",
  TRICHY: "Trichy",
  TIRUCHIRAPPALLI: "Trichy",
  BENGALURU: "Bangalore",
  BANGALORE: "Bangalore",
  HYDERABAD: "Hyderabad",
  COIMBATORE: "Coimbatore",
  MUMBAI: "Mumbai",
  "NAVI MUMBAI": "Mumbai",
}

/** Returns the canonical location, or null if the value isn't in the map. */
export function canonLocation(v: unknown): string | null {
  const k = keyOf(v)
  if (!k) return null
  return LOCATION_MAP[k] ?? null
}

/** Location for joining: canonical if known, otherwise the original text trimmed. */
export function locationKey(v: unknown): string {
  const c = canonLocation(v)
  return keyOf(c ?? v)
}

/** Service line: case-insensitive (§3.3). `PAYMENT POSTING` = `Payment posting`. */
export function slKey(v: unknown): string {
  return keyOf(v)
}

/** Hiring Type: `Laterals` → `Lateral` (§3.4). */
export function normHiringType(v: unknown): string {
  const k = keyOf(v)
  if (k === "LATERALS" || k === "LATERAL") return "Lateral"
  if (k === "TRAINEE" || k === "TRAINEES") return "Trainee"
  return v == null ? "" : String(v).trim()
}

/** Approved Status: `Apprvoed` typo → `Approved` (§3.5). */
export function normApproved(v: unknown): { value: string; typo: boolean } {
  const k = keyOf(v)
  if (k === "APPRVOED") return { value: "Approved", typo: true }
  if (k === "APPROVED") return { value: "Approved", typo: false }
  return { value: v == null ? "" : String(v).trim(), typo: false }
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** A month is stored internally as `YYYY-MM` (the 1st of the month). */
export type MonthKey = string

/**
 * Parse `Mon'YY` (e.g. `Sep'26`) — also tolerates `Sep-26`, `Sep 26`, `Sep'2026`,
 * an Excel date serial, a JS Date, or `YYYY-MM[-DD]`. Returns null when it can't.
 */
export function parseMonth(v: unknown): MonthKey | null {
  if (v == null || v === "") return null
  if (v instanceof Date && !Number.isNaN(v.getTime()))
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}`
  if (typeof v === "number" && Number.isFinite(v) && v > 20000 && v < 80000) {
    const d = excelSerialToDate(v)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
  }
  const s = String(v).trim()
  let m = /^([A-Za-z]{3})[A-Za-z]*\s*['’`\-\s/]\s*(\d{2}|\d{4})$/.exec(s)
  if (m) {
    const mi = MONTHS.indexOf(m[1].toUpperCase())
    if (mi < 0) return null
    const y = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2])
    return `${y}-${String(mi + 1).padStart(2, "0")}`
  }
  m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?/.exec(s)
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2].padStart(2, "0")}`
  return null
}

/** `2026-09` → `Sep'26` */
export function monthLabel(m: MonthKey): string {
  const [y, mo] = m.split("-").map(Number)
  return `${MONTH_LABELS[mo - 1]}'${String(y).slice(-2)}`
}

export function monthStart(m: MonthKey): Date {
  const [y, mo] = m.split("-").map(Number)
  return new Date(Date.UTC(y, mo - 1, 1))
}

export function monthEnd(m: MonthKey): Date {
  const [y, mo] = m.split("-").map(Number)
  return new Date(Date.UTC(y, mo, 0))
}

/** Excel serial (1900 system) → UTC date. */
export function excelSerialToDate(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000))
}

/** Any date-ish cell → UTC Date, or null. */
export function parseDate(v: unknown): Date | null {
  if (v == null || v === "") return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === "number" && Number.isFinite(v)) return excelSerialToDate(v)
  const s = String(v).trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]))
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s)
  if (dmy) return new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1]))
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t)
}

export function fmtDate(d: Date | null): string {
  if (!d) return ""
  return d.toISOString().slice(0, 10)
}

/** Number from a cell; null when blank or not numeric. */
export function num(v: unknown): number | null {
  if (v == null || v === "") return null
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  const s = String(v).trim().replace(/,/g, "")
  if (s === "" || s === "-") return null
  const pct = s.endsWith("%")
  const n = Number(pct ? s.slice(0, -1) : s)
  if (!Number.isFinite(n)) return null
  return pct ? n / 100 : n
}
