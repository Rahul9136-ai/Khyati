import { Lock } from "lucide-react"

import type { AccessLevel, ModuleId } from "@/lib/domain/roles"
import { useWfm } from "@/store/wfm"

/**
 * Renders `children` only if the current designation (role) has at least
 * `min` access to `module`. Otherwise renders `fallback` (default: nothing).
 * Use this to gate buttons/actions — page-level "no access" screens are
 * handled separately by `RoleGuard`.
 */
export function PermissionGate({
  module,
  min = "edit",
  children,
  fallback = null,
}: {
  module: ModuleId
  min?: AccessLevel
  children: React.ReactNode
  fallback?: React.ReactNode
}) {
  const can = useWfm((s) => s.can(module, min))
  if (!can) return <>{fallback}</>
  return <>{children}</>
}

/** A small disabled-look badge to show in place of a gated action, so it's clear the control exists but is locked rather than silently missing. */
export function LockedHint({ label = "Restricted" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground">
      <Lock className="h-3 w-3" /> {label}
    </span>
  )
}
