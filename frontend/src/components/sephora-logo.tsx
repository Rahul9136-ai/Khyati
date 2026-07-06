import { cn } from "@/lib/utils"

/**
 * Sephora brand mark — the tall, slender flame + spaced wordmark, drawn as
 * inline SVG/text (no image asset). Everything inherits `currentColor`, so the
 * mark reads near-black on light surfaces and white in dark mode.
 */
export function SephoraFlame({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 120"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      role="presentation"
    >
      <path d="M21.5 0 C 15.5 13, 11 26, 11.5 42 C 11.9 57, 14.8 66, 14.4 80 C 14 94, 11 106, 6 120 C 13.5 108, 17.6 95, 18.1 81 C 18.6 67, 15.7 57, 15.6 43 C 15.5 28, 18.2 12, 21.5 0 Z" />
    </svg>
  )
}

export function SephoraWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-semibold uppercase", className)} style={{ letterSpacing: "0.32em" }}>
      Sephora
    </span>
  )
}

const SIZES = {
  sm: { flame: "h-6", word: "text-sm" },
  md: { flame: "h-12", word: "text-xl" },
  lg: { flame: "h-16", word: "text-3xl" },
} as const

/**
 * Sephora lockup. `stacked` (default) mirrors the official logo — flame
 * centred above the wordmark; `horizontal` is a compact variant for tight
 * chrome like the sidebar header.
 */
export function SephoraLogo({
  className,
  size = "md",
  orientation = "stacked",
}: {
  className?: string
  size?: keyof typeof SIZES
  orientation?: "stacked" | "horizontal"
}) {
  const { flame, word } = SIZES[size]
  return (
    <div
      className={cn(
        "flex items-center text-foreground",
        orientation === "stacked" ? "flex-col gap-2" : "flex-row gap-2",
        className,
      )}
      aria-label="Sephora"
      role="img"
    >
      <SephoraFlame className={cn(flame, "w-auto")} />
      <SephoraWordmark className={word} />
    </div>
  )
}
