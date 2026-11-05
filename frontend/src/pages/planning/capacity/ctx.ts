import { createContext, useContext } from "react"

import type { EngineResult } from "@/lib/capacity/engine"
import { canonLocation, keyOf } from "@/lib/capacity/normalize"

// ---------------------------------------------------------------- context
export interface Filters {
  customer: string
  serviceLine: string
  location: string
  month: string // YYYY-MM or ""
}
export const EMPTY_FILTERS: Filters = { customer: "", serviceLine: "", location: "", month: "" }

interface Ctx {
  result: EngineResult
  filters: Filters
  setFilters: (f: Filters) => void
  canEdit: boolean
}
export const CapacityCtx = createContext<Ctx | null>(null)
export function useCap(): Ctx {
  const c = useContext(CapacityCtx)
  if (!c) throw new Error("CapacityCtx missing")
  return c
}

/** Does a row's Customer / SL / Location / Month pass the filters? Location is compared canonically. */
export function passes(
  f: Filters, v: { customer?: unknown; serviceLine?: unknown; location?: unknown; month?: string | null },
): boolean {
  if (f.customer && v.customer !== undefined && keyOf(v.customer) !== keyOf(f.customer)) return false
  if (f.serviceLine && v.serviceLine !== undefined && keyOf(v.serviceLine) !== keyOf(f.serviceLine)) return false
  if (f.location && v.location !== undefined) {
    const loc = canonLocation(v.location) ?? String(v.location ?? "")
    if (keyOf(loc) !== keyOf(f.location)) return false
  }
  if (f.month && v.month !== undefined && v.month !== f.month) return false
  return true
}

// ---------------------------------------------------------------- formatting
export type Fmt = "hc" | "pct" | "int" | "num" | "text" | "pct-raw"

/** Display formatting only (§4.5): HC 2 dp, % 2 dp. Null → blank, never NaN / ∞. */
export function fmt(v: unknown, f: Fmt = "num"): string {
  if (v == null || v === "") return ""
  if (typeof v !== "number") return String(v)
  if (!Number.isFinite(v)) return ""
  switch (f) {
    case "hc": return v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    case "pct": return `${(v * 100).toFixed(2)}%`
    case "pct-raw": return `${v.toFixed(2)}%`
    case "int": return v.toLocaleString("en-IN", { maximumFractionDigits: 0 })
    case "text": return String(v)
    default: return v.toLocaleString("en-IN", { maximumFractionDigits: 4 })
  }
}

export function capacityTone(v: number | null, low: number, high: number): string {
  if (v == null) return ""
  if (v < low) return "bg-red-500/15 text-red-700 dark:text-red-400"
  if (v > high) return "bg-amber-500/15 text-amber-700 dark:text-amber-400"
  return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
}

