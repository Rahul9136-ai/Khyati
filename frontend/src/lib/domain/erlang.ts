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

/** Erlang A (M/M/N+M): Erlang C plus callers who hang up after an
 *  exponentially distributed wait with mean `patience` seconds. Solved exactly
 *  as a birth–death chain (arrivals λ; departures min(n, N)·μ + max(n − N, 0)·θ),
 *  so it stays finite when the queue is overloaded or nobody is on.
 *  `abandon` = share of offered contacts that hang up; `wait` = mean seconds in
 *  queue per offered contact; `waitProb` = share that wait at all. */
export function erlangA(
  agents: number,
  volume: number,
  aht: number,
  patience: number,
  interval = 1800,
): { abandon: number; wait: number; waitProb: number } {
  if (volume <= 0 || interval <= 0) return { abandon: 0, wait: 0, waitProb: 0 }
  const n = Math.max(0, Math.floor(agents))
  const lambda = volume / interval
  const mu = 1 / aht
  const theta = 1 / patience
  let p = 1 // unnormalised P(state k), starting at k = 0
  let total = 1
  let queued = 0 // Σ (k − N)·p_k for k > N
  let waiting = n === 0 ? 1 : 0 // Σ p_k for k ≥ N
  for (let k = 1; k < n + 20_000; k++) {
    p *= lambda / (Math.min(k, n) * mu + Math.max(k - n, 0) * theta)
    total += p
    if (k >= n) waiting += p
    if (k > n) queued += (k - n) * p
    if (total > 1e250) { // rescale — very busy queues with many agents
      p /= 1e250; total /= 1e250; queued /= 1e250; waiting /= 1e250
    }
    if (k > n && p < total * 1e-13) break
  }
  const lq = queued / total
  return { abandon: Math.min(1, (theta * lq) / lambda), wait: lq / lambda, waitProb: waiting / total }
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
