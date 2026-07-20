import { useMemo } from "react"
import { AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

/** Stable identity key for "who is looking at the screen right now" in this
 *  single-session RBAC preview — an Agent is keyed by their specific record,
 *  everyone else by their designation. */
function viewerKey(currentRole: string, currentAgentId: string): string {
  return currentRole === "Agent" ? `agent:${currentAgentId}` : `role:${currentRole}`
}

/** Proactive popup for TeamMessages — mounted once at the app root so a
 *  message a Team Leader/WFM Manager sends interrupts whatever page the
 *  recipient is on, instead of waiting to be noticed in the bell dropdown. */
export function MessagePopup() {
  const { messages, currentRole, currentAgentId, agents, dismissMessage } = useWfm()
  const key = viewerKey(currentRole, currentAgentId)
  const myTeam = useMemo(() => agents.find((a) => a.id === currentAgentId)?.team, [agents, currentAgentId])

  const next = useMemo(() => {
    return [...messages]
      .filter((m) => !m.dismissedBy.includes(key))
      .filter((m) => {
        if (m.audience === "all") return true
        if (m.audience === "team") return currentRole === "Agent" && m.team === myTeam
        if (m.audience === "agent") return currentRole === "Agent" && m.agentId === currentAgentId
        return false
      })
      .sort((a, b) => b.ts - a.ts)[0]
  }, [messages, key, currentRole, currentAgentId, myTeam])

  if (!next) return null

  return (
    <Dialog
      open
      onClose={() => dismissMessage(next.id, key)}
      title={next.urgent ? "Urgent message" : "New message"}
      description={`From ${next.fromName} · ${next.fromRole} · ${new Date(next.ts).toLocaleString()}`}
      footer={<Button onClick={() => dismissMessage(next.id, key)}>Got it</Button>}
    >
      <div className={cn("rounded-lg border p-3 text-sm", next.urgent && "border-destructive/40 bg-destructive/5")}>
        {next.urgent && (
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" /> Urgent
          </div>
        )}
        <p className="whitespace-pre-wrap">{next.text}</p>
      </div>
    </Dialog>
  )
}
