import { useMemo, useState } from "react"
import { CalendarRange, DollarSign, TrendingDown, TrendingUp, Users } from "lucide-react"

import { SeriesChart } from "@/components/charts/series-chart"
import { KpiCard } from "@/components/kpi-card"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { parseYMD, TODAY, ymd } from "@/lib/domain/dates"
import { fmtPct } from "@/lib/domain/planning"
import { computeRamp, fmtMoney, type RampDirection, type RampInput, type RampShape } from "@/lib/domain/ramp"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

export function RampPlanner() {
  const { queue, shrinkage } = useWfm()
  const q = queue()

  const [name, setName] = useState("New LOB — Mortgages")
  const [direction, setDirection] = useState<RampDirection>("up")
  const [start, setStart] = useState(ymd(TODAY))
  const [rampWeeks, setRampWeeks] = useState(5)
  const [horizonWeeks, setHorizonWeeks] = useState(14)
  const [steadyVolume, setSteadyVolume] = useState(700)
  const [aht, setAht] = useState(q.aht)
  const [shape, setShape] = useState<RampShape>("scurve")
  const [revenuePerContact, setRevenuePerContact] = useState(7.5)
  const [costPerAgentHour, setCostPerAgentHour] = useState(26)
  const [setupCost, setSetupCost] = useState(60000)

  const input: RampInput = {
    name,
    direction,
    startDate: parseYMD(start),
    rampWeeks,
    horizonWeeks: Math.max(rampWeeks, horizonWeeks),
    steadyVolume,
    aht,
    slTarget: q.slTarget,
    targetTime: q.targetTime,
    shrinkage,
    shape,
    revenuePerContact,
    costPerAgentHour,
    setupCost,
    daysPerWeek: 5,
    hoursPerFTE: 40,
  }

  const result = useMemo(() => computeRamp(input), [JSON.stringify({ ...input, startDate: start })])

  const chartData = result.rows.map((r) => ({
    label: `W${r.week}`,
    Revenue: Math.round(r.revenue),
    "Staff cost": Math.round(r.staffCost),
    Cumulative: Math.round(r.cumContribution),
  }))

  const Dir = direction === "up" ? TrendingUp : TrendingDown

  return (
    <Card className="glass">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Dir className="h-4 w-4 text-primary" />
          Ramp-Up / Ramp-Down Planner
          <Badge variant="secondary">new business / LOB</Badge>
        </CardTitle>
        <div className="inline-flex rounded-lg bg-muted p-1" role="group" aria-label="Ramp direction">
          <button
            onClick={() => setDirection("up")}
            aria-pressed={direction === "up"}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-semibold transition-colors",
              direction === "up" ? "bg-background text-emerald-500 shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <TrendingUp className="h-4 w-4" /> Ramp Up
          </button>
          <button
            onClick={() => setDirection("down")}
            aria-pressed={direction === "down"}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-semibold transition-colors",
              direction === "down" ? "bg-background text-amber-500 shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <TrendingDown className="h-4 w-4" /> Ramp Down
          </button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Inputs */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          <div className="col-span-2">
            <Field label="Scenario name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <Field label="Curve">
            <Select
              value={shape}
              onChange={(e) => setShape(e.target.value as RampShape)}
              options={[
                { value: "scurve", label: "S-curve" },
                { value: "linear", label: "Linear" },
                { value: "stepped", label: "Stepped" },
              ]}
              className="w-full"
            />
          </Field>
          <Field label="Start date">
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Ramp weeks">
            <Input type="number" min={1} max={52} value={rampWeeks} onChange={(e) => setRampWeeks(+e.target.value)} />
          </Field>
          <Field label="Horizon weeks">
            <Input type="number" min={1} max={104} value={horizonWeeks} onChange={(e) => setHorizonWeeks(+e.target.value)} />
          </Field>
          <Field label="Steady volume /day">
            <Input type="number" min={0} value={steadyVolume} onChange={(e) => setSteadyVolume(+e.target.value)} />
          </Field>
          <Field label="AHT (s)">
            <Input type="number" min={30} value={aht} onChange={(e) => setAht(+e.target.value)} />
          </Field>
          <Field label="Revenue / contact ($)">
            <Input type="number" min={0} step={0.1} value={revenuePerContact} onChange={(e) => setRevenuePerContact(+e.target.value)} />
          </Field>
          <Field label="Cost / agent-hr ($)">
            <Input type="number" min={0} step={0.5} value={costPerAgentHour} onChange={(e) => setCostPerAgentHour(+e.target.value)} />
          </Field>
          <Field label="Setup cost ($)">
            <Input type="number" min={0} step={1000} value={setupCost} onChange={(e) => setSetupCost(+e.target.value)} />
          </Field>
        </div>

        {/* KPIs */}
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard
            label={direction === "up" ? "Peak FTE to hire" : "FTE released"}
            value={Math.ceil(result.peakFte)}
            hint={`${result.steadyFte.toFixed(1)} at steady state`}
            icon={Users}
          />
          <KpiCard label="Steady weekly margin" value={fmtMoney(result.steadyWeeklyContribution)} hint="revenue − staffing" tone={result.steadyWeeklyContribution >= 0 ? "good" : "bad"} icon={DollarSign} />
          <KpiCard
            label="Break-even"
            value={result.breakEvenWeek ? `Week ${result.breakEvenWeek}` : "—"}
            hint={`recovers ${fmtMoney(setupCost)} setup`}
            tone={result.breakEvenWeek ? "good" : "warn"}
            icon={CalendarRange}
          />
          <KpiCard label={`Net over ${input.horizonWeeks} wks`} value={fmtMoney(result.totalContribution)} hint={`${fmtMoney(result.totalRevenue)} rev`} tone={result.totalContribution >= 0 ? "good" : "bad"} icon={TrendingUp} />
        </div>

        {/* Financial chart */}
        <div className="mt-5">
          <div className="mb-1 text-sm font-medium">Weekly revenue vs staffing cost · cumulative contribution</div>
          <SeriesChart
            data={chartData}
            xKey="label"
            yLabel="$ / week"
            height={280}
            series={[
              { key: "Revenue", name: "Revenue", color: "#22c55e", type: "bar" },
              { key: "Staff cost", name: "Staff cost", color: "#f59e0b", type: "bar" },
              { key: "Cumulative", name: "Cumulative contribution", color: q.color },
            ]}
          />
        </div>

        {/* Weekly table */}
        <div className="mt-4 max-h-80 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Week</TableHead>
                <TableHead>Ramp</TableHead>
                <TableHead>Vol/day</TableHead>
                <TableHead>FTE</TableHead>
                <TableHead>Revenue</TableHead>
                <TableHead>Staff cost</TableHead>
                <TableHead>Contribution</TableHead>
                <TableHead>Cumulative</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((r) => (
                <TableRow key={r.week} className={cn(r.breakEven && "bg-emerald-500/10")}>
                  <TableCell className="text-left font-medium">{r.label}</TableCell>
                  <TableCell>{fmtPct(r.pct)}</TableCell>
                  <TableCell>{r.dailyVolume.toLocaleString()}</TableCell>
                  <TableCell>{r.fte.toFixed(1)}</TableCell>
                  <TableCell>{fmtMoney(r.revenue)}</TableCell>
                  <TableCell>{fmtMoney(r.staffCost)}</TableCell>
                  <TableCell className={r.contribution >= 0 ? "text-emerald-500" : "text-destructive"}>{fmtMoney(r.contribution)}</TableCell>
                  <TableCell className={cn("font-semibold", r.cumContribution >= 0 ? "text-emerald-500" : "text-destructive")}>
                    {fmtMoney(r.cumContribution)}
                    {r.breakEven && <Badge variant="success" className="ml-2">break-even</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
