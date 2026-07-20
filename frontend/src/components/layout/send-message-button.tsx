import { useMemo, useState } from "react"
import { AlertTriangle, MessageSquarePlus } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { CAN_SEND_MESSAGE } from "@/lib/domain/roles"
import type { MessageAudience } from "@/store/wfm"
import { useWfm } from "@/store/wfm"

const AUDIENCE_LABEL: Record<MessageAudience, string> = {
  agent: "One agent",
  team: "A whole team",
  all: "Everyone",
}

/** Topbar entry point for Team Leaders / the WFM Manager to push a message
 *  that pops up on screen for the recipient(s) — see message-popup.tsx. */
export function SendMessageButton() {
  const { currentRole, currentUser, agents, messages, sendMessage } = useWfm()
  const teams = useMemo(() => [...new Set(agents.map((a) => a.team))], [agents])
  const [open, setOpen] = useState(false)
  const [audience, setAudience] = useState<MessageAudience>("agent")
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "")
  const [team, setTeam] = useState(teams[0] ?? "")
  const [text, setText] = useState("")
  const [urgent, setUrgent] = useState(false)
  const [error, setError] = useState("")

  const sentByMe = messages.filter((m) => m.fromName === currentUser).slice(0, 5)

  function reset() {
    setAudience("agent")
    setAgentId(agents[0]?.id ?? "")
    setTeam(teams[0] ?? "")
    setText("")
    setUrgent(false)
    setError("")
  }

  function submit() {
    if (!text.trim()) return setError("Write a message first.")
    if (audience === "agent" && !agentId) return setError("Pick who this goes to.")
    if (audience === "team" && !team) return setError("Pick a team.")
    sendMessage({ audience, agentId: audience === "agent" ? agentId : undefined, team: audience === "team" ? team : undefined, text: text.trim(), urgent })
    reset()
    setOpen(false)
  }

  if (!CAN_SEND_MESSAGE.includes(currentRole)) return null

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => { reset(); setOpen(true) }}>
        <MessageSquarePlus className="h-4 w-4" /> Send message
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Send a message"
        description="Pops up on screen for the recipient(s) as soon as they're on the app — not just a bell notification."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit}><MessageSquarePlus className="h-4 w-4" /> Send</Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Send to</span>
            <Select
              value={audience}
              onChange={(e) => { setAudience(e.target.value as MessageAudience); setError("") }}
              options={(Object.keys(AUDIENCE_LABEL) as MessageAudience[]).map((a) => ({ value: a, label: AUDIENCE_LABEL[a] }))}
              className="w-full"
            />
          </label>

          {audience === "agent" && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Agent</span>
              <Select value={agentId} onChange={(e) => { setAgentId(e.target.value); setError("") }} options={agents.map((a) => ({ value: a.id, label: `${a.name} · ${a.team}` }))} className="w-full" />
            </label>
          )}
          {audience === "team" && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Team</span>
              <Select value={team} onChange={(e) => { setTeam(e.target.value); setError("") }} options={teams.map((t) => ({ value: t, label: `Team ${t}` }))} className="w-full" />
            </label>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Message</span>
            <Textarea value={text} onChange={(e) => { setText(e.target.value); setError("") }} placeholder="e.g. Huddle in 10 minutes about tomorrow's coverage plan." rows={4} />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} className="h-4 w-4 rounded border-input" />
            Mark as urgent
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {sentByMe.length > 0 && (
            <div className="border-t pt-3">
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Recently sent</p>
              <div className="max-h-32 space-y-1.5 overflow-auto pr-1">
                {sentByMe.map((m) => (
                  <div key={m.id} className="flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs">
                    {m.urgent && <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />}
                    <div className="min-w-0 flex-1">
                      <span className="font-medium">
                        {m.audience === "agent" ? (agents.find((a) => a.id === m.agentId)?.name ?? "agent") : m.audience === "team" ? `Team ${m.team}` : "Everyone"}
                      </span>
                      <span className="text-muted-foreground"> · {m.text}</span>
                    </div>
                    {m.dismissedBy.length > 0 && <Badge variant="secondary">seen</Badge>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Dialog>
    </>
  )
}
