import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRightLeft } from "lucide-react"

import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { type Lob, listAgents, updateProfile } from "@/lib/hcplanning"

export function MovementTab({ lobId, lobs }: { lobId: string; lobs: Lob[] }) {
  const qc = useQueryClient()
  const { data: agents = [] } = useQuery({
    queryKey: ["planning-agents", lobId], queryFn: () => listAgents(lobId), enabled: !!lobId,
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["planning-agents", lobId] })
    qc.invalidateQueries({ queryKey: ["planning-capacity", lobId] })
  }
  const save = useMutation({
    mutationFn: (v: { id: string; body: Record<string, string | null> }) => updateProfile(v.id, v.body),
    onSuccess: refresh,
  })
  const lobName = (id: string | null) => lobs.find((l) => l.id === id)?.name ?? "—"

  return (
    <Card className="glass">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm"><ArrowRightLeft className="h-4 w-4 text-primary" /> Agent Movement</CardTitle>
        <p className="text-xs text-muted-foreground">
          Plan move-out / move-in across LOBs. Between move-out and move-in an agent is in transition
          and counts against no LOB; from move-in it counts toward the target LOB — reflected live in Capacity.
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Home LOB</TableHead>
              <TableHead>Move-out</TableHead>
              <TableHead>Move-in</TableHead>
              <TableHead>Target LOB</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agents.map((a) => (
              <TableRow key={a.employee_id}>
                <TableCell className="font-medium">{a.name}</TableCell>
                <TableCell><Badge variant="outline">{a.planning_status}</Badge></TableCell>
                <TableCell className="text-muted-foreground">{lobName(a.lob_id)}</TableCell>
                <TableCell>
                  <PermissionGate module="planning" fallback={<span>{a.move_out_date ?? "—"}</span>}>
                    <Input type="date" defaultValue={a.move_out_date ?? ""} className="h-8 w-36"
                      onBlur={(e) => e.target.value !== (a.move_out_date ?? "") &&
                        save.mutate({ id: a.employee_id, body: { move_out_date: e.target.value || null } })} />
                  </PermissionGate>
                </TableCell>
                <TableCell>
                  <PermissionGate module="planning" fallback={<span>{a.move_in_date ?? "—"}</span>}>
                    <Input type="date" defaultValue={a.move_in_date ?? ""} className="h-8 w-36"
                      onBlur={(e) => e.target.value !== (a.move_in_date ?? "") &&
                        save.mutate({ id: a.employee_id, body: { move_in_date: e.target.value || null } })} />
                  </PermissionGate>
                </TableCell>
                <TableCell>
                  <PermissionGate module="planning" fallback={<span>{lobName(a.target_lob_id)}</span>}>
                    <Select value={a.target_lob_id ?? ""}
                      onChange={(e) => save.mutate({ id: a.employee_id, body: { target_lob_id: e.target.value || null } })}
                      options={[{ value: "", label: "—" }, ...lobs.map((l) => ({ value: l.id, label: l.name }))]} />
                  </PermissionGate>
                </TableCell>
              </TableRow>
            ))}
            {agents.length === 0 && (
              <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No agents in this LOB.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
