import { AlertTriangle, CheckCircle2, CloudOff, Loader2 } from "lucide-react"

import { useWorkspaceSync } from "@/lib/workspaceSync"
import { cn } from "@/lib/utils"

/** Top-bar indicator: is what I've added saved on the server? */
export function SaveStatus() {
  const { status, message, lastSavedAt } = useWorkspaceSync()
  if (status === "idle") return null
  const v = {
    loading: { icon: Loader2, text: "Loading…", cls: "text-muted-foreground", tip: "Loading your organisation's data" },
    saving: { icon: Loader2, text: "Saving…", cls: "text-sky-600 dark:text-sky-400", tip: "Saving your changes" },
    saved: { icon: CheckCircle2, text: "All changes saved", cls: "text-emerald-600 dark:text-emerald-400", tip: "Everything you add is saved for your organisation and stays until it's removed, on every browser and device." },
    offline: { icon: CloudOff, text: "Offline", cls: "text-amber-600 dark:text-amber-400", tip: "" },
    conflict: { icon: AlertTriangle, text: "Updated by someone else", cls: "text-amber-600 dark:text-amber-400", tip: "" },
  }[status]
  const Icon = v.icon
  return (
    <span
      role="status"
      aria-label="Save status"
      title={[message ?? v.tip, lastSavedAt ? `Last saved ${new Date(lastSavedAt).toLocaleTimeString()}` : ""].filter(Boolean).join(" · ")}
      className={cn("hidden items-center gap-1.5 whitespace-nowrap text-xs font-medium lg:inline-flex", v.cls)}
    >
      <Icon className={cn("h-4 w-4", (status === "loading" || status === "saving") && "animate-spin")} />
      {v.text}
    </span>
  )
}
