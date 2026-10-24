import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Eraser, MoreHorizontal } from "lucide-react"

import { Input } from "@/components/ui/input"
import { AUX_KINDS, fmtHM, toMins, type AuxKind } from "@/lib/domain/channels"
import { cn } from "@/lib/utils"

const LENGTHS = [15, 30, 60, 120]

export interface AuxMenuChoice {
  kind: AuxKind
  start: number
  length: number
  fullShift: boolean
}

/** Right-click menu listing every AUX; choosing one marks it on all targeted
 *  schedules at the chosen time/length. */
export function AuxContextMenu({
  x,
  y,
  at,
  targets,
  removable,
  onPick,
  onRemove,
  onMore,
  onClose,
}: {
  /** Viewport position of the right-click. */
  x: number
  y: number
  /** Minute under the cursor (default start). */
  at: number
  /** How many schedules the choice applies to. */
  targets: number
  /** Activities found under the cursor among the targets (for "Remove"). */
  removable: number
  onPick: (choice: AuxMenuChoice) => void
  onRemove: () => void
  onMore: (kind: AuxKind, start: number) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [start, setStart] = useState(fmtHM(at))
  const [length, setLength] = useState(30)
  const [pos, setPos] = useState({ left: x, top: y })

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) })
  }, [x, y])

  useEffect(() => {
    const away = (e: Event) => ref.current && !ref.current.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("mousedown", away)
    document.addEventListener("keydown", key)
    window.addEventListener("scroll", onClose, true)
    window.addEventListener("resize", onClose)
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus()
    return () => {
      document.removeEventListener("mousedown", away)
      document.removeEventListener("keydown", key)
      window.removeEventListener("scroll", onClose, true)
      window.removeEventListener("resize", onClose)
    }
  }, [onClose])

  const startMin = toMins(start)
  const item = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:bg-accent"

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Mark AUX"
      className="fixed z-50 w-64 rounded-lg border bg-card p-1.5 shadow-2xl animate-fade-in"
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-2 pb-1.5 pt-1 text-xs font-semibold">
        Mark AUX for {targets} schedule{targets > 1 ? "s" : ""}
      </div>
      <div className="flex items-center gap-1.5 px-2 pb-2 text-xs">
        <span className="text-muted-foreground">from</span>
        <Input type="time" step={300} className="h-7 w-24 text-xs" aria-label="AUX start" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} />
        <span className="text-muted-foreground">for</span>
      </div>
      <div className="flex flex-wrap gap-1 px-2 pb-2">
        {LENGTHS.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={length === m}
            onClick={() => setLength(m)}
            className={cn("rounded-full border px-2 py-0.5 text-[11px]", length === m ? "border-primary/60 bg-primary/10 font-semibold" : "text-muted-foreground hover:bg-muted/40")}
          >
            {m < 60 ? `${m}m` : `${m / 60}h`}
          </button>
        ))}
      </div>
      <div className="border-t pt-1">
        {AUX_KINDS.map((k) => (
          <div key={k.id} className="group flex items-center">
            <button
              role="menuitem"
              type="button"
              className={item}
              onClick={() => onPick({ kind: k.id, start: startMin, length, fullShift: !!k.fullShift })}
              title={k.fullShift ? "Marks the whole shift" : undefined}
            >
              <i className="h-2.5 w-4 rounded-full ring-1 ring-white/70" style={{ background: k.color }} />
              <span className="flex-1">{k.label}</span>
              <span className="tabular-nums text-[10px] text-muted-foreground">
                {k.fullShift ? "full shift" : `${fmtHM(startMin)}–${fmtHM(startMin + length)}`}
              </span>
            </button>
            {k.id !== "break" && k.id !== "lunch" && (
              <button
                type="button"
                aria-label={`More options for ${k.label}`}
                title="More options (note, waves, different times per agent)…"
                className="rounded p-1 text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => onMore(k.id, startMin)}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
      {removable > 0 && (
        <div className="mt-1 border-t pt-1">
          <button role="menuitem" type="button" className={cn(item, "text-destructive")} onClick={onRemove}>
            <Eraser className="h-3.5 w-3.5" /> Remove activities at {fmtHM(at)} ({removable})
          </button>
        </div>
      )}
    </div>
  )
}
