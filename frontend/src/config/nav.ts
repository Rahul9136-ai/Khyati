import {
  Activity,
  BarChart3,
  BookOpenText,
  Bot,
  CalendarCheck,
  CalendarClock,
  CheckCheck,
  ClipboardList,
  CalendarRange,
  ClipboardCheck,
  Clock,
  FlaskConical,
  Gauge,
  History,
  LayoutDashboard,
  LineChart,
  Mail,
  Repeat,
  type LucideIcon,
  PlaneTakeoff,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  TrendingUp,
  UsersRound,
  Workflow,
} from "lucide-react"

import type { ModuleId } from "@/lib/domain/roles"

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  module: ModuleId
}

export interface NavGroup {
  /** Main section shown in the sidebar, e.g. "Planning". */
  group: string
  /** Icon for the main section. */
  icon: LucideIcon
  /** One line under the section name when it's open. */
  hint?: string
  /** Pages inside the section (the sub-tabs shown after clicking it). */
  items: NavItem[]
  /** A section that is just one page: clicking it opens the page directly. */
  direct?: boolean
}

export const NAV: NavGroup[] = [
  {
    group: "Dashboard",
    icon: LayoutDashboard,
    direct: true,
    items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard, module: "dashboard" }],
  },
  {
    group: "Planning",
    icon: CalendarRange,
    hint: "Forecast, capacity and schedules",
    items: [
      { to: "/forecasting", label: "Forecasting", icon: TrendingUp, module: "forecasting" },
      { to: "/planning", label: "Capacity Planning", icon: Gauge, module: "planning" },
      { to: "/scenarios", label: "Scenario Studio", icon: FlaskConical, module: "scenarios" },
      { to: "/scheduling", label: "Scheduling", icon: CalendarRange, module: "scheduling" },
      { to: "/shift-patterns", label: "Shift Patterns", icon: CalendarClock, module: "shiftPatterns" },
      { to: "/work-rules", label: "Work Rules", icon: CalendarCheck, module: "shiftPatterns" },
      { to: "/swaps", label: "Shift Swaps", icon: Repeat, module: "swaps" },
    ],
  },
  {
    group: "Operations",
    icon: Activity,
    hint: "Run the day in real time",
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
    icon: UsersRound,
    hint: "People, skills and leave",
    items: [
      { to: "/employees", label: "Employees", icon: UsersRound, module: "employees" },
      { to: "/hc-tracker", label: "HC Tracker", icon: ClipboardList, module: "employees" },
      { to: "/skills", label: "Skills", icon: Star, module: "skills" },
      { to: "/pto", label: "PTO & Leave", icon: PlaneTakeoff, module: "pto" },
    ],
  },
  {
    group: "Reports & Insights",
    icon: LineChart,
    hint: "KPIs, reports and AI",
    items: [
      { to: "/reports", label: "Reports & KPIs", icon: BarChart3, module: "reports" },
      { to: "/scheduled-reports", label: "Scheduled Reports", icon: Mail, module: "reports" },
      { to: "/copilot", label: "AI Copilot", icon: Sparkles, module: "copilot" },
      { to: "/help", label: "Methodology", icon: BookOpenText, module: "help" },
    ],
  },
  {
    group: "Administration",
    icon: ShieldCheck,
    hint: "Audit, settings and access",
    items: [
      { to: "/audit", label: "Audit Trail", icon: History, module: "audit" },
      { to: "/settings", label: "Settings & RBAC", icon: Settings, module: "settings" },
    ],
  },
]

/** The section and page for a path (for the sidebar and the breadcrumb). */
export function findNav(pathname: string): { group: NavGroup; item: NavItem } | null {
  let best: { group: NavGroup; item: NavItem } | null = null
  for (const group of NAV)
    for (const item of group.items) {
      const hit = item.to === "/" ? pathname === "/" : pathname === item.to || pathname.startsWith(`${item.to}/`)
      if (hit && (!best || item.to.length > best.item.to.length)) best = { group, item }
    }
  return best
}
