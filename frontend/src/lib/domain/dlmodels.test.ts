import { describe, expect, it } from "vitest"

import { GI, GRU_SIZE, gruBackward, gruForward, newWork, W } from "./dlmodels"
import { CAL_FEATURES, M, mulberry32 } from "./modelUtils"

// Numerical gradient check: the hand-written BPTT must agree with finite differences.
describe("GRU backpropagation", () => {
  it("matches finite-difference gradients for every parameter group", () => {
    const rnd = mulberry32(5)
    const P = Float64Array.from({ length: GRU_SIZE }, () => (rnd() - 0.5) * 0.8)
    const xs = Float64Array.from({ length: W * GI }, () => (rnd() - 0.5) * 2)
    const cal = Array.from({ length: CAL_FEATURES }, () => rnd() - 0.5)
    const y = Float64Array.from({ length: M }, () => rnd() + 0.5)
    const ws = newWork()

    const loss = () => {
      gruForward(P, xs, cal, ws)
      let l = 0
      for (let j = 0; j < M; j++) l += 0.5 * (ws.o[j] - y[j]) ** 2
      return l
    }

    const G = new Float64Array(GRU_SIZE)
    gruForward(P, xs, cal, ws)
    gruBackward(P, G, xs, ws, y)

    const eps = 1e-6
    let worst = 0
    for (let i = 0; i < GRU_SIZE; i += 7) { // every 7th parameter spans all the groups
      const keep = P[i]
      P[i] = keep + eps; const up = loss()
      P[i] = keep - eps; const down = loss()
      P[i] = keep
      const numeric = (up - down) / (2 * eps)
      worst = Math.max(worst, Math.abs(numeric - G[i]) / Math.max(1e-6, Math.abs(numeric) + Math.abs(G[i])))
    }
    expect(worst).toBeLessThan(1e-4)
  })
})
