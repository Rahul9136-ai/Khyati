import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarClock } from "lucide-react"
import { useNavigate } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import { api } from "@/lib/api"

export interface ScheduleNotification {
  id: string
  kind: string
  title: string
  body: string
  link?: string | null
  read_at: string | null
  created_at: string
}

/** How often the pop-up checks for schedule news. */
export const SCHEDULE_POPUP_POLL_MS = 15_000

const isScheduleNews = (n: ScheduleNotification) => n.kind === "schedule_published" || n.kind === "schedule_changed"

/** Pops up on an agent's or team leader's screen, whatever page they're on,
 *  when their published schedule is published or changed (backend
 *  notifications of kind schedule_published / schedule_changed). Dismissing
 *  marks it read; repeated edits update the same notification server-side. */
export function SchedulePopup() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data = [] } = useQuery({
    queryKey: ["notifications", "unread"],
    queryFn: async () => (await api.get("/notifications", { params: { unread_only: true } })).data.data as ScheduleNotification[],
    refetchInterval: SCHEDULE_POPUP_POLL_MS,
  })
  const news = data.filter(isScheduleNews)
  const next = news[0] // newest first

  async function markRead(ids: string[]) {
    await Promise.all(ids.map((id) => api.post(`/notifications/${id}/read`)))
    void queryClient.invalidateQueries({ queryKey: ["notifications"] })
  }

  if (!next) return null
  const lines = next.body.split("\n").filter(Boolean)

  return (
    <Dialog
      open
      onClose={() => void markRead([next.id])}
      title={next.title}
      description={`${new Date(next.created_at).toLocaleString()}${news.length > 1 ? ` · 1 of ${news.length} schedule updates` : ""}`}
      footer={
        <>
          {news.length > 1 && (
            <Button variant="ghost" className="mr-auto" onClick={() => void markRead(news.map((n) => n.id))}>
              Dismiss all
            </Button>
          )}
          {next.link && (
            <Button
              variant="outline"
              onClick={() => {
                void markRead([next.id])
                navigate(next.link!)
              }}
            >
              View schedule
            </Button>
          )}
          <Button onClick={() => void markRead([next.id])}>Got it</Button>
        </>
      }
    >
      <div className="flex gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
        <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <ul className="space-y-1">
          {lines.map((l, i) => (
            <li key={i} className="whitespace-pre-wrap">{l}</li>
          ))}
        </ul>
      </div>
    </Dialog>
  )
}
