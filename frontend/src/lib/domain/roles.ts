// Designation-level access control (RBAC). Twelve org roles, each with a
// none/view/edit access level per module. This is a frontend simulation (no
// real auth backend) — the "Sign in as" switcher in Settings lets you preview
// the app as any designation, and PermissionGate enforces the matrix on the
// key actions across every page.

export const ROLES = [
  "Super Admin",
  "Business Admin",
  "WFM Director",
  "WFM Manager",
  "Forecasting Manager",
  "Planner",
  "Scheduler",
  "RTA",
  "Team Leader",
  "Operations Manager",
  "Agent",
  "Read-Only Viewer",
] as const
export type Role = (typeof ROLES)[number]

export type AccessLevel = "none" | "view" | "edit"
export const ACCESS_RANK: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2 }
export const meetsLevel = (have: AccessLevel, need: AccessLevel) => ACCESS_RANK[have] >= ACCESS_RANK[need]

export interface ModuleDef {
  id: string
  label: string
}

// Mirrors the sidebar's routable modules (see config/nav.ts).
export const MODULES: ModuleDef[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "forecasting", label: "Forecasting" },
  { id: "capacity", label: "Capacity Planning" },
  { id: "erlang", label: "Erlang Calculator" },
  { id: "scenarios", label: "Scenario Studio" },
  { id: "scheduling", label: "Scheduling" },
  { id: "shiftPatterns", label: "Shift Patterns" },
  { id: "swaps", label: "Shift Swaps" },
  { id: "intraday", label: "Intraday" },
  { id: "realtime", label: "Real-Time Monitor" },
  { id: "adherence", label: "Adherence" },
  { id: "automation", label: "Automation" },
  { id: "help", label: "Methodology" },
  { id: "employees", label: "Employees" },
  { id: "skills", label: "Skills" },
  { id: "pto", label: "PTO & Leave" },
  { id: "reports", label: "Reports & KPIs" },
  { id: "copilot", label: "AI Copilot" },
  { id: "audit", label: "Audit Trail" },
  { id: "settings", label: "Settings & RBAC" },
]
export type ModuleId = (typeof MODULES)[number]["id"]

export type PermissionMatrix = Record<Role, Record<ModuleId, AccessLevel>>

const E: AccessLevel = "edit"
const V: AccessLevel = "view"
const N: AccessLevel = "none"

// One row per role, one column per module — hand-authored to reflect how a
// real contact-centre WFM org is actually structured.
export const DEFAULT_PERMISSIONS: PermissionMatrix = {
  "Super Admin": {
    dashboard: E, forecasting: E, capacity: E, erlang: E, scenarios: E, scheduling: E, shiftPatterns: E, swaps: E,
    intraday: E, realtime: E, adherence: E, automation: E, help: V, employees: E, skills: E, pto: E, reports: E, copilot: E, audit: E, settings: E,
  },
  "Business Admin": {
    dashboard: E, forecasting: E, capacity: E, erlang: E, scenarios: E, scheduling: E, shiftPatterns: E, swaps: V,
    intraday: E, realtime: E, adherence: E, automation: E, help: V, employees: E, skills: E, pto: E, reports: E, copilot: E, audit: V, settings: E,
  },
  "WFM Director": {
    dashboard: E, forecasting: E, capacity: E, erlang: E, scenarios: E, scheduling: E, shiftPatterns: E, swaps: V,
    intraday: V, realtime: V, adherence: V, automation: V, help: V, employees: E, skills: E, pto: E, reports: E, copilot: E, audit: V, settings: N,
  },
  "WFM Manager": {
    dashboard: E, forecasting: E, capacity: E, erlang: E, scenarios: E, scheduling: E, shiftPatterns: E, swaps: E,
    intraday: V, realtime: V, adherence: V, automation: E, help: V, employees: V, skills: V, pto: E, reports: E, copilot: E, audit: V, settings: N,
  },
  "Forecasting Manager": {
    dashboard: V, forecasting: E, capacity: E, erlang: E, scenarios: E, scheduling: V, shiftPatterns: N, swaps: N,
    intraday: V, realtime: N, adherence: N, automation: V, help: V, employees: N, skills: N, pto: N, reports: V, copilot: E, audit: N, settings: N,
  },
  Planner: {
    dashboard: V, forecasting: V, capacity: E, erlang: E, scenarios: E, scheduling: E, shiftPatterns: E, swaps: V,
    intraday: V, realtime: N, adherence: N, automation: V, help: V, employees: V, skills: V, pto: V, reports: V, copilot: V, audit: N, settings: N,
  },
  Scheduler: {
    dashboard: V, forecasting: N, capacity: V, erlang: N, scenarios: V, scheduling: E, shiftPatterns: E, swaps: E,
    intraday: V, realtime: N, adherence: N, automation: N, help: V, employees: V, skills: V, pto: V, reports: V, copilot: N, audit: N, settings: N,
  },
  RTA: {
    dashboard: V, forecasting: N, capacity: N, erlang: N, scenarios: N, scheduling: V, shiftPatterns: N, swaps: V,
    intraday: E, realtime: E, adherence: E, automation: V, help: V, employees: V, skills: N, pto: N, reports: V, copilot: N, audit: N, settings: N,
  },
  "Team Leader": {
    dashboard: V, forecasting: N, capacity: N, erlang: N, scenarios: N, scheduling: V, shiftPatterns: N, swaps: E,
    intraday: V, realtime: E, adherence: E, automation: N, help: V, employees: V, skills: E, pto: E, reports: V, copilot: N, audit: N, settings: N,
  },
  "Operations Manager": {
    dashboard: E, forecasting: V, capacity: V, erlang: N, scenarios: V, scheduling: V, shiftPatterns: N, swaps: V,
    intraday: V, realtime: E, adherence: E, automation: V, help: V, employees: V, skills: V, pto: E, reports: E, copilot: V, audit: V, settings: N,
  },
  Agent: {
    dashboard: V, forecasting: N, capacity: N, erlang: N, scenarios: N, scheduling: V, shiftPatterns: N, swaps: E,
    intraday: N, realtime: N, adherence: N, automation: N, help: V, employees: N, skills: N, pto: E, reports: N, copilot: N, audit: N, settings: N,
  },
  "Read-Only Viewer": {
    dashboard: V, forecasting: V, capacity: V, erlang: V, scenarios: V, scheduling: V, shiftPatterns: V, swaps: V,
    intraday: V, realtime: V, adherence: V, automation: V, help: V, employees: V, skills: V, pto: V, reports: V, copilot: V, audit: V, settings: N,
  },
}

// Effective access for a role+module. Persisted matrices from older versions
// of the app may lack newly added modules — fall back to the shipped defaults
// so new pages don't silently disappear for everyone.
export function effectiveLevel(
  permissions: PermissionMatrix,
  role: Role,
  moduleId: ModuleId,
): AccessLevel {
  return permissions[role]?.[moduleId] ?? DEFAULT_PERMISSIONS[role]?.[moduleId] ?? "none"
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  "Super Admin": "Full system access, including RBAC configuration.",
  "Business Admin": "Runs the business day-to-day; can't clear the audit trail.",
  "WFM Director": "Owns WFM strategy across forecasting, capacity and scheduling.",
  "WFM Manager": "Manages the WFM function's daily planning workflow.",
  "Forecasting Manager": "Owns demand forecasting and the AI Copilot.",
  Planner: "Builds capacity plans and schedules from the forecast.",
  Scheduler: "Builds and imports schedules; owns shift patterns.",
  RTA: "Watches the floor in real time and manages intraday.",
  "Team Leader": "Manages their team's skills, PTO and real-time exceptions.",
  "Operations Manager": "Cross-functional oversight of live operations and reporting.",
  Agent: "Self-service: view their own schedule, submit PTO requests.",
  "Read-Only Viewer": "Can see everything, change nothing.",
}
