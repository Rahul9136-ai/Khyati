// The Capacity Planning engine: normalise → join → calculate (§3, §4) and log
// every join failure / dirty value to Data Exceptions (§5). Pure function of
// (dataset, config) — the UI re-runs it whenever an input or switch changes.
import { type CapacityConfig, treatmentFor } from "./config"
import {
  type HcProdOut, type HcQcaOut, type VolumeOut, baseFteTransaction, flatRampProduction, hcProduction, hcQca,
  safeDiv, volumeBased,
} from "./formulas"
import {
  type MonthKey, canonLocation, keyOf, locationKey, monthLabel, monthStart, normApproved, num,
  parseDate, parseMonth, slKey,
} from "./normalize"
import type { Cell, Dataset, Row } from "./parse"
import { RAMP_WEEKS, SAMPLING_WEEKS, type SheetId } from "./schema"

// ---------------------------------------------------------------- types
export type Severity = "error" | "warning" | "info"
export type ExceptionCode =
  | "forecast-task-missing" | "forecast-duplicate" | "job-not-in-designation" | "approved-typo"
  | "no-budget-month" | "hiring-before-horizon" | "hiring-after-horizon" | "additional-billing"
  | "spelling-variant" | "unknown-location" | "unparsable-month" | "div-by-zero" | "missing-lookup"
  | "peak-target-invalid" | "missing-dop" | "non-numeric" | "sno-gap" | "hiring-designation-missing"
  | "duplicate-lookup" | "hiring-not-approved"

export interface DataException {
  code: ExceptionCode
  severity: Severity
  sheet: string
  row: number | null
  issue: string
  value: string
  action: string
  /** Optional join key so the UI can filter exceptions like other sub-tabs. */
  customer?: string
  serviceLine?: string
  location?: string
  month?: string
}

export interface KeyInfo {
  key: string
  customer: string
  serviceLine: string
  location: string
}

export interface TaskContribution {
  taskNo: string
  billType: string
  treatment: string
  units: number
  peak: number | null
  baseFte: number | null
  sourceRows: number[]
}

export interface ResultRow extends KeyInfo {
  month: MonthKey
  monthLabel: string
  // inputs used
  forecastVolume: number // P1
  peakTarget: number | null // P2 (volume-weighted)
  peakTargetQca: number | null
  wdays: number | null // P3
  baseFte: number | null // P4
  baseFteBlankReason: string | null
  shrinkB: number | null; shrinkA: number | null
  glideB: number | null; glideA: number | null
  growthB: number | null
  attrB: number | null; attrProdA: number | null; attrQcaA: number | null
  budgetQcaPct: number | null
  actualHc: number // P11
  actualQa: number // Q4
  additionProd: number // P15
  additionQca: number // Q8
  budgetCarried: boolean
  prod: HcProdOut
  qca: HcQcaOut
  vol: VolumeOut
  tasks: TaskContribution[]
  flags: string[]
}

export interface EngineResult {
  months: MonthKey[]
  rows: ResultRow[]
  exceptions: DataException[]
  /** Row-level helper data for reconciliation checks. */
  counts: {
    rosterProd: { customer: string; serviceLine: string; location: string }[]
    rosterQa: { customer: string; serviceLine: string; location: string }[]
    hiring: { customer: string; serviceLine: string; location: string; month: MonthKey | null; opening: number; qca: boolean; inHorizon: boolean }[]
  }
}

// ---------------------------------------------------------------- helpers
const SHEET_LABEL: Record<SheetId, string> = {
  userMapping: "User Mapping", forecast: "Forecast Details", target: "Target Details", ramp: "Ramp Grid",
  hiring: "Hiring (RR)", budgetBuffer: "Budgeted Buffer", actualShrinkage: "Actual Shrinkage",
  actualAttrition: "Actual Attrition", budgetAttrition: "Budgeted Attrition", budgetQca: "Budgeted QCA %",
  trainingDays: "Training Days", designationType: "Designation Type", sampling: "Sampling Grid", workingDays: "Working Days",
}

const str = (v: Cell | undefined): string => (v == null ? "" : String(v).trim())
const k3 = (c: string, s: string, l: string) => `${c}|${s}|${l}`

const PROD_CATEGORIES = new Set(["02. PRODUCTION", "12. TRAINEE [DU & CUSTOMER SPECIFIC]"])
const QA_CATEGORY = "02. QA"

export function rowsOf(ds: Dataset, id: SheetId): Row[] {
  return ds[id]?.rows ?? []
}

/** Calculated column for Budgeted Attrition / Budgeted QCA %: Numerator ÷ Denominator. */
export function ratioOf(r: Row): number | null {
  return safeDiv(num(r["Numerator"]), num(r["Denominator"]))
}

interface MonthlyLookup<T> {
  byKey: Map<string, Map<MonthKey, T>>
}
function monthlyGet<T>(
  l: MonthlyLookup<T>, key: string, month: MonthKey, carry: boolean,
): { value: T | null; carriedFrom: MonthKey | null } {
  const m = l.byKey.get(key)
  if (!m) return { value: null, carriedFrom: null }
  const exact = m.get(month)
  if (exact !== undefined) return { value: exact, carriedFrom: null }
  if (!carry) return { value: null, carriedFrom: null }
  let best: MonthKey | null = null
  for (const mk of m.keys()) if (mk < month && (best === null || mk > best)) best = mk
  return best ? { value: m.get(best)!, carriedFrom: best } : { value: null, carriedFrom: null }
}

// ---------------------------------------------------------------- engine
export function runEngine(ds: Dataset, cfg: CapacityConfig): EngineResult {
  const ex: DataException[] = []
  const log = (e: DataException) => ex.push(e)

  // display names per key part — first seen wins (forecast first, then roster, then hiring)
  const custName = new Map<string, string>()
  const slName = new Map<string, string>()
  const remember = (map: Map<string, string>, k: string, v: string) => { if (k && !map.has(k)) map.set(k, v) }

  // spelling variants (§3 info rows)
  const variants = new Map<string, { sheet: string; count: number; to: string; field: string }>()
  const noteVariant = (sheet: string, field: string, raw: string, to: string) => {
    if (!raw || raw === to) return
    const id = `${sheet}|${field}|${raw}`
    const v = variants.get(id)
    if (v) v.count++
    else variants.set(id, { sheet, count: 1, to, field })
  }
  const unknownLoc = new Map<string, { sheet: string; rows: number[] }>()
  const locOf = (sheet: SheetId, raw: Cell | undefined, row: number, field = "Location"): string => {
    const s = str(raw)
    const c = canonLocation(s)
    if (c) {
      noteVariant(SHEET_LABEL[sheet], field, s, c)
      return c
    }
    if (s) {
      const id = `${sheet}|${s}`
      const u = unknownLoc.get(id) ?? { sheet: SHEET_LABEL[sheet], rows: [] }
      u.rows.push(row)
      unknownLoc.set(id, u)
    }
    return s
  }
  const slOf = (sheet: SheetId, raw: Cell | undefined, field: string): string => {
    const s = str(raw)
    const k = slKey(s)
    const canonical = slName.get(k)
    if (canonical && canonical !== s) noteVariant(SHEET_LABEL[sheet], field, s, canonical)
    return s
  }

  // ---- Working Days → horizon
  const wdays = new Map<MonthKey, number>()
  for (const r of rowsOf(ds, "workingDays")) {
    const m = parseMonth(r["Month"])
    const d = num(r["Days"])
    if (!m) { log({ code: "unparsable-month", severity: "error", sheet: "Working Days", row: r.__row, issue: "Month can't be parsed as Mon'YY", value: str(r["Month"]), action: "Row ignored" }); continue }
    if (d == null || d <= 0) { log({ code: "non-numeric", severity: "error", sheet: "Working Days", row: r.__row, issue: "Days missing, zero or not a number", value: str(r["Days"]), action: "Month has no W.days — Base FTE blank" }); continue }
    wdays.set(m, d)
  }
  const fcMonthCols = (ds.forecast?.monthColumns ?? []).map((c) => ({ col: c, month: parseMonth(c.replace(/^units\s*_\s*/i, "")) }))
  for (const mc of fcMonthCols) if (!mc.month)
    log({ code: "unparsable-month", severity: "error", sheet: "Forecast Details", row: null, issue: "Month column can't be parsed as Mon'YY", value: mc.col, action: "Column ignored" })
  let months = [...wdays.keys()].sort()
  if (!months.length) months = [...new Set(fcMonthCols.map((m) => m.month).filter((m): m is MonthKey => !!m))].sort()
  const horizon = new Set(months)
  const firstMonth = months[0]
  const lastMonth = months[months.length - 1]

  // ---- Designation Type: designation → user type
  const userTypeOf = new Map<string, string>()
  for (const r of rowsOf(ds, "designationType")) {
    const d = keyOf(r["Designation"])
    if (d && !userTypeOf.has(d)) userTypeOf.set(d, str(r["User Type"]))
  }

  // ---- Target Details by TaskNo
  interface Target { peak: number | null; peakQca: number | null; row: number; specialty: string }
  const targets = new Map<string, Target>()
  let zeroPeakTargets = 0
  for (const r of rowsOf(ds, "target")) {
    const t = keyOf(r["TaskNo"])
    if (!t) continue
    if (targets.has(t)) {
      log({ code: "duplicate-lookup", severity: "warning", sheet: "Target Details", row: r.__row, issue: "TaskNo is not unique", value: str(r["TaskNo"]), action: "First row used" })
      continue
    }
    const peak = num(r["Peak Target Prod"])
    const peakQca = num(r["Peak Target QCA"])
    if (peak == null || peak <= 0) zeroPeakTargets++
    targets.set(t, { peak: peak != null && peak > 0 ? peak : null, peakQca: peakQca != null && peakQca > 0 ? peakQca : null, row: r.__row, specialty: str(r["Specialty"]) })
  }

  // ---- Ramp Grid by TaskNo × User Type (fractions)
  const rampGrid = new Map<string, number[]>()
  for (const r of rowsOf(ds, "ramp")) {
    const id = `${keyOf(r["TaskNo"])}|${keyOf(r["User Type"])}`
    if (rampGrid.has(id)) continue
    rampGrid.set(id, Array.from({ length: RAMP_WEEKS }, (_, i) => (num(r[`Week ${i + 1} %`]) ?? 0) / 100))
  }

  // ---- Forecast
  interface Acc {
    info: KeyInfo
    tasks: Map<string, { taskNo: string; billType: string; treatment: string; peak: number | null; peakQca: number | null; missingTarget: boolean; rows: number[]; units: Map<MonthKey, number> }>
  }
  const keys = new Map<string, KeyInfo>()
  const fc = new Map<string, Acc>()
  const ensureKey = (cust: string, sl: string, loc: string): KeyInfo => {
    const ck = keyOf(cust), sk = slKey(sl), lk = locationKey(loc)
    const k = k3(ck, sk, lk)
    let info = keys.get(k)
    if (!info) {
      remember(custName, ck, cust)
      remember(slName, sk, sl)
      info = { key: k, customer: custName.get(ck)!, serviceLine: slName.get(sk)!, location: canonLocation(loc) ?? loc }
      keys.set(k, info)
    }
    return info
  }

  const dupSeen = new Map<string, number>()
  for (const r of rowsOf(ds, "forecast")) {
    const cust = str(r["Customer Name"])
    const sl = slOf("forecast", r["SERVICE_LINE"], "SERVICE_LINE")
    const loc = locOf("forecast", r["Location"], r.__row)
    const billType = str(r["BILL_TYPE"])
    const treatment = treatmentFor(cfg, billType)
    const taskNo = str(r["TASK_NUMBER (New)"])
    const info = ensureKey(cust, sl, loc)
    const where = { customer: info.customer, serviceLine: info.serviceLine, location: info.location }

    if (treatment === "exclude") {
      const vals = fcMonthCols.map((m) => num(r[m.col]) ?? 0)
      log({ code: "additional-billing", severity: "warning", sheet: "Forecast Details", row: r.__row, ...where,
        issue: `BILL_TYPE "${billType}" holds money values${vals.some((v) => v < 0) ? " (incl. negatives)" : ""}`,
        value: vals.map((v) => +v.toFixed(2)).join(", "), action: "Excluded from volume and Base FTE (§7 Q1)" })
      continue
    }

    const dupId = `${keyOf(taskNo)}|${locationKey(loc)}`
    const firstRow = dupSeen.get(dupId)
    if (firstRow !== undefined)
      log({ code: "forecast-duplicate", severity: "warning", sheet: "Forecast Details", row: r.__row, ...where,
        issue: "Duplicate Forecast row on TASK_NUMBER + Location", value: `${taskNo} @ ${loc} (rows ${firstRow} & ${r.__row})`, action: "Units summed" })
    else dupSeen.set(dupId, r.__row)

    const target = targets.get(keyOf(taskNo))
    if (!target)
      log({ code: "forecast-task-missing", severity: treatment === "transaction" ? "error" : "warning", sheet: "Forecast Details", row: r.__row, ...where,
        issue: "TASK_NUMBER not found in Target Details — no peak target", value: taskNo,
        action: treatment === "transaction" ? "Base FTE not computed for this key — flagged, not defaulted to 0" : `No peak needed for ${billType} Base FTE; volume-based figures for this task have no peak` })

    else if (target.peak == null && treatment === "transaction" && fcMonthCols.some((m) => (num(r[m.col]) ?? 0) !== 0))
      log({ code: "peak-target-invalid", severity: "error", sheet: "Forecast Details", row: r.__row, ...where,
        issue: `Peak Target Prod is 0 / blank in Target Details (row ${target.row})`, value: taskNo,
        action: "Base FTE not computed for this key — flagged, not defaulted to 0 or ∞" })

    let acc = fc.get(info.key)
    if (!acc) { acc = { info, tasks: new Map() }; fc.set(info.key, acc) }
    let task = acc.tasks.get(keyOf(taskNo))
    if (!task) {
      task = { taskNo, billType, treatment, peak: target?.peak ?? null, peakQca: target?.peakQca ?? null, missingTarget: !target, rows: [], units: new Map() }
      acc.tasks.set(keyOf(taskNo), task)
    }
    task.rows.push(r.__row)
    for (const mc of fcMonthCols) {
      if (!mc.month) continue
      const raw = r[mc.col]
      const u = num(raw)
      if (raw != null && raw !== "" && u == null)
        log({ code: "non-numeric", severity: "error", sheet: "Forecast Details", row: r.__row, ...where, month: monthLabel(mc.month), issue: `Units for ${mc.col} not a number`, value: str(raw), action: "Treated as 0" })
      task.units.set(mc.month, (task.units.get(mc.month) ?? 0) + (u ?? 0))
    }
  }

  // ---- User Mapping (roster)
  interface User { type: string; dop: Date | null; specialty: string; row: number }
  const roster = new Map<string, { prod: User[]; qa: User[] }>()
  const rosterProd: EngineResult["counts"]["rosterProd"] = []
  const rosterQa: EngineResult["counts"]["rosterQa"] = []
  for (const r of rowsOf(ds, "userMapping")) {
    if (keyOf(r["Employment Status"]) !== "ACTIVE") continue
    const cat = keyOf(r["Employee Category"])
    const isProd = PROD_CATEGORIES.has(cat)
    const isQa = cat === QA_CATEGORY
    if (!isProd && !isQa) continue
    const cust = str(r["Customer Name"])
    const sl = slOf("userMapping", r["Service Line"], "Service Line")
    const loc = locOf("userMapping", r["City"], r.__row, "City")
    const info = ensureKey(cust, sl, loc)
    const where = { customer: info.customer, serviceLine: info.serviceLine, location: info.location }
    const job = str(r["Job Name"])
    const type = userTypeOf.get(keyOf(job))
    if (type === undefined)
      log({ code: "job-not-in-designation", severity: "warning", sheet: "User Mapping", row: r.__row, ...where,
        issue: "Job Name missing from Designation Type", value: job, action: "No user type — counted in HC, treated as BAU (not ramp)" })
    const dop = parseDate(r["Date of Production"])
    if (!dop && isProd)
      log({ code: "missing-dop", severity: "warning", sheet: "User Mapping", row: r.__row, ...where,
        issue: "Date of Production missing", value: str(r["Emp Id"]), action: "Counted in HC, treated as BAU (not ramp)" })
    const u: User = { type: type ?? "", dop, specialty: str(r["Specialty"]), row: r.__row }
    let g = roster.get(info.key)
    if (!g) { g = { prod: [], qa: [] }; roster.set(info.key, g) }
    if (isProd) { g.prod.push(u); rosterProd.push(where) }
    else { g.qa.push(u); rosterQa.push(where) }
  }

  // ---- Hiring
  const addProd = new Map<string, number>()
  const addQca = new Map<string, number>()
  const hiringCounts: EngineResult["counts"]["hiring"] = []
  let expectedSno = 1
  for (const r of rowsOf(ds, "hiring")) {
    const sno = num(r["S.No"])
    if (sno !== expectedSno)
      log({ code: "sno-gap", severity: "warning", sheet: "Hiring (RR)", row: r.__row, issue: `S.No breaks the running number (expected ${expectedSno})`, value: str(r["S.No"]), action: "S.No = previous + 1 used for display" })
    expectedSno++
    const appr = normApproved(r["Approved Status"])
    const cust = str(r["Customer Name"])
    const sl = slOf("hiring", r["SL-As Per EM"], "SL-As Per EM")
    const loc = locOf("hiring", r["Location"], r.__row)
    const info = ensureKey(cust, sl, loc)
    const where = { customer: info.customer, serviceLine: info.serviceLine, location: info.location }
    if (appr.typo)
      log({ code: "approved-typo", severity: "info", sheet: "Hiring (RR)", row: r.__row, ...where, issue: "Approved Status typo", value: str(r["Approved Status"]), action: "Treated as Approved" })
    const status = keyOf(r["Status"])
    const month = parseMonth(r["Due to delivery month"])
    const desig = str(r["Designation"])
    const uType = userTypeOf.get(keyOf(desig))
    if (uType === undefined)
      log({ code: "hiring-designation-missing", severity: "warning", sheet: "Hiring (RR)", row: r.__row, ...where, issue: "Designation missing from Designation Type", value: desig, action: "Counted as a production (non-QCA) addition" })
    const isQca = keyOf(uType) === "QCA"
    const opening = num(r["Opening"]) ?? 0
    if (appr.value !== "Approved" || status !== "OPEN") {
      log({ code: "hiring-not-approved", severity: "info", sheet: "Hiring (RR)", row: r.__row, ...where, issue: "Not Approved + OPEN", value: `${str(r["Approved Status"])} / ${str(r["Status"])}`, action: "Not counted as an addition" })
      continue
    }
    if (!month) {
      log({ code: "unparsable-month", severity: "error", sheet: "Hiring (RR)", row: r.__row, ...where, issue: "Due to delivery month can't be parsed", value: str(r["Due to delivery month"]), action: "Not counted as an addition" })
      hiringCounts.push({ ...where, month: null, opening, qca: isQca, inHorizon: false })
      continue
    }
    const inHorizon = horizon.has(month)
    hiringCounts.push({ ...where, month, opening, qca: isQca, inHorizon })
    if (!inHorizon) {
      const before = firstMonth && month < firstMonth
      log({ code: before ? "hiring-before-horizon" : "hiring-after-horizon", severity: "warning", sheet: "Hiring (RR)", row: r.__row, ...where, month: monthLabel(month),
        issue: before ? `Due month falls before the forecast starts (${monthLabel(firstMonth)})` : `Due month falls after the forecast ends (${monthLabel(lastMonth)})`,
        value: monthLabel(month), action: "Not added to any month" })
      continue
    }
    const id = `${info.key}|${month}`
    const target = isQca ? addQca : addProd
    target.set(id, (target.get(id) ?? 0) + opening)
  }

  // ---- monthly budget lookups (Customer × SL × Location × Month)
  const buffer: MonthlyLookup<{ shr: number | null; glide: number | null; growth: number | null }> = { byKey: new Map() }
  for (const r of rowsOf(ds, "budgetBuffer")) {
    const m = parseMonth(r["Month"])
    if (!m) { log({ code: "unparsable-month", severity: "error", sheet: "Budgeted Buffer", row: r.__row, issue: "Month can't be parsed", value: str(r["Month"]), action: "Row ignored" }); continue }
    const k = k3(keyOf(r["Customer Name"]), slKey(slOf("budgetBuffer", r["SL"], "SL")), locationKey(locOf("budgetBuffer", r["Location"], r.__row)))
    const mm = buffer.byKey.get(k) ?? new Map()
    if (mm.has(m)) { log({ code: "duplicate-lookup", severity: "warning", sheet: "Budgeted Buffer", row: r.__row, issue: "Duplicate Customer × SL × Location × Month", value: k.replace(/\|/g, " × ") + ` × ${monthLabel(m)}`, action: "First row used" }); continue }
    mm.set(m, { shr: num(r["Shrinkage %"]), glide: num(r["Glide Buffer %"]), growth: num(r["Growth Buffer %"]) })
    buffer.byKey.set(k, mm)
  }
  const budAttr: MonthlyLookup<number | null> = { byKey: new Map() }
  for (const r of rowsOf(ds, "budgetAttrition")) {
    const m = parseMonth(r["Month"])
    if (!m) { log({ code: "unparsable-month", severity: "error", sheet: "Budgeted Attrition", row: r.__row, issue: "Month can't be parsed", value: str(r["Month"]), action: "Row ignored" }); continue }
    const ratio = ratioOf(r)
    if (ratio == null) log({ code: "div-by-zero", severity: "warning", sheet: "Budgeted Attrition", row: r.__row, issue: "Attrition % = Numerator ÷ Denominator can't be computed", value: `${str(r["Numerator"])} ÷ ${str(r["Denominator"])}`, action: "Budgeted attrition blank (Actual used if present)" })
    const k = k3(keyOf(r["Customer Name"]), slKey(slOf("budgetAttrition", r["SL"], "SL")), locationKey(locOf("budgetAttrition", r["Location"], r.__row)))
    const mm = budAttr.byKey.get(k) ?? new Map()
    if (!mm.has(m)) mm.set(m, ratio)
    budAttr.byKey.set(k, mm)
  }
  const budQca: MonthlyLookup<number | null> = { byKey: new Map() }
  for (const r of rowsOf(ds, "budgetQca")) {
    const m = parseMonth(r["Month"])
    if (!m) { log({ code: "unparsable-month", severity: "error", sheet: "Budgeted QCA %", row: r.__row, issue: "Month can't be parsed", value: str(r["Month"]), action: "Row ignored" }); continue }
    const ratio = ratioOf(r)
    if (ratio == null) log({ code: "div-by-zero", severity: "warning", sheet: "Budgeted QCA %", row: r.__row, issue: "QCA % = Numerator ÷ Denominator can't be computed", value: `${str(r["Numerator"])} ÷ ${str(r["Denominator"])}`, action: "Budgeted QCA % blank" })
    const k = `${keyOf(r["Customer Name"])}|${slKey(slOf("budgetQca", r["SL"], "SL"))}`
    const mm = budQca.byKey.get(k) ?? new Map()
    if (!mm.has(m)) mm.set(m, ratio)
    budQca.byKey.set(k, mm)
  }
  // ---- non-monthly actuals
  const actShr = new Map<string, number | null>()
  for (const r of rowsOf(ds, "actualShrinkage")) {
    const k = k3(keyOf(r["Customer Name"]), slKey(slOf("actualShrinkage", r["Service Line"], "Service Line")), locationKey(locOf("actualShrinkage", r["Location"], r.__row)))
    if (!actShr.has(k)) actShr.set(k, num(r["Last 3 month cum trend - %"]))
  }
  const actAttr = new Map<string, number | null>()
  for (const r of rowsOf(ds, "actualAttrition")) {
    const desg = keyOf(r["Desg"]) === "QCA" ? "QCA" : "PROD"
    const k = `${desg}|${k3(keyOf(r["Customer Name"]), slKey(slOf("actualAttrition", r["Vertical"], "Vertical")), locationKey(locOf("actualAttrition", r["Location"], r.__row)))}`
    if (!actAttr.has(k)) actAttr.set(k, num(r["Last 3 month cum trend - %"]))
  }
  // ---- Sampling Grid
  const sampling = new Map<string, number[]>() // 12 weeks + BAU
  for (const r of rowsOf(ds, "sampling")) {
    const k = [keyOf(r["User Type"]), keyOf(r["Customer Name"]), slKey(r["Service Line"]), keyOf(r["Specialty"])].join("|")
    if (!sampling.has(k)) sampling.set(k, [...Array.from({ length: SAMPLING_WEEKS }, (_, i) => num(r[`Week-${i + 1}`]) ?? 0), num(r["BAU"]) ?? 0])
  }

  // ---- per key × month
  const out: ResultRow[] = []
  const missingBudgetKeys = new Map<string, { info: KeyInfo; what: Set<string>; months: Set<string>; carried: boolean }>()
  const noteMissing = (info: KeyInfo, what: string, month: MonthKey, carried: boolean) => {
    const id = `${info.key}|${what}|${carried}`
    const e = missingBudgetKeys.get(id) ?? { info, what: new Set(), months: new Set(), carried }
    e.what.add(what)
    e.months.add(monthLabel(month))
    missingBudgetKeys.set(id, e)
  }
  const missingSampling = new Map<string, { info: KeyInfo; users: number }>()

  const sortedKeys = [...keys.values()].sort((a, b) =>
    a.customer.localeCompare(b.customer) || a.serviceLine.localeCompare(b.serviceLine) || a.location.localeCompare(b.location))

  for (const info of sortedKeys) {
    const acc = fc.get(info.key)
    const [ck, sk] = info.key.split("|")
    const team = roster.get(info.key) ?? { prod: [], qa: [] }
    const tasks = acc ? [...acc.tasks.values()] : []

    for (const month of months) {
      const wd = wdays.get(month) ?? null
      const flags: string[] = []
      const contribs: TaskContribution[] = []
      let volume = 0
      let equivVolume = 0
      let baseFte: number | null = 0
      let blankReason: string | null = null
      let txUnits = 0, txUnitsPerPeak = 0 // Σ Volume and Σ (Volume ÷ Peak) over transaction tasks
      for (const t of tasks) {
        const units = t.units.get(month) ?? 0
        volume += units
        let fte: number | null = null
        if (wd == null) { fte = null; blankReason = `No W.days for ${monthLabel(month)}` }
        else if (t.treatment === "transaction") {
          if (t.peak == null) {
            fte = null
            if (units !== 0) {
              if (cfg.missingPeakMode === "blank-key") blankReason = `Task ${t.taskNo} has no peak target`
              flags.push(`Task ${t.taskNo}: no peak target`)
            } else fte = 0
          } else {
            fte = baseFteTransaction(units, wd, t.peak)
            txUnits += units
            txUnitsPerPeak += units / t.peak
          }
          equivVolume += units
        } else if (t.treatment === "fte") {
          fte = units
          if (t.peak != null) equivVolume += units * t.peak * wd
        } else if (t.treatment === "hourly") {
          fte = safeDiv(units, wd * cfg.hoursPerDay)
          if (t.peak != null && fte != null) equivVolume += fte * t.peak * wd
        }
        if (fte != null && baseFte != null) baseFte += fte
        contribs.push({ taskNo: t.taskNo, billType: t.billType, treatment: t.treatment, units, peak: t.peak, baseFte: fte, sourceRows: t.rows })
      }
      if (blankReason) baseFte = null

      // P2: volume-weighted peak (Σ volume ÷ Σ volume/peak), else average task peak
      const peaks = tasks.map((t) => t.peak).filter((p): p is number => p != null)
      const peak = txUnitsPerPeak > 0 ? txUnits / txUnitsPerPeak : peaks.length ? peaks.reduce((s, p) => s + p, 0) / peaks.length : null
      const qcaW = tasks.filter((t) => t.peakQca != null && t.treatment === "transaction" && (t.units.get(month) ?? 0) > 0)
      const qcaWsum = qcaW.reduce((s, t) => s + (t.units.get(month) ?? 0), 0)
      const qcaAll = tasks.map((t) => t.peakQca).filter((p): p is number => p != null)
      const peakQca = qcaWsum > 0
        ? qcaW.reduce((s, t) => s + t.peakQca! * (t.units.get(month) ?? 0), 0) / qcaWsum
        : qcaAll.length ? qcaAll.reduce((s, p) => s + p, 0) / qcaAll.length : null

      // budgets
      const bb = monthlyGet(buffer, info.key, month, cfg.carryForwardBudget)
      const ba = monthlyGet(budAttr, info.key, month, cfg.carryForwardBudget)
      const bq = monthlyGet(budQca, `${ck}|${sk}`, month, cfg.carryForwardBudget)
      const carried = !!(bb.carriedFrom || ba.carriedFrom || bq.carriedFrom)
      if (bb.carriedFrom) noteMissing(info, "Budgeted Buffer", month, true)
      else if (!bb.value) noteMissing(info, "Budgeted Buffer", month, false)
      if (ba.carriedFrom) noteMissing(info, "Budgeted Attrition", month, true)
      else if (ba.value == null) noteMissing(info, "Budgeted Attrition", month, false)
      if (bq.carriedFrom) noteMissing(info, "Budgeted QCA %", month, true)
      else if (bq.value == null) noteMissing(info, "Budgeted QCA %", month, false)
      if (carried) flags.push(`Budget carried forward from ${monthLabel((bb.carriedFrom ?? ba.carriedFrom ?? bq.carriedFrom)!)}`)

      const shrinkA = actShr.get(info.key) ?? null
      const attrProdA = actAttr.get(`PROD|${info.key}`) ?? null
      const attrQcaA = actAttr.get(`QCA|${info.key}`) ?? null
      const actualHc = team.prod.length
      const actualQa = team.qa.length
      const additionProd = addProd.get(`${info.key}|${month}`) ?? 0
      const additionQca = addQca.get(`${info.key}|${month}`) ?? 0

      const prod = hcProduction({
        baseFte, shrinkB: bb.value?.shr ?? null, shrinkA, glideB: bb.value?.glide ?? null, glideA: cfg.glideActualPct,
        growth: bb.value?.growth ?? null, actualHc, attrB: ba.value, attrA: attrProdA, snp: cfg.snpPct, addition: additionProd,
      })
      const qca = hcQca({
        budgetQcaPct: bq.value, projectedProdHc: prod.projectedHc, actualQa, attrB: ba.value, attrA: attrQcaA,
        snp: cfg.snpPct, addition: additionQca, mode: cfg.qcaAttritionMode,
      })

      // ---- volume based: ramp users
      let rampTrainee = 0, rampLateral = 0
      let rampProdGrid: number | null = 0
      let sampW = 0, sampSum = 0
      const ms = monthStart(month).getTime()
      const gridFor = (type: string, week: number): number | null => {
        // volume-weighted across the key's tasks (simple mean with no volume)
        const rows = tasks.map((t) => ({ g: rampGrid.get(`${keyOf(t.taskNo)}|${keyOf(type)}`), w: t.treatment === "transaction" ? (t.units.get(month) ?? 0) : 0 }))
          .filter((x) => x.g)
        if (!rows.length) return null
        const wsum = rows.reduce((s, x) => s + x.w, 0)
        return wsum > 0 ? rows.reduce((s, x) => s + x.g![week - 1] * x.w, 0) / wsum : rows.reduce((s, x) => s + x.g![week - 1], 0) / rows.length
      }
      for (const u of team.prod) {
        const t = keyOf(u.type)
        let week: number | null = null
        if (u.dop && (t === "TRAINEE" || t === "LATERAL")) {
          const w = Math.floor((ms - u.dop.getTime()) / (7 * 86400000)) + 1
          week = Math.max(1, w)
          if (week > RAMP_WEEKS) week = null
        }
        let userProd: number | null = peak == null || wd == null ? null : peak * wd
        if (week != null) {
          if (t === "TRAINEE") rampTrainee++
          else rampLateral++
          const pct = gridFor(u.type, week)
          if (pct == null || userProd == null) {
            rampProdGrid = null
            userProd = null
          } else {
            userProd = userProd * pct
            if (rampProdGrid != null) rampProdGrid += userProd
          }
        }
        // sampling (production-weighted)
        if (cfg.samplingMode === "grid" && userProd != null) {
          const types = t === "TRAINEE" ? ["TRAINEE", "LATERAL"] : ["LATERAL", "TRAINEE"]
          let g: number[] | undefined
          for (const ty of types) {
            g = sampling.get([ty, ck, sk, keyOf(u.specialty)].join("|"))
            if (g) break
          }
          let s: number
          if (!g) {
            s = cfg.samplingFlatPct
            const m = missingSampling.get(info.key) ?? { info, users: 0 }
            m.users++
            missingSampling.set(info.key, m)
          } else s = week != null && week <= SAMPLING_WEEKS ? g[week - 1] : g[SAMPLING_WEEKS]
          sampW += userProd
          sampSum += userProd * s
        }
      }
      if (rampProdGrid != null && rampTrainee + rampLateral > 0 && (peak == null || wd == null)) rampProdGrid = null
      const rampProduction = cfg.rampMode === "flat"
        ? (wd == null ? null : flatRampProduction(rampTrainee + rampLateral, cfg.rampFlatUnitsPerDay, wd))
        : rampProdGrid
      const shrinkForVolume = cfg.volumeShrinkageSource === "min" ? prod.shrinkage
        : cfg.volumeShrinkageSource === "budget" ? (bb.value?.shr ?? 0) : (shrinkA ?? 0)
      const samplingPct = cfg.samplingMode === "flat" ? cfg.samplingFlatPct : (sampW > 0 ? sampSum / sampW : (team.prod.length ? null : cfg.samplingFlatPct))
      const vol = volumeBased({
        forecastVolume: cfg.volumeForecastBasis === "units" ? volume : equivVolume,
        actualHc, rampTrainee, rampLateral, rampProduction, peak, wdays: wd ?? 0,
        shrinkagePct: shrinkForVolume, samplingPct, actualQca: actualQa, peakQca,
      })
      if (wd == null) flags.push(`No W.days for ${monthLabel(month)}`)

      out.push({
        ...info, month, monthLabel: monthLabel(month), forecastVolume: volume, peakTarget: peak, peakTargetQca: peakQca,
        wdays: wd, baseFte, baseFteBlankReason: blankReason,
        shrinkB: bb.value?.shr ?? null, shrinkA, glideB: bb.value?.glide ?? null, glideA: cfg.glideActualPct,
        growthB: bb.value?.growth ?? null, attrB: ba.value, attrProdA, attrQcaA, budgetQcaPct: bq.value,
        actualHc, actualQa, additionProd, additionQca, budgetCarried: carried, prod, qca, vol, tasks: contribs, flags,
      })
    }
  }

  // ---- roll-up exceptions
  for (const e of missingBudgetKeys.values()) {
    const what = [...e.what].join(", ")
    const months = [...e.months]
    log({
      // Not blocking: the row still calculates (Actual used, else 0) — so a warning, not an error.
      code: "no-budget-month", severity: "warning", sheet: what, row: null,
      customer: e.info.customer, serviceLine: e.info.serviceLine, location: e.info.location,
      issue: e.carried ? "No budget row for these forecast months" : "No budget row for this key at all",
      value: `${e.info.customer} × ${e.info.serviceLine} × ${e.info.location}: ${months.length === 1 ? months[0] : `${months[0]}–${months[months.length - 1]} (${months.length} months)`}`,
      action: e.carried ? "Last budget month carried forward (§7 Q7) — rows flagged" : "Budgeted value missing → Actual used if present, else 0",
    })
  }
  for (const m of missingSampling.values())
    log({ code: "missing-lookup", severity: "warning", sheet: "Sampling Grid", row: null, customer: m.info.customer, serviceLine: m.info.serviceLine, location: m.info.location,
      issue: "No Sampling Grid row for (User Type, Customer, SL, Specialty)", value: `${m.users} user-months`, action: `Flat ${(cfg.samplingFlatPct * 100).toFixed(0)}% used` })
  if (zeroPeakTargets)
    log({ code: "peak-target-invalid", severity: "info", sheet: "Target Details", row: null, issue: "Target rows with Peak Target Prod = 0 / blank",
      value: `${zeroPeakTargets} rows`, action: "Only a problem where a transaction forecast uses the task — those rows are listed separately" })
  for (const [, u] of unknownLoc)
    log({ code: "unknown-location", severity: "warning", sheet: u.sheet, row: u.rows[0], issue: "Location not in the §3 location map", value: `${u.rows.length} row(s)`, action: "Original value used as the key — may not join" })
  for (const [id, v] of variants) {
    const raw = id.split("|")[2]
    log({ code: "spelling-variant", severity: "info", sheet: v.sheet, row: null, issue: `${v.field} spelling variant`, value: `${raw} → ${v.to} (${v.count} rows)`, action: "Normalised by the §3 maps" })
  }

  return { months, rows: out, exceptions: ex, counts: { rosterProd, rosterQa, hiring: hiringCounts } }
}

/** For the exceptions panel: counts by code. */
export function countByCode(ex: DataException[]): Record<string, number> {
  const c: Record<string, number> = {}
  for (const e of ex) c[e.code] = (c[e.code] ?? 0) + 1
  return c
}

