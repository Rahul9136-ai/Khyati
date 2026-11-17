// The published forecast: one queue's prediction for the selected period, with
// every target day by day. It is what the rest of the app (Dashboard, Reports,
// Scenario Studio, Capacity, Scheduling) and outside dashboards read:
//
// * in the app — the store's `publishedForecasts[queueId]`
// * on the server — workspace area `publishedForecasts` (saved by workspaceSync),
//   flattened for BI tools at GET /api/v1/forecasting/published (JSON or CSV,
//   API-key friendly), with a `forecast.published` webhook on every publish.
import type { ForecastDriver } from "./drivers"
import type { RangePlan, TargetValues } from "./granularity"

export const FORECAST_TARGETS = [
  { id: "volume", name: "Volume", unit: "contacts", total: true },
  { id: "aht", name: "AHT", unit: "sec", total: false },
  { id: "required", name: "Required hours", unit: "agent-hrs", total: true },
  { id: "fte", name: "Required FTE", unit: "FTE / day", total: false },
  { id: "scheduled", name: "Scheduled hours", unit: "agent-hrs", total: true },
  { id: "variance", name: "Over / under", unit: "agent-hrs", total: true },
  { id: "projSL", name: "Service level", unit: "%", total: false },
  { id: "occupancy", name: "Occupancy", unit: "%", total: false },
] as const
export type TargetId = (typeof FORECAST_TARGETS)[number]["id"]
export const DEFAULT_TARGETS: TargetId[] = ["volume", "aht", "required", "fte", "projSL"]
export const targetById = Object.fromEntries(FORECAST_TARGETS.map((t) => [t.id, t])) as Record<TargetId, (typeof FORECAST_TARGETS)[number]>

export function fmtTarget(id: TargetId, v: number): string {
  if (!Number.isFinite(v)) return "—"
  if (id === "projSL" || id === "occupancy") return `${(v * 100).toFixed(1)}%`
  if (id === "aht") return `${Math.round(v)}s`
  if (id === "fte") return v.toFixed(1)
  if (id === "variance") return `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString()}`
  return Math.round(v).toLocaleString()
}

export interface PublishedDay extends TargetValues {
  date: string
}

export interface PublishedForecast {
  queueId: string
  queueName: string
  start: string
  end: string
  bucket: RangePlan["bucket"]
  methodId: string
  methodName: string
  mape: number
  targets: TargetId[]
  drivers: { id: string; name: string; target: string; elasticity: number }[]
  events: number
  totals: TargetValues
  days: PublishedDay[]
  publishedAt: number
  publishedBy: string
  auto: boolean
}

const r2 = (x: number) => Math.round(x * 100) / 100
const r4 = (x: number) => Math.round(x * 10000) / 10000

export function buildPublished(args: {
  queueId: string
  queueName: string
  start: string
  end: string
  plan: RangePlan
  methodId: string
  methodName: string
  mape: number
  targets: TargetId[]
  drivers: ForecastDriver[]
  events: number
  publishedBy: string
  auto: boolean
}): PublishedForecast {
  const { plan } = args
  const tidy = (t: TargetValues): TargetValues => ({
    volume: Math.round(t.volume),
    aht: Math.round(t.aht),
    required: r2(t.required),
    fte: r2(t.fte),
    scheduled: r2(t.scheduled),
    variance: r2(t.variance),
    projSL: r4(t.projSL),
    occupancy: r4(t.occupancy),
  })
  return {
    queueId: args.queueId,
    queueName: args.queueName,
    start: args.start,
    end: args.end,
    bucket: plan.bucket,
    methodId: args.methodId,
    methodName: args.methodName,
    mape: r4(args.mape),
    targets: args.targets,
    drivers: args.drivers.map((d) => ({ id: d.id, name: d.name, target: d.target, elasticity: d.elasticity })),
    events: args.events,
    totals: tidy(plan.totals),
    days: plan.days.map((d) => ({ date: d.date, ...tidy(d) })),
    publishedAt: Date.now(),
    publishedBy: args.publishedBy,
    auto: args.auto,
  }
}

/** What changed between two publishes, ignoring when/who — so auto-publish only fires on a real change. */
export const publishFingerprint = (p: PublishedForecast | undefined) =>
  p ? JSON.stringify([p.start, p.end, p.methodId, p.targets, p.drivers, p.events, p.totals, p.days]) : ""

/** Flat rows (one per queue per day) — the shape BI tools and the CSV feed use. */
export function publishedRows(list: PublishedForecast[]): Record<string, string | number>[] {
  return list.flatMap((p) =>
    p.days.map((d) => ({
      queue_id: p.queueId,
      queue: p.queueName,
      date: d.date,
      volume: d.volume,
      aht_sec: d.aht,
      required_hours: d.required,
      required_fte: d.fte,
      scheduled_hours: d.scheduled,
      over_under_hours: d.variance,
      service_level: d.projSL,
      occupancy: d.occupancy,
      model: p.methodName,
      mape: p.mape,
      published_at: new Date(p.publishedAt).toISOString(),
    })),
  )
}

function download(name: string, mime: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadPublishedCsv(list: PublishedForecast[], name = "published-forecast.csv") {
  const rows = publishedRows(list)
  if (!rows.length) return
  const cols = Object.keys(rows[0])
  const esc = (v: unknown) => {
    const s = String(v ?? "")
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  download(name, "text/csv", [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n"))
}

export function downloadPublishedJson(list: PublishedForecast[], name = "published-forecast.json") {
  download(name, "application/json", JSON.stringify(list, null, 2))
}
