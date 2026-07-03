import { useMemo, useState } from "react"

import { ExportButton } from "@/components/export-button"
import { KpiCard } from "@/components/kpi-card"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Activity, Calculator, Layers, Users } from "lucide-react"
import { applyShrinkage, asa, occupancy, requiredAgents, serviceLevel, trafficIntensity } from "@/lib/domain/erlang"
import { fmtPct, fmtSec } from "@/lib/domain/planning"
import { useWfm } from "@/store/wfm"

function Slider({ label, value, min, max, step, onChange, suffix }: { label: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void; suffix?: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">
          {value}
          {suffix}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} className="w-full accent-primary" />
    </div>
  )
}

export function Erlang() {
  const { shrinkage, setShrinkage } = useWfm()
  const [volume, setVolume] = useState(140)
  const [aht, setAht] = useState(280)
  const [slTarget, setSlTarget] = useState(80)
  const [targetTime, setTargetTime] = useState(20)

  const intensity = useMemo(() => trafficIntensity(volume, aht, 1800), [volume, aht])
  const reqNet = useMemo(() => requiredAgents(volume, aht, { slTarget: slTarget / 100, targetTime }), [volume, aht, slTarget, targetTime])
  const reqGross = applyShrinkage(reqNet, shrinkage)

  const band = useMemo(() => {
    const startN = Math.max(1, reqNet - 4)
    return Array.from({ length: 10 }, (_, k) => startN + k).map((agents) => ({
      agents,
      sl: serviceLevel(agents, intensity, aht, targetTime),
      asa: asa(agents, intensity, aht),
      occ: occupancy(agents, intensity),
      meets: serviceLevel(agents, intensity, aht, targetTime) >= slTarget / 100,
    }))
  }, [reqNet, intensity, aht, targetTime, slTarget])

  return (
    <>
      <PageHeader
        title="Erlang C Staffing Calculator"
        subtitle="Single-interval staffing model · 30-minute interval"
        actions={
          <ExportButton
            filename="erlang-staffing"
            sheets={() => [
              { name: "Inputs & Result", rows: [
                { Metric: "Contacts / interval", Value: volume },
                { Metric: "AHT (s)", Value: aht },
                { Metric: "SL target", Value: `${slTarget}%` },
                { Metric: "Target time (s)", Value: targetTime },
                { Metric: "Shrinkage", Value: fmtPct(shrinkage) },
                { Metric: "Offered load (Erlangs)", Value: intensity.toFixed(2) },
                { Metric: "Required (net)", Value: reqNet },
                { Metric: "Required (rostered)", Value: reqGross },
                { Metric: "Achieved SL", Value: fmtPct(serviceLevel(reqNet, intensity, aht, targetTime)) },
              ] },
              { name: "Sensitivity", rows: band.map((r) => ({ Agents: r.agents, "Service Level": fmtPct(r.sl), ASA: fmtSec(r.asa), Occupancy: fmtPct(r.occ), "Meets target": r.meets ? "Yes" : "No" })) },
            ]}
          />
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="glass">
          <CardHeader>
            <CardTitle>Inputs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Slider label="Contacts / interval" value={volume} min={5} max={400} step={5} onChange={setVolume} />
            <Slider label="AHT" value={aht} min={60} max={700} step={10} onChange={setAht} suffix="s" />
            <Slider label="SL target" value={slTarget} min={50} max={99} step={1} onChange={setSlTarget} suffix="%" />
            <Slider label="Within" value={targetTime} min={5} max={120} step={5} onChange={setTargetTime} suffix="s" />
            <Slider label="Shrinkage" value={Math.round(shrinkage * 100)} min={0} max={50} step={1} onChange={(n) => setShrinkage(n / 100)} suffix="%" />
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-4">
            <KpiCard label="Offered load" value={`${intensity.toFixed(1)} E`} hint={`${volume} × ${aht}s ÷ 1800s`} icon={Layers} />
            <KpiCard label="Required (productive)" value={reqNet} hint={`hit ${slTarget}/${targetTime}`} icon={Calculator} />
            <KpiCard label="Required (rostered)" value={reqGross} hint={`+${fmtPct(shrinkage)} shrinkage`} tone="warn" icon={Users} />
            <KpiCard label="Achieved SL" value={fmtPct(serviceLevel(reqNet, intensity, aht, targetTime))} hint={`ASA ${fmtSec(asa(reqNet, intensity, aht))}`} tone="good" icon={Activity} />
          </div>

          <Card className="glass mt-4">
            <CardHeader>
              <CardTitle>Sensitivity — what each staffing level buys</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agents (net)</TableHead>
                    <TableHead>Service Level</TableHead>
                    <TableHead>ASA</TableHead>
                    <TableHead>Occupancy</TableHead>
                    <TableHead>Meets target?</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {band.map((r) => (
                    <TableRow key={r.agents} className={r.agents === reqNet ? "bg-primary/10 font-semibold" : ""}>
                      <TableCell className="font-medium">
                        {r.agents}
                        {r.agents === reqNet && <span className="ml-2 text-xs text-primary">◄ recommended</span>}
                      </TableCell>
                      <TableCell>{fmtPct(r.sl)}</TableCell>
                      <TableCell>{fmtSec(r.asa)}</TableCell>
                      <TableCell>{fmtPct(r.occ)}</TableCell>
                      <TableCell>
                        <Badge variant={r.meets ? "success" : "destructive"}>{r.meets ? "yes" : "no"}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
