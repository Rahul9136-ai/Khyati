import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Bell } from "lucide-react"
import { useState } from "react"

import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

interface Notification {
  id: string
  kind: string
  title: string
  body: string
  read_at: string | null
  created_at: string
}

/** Live in-app notification center backed by GET /notifications. */
export function NotificationsBell() {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()

  const { data: items = [] } = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => (await api.get("/notifications")).data.data as Notification[],
    refetchInterval: 60_000,
  })
  const unread = items.filter((n) => !n.read_at).length

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
            <div className="max-h-80 overflow-y-auto">
              {items.length === 0 && (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                  Nothing here yet — schedule publishes and request decisions land in this inbox.
                </p>
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
