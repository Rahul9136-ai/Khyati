import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, MessageSquare, Send, Slack } from "lucide-react"
import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  type ConfigPatch, getConfig, testDispatch, updateConfig,
} from "@/lib/integrations"
import { useAuth } from "@/store/auth"

/** Settings card to connect the Slack/Teams approval bridge. Only rendered for
 *  users holding the backend `integration:manage` permission. Secrets are
 *  write-only — the API returns "…set" flags, never the values. */
export function IntegrationsSettings() {
  const qc = useQueryClient()
  const perms = useAuth((s) => s.user?.permission_codes ?? [])
  const canManage = perms.includes("integration:manage")

  const { data: config } = useQuery({
    queryKey: ["integration-config"], queryFn: getConfig, enabled: canManage, retry: false,
  })
  const [slackWebhook, setSlackWebhook] = useState("")
  const [slackSecret, setSlackSecret] = useState("")
  const [slackChannel, setSlackChannel] = useState("")
  const [teamsWebhook, setTeamsWebhook] = useState("")
  const [teamsToken, setTeamsToken] = useState("")
  const [testResult, setTestResult] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (patch: ConfigPatch) => updateConfig(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integration-config"] }),
  })
  const runTest = useMutation({
    mutationFn: testDispatch,
    onSuccess: (d) => setTestResult(
      d.results.length
        ? d.results.map((r) => `${r.channel}: ${r.simulated ? "simulated" : r.ok ? "sent" : "failed"}`).join(" · ")
        : "No channels enabled.",
    ),
  })

  if (!canManage) return null

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" /> Slack / Teams approval bridge
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Route real-time & scheduling changes to the Operations Manager for sign-off in chat.
          Leave a channel enabled with no webhook to run it in <b>simulated</b> mode.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Slack */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium"><Slack className="h-4 w-4" /> Slack</div>
            <div className="flex items-center gap-2">
              {config?.slack_webhook_set && <Badge variant="success">webhook set</Badge>}
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" className="accent-primary" checked={config?.slack_enabled ?? false}
                  onChange={(e) => save.mutate({ slack_enabled: e.target.checked })} /> enabled
              </label>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder="Incoming webhook URL (https://hooks.slack.com/…)" value={slackWebhook} onChange={(e) => setSlackWebhook(e.target.value)} />
            <Input placeholder="Channel (#wfm-approvals)" value={slackChannel} onChange={(e) => setSlackChannel(e.target.value)} />
            <Input placeholder="Signing secret (for button callbacks)" value={slackSecret} onChange={(e) => setSlackSecret(e.target.value)} />
            <Button variant="outline" disabled={save.isPending}
              onClick={() => save.mutate({
                ...(slackWebhook ? { slack_webhook_url: slackWebhook } : {}),
                ...(slackSecret ? { slack_signing_secret: slackSecret } : {}),
                ...(slackChannel ? { slack_channel: slackChannel } : {}),
              })}>
              Save Slack
            </Button>
          </div>
        </div>

        {/* Teams */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium"><MessageSquare className="h-4 w-4" /> Microsoft Teams</div>
            <div className="flex items-center gap-2">
              {config?.teams_webhook_set && <Badge variant="success">webhook set</Badge>}
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" className="accent-primary" checked={config?.teams_enabled ?? false}
                  onChange={(e) => save.mutate({ teams_enabled: e.target.checked })} /> enabled
              </label>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder="Incoming webhook URL" value={teamsWebhook} onChange={(e) => setTeamsWebhook(e.target.value)} />
            <Input placeholder="Security token (echoed on callbacks)" value={teamsToken} onChange={(e) => setTeamsToken(e.target.value)} />
            <Button variant="outline" disabled={save.isPending}
              onClick={() => save.mutate({
                ...(teamsWebhook ? { teams_webhook_url: teamsWebhook } : {}),
                ...(teamsToken ? { teams_security_token: teamsToken } : {}),
              })}>
              Save Teams
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-primary" checked={config?.auto_apply_on_approve ?? true}
              onChange={(e) => save.mutate({ auto_apply_on_approve: e.target.checked })} />
            <span className="text-muted-foreground">Auto-apply the change the moment the OM approves</span>
          </label>
          <div className="flex items-center gap-3">
            {testResult && <span className="flex items-center gap-1 text-xs text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> {testResult}</span>}
            <Button disabled={runTest.isPending} onClick={() => runTest.mutate()}>
              <Send className="h-4 w-4" /> Send test card
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
