import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, Bell, Info, Zap } from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router-dom"

import { api } from "@/lib/api"
import type { AlertSeverity } from "@/lib/domain/alerts"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

interface Notification {
  id: string
  kind: string
  title: string
  body: string
  read_at: string | null
  created_at: string
}

const SEVERITY_ICON: Record<AlertSeverity, { icon: typeof Bell; cls: string }> = {
  critical: { icon: Zap, cls: "text-destructive" },
  warning: { icon: AlertTriangle, cls: "text-amber-600" },
  info: { icon: Info, cls: "text-primary" },
}

/** Live in-app notification center: backend GET /notifications merged with
 *  the WFM proactive-alerts engine (SL risk, adherence escalation, pending
 *  approvals) so operational conditions surface here from any page, not
 *  only when the relevant module happens to be open. */
export function NotificationsBell() {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const alerts = useWfm((s) => s.alerts)

  const { data: items = [] } = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => (await api.get("/notifications")).data.data as Notification[],
    refetchInterval: 60_000,
  })
  const unread = items.filter((n) => !n.read_at).length + alerts.length

  async function markRead(id: string) {
    await api.post(`/notifications/${id}/read`)
    void queryClient.invalidateQueries({ queryKey: ["notifications"] })
  }

  return (
    <div className="relative">
      <button
        className="relative grid h-9 w-9 place-items-center rounded-md hover:bg-accent"
        aria-label="Notifications"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[9px] font-bold text-white">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-30 mt-2 w-80 overflow-hidden rounded-lg border bg-card shadow-xl">
            <div className="border-b px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Notifications {unread > 0 && `· ${unread} unread`}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {items.length === 0 && alerts.length === 0 && (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                  Nothing here yet — schedule publishes, request decisions, and live WFM alerts land in this inbox.
                </p>
              )}
              {alerts.length > 0 && (
                <div className="border-b px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  Live WFM alerts
                </div>
              )}
              {alerts.map((a) => {
                const S = SEVERITY_ICON[a.severity]
                return (
                  <button
                    key={a.id}
                    onClick={() => { navigate(a.to); setOpen(false) }}
                    className="flex w-full items-start gap-2 border-b bg-primary/5 px-4 py-2.5 text-left text-xs transition-colors last:border-0 hover:bg-accent"
                  >
                    <S.icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", S.cls)} />
                    <span className="min-w-0">
                      <span className="block font-medium">{a.title}</span>
                      <span className="mt-0.5 block text-muted-foreground">{a.detail}</span>
                    </span>
                  </button>
                )
              })}
              {items.length > 0 && (
                <div className="border-b px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  Inbox
                </div>
              )}
              {items.slice(0, 12).map((n) => (
                <button
                  key={n.id}
                  onClick={() => void markRead(n.id)}
                  className={cn(
                    "block w-full border-b px-4 py-2.5 text-left text-xs transition-colors last:border-0 hover:bg-accent",
                    !n.read_at && "bg-primary/5",
                  )}
                >
                  <span className="flex items-center gap-2 font-medium">
                    {!n.read_at && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                    {n.title}
                  </span>
                  {n.body && <span className="mt-0.5 block text-muted-foreground">{n.body}</span>}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
