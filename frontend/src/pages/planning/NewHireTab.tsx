import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, Plus, Trash2 } from "lucide-react"
import { useState } from "react"

import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  createBatch, deleteBatch, getConfig, getPipeline, listBatches, monthLabel,
} from "@/lib/hcplanning"

export function NewHireTab({ lobId }: { lobId: string }) {
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

  return (
    <div className="space-y-4">
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
                  No hiring batches yet. Add one above to build the pipeline.
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
