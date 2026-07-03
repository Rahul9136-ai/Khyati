import { useMemo } from "react"
import { ArrowRight, BellRing, CheckCircle2, PhoneIncoming, Zap } from "lucide-react"

import { PermissionGate } from "@/components/permission-gate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { recommendActions, type HealAction } from "@/lib/domain/heal"
import { fmtPct } from "@/lib/domain/planning"
import { useWfm } from "@/store/wfm"

/** "Self-healing intraday" — the copilot proposes concrete recovery actions
 *  for at-risk queues; one click executes them through the real store. */
export function CopilotActions() {
  const { queues, forecasts, shrinkage, agents, rta, nowIdx, recallMany, logAudit } = useWfm()

  const actions = useMemo(
    () => recommendActions(queues, forecasts, shrinkage, agents, rta, nowIdx),
    [queues, forecasts, shrinkage, agents, rta, nowIdx],
  )

  function apply(a: HealAction) {
    if (a.kind === "recall") {
      recallMany(a.agentIds)
    } else {
      logAudit("Real-Time", "Flagged to TL", `${a.queueName} · ${a.detail}`)
    }
  }

  return (
    <Card className="glass mb-4">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" /> Recommended actions
        </CardTitle>
        <Badge variant={actions.length ? "warning" : "success"}>
          {actions.length ? `${actions.length} pending` : "All healthy"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-2">
        {actions.length === 0 && (
          <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Every queue is at or above its SL target for the current interval — nothing to fix.
          </p>
        )}
        {actions.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-background/40 p-3">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md" style={{ background: `${a.queueColor}26`, color: a.queueColor }}>
              {a.kind === "recall" ? <PhoneIncoming className="h-4 w-4" /> : <BellRing className="h-4 w-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                {a.title}
                <Badge variant="outline">{a.queueName}</Badge>
              </div>
              <p className="truncate text-xs text-muted-foreground" title={a.detail}>{a.detail}</p>
            </div>
            <div className="flex items-center gap-1.5 text-xs tabular-nums">
              <span className="text-destructive">{fmtPct(a.slBefore)}</span>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <span className={a.slAfter >= a.slTarget ? "font-semibold text-emerald-500" : "font-semibold text-amber-500"}>
                {fmtPct(a.slAfter)}
              </span>
              <span className="text-muted-foreground">(target {fmtPct(a.slTarget)})</span>
            </div>
            <PermissionGate module="realtime" fallback={<Badge variant="secondary">view only</Badge>}>
              <Button size="sm" onClick={() => apply(a)}>
                {a.kind === "recall" ? "Recall now" : "Notify TL"}
              </Button>
            </PermissionGate>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
