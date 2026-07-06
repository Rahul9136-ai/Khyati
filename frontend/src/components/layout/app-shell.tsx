import { LogOut, Search } from "lucide-react"
import { NavLink } from "react-router-dom"

import { NotificationsBell } from "@/components/layout/notifications-bell"
import { QueuePicker } from "@/components/layout/queue-picker"
import { SephoraLogo } from "@/components/sephora-logo"
import { ThemeToggle } from "@/components/theme-toggle"
import { Select } from "@/components/ui/select"
import { NAV } from "@/config/nav"
import { initialsOf } from "@/lib/auth"
import type { ModuleId } from "@/lib/domain/roles"
import { effectiveLevel, ROLES } from "@/lib/domain/roles"
import { cn } from "@/lib/utils"
import { useAuth } from "@/store/auth"
import { useWfm } from "@/store/wfm"

export function AppShell({ children }: { children: React.ReactNode }) {
  const permissions = useWfm((s) => s.permissions)
  const currentRole = useWfm((s) => s.currentRole)
  const setCurrentRole = useWfm((s) => s.setCurrentRole)
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)
  const visible = (moduleId: ModuleId) => effectiveLevel(permissions, currentRole, moduleId) !== "none"

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card/40 backdrop-blur-xl md:flex">
        <div className="flex h-14 items-center border-b px-5">
          <div className="flex flex-col gap-0.5">
            <SephoraLogo size="sm" orientation="horizontal" />
            <span className="pl-4 text-[9px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Workforce Mgmt
            </span>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto p-3">
          {NAV.map((g) => {
            const items = g.items.filter((it) => visible(it.module))
            if (items.length === 0) return null
            return (
              <div key={g.group} className="mb-3">
                <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {g.group}
                </p>
                {items.map((it) => (
                  <NavLink
                    key={it.to}
                    to={it.to}
                    end={it.to === "/"}
                    className={({ isActive }) =>
                      cn(
                        "mb-0.5 flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-primary/15 text-primary"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )
                    }
                  >
                    <it.icon className="h-4 w-4" />
                    {it.label}
                  </NavLink>
                ))}
              </div>
            )
          })}
        </nav>
        <div className="border-t p-4 text-[11px] text-muted-foreground">
          Powered by FlowForce WFM
          <br />
          v0.1 · Erlang-C engine · 5 models
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-card/60 px-5 backdrop-blur-xl">
          <div className="relative hidden max-w-xs flex-1 items-center md:flex">
            <Search className="absolute left-3 h-4 w-4 text-muted-foreground" />
            <input
              placeholder="Search…"
              className="h-8 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
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
    </div>
  )
}
