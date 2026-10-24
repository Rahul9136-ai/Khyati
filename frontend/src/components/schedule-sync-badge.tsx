import { AlertTriangle, CheckCircle2, CloudOff, Eye, Loader2, RefreshCw } from "lucide-react"

import { flush, pull, useScheduleSync, type SyncStatus } from "@/lib/scheduleSync"
import { cn } from "@/lib/utils"

const LOOK: Record<SyncStatus, { icon: typeof CheckCircle2; text: string; cls: string; spin?: boolean }> = {
  idle: { icon: CloudOff, text: "Not synced", cls: "text-muted-foreground" },
  loading: { icon: Loader2, text: "Loading…", cls: "text-muted-foreground", spin: true },
  saving: { icon: Loader2, text: "Saving…", cls: "text-muted-foreground", spin: true },
  synced: { icon: CheckCircle2, text: "Synced", cls: "text-emerald-600 dark:text-emerald-400" },
  readonly: { icon: Eye, text: "Synced (view only)", cls: "text-muted-foreground" },
  offline: { icon: CloudOff, text: "Offline — saved locally", cls: "text-amber-600 dark:text-amber-400" },
  conflict: { icon: AlertTriangle, text: "Updated from server", cls: "text-amber-600 dark:text-amber-400" },
}

/** Server-sync state of the schedules (see lib/scheduleSync.ts). */
export function ScheduleSyncBadge() {
  const { status, message, lastSyncedAt, planDate } = useScheduleSync()
  const look = LOOK[status]
  const Icon = look.icon
  const when = lastSyncedAt ? new Date(lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null
  const title = [
    message,
    planDate && `Schedules for ${planDate} are stored on the server.`,
    when && `Last synced ${when}.`,
  ].filter(Boolean).join(" ")
  return (
    <span aria-live="polite" data-sync-status={status} title={title || undefined} className={cn("flex items-center gap-1 text-xs", look.cls)}>
      <Icon className={cn("h-3.5 w-3.5", look.spin && "animate-spin")} />
      {look.text}
      {(status === "offline" || status === "conflict") && (
        <button
          type="button"
          className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          aria-label="Retry sync"
          title="Retry now"
          onClick={() => void flush().then(pull)}
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}
