import { useEffect, useState } from "react"

import { SkillPriorityEditor } from "@/components/skill-priority-editor"
import { Button } from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import type { Agent } from "@/lib/domain/types"
import { useWfm } from "@/store/wfm"

/** Edit an existing agent's skills + priority order. Shared by Employees and Skills pages. */
export function AgentSkillsDialog({ agent, open, onClose }: { agent: Agent | null; open: boolean; onClose: () => void }) {
  const { setAgentSkills } = useWfm()
  const [draft, setDraft] = useState<string[]>([])

  useEffect(() => {
    if (agent) setDraft(agent.skills)
  }, [agent])

  if (!agent) return null

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Skills — ${agent.name}`}
      description="Order sets priority — the top skill is this agent's primary."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => {
              setAgentSkills(agent.id, draft)
              onClose()
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <SkillPriorityEditor skills={draft} onChange={setDraft} />
    </Dialog>
  )
}
