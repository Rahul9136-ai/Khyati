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
import { seedExceptions, type AdherenceException, type ExceptionStatus } from "@/lib/domain/adherence"
import { computeAlerts, type WfmAlert } from "@/lib/domain/alerts"
import type { ExternalFactor, NewFactor } from "@/lib/domain/externalFactors"
import type { ScheduleAddition } from "@/lib/domain/autoschedule"
import { evaluatePtoRequest } from "@/lib/domain/ptoRules"
import {
  DEFAULT_RULE_STATE,
  DEFAULT_THRESHOLDS,
  PIPELINE,
  RULES,
  THRESHOLD_META,
  type RuleState,
  type Thresholds,
} from "@/lib/domain/automation"
import { effectiveSegments, optimiseBreaks, type BreakOverrides } from "@/lib/domain/breaks"
import { buildPlan, summarisePlan } from "@/lib/domain/planning"
import type { Scenario } from "@/lib/domain/scenario"
import { AGENTS, forecastFor, inAdherence, makeRTA, QUEUES, SHRINKAGE, TEAMS } from "@/lib/domain/seed"
import { recommendSkillChanges } from "@/lib/domain/skillRecommend"
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

export type PtoStatus = "Pending" | "Auto-Approved" | "Approved" | "Denied"
export interface PtoRequest {
  id: string
  agentId: string
  type: string
  from: string
  to: string
  days: number
  status: PtoStatus
}

// Broadcast messages (Team Leader / WFM Manager → agent, team, or everyone).
// Pop up on screen for the recipient(s) rather than sitting in the passive
// notifications bell — see components/layout/message-popup.tsx.
export type MessageAudience = "agent" | "team" | "all"
export interface TeamMessage {
  id: string
  fromName: string
  fromRole: Role
  audience: MessageAudience
  agentId?: string // audience === "agent"
  team?: string // audience === "team"
  text: string
  urgent: boolean
  ts: number
  /** Viewer keys ("agent:<id>" or "role:<Role>") that have acknowledged it. */
  dismissedBy: string[]
}

// RTA skill re-balancing: system-generated recommendation to move an agent's
// skill from a surplus queue to a short one, live until a WFM Manager AND an
// Operations Manager have both signed off — see lib/domain/skillRecommend.ts.
export type SkillChangeStatus = "Pending" | "Rejected" | "Applied"
export interface SkillChangeRecommendation {
  id: string
  agentId: string
  agentName: string
  fromQueueId: string
  fromQueueName: string
  toQueueId: string
  toQueueName: string
  reason: string
  generatedAt: number
  status: SkillChangeStatus
  wfmApprovedBy?: string
  opsApprovedBy?: string
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

  // Which roster agent the Agent-role self-service view is scoped to (preview aid).
  currentAgentId: string
  setCurrentAgentId: (id: string) => void

  queues: Queue[]
  addQueue: (q: NewQueue) => string
  queueId: string
  setQueueId: (id: string) => void
  queue: () => Queue

  agents: Agent[]
  rta: RtaEntry[]
  addAgent: (a: NewAgent) => void
  /** Auto-scheduler: mint new agents from the recommended pattern additions. */
  applyAutoSchedule: (queueId: string, additions: ScheduleAddition[]) => void
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

  // Known future/past events (campaigns, holidays, weather, outages) overlaid
  // on the date-range forecast to correct for step changes a pure model misses.
  externalFactors: ExternalFactor[]
  addExternalFactor: (f: NewFactor) => void
  importExternalFactors: (rows: NewFactor[], sourceLabel: string) => void
  removeExternalFactor: (id: string) => void

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

  // Automation layer: configurable thresholds + rules-engine toggles.
  thresholds: Thresholds
  setThreshold: (key: keyof Thresholds, value: number) => void
  ruleState: RuleState
  setRuleEnabled: (id: string, enabled: boolean) => void

  // Pipeline execution: "Run now" fires a job's real logic immediately;
  // pipelineAutoRun toggles a live (demo-paced) interval that keeps firing it.
  pipelineAutoRun: Record<string, boolean>
  setPipelineAutoRun: (jobId: string, on: boolean) => void
  runPipelineJob: (jobId: string, scheduled?: boolean) => void

  // Proactive alerts: recomputed on an interval regardless of the current page.
  alerts: WfmAlert[]
  recomputeAlerts: () => void

  // Adherence exception management (approved activities auto-applied).
  exceptions: AdherenceException[]
  addException: (e: Omit<AdherenceException, "id" | "status">) => void
  setExceptionStatus: (id: string, status: ExceptionStatus) => void
  /** Executes an Approved request: for a breakChange it writes the new
   *  segment into breakOverrides; for an exception it just marks Applied
   *  (only then does it count toward the adherence score). */
  applyException: (id: string) => void

  // Broadcast messages: Team Leader/WFM Manager -> agent, team, or everyone.
  messages: TeamMessage[]
  sendMessage: (m: { audience: MessageAudience; agentId?: string; team?: string; text: string; urgent: boolean }) => void
  dismissMessage: (id: string, viewerKey: string) => void

  // RTA skill re-balancing: scan for candidates, then a WFM Manager + an
  // Operations Manager both have to approve before the skill actually switches.
  skillChangeRecommendations: SkillChangeRecommendation[]
  scanSkillRecommendations: () => number
  /** Records one tier's approval; once both tiers are in, applies the switch. */
  approveSkillChange: (id: string, tier: "wfm" | "ops") => void
  rejectSkillChange: (id: string) => void
}

const DEFAULT_USER = "Avery Owens"

export const useWfm = create<WfmState>()(
  persist(
    (set, get) => ({
      currentUser: DEFAULT_USER,

      currentRole: "Super Admin",
      setCurrentRole: (role) => set({ currentRole: role }),
      currentAgentId: AGENTS[0]?.id ?? "",
      setCurrentAgentId: (id) => set({ currentAgentId: id }),
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

      applyAutoSchedule: (queueId, additions) =>
        set((s) => {
          const teamNames = Object.keys(TEAMS)
          let seq = s.agents.length
          const newAgents: Agent[] = []
          const newRta: RtaEntry[] = []
          additions.forEach(({ patternId, count }) => {
            const pattern = s.shiftPatterns.find((p) => p.id === patternId)
            for (let i = 0; i < count; i++) {
              seq++
              const team = teamNames[seq % teamNames.length] ?? teamNames[0]
              const id = "a" + String(seq).padStart(3, "0") + uid().slice(0, 3)
              const agent: Agent = {
                id,
                name: `New Hire ${seq}`,
                skills: [queueId],
                shift: pattern ? shiftStringFor(pattern) : "07:00–15:30",
                shiftPatternId: patternId,
                team,
                tl: TEAMS[team]?.tl ?? "Unassigned",
              }
              newAgents.push(agent)
              newRta.push({ id, actual: "AVAIL", scheduled: "AVAIL", secs: 0 })
            }
          })
          const queueName = skillLabel(queueId, s.queues)
          const detail = additions.map((a) => `${a.count}× ${a.patternName}`).join(", ")
          return {
            agents: [...s.agents, ...newAgents],
            rta: [...s.rta, ...newRta],
            auditLog: [
              entry(s.currentUser, "Employee", "Auto-scheduled new hires", `${queueName} · ${newAgents.length} agent(s) · ${detail}`),
              ...s.auditLog,
            ],
          }
        }),

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

      externalFactors: [],
      addExternalFactor: (f) =>
        set((s) => {
          const factor: ExternalFactor = { ...f, id: "fac" + uid(), createdAt: Date.now() }
          const scope = f.queueId === "all" ? "all queues" : skillLabel(f.queueId, s.queues)
          return {
            externalFactors: [factor, ...s.externalFactors],
            auditLog: [
              entry(s.currentUser, "Forecast", "Added external factor", `${f.name} · ${scope} · ${f.from}${f.to !== f.from ? ` → ${f.to}` : ""} · ${f.impactPct > 0 ? "+" : ""}${f.impactPct}%`),
              ...s.auditLog,
            ],
          }
        }),
      importExternalFactors: (rows, sourceLabel) =>
        set((s) => {
          const factors: ExternalFactor[] = rows.map((f) => ({ ...f, id: "fac" + uid(), createdAt: Date.now() }))
          return {
            externalFactors: [...factors, ...s.externalFactors],
            auditLog: [entry(s.currentUser, "Forecast", "Imported external factors", `${factors.length} factor(s) from ${sourceLabel}`), ...s.auditLog],
          }
        }),
      removeExternalFactor: (id) =>
        set((s) => {
          const f = s.externalFactors.find((x) => x.id === id)
          return {
            externalFactors: s.externalFactors.filter((x) => x.id !== id),
            auditLog: f ? [entry(s.currentUser, "Forecast", "Removed external factor", f.name), ...s.auditLog] : s.auditLog,
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
          const ruleOn = s.ruleState["pto-auto-approve"] !== false
          const evalResult = ruleOn
            ? evaluatePtoRequest(r, s.agents, s.queues, s.forecasts, s.shrinkage, s.ptoRequests, s.thresholds.ptoOverlapCapPct)
            : null
          const status: PtoStatus = evalResult?.approve ? "Auto-Approved" : "Pending"
          const req: PtoRequest = { ...r, id: "lv" + uid(), status }
          const base = `${agent?.name ?? r.agentId} · ${r.type} · ${r.from} → ${r.to} (${r.days}d)`
          return {
            ptoRequests: [req, ...s.ptoRequests],
            auditLog: [
              entry(
                s.currentUser,
                "PTO",
                status === "Auto-Approved" ? "Leave auto-approved" : "Submitted leave request",
                status === "Auto-Approved" ? `${base} · ${evalResult!.reason}` : base,
              ),
              ...s.auditLog,
            ],
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

      thresholds: DEFAULT_THRESHOLDS,
      setThreshold: (key, value) =>
        set((s) => {
          const meta = THRESHOLD_META.find((m) => m.key === key)
          const fmt = (v: number) => (meta?.kind === "pct" ? `${(v * 100).toFixed(0)}%` : meta?.kind === "mins" ? `${v} min` : `${v}pp`)
          return {
            thresholds: { ...s.thresholds, [key]: value },
            auditLog: [
              entry(s.currentUser, "Config", "Changed threshold", `${meta?.label ?? key}: ${fmt(s.thresholds[key])} → ${fmt(value)}`),
              ...s.auditLog,
            ],
          }
        }),

      ruleState: DEFAULT_RULE_STATE,
      setRuleEnabled: (id, enabled) =>
        set((s) => {
          const rule = RULES.find((r) => r.id === id)
          return {
            ruleState: { ...s.ruleState, [id]: enabled },
            auditLog: [
              entry(s.currentUser, "Config", `${enabled ? "Enabled" : "Disabled"} automation rule`, rule?.name ?? id),
              ...s.auditLog,
            ],
          }
        }),

      pipelineAutoRun: {},
      setPipelineAutoRun: (jobId, on) =>
        set((s) => {
          const job = PIPELINE.find((j) => j.id === jobId)
          return {
            pipelineAutoRun: { ...s.pipelineAutoRun, [jobId]: on },
            auditLog: [
              entry(s.currentUser, "Config", on ? "Enabled scheduled run" : "Disabled scheduled run", job?.name ?? jobId),
              ...s.auditLog,
            ],
          }
        }),
      runPipelineJob: (jobId, scheduled = false) =>
        set((s) => {
          const trigger = scheduled ? "scheduled" : "manual"
          const jobName = PIPELINE.find((j) => j.id === jobId)?.name ?? jobId

          if (jobId === "ingest") {
            return {
              auditLog: [entry(s.currentUser, "Config", "Ran data ingest", `${s.queues.length} queue(s) refreshed · ${trigger} run`), ...s.auditLog],
            }
          }

          if (jobId === "forecast") {
            const forecasts = { ...s.forecasts }
            const forecastMethod = { ...s.forecastMethod }
            const refreshed: string[] = []
            for (const q of s.queues) {
              const overlay = s.importedActuals[q.id]
              if (!overlay || overlay.length === 0) continue
              const bt = backtest(q.id, overlay)
              forecasts[q.id] = generate(q.id, bt.best.id, overlay)
              forecastMethod[q.id] = bt.best.id
              refreshed.push(`${q.name} (${bt.best.name})`)
            }
            const detail = refreshed.length
              ? `Retrained ${refreshed.length} queue(s): ${refreshed.join(", ")} · ${trigger} run`
              : `No queues had imported actuals to retrain against · ${trigger} run`
            return {
              ...(refreshed.length ? { forecasts, forecastMethod } : {}),
              auditLog: [entry(s.currentUser, "Forecast", "Ran forecast refresh", detail), ...s.auditLog],
            }
          }

          if (jobId === "capacity") {
            const totals = s.queues.reduce(
              (acc, q) => {
                const sum = summarisePlan(buildPlan(s.forecasts[q.id] ?? [], q.aht, q, s.shrinkage, s.agents))
                return { req: acc.req + sum.reqHours, sched: acc.sched + sum.schedHours }
              },
              { req: 0, sched: 0 },
            )
            return {
              auditLog: [
                entry(s.currentUser, "Config", "Ran capacity rebuild", `${totals.req.toFixed(0)} required vs ${totals.sched.toFixed(0)} scheduled agent-hrs across ${s.queues.length} queue(s) · ${trigger} run`),
                ...s.auditLog,
              ],
            }
          }

          if (jobId === "schedule") {
            const res = optimiseBreaks(s.queues, s.forecasts, s.shrinkage, s.agents, s.shiftPatterns, s.breakOverrides)
            const detail = res.moved
              ? `${res.moved} break move(s) · under-target ${res.beforeUnder} → ${res.afterUnder} · ${trigger} run`
              : `No beneficial break moves found · ${trigger} run`
            return {
              ...(res.moved ? { breakOverrides: res.overrides } : {}),
              auditLog: [entry(s.currentUser, "Schedule", "Ran schedule optimiser", detail), ...s.auditLog],
            }
          }

          if (jobId === "rta") {
            const escalated = s.rta.filter(
              (r) => !inAdherence(r.actual, r.scheduled) && r.secs >= s.thresholds.escalateMins * 60,
            ).length
            return {
              auditLog: [
                entry(s.currentUser, "Real-Time", "Ran RTA monitor", `${s.rta.length} agent(s) polled · ${escalated} escalation(s) at grace ${s.thresholds.graceMins}min/escalate ${s.thresholds.escalateMins}min · ${trigger} run`),
                ...s.auditLog,
              ],
            }
          }

          return { auditLog: [entry(s.currentUser, "Config", "Ran automation job", `${jobName} · ${trigger} run`), ...s.auditLog] }
        }),

      alerts: [],
      recomputeAlerts: () => {
        // Auto-scan for skill re-balancing candidates first (SL dropping or a
        // volume spike on some queue) so a real recommendation is already
        // waiting — not gated behind someone manually clicking "Scan" on RTA.
        get().scanSkillRecommendations()
        set((s) => ({
          alerts: computeAlerts({
            queues: s.queues,
            forecasts: s.forecasts,
            shrinkage: s.shrinkage,
            agents: s.agents,
            rta: s.rta,
            nowIdx: s.nowIdx,
            thresholds: s.thresholds,
            ptoPending: s.ptoRequests.filter((r) => r.status === "Pending").length,
            swapsPending: s.swaps.filter((r) => r.status === "Pending").length,
            skillChangePending: s.skillChangeRecommendations.filter((r) => r.status === "Pending").length,
          }),
        }))
      },

      exceptions: seedExceptions(AGENTS),
      addException: (e) =>
        set((s) => {
          const agent = s.agents.find((a) => a.id === e.agentId)
          const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
          const ex: AdherenceException = { ...e, id: "ex" + uid(), status: "Pending" }
          return {
            exceptions: [ex, ...s.exceptions],
            auditLog: [
              entry(s.currentUser, "Real-Time", "Raised adherence exception", `${agent?.name ?? e.agentId} · ${e.reason} · ${fmt(e.startMin)}–${fmt(e.endMin)}`),
              ...s.auditLog,
            ],
          }
        }),
      setExceptionStatus: (id, status) =>
        set((s) => {
          const ex = s.exceptions.find((x) => x.id === id)
          const agent = ex ? s.agents.find((a) => a.id === ex.agentId) : undefined
          return {
            exceptions: s.exceptions.map((x) => (x.id === id ? { ...x, status } : x)),
            auditLog: ex
              ? [entry(s.currentUser, "Real-Time", `${status} adherence exception`, `${agent?.name ?? ex.agentId} · ${ex.reason}`), ...s.auditLog]
              : s.auditLog,
          }
        }),
      applyException: (id) =>
        set((s) => {
          const ex = s.exceptions.find((x) => x.id === id)
          if (!ex || ex.status !== "Approved") return s
          const agent = s.agents.find((a) => a.id === ex.agentId)
          if (!agent) return s

          let breakOverrides = s.breakOverrides
          if (ex.kind === "breakChange") {
            const [shiftStartS] = agent.shift.split("–")
            const [h, m] = shiftStartS.split(":").map(Number)
            const shiftStart = h * 60 + m
            const current = effectiveSegments(agent, s.shiftPatterns, s.breakOverrides)
            const newSeg = {
              id: ex.segId && ex.segId !== "new" ? ex.segId : "seg" + uid(),
              type: ex.segType ?? "break",
              label: ex.segType === "lunch" ? "Lunch" : "Break",
              offsetMinutes: ex.startMin - shiftStart,
              durationMinutes: ex.endMin - ex.startMin,
            }
            const nextSegs =
              ex.segId && ex.segId !== "new"
                ? current.map((seg) => (seg.id === ex.segId ? newSeg : seg))
                : [...current, newSeg]
            breakOverrides = { ...s.breakOverrides, [agent.id]: nextSegs }
          }

          return {
            breakOverrides,
            exceptions: s.exceptions.map((x) => (x.id === id ? { ...x, status: "Applied" as ExceptionStatus } : x)),
            auditLog: [
              entry(
                s.currentUser,
                "Real-Time",
                ex.kind === "breakChange" ? "Applied break/shrinkage change" : "Applied adherence exception",
                `${agent.name} · ${ex.reason}`,
              ),
              ...s.auditLog,
            ],
          }
        }),

      messages: [],
      sendMessage: (m) =>
        set((s) => {
          const msg: TeamMessage = {
            id: "msg" + uid(),
            fromName: s.currentUser,
            fromRole: s.currentRole,
            audience: m.audience,
            agentId: m.agentId,
            team: m.team,
            text: m.text,
            urgent: m.urgent,
            ts: Date.now(),
            dismissedBy: [],
          }
          const target =
            m.audience === "agent"
              ? (s.agents.find((a) => a.id === m.agentId)?.name ?? m.agentId)
              : m.audience === "team"
                ? `Team ${m.team}`
                : "everyone"
          return {
            messages: [msg, ...s.messages],
            auditLog: [
              entry(s.currentUser, "Real-Time", "Sent message", `To ${target}${m.urgent ? " · urgent" : ""} · ${m.text}`),
              ...s.auditLog,
            ],
          }
        }),
      dismissMessage: (id, viewerKey) =>
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === id && !m.dismissedBy.includes(viewerKey)
              ? { ...m, dismissedBy: [...m.dismissedBy, viewerKey] }
              : m,
          ),
        })),

      skillChangeRecommendations: [],
      scanSkillRecommendations: () => {
        let added = 0
        set((s) => {
          const candidates = recommendSkillChanges(s.queues, s.forecasts, s.shrinkage, s.agents, s.nowIdx)
          const existingPending = new Set(
            s.skillChangeRecommendations
              .filter((r) => r.status === "Pending")
              .map((r) => `${r.agentId}:${r.toQueueId}`),
          )
          const fresh = candidates.filter((c) => !existingPending.has(`${c.agentId}:${c.toQueueId}`))
          added = fresh.length
          if (!fresh.length) return s
          const now = Date.now()
          const newRecs: SkillChangeRecommendation[] = fresh.map((c) => ({
            id: "sc" + uid(),
            agentId: c.agentId,
            agentName: c.agentName,
            fromQueueId: c.fromQueueId,
            fromQueueName: c.fromQueueName,
            toQueueId: c.toQueueId,
            toQueueName: c.toQueueName,
            reason: c.reason,
            generatedAt: now,
            status: "Pending",
          }))
          return {
            skillChangeRecommendations: [...newRecs, ...s.skillChangeRecommendations],
            auditLog: [
              entry(s.currentUser, "Real-Time", "Scanned for skill re-balancing", `${newRecs.length} new recommendation(s)`),
              ...s.auditLog,
            ],
          }
        })
        return added
      },
      approveSkillChange: (id, tier) =>
        set((s) => {
          const rec = s.skillChangeRecommendations.find((r) => r.id === id)
          if (!rec || rec.status !== "Pending") return s
          const updated: SkillChangeRecommendation = {
            ...rec,
            wfmApprovedBy: tier === "wfm" ? s.currentUser : rec.wfmApprovedBy,
            opsApprovedBy: tier === "ops" ? s.currentUser : rec.opsApprovedBy,
          }
          const bothApproved = !!updated.wfmApprovedBy && !!updated.opsApprovedBy

          if (!bothApproved) {
            return {
              skillChangeRecommendations: s.skillChangeRecommendations.map((r) => (r.id === id ? updated : r)),
              auditLog: [
                entry(
                  s.currentUser,
                  "Real-Time",
                  `${tier === "wfm" ? "WFM" : "Ops"} approved skill switch`,
                  `${rec.agentName} · ${rec.fromQueueName} → ${rec.toQueueName}`,
                ),
                ...s.auditLog,
              ],
            }
          }

          updated.status = "Applied"
          const agent = s.agents.find((a) => a.id === rec.agentId)
          return {
            agents: s.agents.map((a) =>
              a.id === rec.agentId
                ? { ...a, skills: [...new Set(a.skills.map((sk) => (sk === rec.fromQueueId ? rec.toQueueId : sk)))] }
                : a,
            ),
            skillChangeRecommendations: s.skillChangeRecommendations.map((r) => (r.id === id ? updated : r)),
            auditLog: [
              entry(
                s.currentUser,
                "Real-Time",
                "Applied RTA skill switch",
                `${agent?.name ?? rec.agentName} · ${rec.fromQueueName} → ${rec.toQueueName}`,
              ),
              ...s.auditLog,
            ],
          }
        }),
      rejectSkillChange: (id) =>
        set((s) => {
          const rec = s.skillChangeRecommendations.find((r) => r.id === id)
          return {
            skillChangeRecommendations: s.skillChangeRecommendations.map((r) =>
              r.id === id ? { ...r, status: "Rejected" as SkillChangeStatus } : r,
            ),
            auditLog: rec
              ? [
                  entry(s.currentUser, "Real-Time", "Rejected skill switch recommendation", `${rec.agentName} · ${rec.fromQueueName} → ${rec.toQueueName}`),
                  ...s.auditLog,
                ]
              : s.auditLog,
          }
        }),
    }),
    {
      name: "flowforce-wfm",
      // v6: Planner's Adherence access dropped to view (apply-only, via the
      // request workflow below) and Team Leader's dropped from edit to view
      // (they raise requests, not edit adherence directly) — another
      // values-only DEFAULT_PERMISSIONS change that needs an explicit reset,
      // same as v2-v4 before it. Also: AdherenceException gained a required
      // `kind` field — persisted exceptions from pre-v6 sessions lack it
      // entirely, which silently breaks the Applied-exception adherence
      // credit (scoreAgentDay filters on `e.kind === "exception"`), so those
      // get reseeded fresh rather than patched in place. (Bumped straight to
      // v6 because a v5 build without the exceptions reseed already shipped
      // and wrote version 5 into some browsers' localStorage.)
      version: 6,
      migrate: (persisted, fromVersion) => {
        const state = persisted as Partial<{ permissions: PermissionMatrix; exceptions: AdherenceException[] }> | undefined
        if (state && fromVersion < 6) {
          return { ...state, permissions: DEFAULT_PERMISSIONS, exceptions: seedExceptions(AGENTS) }
        }
        return state
      },
      // persist everything a user changes so nothing is lost on refresh
      partialize: (s) => ({
        currentUser: s.currentUser,
        currentRole: s.currentRole,
        currentAgentId: s.currentAgentId,
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
        externalFactors: s.externalFactors,
        auditLog: s.auditLog,
        ptoRequests: s.ptoRequests,
        users: s.users,
        scenarios: s.scenarios,
        swaps: s.swaps,
        breakOverrides: s.breakOverrides,
        thresholds: s.thresholds,
        ruleState: s.ruleState,
        exceptions: s.exceptions,
        pipelineAutoRun: s.pipelineAutoRun,
        messages: s.messages,
        skillChangeRecommendations: s.skillChangeRecommendations,
      }),
    },
  ),
)
