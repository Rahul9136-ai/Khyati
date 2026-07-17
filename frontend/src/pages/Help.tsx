import { BookOpenText } from "lucide-react"

import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

function Formula({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-lg border bg-muted/60 px-3 py-2 text-xs leading-relaxed">
      {children}
    </pre>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">{children}</CardContent>
    </Card>
  )
}

export function Help() {
  return (
    <>
      <PageHeader
        title="Methodology & Formulas"
        subtitle="Every number in the platform, documented — the same math the engine runs"
      />

      <div className="mb-4 flex items-center gap-2 rounded-lg border border-teal-600/30 px-4 py-2.5 text-sm text-muted-foreground">
        <BookOpenText className="h-4 w-4 text-teal-600" />
        These are the exact formulas implemented in <code>src/lib/domain/</code> — not simplified approximations.
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Erlang C — voice staffing">
          <p>
            Traffic intensity for an interval: <b>a = (volume × AHT) ÷ interval seconds</b> (erlangs). The probability a
            contact waits, with <b>N</b> agents:
          </p>
          <Formula>{`Pw = (aᴺ/N!) · (N/(N−a))
     ─────────────────────────────
     Σₖ₌₀ᴺ⁻¹ (aᵏ/k!) + (aᴺ/N!)·(N/(N−a))

Service level  SL = 1 − Pw · e^(−(N−a)·T/AHT)
ASA            = Pw · AHT / (N − a)
Occupancy      = a / N`}</Formula>
          <p>
            Required agents = the smallest <b>N &gt; a</b> whose SL meets the target (e.g. 80% in 20 s). The factorial
            terms are computed iteratively so large N stays numerically stable. Erlang A extends this with a Palm
            abandonment approximation using mean patience.
          </p>
        </Section>

        <Section title="Shrinkage & FTE">
          <p>Shrinkage converts on-phone requirement into bodies to schedule (breaks, meetings, absence, attrition):</p>
          <Formula>{`Gross required = ⌈ Net required ÷ (1 − shrinkage) ⌉

FTE = agent-hours required ÷ contracted hours per FTE
Agent-hours = Σ intervals (gross required × interval length)`}</Formula>
          <p>
            Planned shrinkage default is 25% (configurable). Capacity plans flag intervals whose planned occupancy
            exceeds the occupancy cap — sustained occupancy above ~85% is a burnout and attrition risk.
          </p>
        </Section>

        <Section title="Adherence %">
          <p>Time-sensitive: were you in the scheduled state at the scheduled minute?</p>
          <Formula>{`Adherence = minutes in scheduled state (or approved exception)
            ─────────────────────────────────────────────
                        scheduled minutes`}</Formula>
          <p>
            Compared minute-by-minute. Productive states are interchangeable (Available ↔ After-Call Work don't hurt
            adherence). Approved exceptions (coaching, meetings) are credited automatically. Real-time flagging honours
            the grace period, then escalates to the team lead after the configured window.
          </p>
        </Section>

        <Section title="Conformance %">
          <p>Time-insensitive: did you deliver the scheduled amount of work, whenever it happened?</p>
          <Formula>{`Conformance = productive minutes worked ÷ productive minutes scheduled`}</Formula>
          <p>
            An agent who takes lunch an hour late hurts adherence but can still hit 100% conformance. Both metrics are
            on the RTA wallboard and the end-of-day scorecards.
          </p>
        </Section>

        <Section title="Forecast accuracy — MAPE, WAPE, bias">
          <Formula>{`APE (one day)  = |actual − forecast| ÷ actual
MAPE           = mean of daily APEs
WAPE           = Σ|actual − forecast| ÷ Σactual   (volume-weighted)
Bias           = Σ(forecast − actual) ÷ Σactual   (+ = over-forecasting)`}</Formula>
          <p>
            MAPE treats every day equally (small days can dominate); WAPE weights by volume and is the fairer headline
            number. Persistent positive bias silently inflates budgets; negative bias burns service level. Interval
            variance alerts fire when an interval misses forecast beyond the configured threshold — 2× threshold is
            critical and triggers the intraday desk.
          </p>
        </Section>

        <Section title="Forecasting models & selection">
          <p>
            Five models compete per queue: weighted moving average, exponential smoothing (Holt-Winters style with
            weekly seasonality), trend + seasonal decomposition, same-weekday regression, and a gradient-boosted-style
            ensemble. Selection is a rolling back-test:
          </p>
          <Formula>{`for each model: train on history minus hold-out → predict hold-out → MAPE
apply the lowest-MAPE model; retrain automatically when actuals import`}</Formula>
          <p>
            Outliers are capped with MAD (median absolute deviation) before fitting; holiday intervals are damped by a
            calendar factor; intraday distribution uses the queue's historical interval shape.
          </p>
        </Section>

        <Section title="Coverage, net staffing & intraday reforecast">
          <Formula>{`Coverage(i)     = agents whose shift spans interval i (minus breaks)
Net staffing(i) = scheduled(i) − gross required(i)

Pacing          = Σ actuals to-date ÷ Σ forecast to-date
Reforecast(i>now) = forecast(i) × pacing`}</Formula>
          <p>
            When |pacing − 1| exceeds the auto-reforecast threshold (default ±10%), the remaining day is repaced
            automatically and the staffing plan below it switches to the reforecast. Sustained surplus proposes VTO;
            deficit proposes overtime and break re-staggering.
          </p>
        </Section>

        <Section title="Auto-approval rules">
          <Formula>{`Shift swap  → auto-approve if volume-weighted SL impact ≥ −tolerance (pp)
Leave       → auto-approve if coverage surplus on every requested day
              and balance available; otherwise route to manager
Exceptions  → approved activities credit adherence automatically`}</Formula>
          <p>
            Every automated decision — approvals, recalls, reforecasts, threshold changes — lands in the immutable
            audit trail with actor, timestamp and detail, and surfaces in the Automation Center's decision feed.
          </p>
        </Section>

        <Section title="Service-level & occupancy definitions">
          <Formula>{`SL attainment = contacts answered within target time ÷ contacts offered
Occupancy     = talk + after-call work ÷ staffed (logged-in productive) time
ASA           = average speed of answer across the interval`}</Formula>
          <p>
            Projected SL on every plan row is computed from the actual scheduled coverage through the same Erlang C
            formula — so the number you plan with is the number the wallboard tracks.
          </p>
        </Section>
      </div>
    </>
  )
}
