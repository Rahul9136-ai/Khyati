import { Send, Sparkles } from "lucide-react"
import { useState } from "react"

import { CopilotActions } from "@/components/copilot-actions"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import { initialsOf } from "@/lib/auth"
import { backtest } from "@/lib/domain/forecast"
import { buildPlan, fmtPct, summarisePlan } from "@/lib/domain/planning"
import { cn } from "@/lib/utils"
import { useAuth } from "@/store/auth"
import { useWfm } from "@/store/wfm"

interface Msg {
  role: "user" | "assistant"
  text: string
  source?: "server" | "local"
}

const SUGGESTIONS = [
  "What's our service level risk today?",
  "Which forecast model is most accurate?",
  "Do we need to hire?",
  "Why is adherence low?",
]

export function Copilot() {
  const { forecasts, shrinkage, agents, queues } = useWfm()
  const user = useAuth((s) => s.user)
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "assistant", text: "Hi — I'm your WFM Copilot. Ask me about forecasts, staffing, adherence, or capacity. I answer from the live backend (headcount, plans, approved forecasts) and fall back to the in-browser engine when offline." },
  ])
  const [input, setInput] = useState("")

  function answer(qText: string): string {
    const t = qText.toLowerCase()
    const perQueue = queues.map((q) => ({ q, sum: summarisePlan(buildPlan(forecasts[q.id], q.aht, q, shrinkage, agents)), bt: backtest(q.id) }))
    const worst = perQueue.reduce((a, b) => (b.sum.wSL < a.sum.wSL ? b : a))
    if (t.includes("service level") || t.includes("risk") || t.includes("sla")) {
      return `${worst.q.name} is the most at-risk queue at ${fmtPct(worst.sum.wSL)} projected SL (target ${fmtPct(worst.q.slTarget)}), with ${worst.sum.underIntervals} under-staffed intervals. I'd pull cover toward its peak block.`
    }
    if (t.includes("model") || t.includes("forecast") || t.includes("accurate") || t.includes("mape")) {
      const lines = perQueue.map((x) => `${x.q.name}: ${x.bt.best.name} (${fmtPct(x.bt.best.mape)} MAPE)`)
      return `Most accurate model per queue right now —\n• ${lines.join("\n• ")}.\nStatistical models win on stable day-totals; ML (LinReg) captures trend on longer horizons.`
    }
    if (t.includes("hire") || t.includes("capacity") || t.includes("fte")) {
      const req = perQueue.reduce((a, x) => a + x.sum.reqHours, 0)
      const sched = perQueue.reduce((a, x) => a + x.sum.schedHours, 0)
      return sched >= req
        ? `Capacity looks sufficient: ${sched.toFixed(0)} scheduled vs ${req.toFixed(0)} required agent-hrs today. No immediate hiring needed, though weekend cover is thin.`
        : `There's a deficit of ${(req - sched).toFixed(0)} agent-hrs — roughly ${Math.ceil((req - sched) / 8)} FTE. I'd open a hiring requisition and add overtime short-term.`
    }
    if (t.includes("adherence") || t.includes("rta") || t.includes("break")) {
      return "Adherence dips usually come from over-running breaks/ACW. On the Real-Time Monitor I can name specific agents on deferrable breaks to recall and flag them to their TLs when SL is at risk."
    }
    return `Here's the centre picture: ${perQueue.map((x) => `${x.q.name} ${fmtPct(x.sum.wSL)} SL`).join(", ")}. Ask me about forecasts, staffing, hiring, or adherence for detail.`
  }

  async function send(text: string) {
    const clean = text.trim()
    if (!clean) return
    setMsgs((m) => [...m, { role: "user", text: clean }])
    setInput("")
    try {
      const res = await api.post("/ai/chat", { message: clean })
      const serverAnswer = res.data.data.answer as string
      setMsgs((m) => [...m, { role: "assistant", text: serverAnswer, source: "server" }])
    } catch {
      // backend unreachable → the in-browser analytics engine still answers
      setMsgs((m) => [...m, { role: "assistant", text: answer(clean), source: "local" }])
    }
  }

  return (
    <>
      <PageHeader title="AI Copilot" subtitle="Natural-language analytics + self-healing intraday actions" />
      <CopilotActions />
      <Card className="glass flex h-[calc(100vh-12rem)] flex-col">
        <CardContent className="flex flex-1 flex-col gap-4 overflow-y-auto pt-5">
          {msgs.map((m, i) => (
            <div key={i} className={cn("flex gap-3", m.role === "user" && "flex-row-reverse")}>
              <div className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold", m.role === "assistant" ? "bg-primary/15 text-primary" : "bg-muted")}>
                {m.role === "assistant" ? <Sparkles className="h-4 w-4" /> : user ? initialsOf(user) : "you"}
              </div>
              <div className={cn("max-w-[75%] whitespace-pre-line rounded-xl px-4 py-2.5 text-sm", m.role === "assistant" ? "bg-muted" : "bg-primary text-primary-foreground")}>
                {m.text}
                {m.source && (
                  <span className={cn("mt-1.5 block text-[10px] font-medium uppercase tracking-wide", m.source === "server" ? "text-emerald-500" : "text-muted-foreground")}>
                    {m.source === "server" ? "· live backend data" : "· offline engine"}
                  </span>
                )}
              </div>
            </div>
          ))}
        </CardContent>
        <div className="border-t p-4">
          <div className="mb-3 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => void send(s)} className="rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                {s}
              </button>
            ))}
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(input) }}>
            <Input placeholder="Ask the WFM Copilot…" value={input} onChange={(e) => setInput(e.target.value)} />
            <Button type="submit" size="icon"><Send className="h-4 w-4" /></Button>
          </form>
        </div>
      </Card>
    </>
  )
}
