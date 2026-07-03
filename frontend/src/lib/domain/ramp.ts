// Ramp-up / ramp-down planner for new business or a new LOB (Line of Business).
//
// New work doesn't arrive at full scale on day one — contacts (and therefore the
// FTE you must hire, the revenue you earn, and the cost you carry) ramp in over a
// number of weeks. This models that curve and turns it into a financial business
// case: revenue vs staffing cost per week, FTE to hire, and a break-even week.
import { addDays, fmtShort } from "./dates"
import { applyShrinkage, requiredAgents } from "./erlang"
import { SHAPE } from "./seed"

export type RampDirection = "up" | "down"
export type RampShape = "linear" | "scurve" | "stepped"

export interface RampInput {
  name: string
  direction: RampDirection
  startDate: Date
  rampWeeks: number // weeks to reach 100% (up) or 0% (down)
  horizonWeeks: number // total weeks to project (>= rampWeeks)
  steadyVolume: number // contacts/day at full scale
  aht: number // seconds
  slTarget: number
  targetTime: number
  shrinkage: number
  shape: RampShape
  revenuePerContact: number // $
  costPerAgentHour: number // $ (loaded)
  setupCost: number // one-time recruitment / training / tech ($)
  daysPerWeek: number // operating days
  hoursPerFTE: number // contracted weekly hrs per FTE
}

export interface RampWeek {
  week: number
  label: string
  pct: number
  dailyVolume: number
  weeklyVolume: number
  agentHours: number // weekly rostered hours
  fte: number
  revenue: number
  staffCost: number
  contribution: number
  cumContribution: number
  breakEven: boolean
}

export interface RampResult {
  rows: RampWeek[]
  totalRevenue: number
  totalCost: number
  totalContribution: number
  peakFte: number
  steadyFte: number
  breakEvenWeek: number | null
  steadyWeeklyContribution: number
}

const SUM_SHAPE = SHAPE.reduce((a, b) => a + b, 0)

// Ramp fraction (0..1) at progress p (= week / rampWeeks), by curve shape.
function rampFraction(p: number, shape: RampShape): number {
  const c = Math.max(0, Math.min(1, p))
  if (shape === "linear") return c
  if (shape === "scurve") return c * c * (3 - 2 * c) // smoothstep S-curve
  return Math.min(1, Math.ceil(c * 4) / 4) // stepped: 25% increments
}

// Rostered agent-hours needed for one day at a given daily contact total:
// distribute the total across the intraday SHAPE, run Erlang C per interval,
// gross up for shrinkage, and sum the half-hours.
function agentHoursPerDay(dailyTotal: number, inp: RampInput): number {
  if (dailyTotal <= 0) return 0
  let hours = 0
  for (const s of SHAPE) {
    const v = (dailyTotal * s) / SUM_SHAPE
    const net = requiredAgents(v, inp.aht, { slTarget: inp.slTarget, targetTime: inp.targetTime })
    hours += applyShrinkage(net, inp.shrinkage) * 0.5
  }
  return hours
}

export function computeRamp(inp: RampInput): RampResult {
  const rows: RampWeek[] = []
  let cum = -inp.setupCost
  let totalRevenue = 0
  let totalCost = 0
  let breakEvenWeek: number | null = null

  for (let w = 1; w <= inp.horizonWeeks; w++) {
    const p = inp.rampWeeks > 0 ? w / inp.rampWeeks : 1
    const frac = rampFraction(p, inp.shape)
    let pct = inp.direction === "up" ? frac : 1 - rampFraction((w - 1) / Math.max(1, inp.rampWeeks), inp.shape)
    pct = Math.max(0, Math.min(1, pct))

    const dailyVolume = Math.round(inp.steadyVolume * pct)
    const weeklyVolume = dailyVolume * inp.daysPerWeek
    const agentHours = agentHoursPerDay(dailyVolume, inp) * inp.daysPerWeek
    const fte = agentHours / inp.hoursPerFTE
    const revenue = weeklyVolume * inp.revenuePerContact
    const staffCost = agentHours * inp.costPerAgentHour
    const contribution = revenue - staffCost
    cum += contribution
    const isBreakEven = breakEvenWeek === null && cum >= 0
    if (isBreakEven) breakEvenWeek = w

    totalRevenue += revenue
    totalCost += staffCost

    rows.push({
      week: w,
      label: `Wk ${w} · ${fmtShort(addDays(inp.startDate, (w - 1) * 7))}`,
      pct,
      dailyVolume,
      weeklyVolume,
      agentHours: Math.round(agentHours),
      fte,
      revenue,
      staffCost,
      contribution,
      cumContribution: cum,
      breakEven: isBreakEven,
    })
  }

  const steadyAgentHours = agentHoursPerDay(inp.steadyVolume, inp) * inp.daysPerWeek
  const steadyFte = steadyAgentHours / inp.hoursPerFTE
  const steadyWeeklyContribution =
    inp.steadyVolume * inp.daysPerWeek * inp.revenuePerContact - steadyAgentHours * inp.costPerAgentHour

  return {
    rows,
    totalRevenue,
    totalCost,
    totalContribution: totalRevenue - totalCost - inp.setupCost,
    peakFte: Math.max(...rows.map((r) => r.fte), 0),
    steadyFte,
    breakEvenWeek,
    steadyWeeklyContribution,
  }
}

export const fmtMoney = (n: number) => {
  const abs = Math.abs(n)
  const sign = n < 0 ? "-" : ""
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`
  return `${sign}$${abs.toFixed(0)}`
}
