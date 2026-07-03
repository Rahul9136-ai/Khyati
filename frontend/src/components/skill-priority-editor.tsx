import { ChevronDown, ChevronUp, X } from "lucide-react"

import { useWfm } from "@/store/wfm"

/**
 * Ordered skill list with rank badges + reorder/remove controls, plus an
 * "add skill" row for skills not yet assigned. Order = priority: index 0 is
 * the agent's primary skill. Shared by the Add Employee dialog and the Skills
 * page's per-agent priority editor. Reads the (extensible) skill/queue list
 * from the store so custom skills added via Skills → Add skill show up here too.
 */
export function SkillPriorityEditor({ skills, onChange }: { skills: string[]; onChange: (next: string[]) => void }) {
  const queues = useWfm((s) => s.queues)
  const available = queues.filter((q) => !skills.includes(q.id))

  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= skills.length) return
    const next = [...skills]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const remove = (id: string) => onChange(skills.filter((s) => s !== id))
  const add = (id: string) => onChange([...skills, id])

  return (
    <div className="space-y-2">
      {skills.length === 0 && <p className="text-sm text-muted-foreground">No skills assigned yet — add one below.</p>}
      {skills.map((id, i) => {
        const q = queues.find((qq) => qq.id === id)
        return (
          <div key={id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-bold text-primary">{i + 1}</span>
            <span className="flex-1 text-sm font-medium">{q?.name ?? id}</span>
            {i === 0 && <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">primary</span>}
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30" aria-label="Move up">
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === skills.length - 1} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30" aria-label="Move down">
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => remove(id)} className="rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive" aria-label="Remove skill">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
      {available.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {available.map((q) => (
            <button
              key={q.id}
              type="button"
              onClick={() => add(q.id)}
              className="rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              + {q.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
