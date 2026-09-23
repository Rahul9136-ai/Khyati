import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowDown, ArrowRight, Clock, Plus, Trash2, Workflow } from "lucide-react"
import { useMemo, useState } from "react"

import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  createBatch, deleteBatch, getConfig, getPipeline, listBatches, monthLabel,
  type PipelineStage,
} from "@/lib/hcplanning"
import { cn } from "@/lib/utils"

export function NewHireTab({
  lobId, onGoToCapacity, requiredHc,
}: { lobId: string; onGoToCapacity?: () => void; requiredHc?: number }) {
  const qc = useQueryClient()
  const [hireDate, setHireDate] = useState("")
  const [hires, setHires] = useState("")

  const { data: batches = [] } = useQuery({
    queryKey: ["planning-batches", lobId], queryFn: () => listBatches(lobId), enabled: !!lobId,
  })
  const { data: pipeline = [] } = useQuery({
    queryKey: ["planning-pipeline", lobId], queryFn: () => getPipeline(lobId), enabled: !!lobId,
  })
  const { data: cfg } = useQuery({
    queryKey: ["planning-config", lobId], queryFn: () => getConfig(lobId), enabled: !!lobId,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["planning-batches", lobId] })
    qc.invalidateQueries({ queryKey: ["planning-pipeline", lobId] })
    qc.invalidateQueries({ queryKey: ["planning-capacity", lobId] })
  }
  const add = useMutation({
    mutationFn: () => createBatch({ lob_id: lobId, hire_date: hireDate, planned_hires: +hires }),
    onSuccess: () => { setHireDate(""); setHires(""); refresh() },
  })
  const remove = useMutation({ mutationFn: (id: string) => deleteBatch(id), onSuccess: refresh })

  const totalProd = pipeline.reduce((s, p) => s + p.production, 0)
  const weeklyHours = cfg?.weekly_hours ?? 40
  const requiredScheduledHours = (requiredHc ?? 0) * weeklyHours
  const pipelineScheduledHours = totalProd * weeklyHours
  const pctOfScheduledHours = requiredScheduledHours > 0
    ? (pipelineScheduledHours / requiredScheduledHours) * 100
    : null

  return (
    <div className="space-y-4">
      <HiringFunnel pipeline={pipeline} cfg={cfg} onGoToCapacity={onGoToCapacity} />

      <Card className="glass">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Hiring → Training → Nesting → Production</CardTitle>
          <p className="text-xs text-muted-foreground">
            Throughput {cfg ? `${(cfg.hiring_throughput * 100).toFixed(0)}% hiring · ${(cfg.training_throughput * 100).toFixed(0)}% training` : "…"}
            {cfg ? ` · ${cfg.training_days}d training + ${cfg.nesting_days}d nesting` : ""}. Production feeds Ramp in Capacity Planning.
          </p>
        </CardHeader>
        <CardContent>
          <PermissionGate module="planning">
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Hire date</span>
                <Input type="date" value={hireDate} onChange={(e) => setHireDate(e.target.value)} className="h-9 w-40" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Planned hires</span>
                <Input type="number" min={0} value={hires} onChange={(e) => setHires(e.target.value)} className="h-9 w-28" />
              </label>
              <Button disabled={!hireDate || !hires || add.isPending} onClick={() => add.mutate()}>
                <Plus className="h-4 w-4" /> Add batch
              </Button>
            </div>
          </PermissionGate>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hire date</TableHead>
                <TableHead className="text-right">Planned</TableHead>
                <TableHead className="text-right">Successful (×hiring)</TableHead>
                <TableHead className="text-right">In training (×training)</TableHead>
                <TableHead className="text-right">Production</TableHead>
                <TableHead>Prod. month</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pipeline.map((p, i) => (
                <TableRow key={i}>
                  <TableCell>{p.hire_date}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.planned_hires}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.successful_hires}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.entering_training}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums text-emerald-600">{p.production}</TableCell>
                  <TableCell>
                    <button type="button" onClick={onGoToCapacity} disabled={!onGoToCapacity}
                      className="disabled:cursor-default">
                      <Badge variant="outline" className={onGoToCapacity ? "cursor-pointer hover:bg-muted" : ""}>
                        {monthLabel(p.production_month)}
                      </Badge>
                    </button>
                  </TableCell>
                  <TableCell className="text-right">
                    <PermissionGate module="planning" fallback={null}>
                      <Button size="sm" variant="ghost" onClick={() => remove.mutate(batches[i]?.id)} disabled={!batches[i]}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </PermissionGate>
                  </TableCell>
                </TableRow>
              ))}
              {pipeline.length === 0 && (
                <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  No hiring batches yet. Add one above to build the pipeline.
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>

          {pipeline.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>Total new-hire production feeding Ramp:</span>
                <button type="button" onClick={onGoToCapacity} disabled={!onGoToCapacity} className="disabled:cursor-default">
                  <Badge variant="success" className={cn("flex items-center gap-1", onGoToCapacity && "cursor-pointer hover:opacity-90")}>
                    {totalProd} agents <ArrowRight className="h-3 w-3" /> Capacity Ramp
                  </Badge>
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                = {pipelineScheduledHours.toFixed(0)} scheduled hrs/week (× {weeklyHours}h).
                {pctOfScheduledHours !== null ? (
                  <>
                    {" "}That's{" "}
                    <span className={cn("font-semibold", pctOfScheduledHours >= 100 ? "text-emerald-600" : "text-foreground")}>
                      {pctOfScheduledHours.toFixed(0)}%
                    </span>{" "}
                    of this month's total required scheduled hours ({requiredScheduledHours.toFixed(0)} hrs, from
                    Required HC × weekly hours) — how much of the LOB's staffing requirement this pipeline alone covers.
                  </>
                ) : (
                  " Set demand in Capacity Planning to see this as a % of required scheduled hours."
                )}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** Live snapshot of headcount moving through the pipeline, aggregated across every
 *  batch: Hiring narrows the raw plan by hiring throughput, Training narrows it again
 *  by training throughput, Nesting holds that same headcount for its duration (no
 *  further loss modeled), and Production is what lands in Ramp. Mirrors the batch
 *  table's own columns — same numbers, read as a funnel instead of rows. */
function HiringFunnel({
  pipeline, cfg, onGoToCapacity,
}: {
  pipeline: PipelineStage[]
  cfg: { hiring_throughput: number; training_throughput: number; training_days: number; nesting_days: number } | undefined
  onGoToCapacity?: () => void
}) {
  const totals = useMemo(
    () => pipeline.reduce(
      (acc, p) => ({
        planned: acc.planned + p.planned_hires,
        hiring: acc.hiring + p.successful_hires,
        training: acc.training + p.entering_training,
        nesting: acc.nesting + p.entering_training,
        production: acc.production + p.production,
      }),
      { planned: 0, hiring: 0, training: 0, nesting: 0, production: 0 },
    ),
    [pipeline],
  )
  if (pipeline.length === 0) return null

  const max = Math.max(totals.planned, totals.hiring, totals.training, totals.nesting, totals.production, 1)
  // `intoNote`/`intoIcon` describe the transition that PRODUCES this stage's headcount
  // from the previous one, rendered as the connector directly above its bar.
  const stages: {
    key: "hiring" | "training" | "nesting" | "production"; label: string; color: string; goTo?: boolean
    intoNote: string; intoIcon: typeof Clock
  }[] = [
    {
      key: "hiring", label: "Hiring", color: "bg-sky-500",
      intoNote: `${totals.planned} planned × ${((cfg?.hiring_throughput ?? 0) * 100).toFixed(0)}% hiring throughput`, intoIcon: ArrowDown,
    },
    {
      key: "training", label: "Training", color: "bg-amber-500",
      intoNote: `× ${((cfg?.training_throughput ?? 0) * 100).toFixed(0)}% training throughput · ${cfg?.training_days ?? "…"}d`, intoIcon: ArrowDown,
    },
    {
      key: "nesting", label: "Nesting", color: "bg-violet-500",
      intoNote: `${cfg?.nesting_days ?? "…"}d ramp, same headcount`, intoIcon: Clock,
    },
    {
      key: "production", label: "Production", color: "bg-emerald-500", goTo: true,
      intoNote: "feeds Ramp in Capacity Planning", intoIcon: ArrowRight,
    },
  ]

  return (
    <Card className="glass">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm"><Workflow className="h-4 w-4 text-primary" /> Resource flow</CardTitle>
        <p className="text-xs text-muted-foreground">
          Current headcount at each stage of the pipeline, aggregated across every batch below.
        </p>
      </CardHeader>
      <CardContent className="space-y-1">
        {stages.map((s) => {
          const Icon = s.intoIcon
          const bar = (
            <div className="h-7 overflow-hidden rounded-md bg-muted">
              <div className={cn("flex h-full items-center rounded-md transition-all", s.color, s.goTo && onGoToCapacity && "hover:opacity-90")}
                style={{ width: `${Math.max(6, (totals[s.key] / max) * 100)}%` }} />
            </div>
          )
          return (
            <div key={s.key}>
              <div className="flex items-center gap-1 py-1 pl-1 text-[11px] text-muted-foreground">
                <Icon className="h-3 w-3" /> {s.intoNote}
              </div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="font-medium">{s.label}</span>
                <span className="tabular-nums text-muted-foreground">{totals[s.key]} agents</span>
              </div>
              {s.goTo && onGoToCapacity ? (
                <button type="button" onClick={onGoToCapacity} className="block w-full text-left">{bar}</button>
              ) : bar}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
