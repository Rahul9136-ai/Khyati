import { useMemo, useState } from "react"
import { Check, Plus, Star } from "lucide-react"

import { AgentSkillsDialog } from "@/components/agent-skills-dialog"
import { ExportButton } from "@/components/export-button"
import { PageHeader } from "@/components/page-header"
import { PermissionGate } from "@/components/permission-gate"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { Agent } from "@/lib/domain/types"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

const ORDINAL = ["1st", "2nd", "3rd", "4th", "5th"]
const ordinal = (rank: number) => ORDINAL[rank] ?? `${rank + 1}th`

const COLOR_PRESETS = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#d946ef", "#84cc16", "#f472b6"]

export function Skills() {
  const { agents, queues, addQueue } = useWfm()
  const [editing, setEditing] = useState<Agent | null>(null)

  // add-skill form state
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [color, setColor] = useState(COLOR_PRESETS[0])
  const [aht, setAht] = useState(300)
  const [slTarget, setSlTarget] = useState(80)
  const [targetTime, setTargetTime] = useState(20)
  const [error, setError] = useState("")

  const coverage = useMemo(
    () =>
      queues.map((q) => {
        const skilled = agents.filter((a) => a.skills.includes(q.id))
        const primary = agents.filter((a) => a.skills[0] === q.id)
        return { q, count: skilled.length, primaryCount: primary.length, pct: skilled.length / agents.length }
      }),
    [agents, queues],
  )

  function resetForm() {
    setName("")
    setColor(COLOR_PRESETS[queues.length % COLOR_PRESETS.length])
    setAht(300)
    setSlTarget(80)
    setTargetTime(20)
    setError("")
  }

  function submit() {
    if (!name.trim()) return setError("Name is required.")
    if (queues.some((q) => q.name.toLowerCase() === name.trim().toLowerCase())) {
      return setError("A skill with that name already exists.")
    }
    addQueue({ name, color, aht, slTarget: slTarget / 100, targetTime })
    resetForm()
    setOpen(false)
  }

  return (
    <>
      <PageHeader
        title="Skills Management"
        subtitle="Skill coverage, priority & competency matrix"
        actions={
          <>
            <ExportButton
              filename="skills"
              sheets={() => [
                { name: "Coverage", rows: coverage.map((c) => ({ Skill: c.q.name, "Skilled agents": c.count, "Primary for": c.primaryCount, "% of workforce": `${Math.round(c.pct * 100)}%`, AHT: `${c.q.aht}s` })) },
                {
                  name: "Skill Priority",
                  rows: agents.map((a) => ({ Agent: a.name, Team: a.team, "Skills (priority order)": a.skills.map((s, i) => `${i + 1}. ${queues.find((q) => q.id === s)?.name ?? s}`).join(", ") })),
                },
              ]}
            />
            <PermissionGate module="skills">
              <Button onClick={() => { resetForm(); setOpen(true) }}>
                <Plus className="h-4 w-4" /> Add skill
              </Button>
            </PermissionGate>
          </>
        }
      />

      <div className="mb-4 grid gap-4 md:grid-cols-3">
        {coverage.map(({ q, count, primaryCount, pct }) => (
          <Card key={q.id} className="glass">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="flex items-center gap-2">
                <span className="h-3 w-3 rounded" style={{ background: q.color }} /> {q.name}
              </CardTitle>
              <span className="text-2xl font-bold tabular-nums">{count}</span>
            </CardHeader>
            <CardContent>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: q.color }} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {Math.round(pct * 100)}% of workforce skilled · {primaryCount} primary · AHT {q.aht}s
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="glass">
        <CardHeader>
          <CardTitle>Competency matrix</CardTitle>
          <p className="text-sm text-muted-foreground">Rank reflects each agent's skill priority order. Click Edit to reassign or reorder.</p>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase">Agent</th>
                  {queues.map((q) => (
                    <th key={q.id} className="whitespace-nowrap px-3 py-2 text-xs font-semibold uppercase">{q.name}</th>
                  ))}
                  <th className="px-3 py-2 text-xs font-semibold uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id} className="border-b hover:bg-muted/30">
                    <td className="px-3 py-2 font-medium">{a.name}</td>
                    {queues.map((q) => {
                      const rank = a.skills.indexOf(q.id)
                      const has = rank !== -1
                      return (
                        <td key={q.id} className="px-3 py-2 text-center">
                          {has ? (
                            <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", rank === 0 ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>
                              <Check className="h-3 w-3" /> {ordinal(rank)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>
                      )
                    })}
                    <td className="px-3 py-2 text-right">
                      <PermissionGate module="skills" fallback={<span className="text-xs text-muted-foreground">—</span>}>
                        <Button variant="ghost" size="sm" onClick={() => setEditing(a)}>
                          <Star className="h-3.5 w-3.5" /> Edit
                        </Button>
                      </PermissionGate>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <AgentSkillsDialog agent={editing} open={!!editing} onClose={() => setEditing(null)} />

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add skill"
        description="New skills appear immediately in Employees, the competency matrix, and the queue picker — with their own forecast and Erlang C staffing."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit}><Plus className="h-4 w-4" /> Add skill</Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Skill / LOB name</span>
            <Input value={name} onChange={(e) => { setName(e.target.value); setError("") }} placeholder="e.g. Retentions" autoFocus />
          </label>

          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Colour</span>
            <div className="flex flex-wrap gap-2">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={cn("h-7 w-7 rounded-full ring-offset-2 ring-offset-card transition-shadow", color === c && "ring-2 ring-foreground")}
                  style={{ background: c }}
                  aria-label={`Colour ${c}`}
                />
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">AHT (seconds)</span>
              <Input type="number" min={30} step={10} value={aht} onChange={(e) => setAht(+e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">SL target (%)</span>
              <Input type="number" min={50} max={99} value={slTarget} onChange={(e) => setSlTarget(+e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Within (s)</span>
              <Input type="number" min={5} step={5} value={targetTime} onChange={(e) => setTargetTime(+e.target.value)} />
            </label>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </Dialog>
    </>
  )
}
