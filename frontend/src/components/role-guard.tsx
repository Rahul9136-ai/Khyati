import { ShieldOff } from "lucide-react"

import { PageHeader } from "@/components/page-header"
import { Card, CardContent } from "@/components/ui/card"
import type { ModuleId } from "@/lib/domain/roles"
import { MODULES } from "@/lib/domain/roles"
import { useWfm } from "@/store/wfm"

/** Wraps a route element; shows a restricted-access placeholder instead of the
 * page when the current designation has no view access to `module`. */
export function RoleGuard({ module, children }: { module: ModuleId; children: React.ReactNode }) {
  const can = useWfm((s) => s.can(module, "view"))
  const role = useWfm((s) => s.currentRole)
  if (can) return <>{children}</>

  const label = MODULES.find((m) => m.id === module)?.label ?? module
  return (
    <>
      <PageHeader title={label} subtitle="Access restricted" />
      <Card className="glass">
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <ShieldOff className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium">Your designation ({role}) doesn't have access to {label}.</p>
          <p className="max-w-sm text-xs text-muted-foreground">Switch designation from Settings → Roles & Permissions, or ask a Super Admin to grant access.</p>
        </CardContent>
      </Card>
    </>
  )
}
