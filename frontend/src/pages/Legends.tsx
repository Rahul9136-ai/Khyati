import { BookMarked, Search, X } from "lucide-react"
import { useMemo, useState } from "react"

import { ExportButton } from "@/components/export-button"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useCapacity } from "@/lib/capacity/store"
import { buildLegends, legendSheets, type LegendGroup } from "@/lib/domain/legends"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

const matches = (q: string, ...xs: (string | undefined)[]) => xs.some((x) => x?.toLowerCase().includes(q))

/** Every legend in the tool (colours, codes, statuses, abbreviations), searchable and exportable. */
export function Legends() {
  const queues = useWfm((s) => s.queues)
  const lobs = useWfm((s) => s.lobs)
  const cfg = useCapacity((s) => s.config)
  const all = useMemo(
    () => buildLegends({ queues, lobs, capacityLow: cfg.thresholdLow, capacityHigh: cfg.thresholdHigh }),
    [queues, lobs, cfg.thresholdLow, cfg.thresholdHigh],
  )
  const [query, setQuery] = useState("")
  const [only, setOnly] = useState<string | null>(null)

  const q = query.trim().toLowerCase()
  const shown: LegendGroup[] = all
    .filter((g) => !only || g.id === only)
    .map((g) => ({ ...g, items: q ? g.items.filter((i) => matches(q, i.code, i.label, i.meaning, i.colorName, i.color, g.title)) : g.items }))
    .filter((g) => g.items.length)
  const count = shown.reduce((n, g) => n + g.items.length, 0)

  return (
    <>
      <PageHeader
        title="Legends"
        subtitle="Every colour, code, status and abbreviation used in the tool"
        actions={<ExportButton filename={q || only ? "purvi-legends-filtered" : "purvi-legends"} sheets={() => legendSheets(shown)} />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="Search legends"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search, e.g. AHT, break, Ochre, #d97706…"
            className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-8 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </label>
        <span className="text-xs text-muted-foreground" aria-live="polite">{count} {count === 1 ? "entry" : "entries"}</span>
      </div>

      <div role="group" aria-label="Show legend group" className="mb-5 flex flex-wrap gap-1.5">
        {[{ id: null, title: "All" }, ...all.map((g) => ({ id: g.id, title: g.title }))].map((g) => (
          <button
            key={g.id ?? "all"}
            type="button"
            aria-pressed={only === g.id}
            onClick={() => setOnly(g.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              only === g.id ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {g.title}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Card className="glass"><CardContent className="py-10 text-center text-sm text-muted-foreground">Nothing matches "{query}".</CardContent></Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {shown.map((g) => (
            <Card key={g.id} className={cn("glass", g.id === "glossary" && "xl:col-span-2")} aria-label={g.title} role="region">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm"><BookMarked className="h-4 w-4 text-primary" /> {g.title}</CardTitle>
                <p className="text-xs text-muted-foreground">Where: {g.where}</p>
                {g.note && <p className="text-xs text-muted-foreground">{g.note}</p>}
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="py-1.5 pr-3 font-medium">Colour</th>
                        <th className="py-1.5 pr-3 font-medium">Code</th>
                        <th className="py-1.5 pr-3 font-medium">Name</th>
                        <th className="py-1.5 font-medium">Meaning</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.items.map((i, n) => (
                        <tr key={`${i.code}-${i.label}-${n}`} className="border-t border-border/50 align-top">
                          <td className="py-2 pr-3">
                            {i.color ? (
                              <span className="flex items-center gap-2 whitespace-nowrap">
                                <span className="block h-4 w-4 shrink-0 rounded ring-1 ring-black/10" style={{ background: i.color }} aria-hidden />
                                <span>
                                  <span className="block text-xs font-medium" aria-label={`Colour ${i.colorName} ${i.color}`}>{i.colorName}</span>
                                  <span className="block font-mono text-[10px] text-muted-foreground">{i.color}</span>
                                </span>
                              </span>
                            ) : <span className="text-muted-foreground/50">—</span>}
                          </td>
                          <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs">{i.code ?? ""}</td>
                          <td className="py-2 pr-3 font-medium">{i.label}</td>
                          <td className="py-2 text-muted-foreground">
                            {i.meaning}
                            {i.sameAs && <span className="mt-0.5 block text-[11px] italic text-muted-foreground/80">{i.sameAs}.</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
