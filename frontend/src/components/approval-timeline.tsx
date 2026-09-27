import { Badge } from "@/components/ui/badge"
import type { Approval } from "@/lib/integrations"

const CHANNEL_LABEL: Record<string, string> = {
  slack: "Slack", teams: "Teams", in_app: "In-app", auto: "Automation",
}

function relTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

/** The append-only event trail for one approval (raised, dispatched, decided,
 * applied…) — shared between the Approval Bridge list's inline expansion and
 * the dedicated change-record page. */
export function ApprovalTimeline({ approval }: { approval: Approval }) {
  return (
    <div className="space-y-1.5 border-l-2 border-border pl-3">
      {(approval.events ?? []).map((e, i) => (
        <div key={i} className="flex items-start gap-2 text-xs">
          <span className="mt-0.5 font-mono text-muted-foreground">{relTime(e.at).split(", ")[1] ?? ""}</span>
          <Badge variant="outline" className="shrink-0">{e.type}</Badge>
          {e.channel && (
            <span className="shrink-0 text-muted-foreground">
              via {CHANNEL_LABEL[e.channel] ?? e.channel}
            </span>
          )}
          <span className="text-muted-foreground">{e.detail}</span>
        </div>
      ))}
      {(approval.events ?? []).length === 0 && (
        <p className="text-xs text-muted-foreground">No timeline events yet.</p>
      )}
    </div>
  )
}
