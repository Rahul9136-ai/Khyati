// Erlang C staffing engine — the math heart of contact-centre WFM.

export function trafficIntensity(volume: number, aht: number, interval = 1800): number {
  if (interval <= 0) return 0
  return (volume * aht) / interval
}

function erlangB(agents: number, intensity: number): number {
  let b = 1
  for (let n = 1; n <= agents; n++) b = (intensity * b) / (n + intensity * b)
  return b
}

export function erlangC(agents: number, intensity: number): number {
  if (agents <= intensity) return 1
  const rho = intensity / agents
  const b = erlangB(agents, intensity)
  return b / (1 - rho * (1 - b))
}

export function serviceLevel(agents: number, intensity: number, aht: number, targetTime = 20): number {
  if (agents <= intensity) return 0
  const c = erlangC(agents, intensity)
  return Math.max(0, 1 - c * Math.exp(-((agents - intensity) * targetTime) / aht))
}

export function asa(agents: number, intensity: number, aht: number): number {
  if (agents <= intensity) return Infinity
  const c = erlangC(agents, intensity)
  return (c * aht) / (agents - intensity)
}

export function occupancy(agents: number, intensity: number): number {
  if (agents <= 0) return 0
  return Math.min(1, intensity / agents)
}

export interface RequiredOpts {
  interval?: number
  slTarget?: number
  targetTime?: number
  maxOccupancy?: number
}

export function requiredAgents(volume: number, aht: number, opts: RequiredOpts = {}): number {
  const { interval = 1800, slTarget = 0.8, targetTime = 20, maxOccupancy = 0.95 } = opts
  const intensity = trafficIntensity(volume, aht, interval)
  if (intensity <= 0) return 0
  let agents = Math.max(1, Math.floor(intensity) + 1)
  for (let i = 0; i < 1000; i++) {
    const sl = serviceLevel(agents, intensity, aht, targetTime)
    const occ = occupancy(agents, intensity)
    if (sl >= slTarget && occ <= maxOccupancy) break
    agents++
  }
  return agents
}

export function intervalStaffing(volume: number, aht: number, opts: RequiredOpts = {}) {
  const interval = opts.interval ?? 1800
  const intensity = trafficIntensity(volume, aht, interval)
  const req = requiredAgents(volume, aht, opts)
  return {
    intensity,
    required: req,
    serviceLevel: serviceLevel(req, intensity, aht, opts.targetTime ?? 20),
    asa: asa(req, intensity, aht),
    occupancy: occupancy(req, intensity),
  }
}

export function applyShrinkage(required: number, shrinkage = 0.3): number {
  if (shrinkage >= 1) return required
  return Math.ceil(required / (1 - shrinkage))
}
