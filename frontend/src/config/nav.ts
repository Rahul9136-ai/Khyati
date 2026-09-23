import {
  Activity,
  BarChart3,
  BookOpenText,
  Bot,
  CalendarClock,
  CheckCheck,
  CalendarRange,
  ClipboardCheck,
  Clock,
  FlaskConical,
  Gauge,
  History,
  LayoutDashboard,
  Repeat,
  type LucideIcon,
  PlaneTakeoff,
  Settings,
  Sparkles,
  Star,
  TrendingUp,
  UsersRound,
  Workflow,
} from "lucide-react"

import type { ModuleId } from "@/lib/domain/roles"

export interface NavSubItem {
  to: string
  label: string
  /** The Planning page's `tab` query param this sub-item corresponds to. */
  tab: string
}

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  module: ModuleId
  /** Sub-sections shown under this item once its page is active — e.g. Capacity
   *  Planning's four tabs, so they're reachable straight from the sidebar. */
  children?: NavSubItem[]
}

export interface NavGroup {
  group: string
  items: NavItem[]
}

export const NAV: NavGroup[] = [
  {
    group: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard, module: "dashboard" }],
  },
  {
    group: "Plan",
    items: [
      { to: "/forecasting", label: "Forecasting", icon: TrendingUp, module: "forecasting" },
      {
        to: "/planning", label: "Capacity Planning", icon: Gauge, module: "planning",
        children: [
          { to: "/planning?tab=capacity", label: "Capacity Planning", tab: "capacity" },
          { to: "/planning?tab=newhire", label: "New Hire Planning", tab: "newhire" },
          { to: "/planning?tab=movement", label: "Agent Movement", tab: "movement" },
          { to: "/planning?tab=summary", label: "Summary", tab: "summary" },
        ],
      },
      { to: "/scenarios", label: "Scenario Studio", icon: FlaskConical, module: "scenarios" },
      { to: "/scheduling", label: "Scheduling", icon: CalendarRange, module: "scheduling" },
      { to: "/shift-patterns", label: "Shift Patterns", icon: CalendarClock, module: "shiftPatterns" },
      { to: "/swaps", label: "Shift Swaps", icon: Repeat, module: "swaps" },
    ],
  },
  {
    group: "Operate",
    items: [
      { to: "/intraday", label: "Intraday", icon: Clock, module: "intraday" },
      { to: "/rta", label: "Real-Time Monitor", icon: Activity, module: "realtime" },
      { to: "/approvals", label: "Approval Bridge", icon: CheckCheck, module: "approvals" },
      { to: "/adherence", label: "Adherence", icon: ClipboardCheck, module: "adherence" },
      { to: "/automation", label: "Automation Center", icon: Workflow, module: "automation" },
      { to: "/autonomy", label: "Autonomous Agents", icon: Bot, module: "automation" },
    ],
  },
  {
    group: "Workforce",
    items: [
      { to: "/employees", label: "Employees", icon: UsersRound, module: "employees" },
      { to: "/skills", label: "Skills", icon: Star, module: "skills" },
      { to: "/pto", label: "PTO & Leave", icon: PlaneTakeoff, module: "pto" },
    ],
  },
  {
    group: "Insights",
    items: [
      { to: "/reports", label: "Reports & KPIs", icon: BarChart3, module: "reports" },
      { to: "/copilot", label: "AI Copilot", icon: Sparkles, module: "copilot" },
      { to: "/help", label: "Methodology", icon: BookOpenText, module: "help" },
    ],
  },
  {
    group: "Admin",
    items: [
      { to: "/audit", label: "Audit Trail", icon: History, module: "audit" },
      { to: "/settings", label: "Settings & RBAC", icon: Settings, module: "settings" },
    ],
  },
]
