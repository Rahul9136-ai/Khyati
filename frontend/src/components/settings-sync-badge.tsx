import { AlertTriangle, CheckCircle2, CloudOff, Loader2 } from "lucide-react"

import { useSettingsSync } from "@/lib/settingsSync"
import { cn } from "@/lib/utils"

/** Whether work rules / week offs are saved for everyone, or only in this browser. */
export function SettingsSyncBadge() {
  const { status, message, lastSyncedAt } = useSettingsSync()
  const at = lastSyncedAt ? new Date(lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null
  const view = {
    idle: { icon: CloudOff, text: "Not connected — saved in this browser", tone: "text-muted-foreground" },
    loading: { icon: Loader2, text: "Loading from server…", tone: "text-primary" },
    saving: { icon: Loader2, text: "Saving…", tone: "text-primary" },
    synced: { icon: CheckCircle2, text: `Saved for everyone${at ? ` · ${at}` : ""}`, tone: "text-emerald-600 dark:text-emerald-400" },
    readonly: { icon: CheckCircle2, text: "Up to date (view only)", tone: "text-muted-foreground" },
    offline: { icon: CloudOff, text: "Offline — saved in this browser", tone: "text-amber-600" },
    conflict: { icon: AlertTriangle, text: "Changed elsewhere — reloaded", tone: "text-amber-600" },
  }[status]
  const Icon = view.icon
  return (
    <span role="status" title={message ?? view.text} className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", view.tone)}>
      <Icon className={cn("h-3.5 w-3.5", (status === "loading" || status === "saving") && "animate-spin")} />
      {view.text}
    </span>
  )
}
