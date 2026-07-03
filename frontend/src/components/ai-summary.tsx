import { Sparkles } from "lucide-react"

import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type Tone = "good" | "warn" | "bad" | "neutral"

export interface Insight {
  headline: string
  bullets: string[]
  tone?: Tone
}

const ring: Record<Tone, string> = {
  good: "border-emerald-500/40",
  warn: "border-amber-500/40",
  bad: "border-destructive/40",
  neutral: "border-primary/40",
}

export function AiSummary({ insight, title = "AI Summary" }: { insight: Insight; title?: string }) {
  const tone = insight.tone ?? "neutral"
  return (
    <Card className={cn("glass border p-5", ring[tone])}>
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="ml-auto rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          generated
        </span>
      </div>
      <p className="mb-3 text-sm font-medium leading-relaxed">{insight.headline}</p>
      <ul className="space-y-1.5 text-[13px] text-muted-foreground">
        {insight.bullets.map((b, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-primary">•</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
