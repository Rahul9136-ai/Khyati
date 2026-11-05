// Formulas from build prompt §4 — implemented exactly, no rounding inside.
// Both the live engine and the "Calculation & Logics" calculator call these.

/** Division that returns null (shown blank) instead of Infinity / NaN. */
export function safeDiv(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null
  return a / b
}

/** MIN(B, A) over the values that exist; null when neither does. */
export function minOf(b: number | null | undefined, a: number | null | undefined): number | null {
  const v = [b, a].filter((x): x is number => x != null && Number.isFinite(x))
  return v.length ? Math.min(...v) : null
}

/** MAX(B, A) over the values that exist; null when neither does. */
export function maxOf(b: number | null | undefined, a: number | null | undefined): number | null {
  const v = [b, a].filter((x): x is number => x != null && Number.isFinite(x))
  return v.length ? Math.max(...v) : null
}

const nz = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? 0 : v)
const sub = (a: number | null, b: number | null) => (a == null || b == null ? null : a - b)
const mul = (a: number | null, b: number | null) => (a == null || b == null ? null : a * b)

/** P4 for one transaction task: Forecasted Volume ÷ W.days ÷ Peak Target. */
export function baseFteTransaction(volume: number, wdays: number, peak: number): number | null {
  const perDay = safeDiv(volume, wdays)
  return safeDiv(perDay, peak)
}

// ---------------------------------------------------------------- 4.1 HC – Production
export interface HcProdIn {
  baseFte: number | null // P4
  shrinkB: number | null; shrinkA: number | null // P5
  glideB: number | null; glideA: number | null // P6
  growth: number | null // P7
  actualHc: number // P11
  attrB: number | null; attrA: number | null // P12
  snp: number // P13 (shown, not used)
  addition: number // P15
}
export interface HcProdOut {
  shrinkage: number // P5
  glide: number // P6
  growth: number // P7
  overallBuffer: number // P8
  bufferHc: number | null // P9
  reqHcProd: number | null // P10
  attrition: number // P12
  snp: number // P13
  attritionHc: number // P14
  projectedHc: number // P16
  capacityPct: number | null // P17
  va: number | null // P18
}
export function hcProduction(i: HcProdIn): HcProdOut {
  const shrinkage = nz(minOf(i.shrinkB, i.shrinkA)) // P5 lower of the two
  const glide = nz(minOf(i.glideB, i.glideA)) // P6 lower of the two
  const growth = nz(i.growth) // P7
  const overallBuffer = shrinkage + glide + growth // P8
  const bufferHc = mul(i.baseFte, overallBuffer) // P9
  const reqHcProd = i.baseFte == null || bufferHc == null ? null : i.baseFte + bufferHc // P10
  const attrition = nz(maxOf(i.attrB, i.attrA)) // P12 higher of the two
  const attritionHc = i.actualHc * attrition // P14
  const projectedHc = i.actualHc - attritionHc + i.addition // P16
  const capacityPct = safeDiv(projectedHc, reqHcProd) // P17
  const va = sub(projectedHc, reqHcProd) // P18
  return { shrinkage, glide, growth, overallBuffer, bufferHc, reqHcProd, attrition, snp: i.snp, attritionHc, projectedHc, capacityPct, va }
}

// ---------------------------------------------------------------- 4.2 HC – QCA
export interface HcQcaIn {
  budgetQcaPct: number | null // Q1
  projectedProdHc: number // Q2 = P16
  actualQa: number // Q4
  attrB: number | null; attrA: number | null // Q5
  snp: number // Q6
  addition: number // Q8
  mode: "snp" | "attrition" // §7 Q3
}
export interface HcQcaOut {
  budgetQcaPct: number
  projectedProdHc: number
  reqQca: number // Q3
  attrition: number // Q5
  snp: number
  attritionHc: number // Q7
  projectedQca: number // Q9
  capacityPct: number | null // Q10
  va: number // Q11
}
export function hcQca(i: HcQcaIn): HcQcaOut {
  const budgetQcaPct = nz(i.budgetQcaPct)
  const reqQca = i.projectedProdHc * budgetQcaPct // Q3
  const attrition = nz(maxOf(i.attrB, i.attrA)) // Q5
  const attritionHc = i.actualQa * (i.mode === "snp" ? i.snp : attrition) // Q7 (sheet: =I10*I12)
  const projectedQca = i.actualQa - attritionHc + i.addition // Q9
  return {
    budgetQcaPct, projectedProdHc: i.projectedProdHc, reqQca, attrition, snp: i.snp, attritionHc, projectedQca,
    capacityPct: safeDiv(projectedQca, reqQca), // Q10
    va: projectedQca - reqQca, // Q11
  }
}

// ---------------------------------------------------------------- 4.3 Volume Based
/** V6 in the sheet's simplified form: Ramp HC × units/day × W.days. */
export function flatRampProduction(rampHc: number, unitsPerDay: number, wdays: number): number {
  return rampHc * unitsPerDay * wdays
}

export interface VolumeIn {
  forecastVolume: number // V1
  actualHc: number // V2
  rampTrainee: number // V3
  rampLateral: number // V4
  rampProduction: number | null // V6 (grid or flat, computed by the caller)
  peak: number | null
  wdays: number
  shrinkagePct: number // P5 (Q6)
  samplingPct: number | null // V14
  actualQca: number // V16
  peakQca: number | null
}
export interface VolumeOut {
  forecastVolume: number
  actualHc: number
  rampTrainee: number
  rampLateral: number
  totalRampHc: number // V5
  rampProduction: number | null // V6
  bauHc: number // V7
  bauProduction: number | null // V8
  rawProduction: number | null // V9
  actualProductivity: number | null // V10
  capacityPct: number | null // V11
  vaUnits: number | null // V12
  vaHc: number | null // V13
  samplingPct: number | null // V14
  toBeAudited: number | null // V15
  actualQca: number // V16
  qcaProduction: number | null // V17
  qcaCapacityPct: number | null // V18
}
export function volumeBased(i: VolumeIn): VolumeOut {
  const totalRampHc = i.rampTrainee + i.rampLateral // V5
  const bauHc = i.actualHc - totalRampHc // V7
  const bauProduction = i.peak == null ? null : bauHc * i.peak * i.wdays // V8
  const rawProduction = i.rampProduction == null || bauProduction == null ? null : i.rampProduction + bauProduction // V9
  const actualProductivity = mul(rawProduction, 1 - i.shrinkagePct) // V10
  const vaUnits = actualProductivity == null ? null : actualProductivity - i.forecastVolume // V12
  const toBeAudited = mul(actualProductivity, i.samplingPct) // V15
  const qcaProduction = i.peakQca == null ? null : i.actualQca * i.peakQca * i.wdays // V17
  return {
    forecastVolume: i.forecastVolume, actualHc: i.actualHc, rampTrainee: i.rampTrainee, rampLateral: i.rampLateral,
    totalRampHc, rampProduction: i.rampProduction, bauHc, bauProduction, rawProduction, actualProductivity,
    capacityPct: safeDiv(actualProductivity, i.forecastVolume), // V11
    vaUnits,
    vaHc: safeDiv(safeDiv(vaUnits, i.peak), i.wdays), // V13
    samplingPct: i.samplingPct, toBeAudited, actualQca: i.actualQca, qcaProduction,
    qcaCapacityPct: safeDiv(qcaProduction, toBeAudited), // V18
  }
}
