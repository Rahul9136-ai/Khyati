import { cn } from "@/lib/utils"

/**
 * Purvi.AI brand mark — the hex/node network glyph from Purvi Technology's
 * own site logo (purvi-technology/public/logo-full.svg), redrawn inline here
 * so its gradient can share this app's theme tokens.
 */
export function PurviMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" className={className} aria-hidden="true" role="presentation">
      <defs>
        <linearGradient id="purvi-g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#60A5FA" />
          <stop offset="55%" stopColor="#8B5CF6" />
          <stop offset="100%" stopColor="#C084FC" />
        </linearGradient>
        <linearGradient id="purvi-g2" x1="100%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#C084FC" />
          <stop offset="100%" stopColor="#60A5FA" />
        </linearGradient>
      </defs>
      <path d="M 60 8 A 52 52 0 0 1 112 60" fill="none" stroke="url(#purvi-g)" strokeWidth="3" strokeLinecap="round" opacity="0.9" />
      <path d="M 60 112 A 52 52 0 0 1 8 60" fill="none" stroke="url(#purvi-g2)" strokeWidth="3" strokeLinecap="round" opacity="0.9" />
      <g stroke="url(#purvi-g)" strokeWidth="2" opacity="0.75">
        <line x1="60" y1="60" x2="60" y2="24" />
        <line x1="60" y1="60" x2="91" y2="42" />
        <line x1="60" y1="60" x2="91" y2="78" />
        <line x1="60" y1="60" x2="60" y2="96" />
        <line x1="60" y1="60" x2="29" y2="78" />
        <line x1="60" y1="60" x2="29" y2="42" />
        <line x1="60" y1="24" x2="91" y2="42" />
        <line x1="91" y1="42" x2="91" y2="78" />
        <line x1="91" y1="78" x2="60" y2="96" />
        <line x1="60" y1="96" x2="29" y2="78" />
        <line x1="29" y1="78" x2="29" y2="42" />
        <line x1="29" y1="42" x2="60" y2="24" />
      </g>
      <circle cx="60" cy="60" r="8" fill="url(#purvi-g)" />
      <circle cx="60" cy="60" r="12" fill="none" stroke="url(#purvi-g)" strokeWidth="1.5" opacity="0.4" />
      <circle cx="60" cy="24" r="4.5" fill="#60A5FA" />
      <circle cx="91" cy="42" r="4.5" fill="#818CF8" />
      <circle cx="91" cy="78" r="4.5" fill="#A78BFA" />
      <circle cx="60" cy="96" r="4.5" fill="#C084FC" />
      <circle cx="29" cy="78" r="4.5" fill="#8B5CF6" />
      <circle cx="29" cy="42" r="4.5" fill="#6366F1" />
    </svg>
  )
}

export function PurviWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-bold tracking-tight", className)}>
      Purvi<span className="bg-gradient-to-r from-[#60A5FA] to-[#C084FC] bg-clip-text text-transparent">.AI</span>
    </span>
  )
}

const SIZES = {
  sm: { mark: "h-6 w-6", word: "text-sm" },
  md: { mark: "h-10 w-10", word: "text-xl" },
  lg: { mark: "h-14 w-14", word: "text-3xl" },
} as const

/**
 * Purvi.AI lockup. `stacked` (default) centres the mark above the wordmark
 * for the login screen; `horizontal` is a compact side-by-side variant for
 * tight chrome like the sidebar header.
 */
export function PurviLogo({
  className,
  size = "md",
  orientation = "stacked",
}: {
  className?: string
  size?: keyof typeof SIZES
  orientation?: "stacked" | "horizontal"
}) {
  const { mark, word } = SIZES[size]
  return (
    <div
      className={cn(
        "flex items-center text-foreground",
        orientation === "stacked" ? "flex-col gap-2" : "flex-row gap-2",
        className,
      )}
      aria-label="Purvi.AI"
      role="img"
    >
      <PurviMark className={cn(mark, "shrink-0")} />
      <PurviWordmark className={word} />
    </div>
  )
}
