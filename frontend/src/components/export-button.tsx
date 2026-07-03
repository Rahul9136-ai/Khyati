import { ChevronDown, Download, FileSpreadsheet, FileText } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { downloadCSV, downloadXLSX, type Sheet } from "@/lib/export"
import { cn } from "@/lib/utils"

/**
 * Export control shown on every KPI / metrics screen. `sheets` is lazy so data is
 * gathered only on click. Excel gets one worksheet per section; CSV concatenates.
 */
export function ExportButton({
  filename,
  sheets,
  label = "Export",
  variant = "outline",
}: {
  filename: string
  sheets: () => Sheet[]
  label?: string
  variant?: "outline" | "default" | "ghost"
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  const run = (fn: (b: string, s: Sheet[]) => void) => {
    fn(filename, sheets())
    setOpen(false)
  }

  return (
    <div className="relative" ref={ref}>
      <Button variant={variant} onClick={() => setOpen((o) => !o)}>
        <Download className="h-4 w-4" /> {label}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </Button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-44 overflow-hidden rounded-lg border bg-card shadow-xl animate-fade-in">
          <button className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent" onClick={() => run(downloadXLSX)}>
            <FileSpreadsheet className="h-4 w-4 text-emerald-500" /> Excel (.xlsx)
          </button>
          <button className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent" onClick={() => run(downloadCSV)}>
            <FileText className="h-4 w-4 text-primary" /> CSV (.csv)
          </button>
        </div>
      )}
    </div>
  )
}
