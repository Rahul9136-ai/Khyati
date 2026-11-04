import { useEffect, useMemo, useRef, useState } from "react"
import { CornerDownLeft, FileText, Search, User } from "lucide-react"
import { useNavigate } from "react-router-dom"

import { NAV } from "@/config/nav"
import { effectiveLevel } from "@/lib/domain/roles"
import { cn } from "@/lib/utils"
import { useWfm } from "@/store/wfm"

interface Hit {
  key: string
  label: string
  hint: string
  to: string
  kind: "page" | "person"
}

const MAX_HITS = 8

/** Top-bar search: jump to any page you can open, or to an employee's
 *  profile, current or former. Ctrl/⌘+K or "/" focuses it. */
export function GlobalSearch() {
  const navigate = useNavigate()
  const { agents, formerEmployees, permissions, currentRole } = useWfm()
  const [q, setQ] = useState("")
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /input|textarea|select/i.test(e.target.tagName)
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault()
        ref.current?.focus()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const hits = useMemo<Hit[]>(() => {
    const text = q.trim().toLowerCase()
    if (!text) return []
    const can = (m: Parameters<typeof effectiveLevel>[2]) => effectiveLevel(permissions, currentRole, m) !== "none"
    const pages: Hit[] = NAV.flatMap((g) => g.items.filter((i) => can(i.module)).map((i) => ({ key: i.to, label: i.label, hint: g.group, to: i.to, kind: "page" as const })))
      .filter((h) => h.label.toLowerCase().includes(text) || h.hint.toLowerCase().includes(text))
    const people: Hit[] = can("employees")
      ? [
          ...agents.map((a) => ({ a, hint: `${a.team} team · ${a.id}` })),
          ...Object.values(formerEmployees).map((a) => ({ a, hint: `Former employee · ${a.id}` })),
        ]
          .filter(({ a }) => a.name.toLowerCase().includes(text) || a.id.toLowerCase() === text)
          .map(({ a, hint }) => ({ key: a.id, label: a.name, hint, to: `/employees/${a.id}`, kind: "person" as const }))
      : []
    // Names that start with the query first.
    const rank = (h: Hit) => (h.label.toLowerCase().startsWith(text) ? 0 : 1)
    return [...pages, ...people].sort((x, y) => rank(x) - rank(y)).slice(0, MAX_HITS)
  }, [q, agents, formerEmployees, permissions, currentRole])

  function go(hit: Hit | undefined) {
    if (!hit) return
    navigate(hit.to)
    setQ("")
    setOpen(false)
    ref.current?.blur()
  }

  return (
    <div className="relative hidden max-w-xs flex-1 items-center md:flex">
      <Search className="absolute left-3 h-4 w-4 text-muted-foreground" />
      <input
        ref={ref}
        role="combobox"
        aria-label="Search pages and employees"
        aria-expanded={open && hits.length > 0}
        aria-controls="global-search-results"
        placeholder="Search…  (Ctrl K)"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1)) }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
          else if (e.key === "Enter") { e.preventDefault(); go(hits[active]) }
          else if (e.key === "Escape") { setQ(""); setOpen(false); ref.current?.blur() }
        }}
        className="h-8 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {open && q.trim() && (
        <div id="global-search-results" role="listbox" className="absolute left-0 right-0 top-10 z-30 overflow-hidden rounded-lg border bg-card shadow-xl">
          {hits.length ? (
            hits.map((h, i) => {
              const Icon = h.kind === "page" ? FileText : User
              return (
                <button
                  key={h.key}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(h)}
                  className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm", i === active && "bg-accent")}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{h.label}</span>
                  <span className="ml-auto truncate text-xs text-muted-foreground">{h.hint}</span>
                  {i === active && <CornerDownLeft className="h-3 w-3 shrink-0 text-muted-foreground" />}
                </button>
              )
            })
          ) : (
            <p className="px-3 py-3 text-sm text-muted-foreground">No pages or employees match "{q.trim()}".</p>
          )}
        </div>
      )}
    </div>
  )
}
