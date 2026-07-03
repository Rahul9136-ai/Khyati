import type { LucideIcon } from "lucide-react"

import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type Tone = "good" | "warn" | "bad" | "neutral"

const toneText: Record<Tone, string> = {
  good: "text-emerald-500",
  warn: "text-amber-500",
  bad: "text-destructive",
  neutral: "text-muted-foreground",
}

export function KpiCard({
  label,
  value,
  hint,
  tone = "neutral",
  icon: Icon,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  tone?: Tone
  icon?: LucideIcon
}) {
  return (
    <Card className="glass p-5">
      <div className="flex items-start justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        {Icon && <Icon className={cn("h-4 w-4", toneText[tone])} />}
      </div>
      <div className="mt-2 text-3xl font-bold tabular-nums">{value}</div>
      {hint && <div className={cn("mt-1 text-xs", toneText[tone])}>{hint}</div>}
    </Card>
  )
}
