// Golden test cases from the sheet "Calculation & Logics" (build prompt §6).
// The calculator sub-tab is pre-filled with GOLDEN_INPUTS; runCalculator() goes
// through the same formula functions as the live engine.
import { baseFteTransaction, flatRampProduction, hcProduction, hcQca, safeDiv, volumeBased } from "./formulas"

export interface CalcInputs {
  // HC Based – Production
  volume: number; peak: number; wdays: number
  shrinkB: number; shrinkA: number; glideB: number; glideA: number; growth: number
  actualHc: number; attrB: number; attrA: number; snp: number; addition: number
  // HC Based – QCA
  budgetQcaPct: number; actualQa: number; qcaAttrB: number; qcaAttrA: number; qcaSnp: number; qcaAddition: number
  qcaMode: "snp" | "attrition"
  // Volume Based
  vVolume: number; vActualHc: number; rampTrainee: number; rampLateral: number; rampUnitsPerDay: number
  vPeak: number; vWdays: number; vShrinkage: number; samplingPct: number; actualQca: number; peakQca: number
}

export const GOLDEN_INPUTS: CalcInputs = {
  volume: 50000, peak: 24, wdays: 21,
  shrinkB: 0.10, shrinkA: 0.06, glideB: 0.06, glideA: 0.10, growth: 0,
  actualHc: 90, attrB: 0.11, attrA: 0.15, snp: 0.20, addition: 10,
  budgetQcaPct: 0.10, actualQa: 10, qcaAttrB: 0.11, qcaAttrA: 0.15, qcaSnp: 0.20, qcaAddition: 1, qcaMode: "snp",
  vVolume: 50000, vActualHc: 90, rampTrainee: 8, rampLateral: 7, rampUnitsPerDay: 15,
  vPeak: 24, vWdays: 21, vShrinkage: 0.06, samplingPct: 0.18, actualQca: 2, peakQca: 100,
}

export function runCalculator(i: CalcInputs) {
  const baseFte = baseFteTransaction(i.volume, i.wdays, i.peak)
  const prod = hcProduction({
    baseFte, shrinkB: i.shrinkB, shrinkA: i.shrinkA, glideB: i.glideB, glideA: i.glideA, growth: i.growth,
    actualHc: i.actualHc, attrB: i.attrB, attrA: i.attrA, snp: i.snp, addition: i.addition,
  })
  const qca = hcQca({
    budgetQcaPct: i.budgetQcaPct, projectedProdHc: prod.projectedHc, actualQa: i.actualQa,
    attrB: i.qcaAttrB, attrA: i.qcaAttrA, snp: i.qcaSnp, addition: i.qcaAddition, mode: i.qcaMode,
  })
  const rampHc = i.rampTrainee + i.rampLateral
  const vol = volumeBased({
    forecastVolume: i.vVolume, actualHc: i.vActualHc, rampTrainee: i.rampTrainee, rampLateral: i.rampLateral,
    rampProduction: flatRampProduction(rampHc, i.rampUnitsPerDay, i.vWdays),
    peak: i.vPeak, wdays: i.vWdays, shrinkagePct: i.vShrinkage, samplingPct: i.samplingPct,
    actualQca: i.actualQca, peakQca: i.peakQca,
  })
  return { baseFte, prod, qca, vol }
}

export type CalcResult = ReturnType<typeof runCalculator>

export interface GoldenCase {
  section: "HC Based – Production" | "HC Based – QCA" | "Volume Based" | "Other"
  label: string
  expected: number | null
  /** Expected values given to fewer than 4 dp in the spec are compared at that precision. */
  dp: number
  actual: (r: CalcResult) => number | null
}

export const GOLDEN_CASES: GoldenCase[] = [
  { section: "HC Based – Production", label: "Base FTE", expected: 99.2063, dp: 4, actual: (r) => r.baseFte },
  { section: "HC Based – Production", label: "Shrinkage % = MIN(0.10, 0.06)", expected: 0.06, dp: 4, actual: (r) => r.prod.shrinkage },
  { section: "HC Based – Production", label: "Glide % = MIN(0.06, 0.10)", expected: 0.06, dp: 4, actual: (r) => r.prod.glide },
  { section: "HC Based – Production", label: "Overall Buffer", expected: 0.12, dp: 4, actual: (r) => r.prod.overallBuffer },
  { section: "HC Based – Production", label: "Buffer HC", expected: 11.9048, dp: 4, actual: (r) => r.prod.bufferHc },
  { section: "HC Based – Production", label: "Req HC Prod", expected: 111.1111, dp: 4, actual: (r) => r.prod.reqHcProd },
  { section: "HC Based – Production", label: "Attrition % = MAX(0.11, 0.15)", expected: 0.15, dp: 4, actual: (r) => r.prod.attrition },
  { section: "HC Based – Production", label: "Attrition HC", expected: 13.5, dp: 4, actual: (r) => r.prod.attritionHc },
  { section: "HC Based – Production", label: "Projected HC", expected: 86.5, dp: 4, actual: (r) => r.prod.projectedHc },
  { section: "HC Based – Production", label: "Capacity %", expected: 0.7785, dp: 4, actual: (r) => r.prod.capacityPct },
  { section: "HC Based – Production", label: "VA", expected: -24.6111, dp: 4, actual: (r) => r.prod.va },
  { section: "HC Based – QCA", label: "Projected Prod HC", expected: 86.5, dp: 4, actual: (r) => r.qca.projectedProdHc },
  { section: "HC Based – QCA", label: "Req QCA", expected: 8.65, dp: 4, actual: (r) => r.qca.reqQca },
  { section: "HC Based – QCA", label: "Attrition %", expected: 0.15, dp: 4, actual: (r) => r.qca.attrition },
  { section: "HC Based – QCA", label: "Attrition HC (= QA × SNP)", expected: 2, dp: 4, actual: (r) => r.qca.attritionHc },
  { section: "HC Based – QCA", label: "Projected QCA", expected: 9, dp: 4, actual: (r) => r.qca.projectedQca },
  { section: "HC Based – QCA", label: "QCA Capacity %", expected: 1.0405, dp: 4, actual: (r) => r.qca.capacityPct },
  { section: "HC Based – QCA", label: "QCA VA", expected: 0.35, dp: 4, actual: (r) => r.qca.va },
  { section: "Volume Based", label: "Total Ramp HC", expected: 15, dp: 4, actual: (r) => r.vol.totalRampHc },
  { section: "Volume Based", label: "Ramp Production (15 × 15 × 21)", expected: 4725, dp: 4, actual: (r) => r.vol.rampProduction },
  { section: "Volume Based", label: "BAU HC", expected: 75, dp: 4, actual: (r) => r.vol.bauHc },
  { section: "Volume Based", label: "BAU Production (75 × 24 × 21)", expected: 37800, dp: 4, actual: (r) => r.vol.bauProduction },
  { section: "Volume Based", label: "Raw Production", expected: 42525, dp: 4, actual: (r) => r.vol.rawProduction },
  { section: "Volume Based", label: "Actual Productivity (× 0.94)", expected: 39973.5, dp: 4, actual: (r) => r.vol.actualProductivity },
  { section: "Volume Based", label: "Capacity %", expected: 0.79947, dp: 5, actual: (r) => r.vol.capacityPct },
  { section: "Volume Based", label: "VA units", expected: -10026.5, dp: 4, actual: (r) => r.vol.vaUnits },
  { section: "Volume Based", label: "VA HC", expected: -19.8938, dp: 4, actual: (r) => r.vol.vaHc },
  { section: "Volume Based", label: "To Be Audited", expected: 7195.23, dp: 4, actual: (r) => r.vol.toBeAudited },
  { section: "Volume Based", label: "QCA Production (2 × 100 × 21)", expected: 4200, dp: 4, actual: (r) => r.vol.qcaProduction },
  { section: "Volume Based", label: "QCA Capacity %", expected: 0.5837, dp: 4, actual: (r) => r.vol.qcaCapacityPct },
  { section: "Other", label: "Budgeted Attrition row 2: 11.727908 ÷ 188.689010", expected: 0.062155, dp: 6,
    actual: () => safeDiv(11.727908070038632, 188.6890098379549) },
  { section: "Other", label: "Budgeted QCA % row 2: 9.936050 ÷ 181.187231", expected: 0.054839, dp: 6,
    actual: () => safeDiv(9.936049900447882, 181.18723143430796) },
  { section: "Other", label: "Req = 0 → Capacity blank (not #DIV/0! / Infinity)", expected: null, dp: 4,
    actual: () => hcProduction({ baseFte: 0, shrinkB: 0, shrinkA: 0, glideB: 0, glideA: null, growth: 0, actualHc: 5,
      attrB: 0, attrA: 0, snp: 0.2, addition: 0 }).capacityPct },
]

/** Compare at the case's precision (≥ 4 dp, per §6). */
export function goldenPass(c: GoldenCase, actual: number | null): boolean {
  if (c.expected === null) return actual === null
  if (actual === null || !Number.isFinite(actual)) return false
  return actual.toFixed(c.dp) === c.expected.toFixed(c.dp) || Math.abs(actual - c.expected) < 0.5 * 10 ** -c.dp
}
