import {
  Activity,
  BarChart3,
  CalendarClock,
  CalendarRange,
  Calculator,
  Clock,
  FlaskConical,
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
} from "lucide-react"

import type { ModuleId } from "@/lib/domain/roles"

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  module: ModuleId
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
      { to: "/capacity", label: "Capacity Planning", icon: BarChart3, module: "capacity" },
      { to: "/erlang", label: "Erlang Calculator", icon: Calculator, module: "erlang" },
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
