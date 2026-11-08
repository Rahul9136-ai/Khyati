import { Loader2 } from "lucide-react"

import { PageHeader } from "@/components/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { useBacktestsReady } from "@/lib/backtests"
import { useWfm } from "@/store/wfm"

/** Shows the page once every queue's forecast backtest is ready (calculated in
 *  the background); until then the heading and a short "Calculating…" note, so
 *  the page never freezes. */
export function BacktestGate({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  const queues = useWfm((s) => s.queues)
  const importedActuals = useWfm((s) => s.importedActuals)
  const ready = useBacktestsReady(queues, importedActuals)
  if (ready) return <>{children}</>
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      <Card className="glass">
        <CardContent role="status" className="flex items-center gap-3 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          Calculating forecast accuracy for {queues.length} queue{queues.length === 1 ? "" : "s"} (12 models each)… This takes a few seconds the first time.
        </CardContent>
      </Card>
    </>
  )
}
