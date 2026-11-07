import { LogOut } from "lucide-react"

import { GlobalSearch } from "@/components/layout/global-search"
import { MessagePopup } from "@/components/layout/message-popup"
import { NotificationsBell } from "@/components/layout/notifications-bell"
import { QueuePicker } from "@/components/layout/queue-picker"
import { SchedulePopup } from "@/components/layout/schedule-popup"
import { SendMessageButton } from "@/components/layout/send-message-button"
import { Breadcrumb, Sidebar } from "@/components/layout/sidebar"
import { ThemeToggle } from "@/components/theme-toggle"
import { Select } from "@/components/ui/select"
import { initialsOf } from "@/lib/auth"
import { METHODS } from "@/lib/domain/forecast"
import type { ModuleId } from "@/lib/domain/roles"
import { effectiveLevel, ROLES } from "@/lib/domain/roles"
import { useAuth } from "@/store/auth"
import { useWfm } from "@/store/wfm"

export function AppShell({ children }: { children: React.ReactNode }) {
  const permissions = useWfm((s) => s.permissions)
  const currentRole = useWfm((s) => s.currentRole)
  const setCurrentRole = useWfm((s) => s.setCurrentRole)
  const agents = useWfm((s) => s.agents)
  const currentAgentId = useWfm((s) => s.currentAgentId)
  const setCurrentAgentId = useWfm((s) => s.setCurrentAgentId)
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)
  const visible = (moduleId: ModuleId) => effectiveLevel(permissions, currentRole, moduleId) !== "none"

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar
        canSee={(it) => visible(it.module)}
        footer={<><p className="font-medium text-foreground/80">Powered by FlowForce WFM</p><p>v0.1 · Erlang-C engine · {METHODS.length} models</p></>}
      />

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-card/60 px-5 backdrop-blur-xl">
          <Breadcrumb />
          <GlobalSearch />
          <div className="flex-1" />
          <QueuePicker />
          {user?.is_superuser && (
            <div className="hidden lg:block" title="Superuser: simulate any designation to preview access">
              <Select
                value={currentRole}
                onChange={(e) => setCurrentRole(e.target.value as typeof currentRole)}
                options={ROLES.map((r) => ({ value: r, label: r }))}
                className="h-8 text-[11px]"
              />
            </div>
          )}
          {user?.is_superuser && currentRole === "Agent" && (
            <div className="hidden lg:block" title="Which agent record the self-service view is scoped to">
              <Select
                value={currentAgentId}
                onChange={(e) => setCurrentAgentId(e.target.value)}
                options={agents.map((a) => ({ value: a.id, label: `${a.name} · ${a.team}` }))}
                className="h-8 text-[11px]"
              />
            </div>
          )}
          <SendMessageButton />
          <NotificationsBell />
          <ThemeToggle />
          {user && (
            <div className="flex items-center gap-2">
              <div
                className="grid h-8 w-8 place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary"
                title={`${user.full_name || user.email} · ${currentRole}`}
              >
                {initialsOf(user)}
              </div>
              <div className="hidden leading-tight xl:block">
                <p className="max-w-[140px] truncate text-xs font-medium">{user.full_name || user.email}</p>
                <p className="text-[10px] text-muted-foreground">{currentRole}</p>
              </div>
              <button
                onClick={() => void logout()}
                className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          )}
        </header>
        <main className="flex-1 p-5 lg:p-6">{children}</main>
      </div>

      <MessagePopup />
      <SchedulePopup />
    </div>
  )
}
