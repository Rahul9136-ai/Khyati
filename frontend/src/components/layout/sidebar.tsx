import { ChevronRight } from "lucide-react"
import { useEffect, useState } from "react"
import { NavLink, useLocation } from "react-router-dom"

import { PurviLogo } from "@/components/purvi-logo"
import { findNav, NAV, type NavGroup, type NavItem } from "@/config/nav"
import { cn } from "@/lib/utils"

const slug = (s: string) => `nav-${s.replace(/\W+/g, "-").toLowerCase()}`

/** Icon tile used for every main section. */
function SectionIcon({ group, active }: { group: NavGroup; active: boolean }) {
  return (
    <span
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors",
        active
          ? "bg-primary text-primary-foreground shadow-sm shadow-primary/30"
          : "bg-muted/70 text-muted-foreground group-hover:bg-muted group-hover:text-foreground",
      )}
    >
      <group.icon className="h-4 w-4" />
    </span>
  )
}

const rowClass = (active: boolean, open = false) =>
  cn(
    "group relative flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors",
    active ? "text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
    open && !active && "bg-accent/40 text-foreground",
    open && active && "bg-accent/40",
  )

/** Marks the section that holds the page you're on. */
const ActiveBar = () => <span aria-hidden className="absolute -left-3 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-primary" />

function Section({ group, items, open, active, onToggle }: {
  group: NavGroup; items: NavItem[]; open: boolean; active: boolean; onToggle: () => void
}) {
  const id = slug(group.group)
  return (
    <div>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle} className={rowClass(active, open)}>
        {active && <ActiveBar />}
        <SectionIcon group={group} active={active} />
        <span className="flex-1 truncate text-left">{group.group}</span>
        <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground/70 transition-transform duration-200", open && "rotate-90")} />
      </button>
      {open && (
        <div id={id} role="group" aria-label={group.group} className="animate-fade-in pb-2 pt-1">
          {group.hint && <p className="pb-1 pl-[3.25rem] pr-2 text-[11px] text-muted-foreground/70">{group.hint}</p>}
          <div className="ml-[1.6rem] space-y-0.5 border-l border-border/70 pl-3">
            {items.map((it) => (
              <NavLink
                key={it.to}
                to={it.to}
                className={({ isActive }) =>
                  cn(
                    "relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
                    isActive
                      ? "bg-primary/10 font-semibold text-primary before:absolute before:-left-[13px] before:top-1/2 before:h-5 before:w-[2px] before:-translate-y-1/2 before:rounded-full before:bg-primary"
                      : "text-foreground/70 hover:bg-accent/50 hover:text-foreground",
                  )
                }
              >
                <it.icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{it.label}</span>
              </NavLink>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The left pane: only the main sections. Clicking a section opens its pages
 * underneath (one section at a time); the section of the page you're on is
 * open when you arrive and is marked.
 */
export function Sidebar({ canSee, footer }: { canSee: (item: NavItem) => boolean; footer?: React.ReactNode }) {
  const { pathname } = useLocation()
  const current = findNav(pathname)?.group.group ?? null
  const [open, setOpen] = useState<string | null>(current)
  useEffect(() => { if (current) setOpen(current) }, [current])

  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border/60 bg-gradient-to-b from-card to-background md:flex">
      <div className="flex h-14 items-center border-b border-border/60 px-5">
        <div className="flex flex-col gap-0.5">
          <PurviLogo size="sm" orientation="horizontal" />
          <span className="pl-8 text-[8px] font-medium uppercase leading-tight tracking-[0.1em] text-muted-foreground">
            A Product of Purvi Technology
          </span>
        </div>
      </div>

      <nav aria-label="Main" className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">Menu</p>
        {NAV.map((g) => {
          const items = g.items.filter(canSee)
          if (items.length === 0) return null
          const active = current === g.group
          if (g.direct) {
            return (
              <NavLink key={g.group} to={items[0].to} end={items[0].to === "/"} className={rowClass(active)}>
                {active && <ActiveBar />}
                <SectionIcon group={g} active={active} />
                <span className="flex-1 truncate">{g.group}</span>
              </NavLink>
            )
          }
          return (
            <Section key={g.group} group={g} items={items} active={active} open={open === g.group}
              onToggle={() => setOpen((o) => (o === g.group ? null : g.group))} />
          )
        })}
      </nav>

      {footer && <div className="m-3 rounded-lg border border-border/60 bg-muted/30 p-3 text-[11px] text-muted-foreground">{footer}</div>}
    </aside>
  )
}

/** "Planning › Capacity Planning" for the header. */
export function Breadcrumb() {
  const hit = findNav(useLocation().pathname)
  if (!hit) return null
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-sm xl:flex">
      <hit.group.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      {hit.group.direct ? (
        <span className="font-medium">{hit.item.label}</span>
      ) : (
        <>
          <span className="text-muted-foreground">{hit.group.group}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          <span className="truncate font-medium" aria-current="page">{hit.item.label}</span>
        </>
      )}
    </nav>
  )
}
