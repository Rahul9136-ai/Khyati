import { create } from "zustand"
import { persist } from "zustand/middleware"

import { backtest, generate } from "@/lib/domain/forecast"
import type { ActualRow } from "@/lib/domain/history"
import {
  ACCESS_RANK,
  DEFAULT_PERMISSIONS,
  effectiveLevel,
  type AccessLevel,
  type ModuleId,
  type PermissionMatrix,
  type Role,
} from "@/lib/domain/roles"
import type { BreakOverrides } from "@/lib/domain/breaks"
import type { Scenario } from "@/lib/domain/scenario"
import { AGENTS, forecastFor, makeRTA, QUEUES, SHRINKAGE, TEAMS } from "@/lib/domain/seed"
import { DEFAULT_SHIFT_PATTERNS, shiftStringFor, type ShiftPattern } from "@/lib/domain/shiftPatterns"
import type { Agent, Queue, RtaEntry } from "@/lib/domain/types"

export interface NewAgent {
  name: string
  skills: string[]
  shiftPatternId: string
  team: string
}

export interface NewQueue {
  name: string
  color: string
  aht: number
  slTarget: number
  targetTime: number
}

export type UserStatus = "Active" | "Invited"
export interface WfmUser {
  id: string
  name: string
  email: string
  role: Role
  status: UserStatus
}

export type SwapStatus = "Auto-Approved" | "Pending" | "Approved" | "Denied"
export interface SwapRequest {
  id: string
  fromAgentId: string
  toAgentId: string
  /** Volume-weighted SL delta across affected queues if the swap is applied (negative = SL drops). */
  slImpact: number
  status: SwapStatus
  /** Whether the shift exchange has been written to the roster. */
  applied: boolean
  ts: number
}

export type PtoStatus = "Pending" | "Approved" | "Denied"
export interface PtoRequest {
  id: string
  agentId: string
  type: string
  from: string
  to: string
  days: number
  status: PtoStatus
}

const skillLabel = (id: string, queues: Queue[]) => queues.find((q) => q.id === id)?.name ?? id

// Exchange two agents' shifts (and their linked break patterns) on the roster.
function swapShifts(agents: Agent[], idA: string, idB: string): Agent[] {
  const a = agents.find((x) => x.id === idA)
  const b = agents.find((x) => x.id === idB)
  if (!a || !b) return agents
  return agents.map((x) =>
    x.id === idA
      ? { ...x, shift: b.shift, shiftPatternId: b.shiftPatternId }
      : x.id === idB
        ? { ...x, shift: a.shift, shiftPatternId: a.shiftPatternId }
        : x,
  )
}
const slugify = (name: string) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")

export type AuditCategory = "Employee" | "Schedule" | "Forecast" | "Real-Time" | "Config" | "PTO"
export interface AuditEntry {
  id: string
  ts: number // epoch ms
  user: string
  category: AuditCategory
  action: string
  detail: string
}

const uid = () => Math.random().toString(36).slice(2, 9)
const entry = (user: string, category: AuditCategory, action: string, detail: string): AuditEntry => ({
  id: uid(),
  ts: Date.now(),
  user,
  category,
  action,
  detail,
})

// A little seed history so the audit trail isn't empty on first load.
function seedAudit(user: string): AuditEntry[] {
  const now = Date.now()
  const h = 3600_000
  return [
    { id: uid(), ts: now - 26 * h, user: "Priya Nair", category: "Forecast", action: "Applied forecast", detail: "Sales · Moving Average" },
    { id: uid(), ts: now - 22 * h, user: "Marcus Webb", category: "Schedule", action: "Imported schedule", detail: "30 agents from roster.xlsx" },
    { id: uid(), ts: now - 6 * h, user: "Sam Okoye", category: "Real-Time", action: "Recalled agents", detail: "2 agents from break (SL risk)" },
    { id: uid(), ts: now - 2 * h, user, category: "Config", action: "Changed shrinkage", detail: "25% → 27%" },
    { id: uid(), ts: now - 40 * 60_000, user, category: "Employee", action: "Added employee", detail: "Onboarded new hire" },
  ]
}

// Seed platform users so the Settings → Users tab isn't empty on first load.
function seedUsers(): WfmUser[] {
  return [
    { id: "u1", name: "Avery Owens", email: "avery.owens@flowforce.io", role: "Super Admin", status: "Active" },
    { id: "u2", name: "Priya Nair", email: "priya.nair@flowforce.io", role: "Planner", status: "Active" },
    { id: "u3", name: "Marcus Webb", email: "marcus.webb@flowforce.io", role: "Team Leader", status: "Active" },
    { id: "u4", name: "Sam Okoye", email: "sam.okoye@flowforce.io", role: "RTA", status: "Active" },
    { id: "u5", name: "Elena Faro", email: "elena.faro@flowforce.io", role: "WFM Manager", status: "Active" },
    { id: "u6", name: "Dana Fields", email: "dana.fields@flowforce.io", role: "Read-Only Viewer", status: "Invited" },
  ]
}

const PTO_TYPES = ["Annual Leave", "Sick", "Personal", "Unpaid", "Bereavement"]

// A little seed PTO history so the page isn't empty on first load.
function seedPto(agents: Agent[]): PtoRequest[] {
  return agents.slice(0, 9).map((a, i) => ({
    id: "lv" + i,
    agentId: a.id,
    type: PTO_TYPES[i % PTO_TYPES.length],
    from: `2026-07-${String(((i * 3) % 27) + 1).padStart(2, "0")}`,
    to: `2026-07-${String(((i * 3) % 27) + 1 + (i % 4)).padStart(2, "0")}`,
    days: (i % 4) + 1,
    status: i % 3 === 0 ? "Pending" : i % 3 === 1 ? "Approved" : "Denied",
  }))
}

interface WfmState {
  currentUser: string

  // Designation-level access control.
  currentRole: Role
  setCurrentRole: (role: Role) => void
  permissions: PermissionMatrix
  setPermission: (role: Role, moduleId: ModuleId, level: AccessLevel) => void
  can: (moduleId: ModuleId, min: AccessLevel) => boolean

  queues: Queue[]
  addQueue: (q: NewQueue) => string
  queueId: string
  setQueueId: (id: string) => void
  queue: () => Queue

  agents: Agent[]
  rta: RtaEntry[]
  addAgent: (a: NewAgent) => void
  setAgents: (agents: Agent[], detail: string) => void
  setAgentSkills: (agentId: string, skills: string[]) => void
  recallAgent: (id: string) => void
  recallMany: (ids: string[]) => void

  // Global shift + break patterns, reused across agents.
  shiftPatterns: ShiftPattern[]
  addShiftPattern: (p: Omit<ShiftPattern, "id">) => void
  updateShiftPattern: (id: string, patch: Partial<Omit<ShiftPattern, "id">>) => void
  removeShiftPattern: (id: string) => void

  shrinkage: number
  setShrinkage: (n: number) => void

  nowIdx: number
  setNowIdx: (n: number) => void

  forecasts: Record<string, number[]>
  forecastMethod: Record<string, string>
  applyForecast: (qid: string, arr: number[], methodId: string, methodName?: string) => void
  setVolume: (qid: string, idx: number, v: number) => void

  // Imported actual daily volumes per queue, appended after the base history's
  // last day (or overwriting an existing day if the date already exists).
  importedActuals: Record<string, ActualRow[]>
  importActuals: (qid: string, rows: ActualRow[], sourceLabel: string) => { methodName: string; mape: number; addedDays: number }
  clearActuals: (qid: string) => void

  auditLog: AuditEntry[]
  logAudit: (category: AuditCategory, action: string, detail: string) => void
  clearAudit: () => void

  ptoRequests: PtoRequest[]
  addPtoRequest: (r: Omit<PtoRequest, "id" | "status">) => void
  setPtoStatus: (id: string, status: PtoStatus) => void

  users: WfmUser[]
  inviteUser: (u: Omit<WfmUser, "id" | "status">) => void
  setUserRole: (id: string, role: Role) => void
  removeUser: (id: string) => void

  scenarios: Scenario[]
  addScenario: (sc: Omit<Scenario, "id" | "createdAt">) => void
  removeScenario: (id: string) => void

  swaps: SwapRequest[]
  /** Propose a swap; SL-neutral ones auto-approve and apply immediately. */
  proposeSwap: (fromAgentId: string, toAgentId: string, slImpact: number, autoApprove: boolean) => void
  /** TL/manager decision on an escalated swap; approving applies the exchange. */
  setSwapStatus: (id: string, status: "Approved" | "Denied") => void

  // Optimised per-agent break placements (from the Scheduling break optimiser).
  breakOverrides: BreakOverrides
  applyBreakOverrides: (overrides: BreakOverrides, detail: string) => void
  resetBreakOverrides: () => void
}

const DEFAULT_USER = "Avery Owens"

export const useWfm = create<WfmState>()(
  persist(
    (set, get) => ({
      currentUser: DEFAULT_USER,

      currentRole: "Super Admin",
      setCurrentRole: (role) => set({ currentRole: role }),
      permissions: DEFAULT_PERMISSIONS,
      setPermission: (role, moduleId, level) =>
        set((s) => ({
          permissions: { ...s.permissions, [role]: { ...s.permissions[role], [moduleId]: level } },
          auditLog: [entry(s.currentUser, "Config", "Updated permission", `${role} · ${moduleId} → ${level}`), ...s.auditLog],
        })),
      can: (moduleId, min) => {
        const s = get()
        const have = effectiveLevel(s.permissions, s.currentRole, moduleId)
        return ACCESS_RANK[have] >= ACCESS_RANK[min]
      },

      queues: QUEUES,
      addQueue: (q) => {
        const s = get()
        let id = slugify(q.name) || "skill"
        if (s.queues.some((x) => x.id === id)) {
          let n = 2
          while (s.queues.some((x) => x.id === `${id}-${n}`)) n++
          id = `${id}-${n}`
        }
        const queue: Queue = { id, name: q.name.trim(), color: q.color, aht: q.aht, slTarget: q.slTarget, targetTime: q.targetTime }
        set((s2) => ({
          queues: [...s2.queues, queue],
          forecasts: { ...s2.forecasts, [id]: forecastFor(id) },
          forecastMethod: { ...s2.forecastMethod, [id]: "baseline" },
          auditLog: [entry(s2.currentUser, "Config", "Added skill", `${queue.name} · AHT ${queue.aht}s · SL ${(queue.slTarget * 100).toFixed(0)}%/${queue.targetTime}s`), ...s2.auditLog],
        }))
        return id
      },
      queueId: QUEUES[0].id,
      setQueueId: (id) => set({ queueId: id }),
      queue: () => get().queues.find((q) => q.id === get().queueId)!,

      agents: AGENTS,
      rta: makeRTA(AGENTS),

      addAgent: (a) =>
        set((s) => {
          const id = "a" + String(s.agents.length + 1).padStart(2, "0") + uid().slice(0, 3)
          const pattern = s.shiftPatterns.find((p) => p.id === a.shiftPatternId)
          const agent: Agent = {
            id,
            name: a.name.trim(),
            skills: a.skills,
            shift: pattern ? shiftStringFor(pattern) : "07:00–15:30",
            shiftPatternId: a.shiftPatternId,
            team: a.team,
            tl: TEAMS[a.team]?.tl ?? "Unassigned",
          }
          return {
            agents: [...s.agents, agent],
            rta: [...s.rta, { id, actual: "AVAIL", scheduled: "AVAIL", secs: 0 }],
            auditLog: [
              entry(s.currentUser, "Employee", "Added employee", `${agent.name} · ${agent.team} · ${agent.skills.map((sk) => skillLabel(sk, s.queues)).join(" > ")} · ${pattern?.name ?? agent.shift}`),
              ...s.auditLog,
            ],
          }
        }),

      setAgents: (agents, detail) =>
        set((s) => ({
          agents,
          rta: makeRTA(agents),
          auditLog: [entry(s.currentUser, "Schedule", "Imported schedule", detail), ...s.auditLog],
        })),

      setAgentSkills: (agentId, skills) =>
        set((s) => {
          const agent = s.agents.find((a) => a.id === agentId)
          return {
            agents: s.agents.map((a) => (a.id === agentId ? { ...a, skills } : a)),
            auditLog: agent
              ? [entry(s.currentUser, "Employee", "Updated skill priority", `${agent.name} · ${skills.map((sk) => skillLabel(sk, s.queues)).join(" > ") || "(no skills)"}`), ...s.auditLog]
              : s.auditLog,
          }
        }),

      shiftPatterns: DEFAULT_SHIFT_PATTERNS,
      addShiftPattern: (p) =>
        set((s) => {
          const pattern: ShiftPattern = { ...p, id: "sp-" + uid() }
          return {
            shiftPatterns: [...s.shiftPatterns, pattern],
            auditLog: [
              entry(s.currentUser, "Config", "Added shift pattern", `${pattern.name} (${pattern.start}–${pattern.end}, ${pattern.breaks.length} break segment(s))`),
              ...s.auditLog,
            ],
          }
        }),
      updateShiftPattern: (id, patch) =>
        set((s) => {
          const existing = s.shiftPatterns.find((p) => p.id === id)
          return {
            shiftPatterns: s.shiftPatterns.map((p) => (p.id === id ? { ...p, ...patch } : p)),
            auditLog: existing
              ? [entry(s.currentUser, "Config", "Updated shift pattern", existing.name), ...s.auditLog]
              : s.auditLog,
          }
        }),
      removeShiftPattern: (id) =>
        set((s) => {
          const existing = s.shiftPatterns.find((p) => p.id === id)
          return {
            shiftPatterns: s.shiftPatterns.filter((p) => p.id !== id),
            auditLog: existing
              ? [entry(s.currentUser, "Config", "Removed shift pattern", existing.name), ...s.auditLog]
              : s.auditLog,
          }
        }),

      recallAgent: (id) =>
        set((s) => {
          const a = s.agents.find((x) => x.id === id)
          return {
            rta: s.rta.map((r) => (r.id === id ? { ...r, actual: "AVAIL", secs: 0, recalled: true } : r)),
            auditLog: [entry(s.currentUser, "Real-Time", "Recalled agent", `${a?.name ?? id} pulled back to Available`), ...s.auditLog],
          }
        }),
      recallMany: (ids) =>
        set((s) => {
          const set2 = new Set(ids)
          return {
            rta: s.rta.map((r) => (set2.has(r.id) ? { ...r, actual: "AVAIL", secs: 0, recalled: true } : r)),
            auditLog: [entry(s.currentUser, "Real-Time", "Recalled agents", `${ids.length} agents recalled from break`), ...s.auditLog],
          }
        }),

      shrinkage: SHRINKAGE,
      setShrinkage: (n) => set({ shrinkage: n }),

      nowIdx: 13,
      setNowIdx: (n) => set({ nowIdx: n }),

      forecasts: Object.fromEntries(QUEUES.map((q) => [q.id, forecastFor(q.id)])),
      forecastMethod: Object.fromEntries(QUEUES.map((q) => [q.id, "baseline"])),
      applyForecast: (qid, arr, methodId, methodName) =>
        set((s) => ({
          forecasts: { ...s.forecasts, [qid]: arr.slice() },
          forecastMethod: { ...s.forecastMethod, [qid]: methodId },
          auditLog: [
            entry(s.currentUser, "Forecast", "Applied forecast", `${s.queues.find((q) => q.id === qid)?.name ?? qid} · ${methodName ?? methodId}`),
            ...s.auditLog,
          ],
        })),
      setVolume: (qid, idx, v) =>
        set((s) => {
          const next = { ...s.forecasts, [qid]: [...s.forecasts[qid]] }
          next[qid][idx] = Math.max(0, Math.round(v) || 0)
          return { forecasts: next, forecastMethod: { ...s.forecastMethod, [qid]: "manual" } }
        }),

      importedActuals: {},
      importActuals: (qid, rows, sourceLabel) => {
        const s = get()
        const existing = s.importedActuals[qid] ?? []
        const merged = new Map(existing.map((r) => [r.date, r]))
        rows.forEach((r) => merged.set(r.date, r))
        const overlay = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date))

        // Retrain: re-evaluate every model on the augmented history and pick the
        // most accurate one, then predict with it — "train again and predict".
        const bt = backtest(qid, overlay)
        const forecastArr = generate(qid, bt.best.id, overlay)
        const queueName = s.queues.find((q) => q.id === qid)?.name ?? qid
        const mapePct = (bt.best.mape * 100).toFixed(1)

        set((s2) => ({
          importedActuals: { ...s2.importedActuals, [qid]: overlay },
          forecasts: { ...s2.forecasts, [qid]: forecastArr },
          forecastMethod: { ...s2.forecastMethod, [qid]: bt.best.id },
          auditLog: [
            entry(
              s2.currentUser,
              "Forecast",
              "Imported actuals & retrained",
              `${queueName} · +${rows.length} day(s) from ${sourceLabel} · best model ${bt.best.name} (${mapePct}% MAPE)`,
            ),
            ...s2.auditLog,
          ],
        }))

        return { methodName: bt.best.name, mape: bt.best.mape, addedDays: rows.length }
      },
      clearActuals: (qid) =>
        set((s) => {
          const bt = backtest(qid)
          const forecastArr = generate(qid, bt.best.id)
          const queueName = s.queues.find((q) => q.id === qid)?.name ?? qid
          const next = { ...s.importedActuals }
          delete next[qid]
          return {
            importedActuals: next,
            forecasts: { ...s.forecasts, [qid]: forecastArr },
            forecastMethod: { ...s.forecastMethod, [qid]: bt.best.id },
            auditLog: [entry(s.currentUser, "Forecast", "Cleared imported actuals", `${queueName} · reverted to base history`), ...s.auditLog],
          }
        }),

      auditLog: seedAudit(DEFAULT_USER),
      logAudit: (category, action, detail) =>
        set((s) => ({ auditLog: [entry(s.currentUser, category, action, detail), ...s.auditLog].slice(0, 500) })),
      clearAudit: () => set({ auditLog: [] }),

      ptoRequests: seedPto(AGENTS),
      addPtoRequest: (r) =>
        set((s) => {
          const agent = s.agents.find((a) => a.id === r.agentId)
          const req: PtoRequest = { ...r, id: "lv" + uid(), status: "Pending" }
          return {
            ptoRequests: [req, ...s.ptoRequests],
            auditLog: [entry(s.currentUser, "PTO", "Submitted leave request", `${agent?.name ?? r.agentId} · ${r.type} · ${r.from} → ${r.to} (${r.days}d)`), ...s.auditLog],
          }
        }),
      setPtoStatus: (id, status) =>
        set((s) => {
          const req = s.ptoRequests.find((r) => r.id === id)
          const agent = req ? s.agents.find((a) => a.id === req.agentId) : undefined
          return {
            ptoRequests: s.ptoRequests.map((r) => (r.id === id ? { ...r, status } : r)),
            auditLog: req
              ? [entry(s.currentUser, "PTO", `${status} leave request`, `${agent?.name ?? req.agentId} · ${req.type} · ${req.from} → ${req.to}`), ...s.auditLog]
              : s.auditLog,
          }
        }),

      users: seedUsers(),
      inviteUser: (u) =>
        set((s) => ({
          users: [...s.users, { ...u, id: "u" + uid(), status: "Invited" }],
          auditLog: [entry(s.currentUser, "Config", "Invited user", `${u.name} <${u.email}> · ${u.role}`), ...s.auditLog],
        })),
      setUserRole: (id, role) =>
        set((s) => {
          const u = s.users.find((x) => x.id === id)
          return {
            users: s.users.map((x) => (x.id === id ? { ...x, role } : x)),
            auditLog: u ? [entry(s.currentUser, "Config", "Changed user designation", `${u.name} · ${u.role} → ${role}`), ...s.auditLog] : s.auditLog,
          }
        }),
      removeUser: (id) =>
        set((s) => {
          const u = s.users.find((x) => x.id === id)
          return {
            users: s.users.filter((x) => x.id !== id),
            auditLog: u ? [entry(s.currentUser, "Config", "Removed user", `${u.name} <${u.email}>`), ...s.auditLog] : s.auditLog,
          }
        }),

      scenarios: [],
      addScenario: (sc) =>
        set((s) => {
          const scenario: Scenario = { ...sc, id: "sc" + uid(), createdAt: Date.now() }
          const scope = sc.queueId === "all" ? "All queues" : skillLabel(sc.queueId, s.queues)
          const bits = [
            sc.volumePct ? `vol ${sc.volumePct > 0 ? "+" : ""}${sc.volumePct}%` : "",
            sc.ahtPct ? `AHT ${sc.ahtPct > 0 ? "+" : ""}${sc.ahtPct}%` : "",
            sc.shrinkagePct != null ? `shrink ${sc.shrinkagePct}%` : "",
            sc.agentDelta ? `${sc.agentDelta > 0 ? "+" : ""}${sc.agentDelta} agents` : "",
          ].filter(Boolean).join(" · ")
          return {
            scenarios: [scenario, ...s.scenarios],
            auditLog: [entry(s.currentUser, "Config", "Created scenario", `${sc.name} · ${scope}${bits ? " · " + bits : ""}`), ...s.auditLog],
          }
        }),
      removeScenario: (id) =>
        set((s) => {
          const sc = s.scenarios.find((x) => x.id === id)
          return {
            scenarios: s.scenarios.filter((x) => x.id !== id),
            auditLog: sc ? [entry(s.currentUser, "Config", "Deleted scenario", sc.name), ...s.auditLog] : s.auditLog,
          }
        }),

      swaps: [],
      proposeSwap: (fromAgentId, toAgentId, slImpact, autoApprove) =>
        set((s) => {
          const a = s.agents.find((x) => x.id === fromAgentId)
          const b = s.agents.find((x) => x.id === toAgentId)
          if (!a || !b) return s
          const swap: SwapRequest = {
            id: "sw" + uid(),
            fromAgentId,
            toAgentId,
            slImpact,
            status: autoApprove ? "Auto-Approved" : "Pending",
            applied: autoApprove,
            ts: Date.now(),
          }
          const impact = `${(slImpact * 100).toFixed(1)}pp SL impact`
          return {
            swaps: [swap, ...s.swaps],
            agents: autoApprove ? swapShifts(s.agents, fromAgentId, toAgentId) : s.agents,
            auditLog: [
              entry(
                s.currentUser,
                "Schedule",
                autoApprove ? "Shift swap auto-approved" : "Shift swap escalated",
                `${a.name} (${a.shift}) ↔ ${b.name} (${b.shift}) · ${impact}`,
              ),
              ...s.auditLog,
            ],
          }
        }),
      setSwapStatus: (id, status) =>
        set((s) => {
          const swap = s.swaps.find((x) => x.id === id)
          if (!swap || swap.status !== "Pending") return s
          const a = s.agents.find((x) => x.id === swap.fromAgentId)
          const b = s.agents.find((x) => x.id === swap.toAgentId)
          const apply = status === "Approved" && !!a && !!b
          return {
            swaps: s.swaps.map((x) => (x.id === id ? { ...x, status, applied: apply } : x)),
            agents: apply ? swapShifts(s.agents, swap.fromAgentId, swap.toAgentId) : s.agents,
            auditLog: [
              entry(s.currentUser, "Schedule", `Shift swap ${status.toLowerCase()}`, a && b ? `${a.name} ↔ ${b.name}` : id),
              ...s.auditLog,
            ],
          }
        }),

      breakOverrides: {},
      applyBreakOverrides: (overrides, detail) =>
        set((s) => ({
          breakOverrides: overrides,
          auditLog: [entry(s.currentUser, "Schedule", "Optimised breaks", detail), ...s.auditLog],
        })),
      resetBreakOverrides: () =>
        set((s) => ({
          breakOverrides: {},
          auditLog: [entry(s.currentUser, "Schedule", "Reset break plan", "Reverted to shift-pattern break placements"), ...s.auditLog],
        })),
    }),
    {
      name: "flowforce-wfm",
      version: 1,
      // persist everything a user changes so nothing is lost on refresh
      partialize: (s) => ({
        currentUser: s.currentUser,
        currentRole: s.currentRole,
        permissions: s.permissions,
        queues: s.queues,
        queueId: s.queueId,
        agents: s.agents,
        rta: s.rta,
        shiftPatterns: s.shiftPatterns,
        shrinkage: s.shrinkage,
        nowIdx: s.nowIdx,
        forecasts: s.forecasts,
        forecastMethod: s.forecastMethod,
        importedActuals: s.importedActuals,
        auditLog: s.auditLog,
        ptoRequests: s.ptoRequests,
        users: s.users,
        scenarios: s.scenarios,
        swaps: s.swaps,
        breakOverrides: s.breakOverrides,
      }),
    },
  ),
)
