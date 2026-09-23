import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, CheckCircle2, MessageSquare, Send, Slack } from "lucide-react"
import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { api } from "@/lib/api"
import {
  type ConfigPatch, getConfig, testDispatch, updateConfig,
} from "@/lib/integrations"
import { useAuth } from "@/store/auth"

const CONFIDENCE_OPTIONS = [
  { value: "High", label: "High only" },
  { value: "Medium", label: "High + Medium" },
  { value: "Off", label: "Never (always ask the OM)" },
]

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
  const [slackCmdChannel, setSlackCmdChannel] = useState("")
  const [teamsCmdChannel, setTeamsCmdChannel] = useState("")
  const [teamsAppId, setTeamsAppId] = useState("")
  const [teamsAppPassword, setTeamsAppPassword] = useState("")
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

        {/* Inbound automation */}
        <div className="space-y-2.5 border-t pt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium"><Bot className="h-4 w-4" /> Inbound automation</div>
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" className="accent-primary" checked={config?.automation_enabled ?? false}
                onChange={(e) => save.mutate({ automation_enabled: e.target.checked })} /> enabled
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            @mention the bot in the channel below on Slack or Teams with a schedule-change message (e.g. "@FlowForce
            Priya E1004 called in sick today") and it's parsed automatically — no pasting into the app. Mark Leave,
            Cancel Leave, Mark Absence and Change Shift Timing (only when the message states an explicit new start
            and end time) apply immediately once the parse meets the confidence threshold below and a directory
            employee ID is found; Shift Swap and anything unrecognised always go to the Operations Manager. Either
            way you get a reply in the same thread, and every request — automatic or not — is on the Approvals page.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs">
              <span className="mb-1 block text-muted-foreground">Auto-apply threshold</span>
              <Select className="w-full" value={config?.auto_apply_min_confidence ?? "High"} options={CONFIDENCE_OPTIONS}
                onChange={(e) => save.mutate({ auto_apply_min_confidence: e.target.value as "High" | "Medium" | "Off" })} />
            </label>
            <div />
            <Input placeholder="Slack command channel ID (e.g. C0123ABC)" value={slackCmdChannel}
              onChange={(e) => setSlackCmdChannel(e.target.value)} />
            <Button variant="outline" size="sm" disabled={save.isPending || !slackCmdChannel}
              onClick={() => save.mutate({ slack_command_channel: slackCmdChannel })}>
              Save Slack channel {config?.slack_command_channel && `(current: ${config.slack_command_channel})`}
            </Button>
            <Input placeholder="Teams command conversation ID" value={teamsCmdChannel}
              onChange={(e) => setTeamsCmdChannel(e.target.value)} />
            <Button variant="outline" size="sm" disabled={save.isPending || !teamsCmdChannel}
              onClick={() => save.mutate({ teams_command_channel: teamsCmdChannel })}>
              Save Teams channel {config?.teams_command_channel && `(current: ${config.teams_command_channel})`}
            </Button>
            <Input placeholder="Teams app ID (Azure Bot registration, optional)" value={teamsAppId}
              onChange={(e) => setTeamsAppId(e.target.value)} />
            <Input placeholder="Teams app password (optional)" value={teamsAppPassword}
              onChange={(e) => setTeamsAppPassword(e.target.value)} />
            <Button variant="outline" size="sm" disabled={save.isPending || !(teamsAppId || teamsAppPassword)}
              onClick={() => save.mutate({
                ...(teamsAppId ? { teams_app_id: teamsAppId } : {}),
                ...(teamsAppPassword ? { teams_app_password: teamsAppPassword } : {}),
              })}>
              Save Teams app credentials
              {config?.teams_app_id_set && <Badge variant="success" className="ml-2">set</Badge>}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Slack: point the app's Event Subscriptions Request URL at{" "}
            <code className="rounded bg-muted px-1">{api.defaults.baseURL}/integrations/slack/events</code>, subscribe
            to <code className="rounded bg-muted px-1">app_mention</code>. Teams: point the bot's messaging endpoint at{" "}
            <code className="rounded bg-muted px-1">{api.defaults.baseURL}/integrations/teams/messages</code>. Without
            a Teams app ID/password above, the reply is recorded but not actually sent (the rest of this Teams
            integration already runs the same way when it isn't fully configured).
          </p>
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
