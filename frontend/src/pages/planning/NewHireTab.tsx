import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, Plus, Target, Trash2, Workflow } from "lucide-react"
import { useMemo, useState } from "react"

import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  type CapacityTable, createBatch, deleteBatch, getConfig, getPipeline, listBatches, monthLabel,
} from "@/lib/hcplanning"

export function NewHireTab({ lobId, capacity }: { lobId: string; capacity?: CapacityTable }) {
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
    mutationFn: (v?: { hire_date: string; planned_hires: number }) =>
      createBatch({ lob_id: lobId, hire_date: v?.hire_date ?? hireDate, planned_hires: v?.planned_hires ?? +hires }),
    onSuccess: () => { setHireDate(""); setHires(""); refresh() },
  })
  const remove = useMutation({ mutationFn: (id: string) => deleteBatch(id), onSuccess: refresh })

  // Phase 1 — hiring requirement from the capacity gap (Required − Closing).
  const yieldRate = (cfg?.hiring_throughput ?? 0.9) * (cfg?.training_throughput ?? 0.95)
  const requirement = useMemo(() => {
    const rows = (capacity?.results ?? []).map((r) => {
      const gap = r.required_hc - r.closing_hc // positive ⇒ short
      const suggested = gap > 0 && yieldRate > 0 ? Math.ceil(gap / yieldRate) : 0
      return { month: r.month, required: r.required_hc, closing: r.closing_hc, gap, suggested }
    })
    return rows
  }, [capacity, yieldRate])
  const shortfalls = requirement.filter((r) => r.gap > 0.05)
  const totalSuggested = shortfalls.reduce((s, r) => s + r.suggested, 0)
  const totalProd = pipeline.reduce((s, p) => s + p.production, 0)

  return (
    <div className="space-y-4">
      {/* Phase 1 — Hiring requirement */}
      <Card className="glass">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm"><Target className="h-4 w-4 text-primary" /> Phase 1 · Hiring requirement</CardTitle>
          <p className="text-xs text-muted-foreground">
            Where Closing HC falls short of Required HC, this suggests how many to hire
            (grossed up for {(yieldRate * 100).toFixed(0)}% combined hiring × training yield).
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {shortfalls.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No capacity deficit in the current horizon — no hiring required.</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Required HC</TableHead>
                    <TableHead className="text-right">Closing HC</TableHead>
                    <TableHead className="text-right">Gap</TableHead>
                    <TableHead className="text-right">Suggested hires</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shortfalls.map((r) => (
                    <TableRow key={r.month}>
                      <TableCell>{monthLabel(r.month)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.required.toFixed(1)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.closing.toFixed(1)}</TableCell>
                      <TableCell className="text-right tabular-nums text-destructive">-{r.gap.toFixed(1)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{r.suggested}</TableCell>
                      <TableCell className="text-right">
                        <PermissionGate module="planning" fallback={null}>
                          <Button size="sm" variant="outline" disabled={add.isPending}
                            onClick={() => add.mutate({ hire_date: `${r.month}-01`, planned_hires: r.suggested })}>
                            <Plus className="h-3.5 w-3.5" /> Plan
                          </Button>
                        </PermissionGate>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="mt-2 text-xs text-muted-foreground">
                Total suggested hires to close the gap: <b>{totalSuggested}</b> across {shortfalls.length} month(s).
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Phase 2 — Pipeline */}
      <Card className="glass">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm"><Workflow className="h-4 w-4 text-primary" /> Phase 2 · Hiring → Training → Nesting → Production</CardTitle>
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
              <Button disabled={!hireDate || !hires || add.isPending} onClick={() => add.mutate(undefined)}>
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
                  <TableCell><Badge variant="outline">{monthLabel(p.production_month)}</Badge></TableCell>
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
                  No hiring batches yet. Add one above, or use “Plan” on a Phase 1 shortfall.
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>

          {pipeline.length > 0 && (
            <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <span>Total new-hire production feeding Ramp:</span>
              <Badge variant="success" className="flex items-center gap-1">
                {totalProd} agents <ArrowRight className="h-3 w-3" /> Capacity Ramp
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
