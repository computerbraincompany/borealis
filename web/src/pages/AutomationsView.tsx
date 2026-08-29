import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  automationsApi,
  connectorsApi,
  formatApiError,
  chatsApi,
  type Automation,
  type AutomationRun,
  type Connector,
} from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

const OUTCOME_STYLING: Record<AutomationRun["outcome"], string> = {
  succeeded: "border-success/30 bg-success/10 text-success",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  skipped: "border-warning/30 bg-warning/10 text-warning",
};

export function AutomationsView() {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [chats, setChats] = useState<Array<{ id: string; title: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"connector_sync" | "agent_turn">("connector_sync");
  const [targetId, setTargetId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState(60);
  const [busy, setBusy] = useState(false);
  const [runsTarget, setRunsTarget] = useState<Automation | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);

  const load = useCallback(async () => {
    setPageError(null);
    try {
      const [rows, connectorRows, chatRows] = await Promise.all([
        automationsApi.list(),
        connectorsApi.list(),
        chatsApi.list(),
      ]);
      setAutomations(rows);
      setConnectors(connectorRows);
      setChats(chatRows.map((chat) => ({ id: chat.id, title: chat.title })));
    } catch (failure: unknown) {
      setPageError(formatApiError(failure, "Could not load automations"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!name.trim() || !targetId) return;
    setBusy(true);
    setPageError(null);
    try {
      await automationsApi.create({
        name: name.trim(),
        kind,
        target_id: targetId,
        ...(kind === "agent_turn" ? { prompt: prompt.trim() } : {}),
        schedule_minutes: schedule,
      });
      setCreating(false);
      setName("");
      setTargetId("");
      setPrompt("");
      await load();
    } catch (failure: unknown) {
      setPageError(formatApiError(failure, "Could not create the automation"));
    } finally {
      setBusy(false);
    }
  };

  const toggleState = async (automation: Automation) => {
    setPageError(null);
    try {
      await automationsApi.update(automation.id, { state: automation.state === "active" ? "paused" : "active" });
      await load();
    } catch (failure: unknown) {
      setPageError(formatApiError(failure, "Could not update the automation"));
    }
  };

  const remove = async (automation: Automation) => {
    setPageError(null);
    try {
      await automationsApi.remove(automation.id);
      setAutomations((current) => current.filter((entry) => entry.id !== automation.id));
    } catch (failure: unknown) {
      setPageError(formatApiError(failure, "Could not delete the automation"));
    }
  };

  const openRuns = async (automation: Automation) => {
    setRunsTarget(automation);
    try {
      setRuns(await automationsApi.runs(automation.id));
    } catch {
      setRuns([]);
    }
  };

  const targets =
    kind === "connector_sync"
      ? connectors.map((connector) => ({ id: connector.id, label: connector.name }))
      : chats.map((chat) => ({ id: chat.id, label: chat.title }));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Automations</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Durable, scheduled work with review. Connector refreshes run through the normal sync path; agent turns
              land in their bound chat as ordinary turns for you to read — nothing publishes itself.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New automation
            </Button>
          </div>
        </div>

        {pageError && (
          <div
            className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {pageError}
          </div>
        )}

        {loading ? (
          <div className="mt-8 space-y-3">
            {[0, 1].map((index) => (
              <Skeleton key={index} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        ) : automations.length === 0 ? (
          <Card className="mt-8 flex flex-col items-center gap-3 py-16 text-center">
            <CalendarClock className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No automations yet. Schedule a connector refresh or a recurring digest turn into a chat.
            </p>
          </Card>
        ) : (
          <div className="mt-8 space-y-3">
            {automations.map((automation) => (
              <Card
                key={automation.id}
                className="flex items-center gap-4 p-4 transition-colors hover:border-foreground/20"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <CalendarClock className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium text-foreground">{automation.name}</span>
                    <Badge variant="secondary">
                      {automation.kind === "connector_sync" ? "connector refresh" : "chat digest"}
                    </Badge>
                    <Badge variant="secondary">every {automation.schedule_minutes} min</Badge>
                    {automation.state === "paused" ? (
                      <Badge variant="secondary">paused</Badge>
                    ) : automation.consecutive_failures > 0 ? (
                      <Badge variant="secondary">{automation.consecutive_failures} recent failures</Badge>
                    ) : null}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Last run {automation.last_run_at ? formatDate(automation.last_run_at) : "never"} · next{" "}
                    {formatDate(automation.next_run_at)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => void openRuns(automation)}>
                    Runs
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title={automation.state === "active" ? "Pause automation" : "Resume automation"}
                    className="text-muted-foreground hover:text-primary"
                    onClick={() => void toggleState(automation)}
                  >
                    {automation.state === "active" ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Delete automation"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => void remove(automation)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* create dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New automation</DialogTitle>
            <DialogDescription>
              Runs every interval through the same gates as a manual action. Agent turns are reviewable in their chat.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              aria-label="Automation name"
              placeholder="Nightly ledger refresh"
              autoFocus
            />
            <select
              aria-label="Automation kind"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as "connector_sync" | "agent_turn");
                setTargetId("");
              }}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="connector_sync">Connector refresh</option>
              <option value="agent_turn">Chat digest (agent turn)</option>
            </select>
            <select
              aria-label="Automation target"
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="">{kind === "connector_sync" ? "Choose a connector…" : "Choose a chat…"}</option>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.label}
                </option>
              ))}
            </select>
            {kind === "agent_turn" && (
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                maxLength={8_000}
                aria-label="Automation prompt"
                placeholder="What this digest should do each run."
                className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            )}
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Every
              <Input
                type="number"
                min={15}
                max={10_080}
                value={schedule}
                onChange={(event) => setSchedule(Number(event.target.value) || 15)}
                aria-label="Schedule minutes"
                className="w-24"
              />
              minutes
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy || !name.trim() || !targetId}>
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* runs dialog */}
      <Dialog open={!!runsTarget} onOpenChange={(open) => !open && setRunsTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{runsTarget?.name} runs</DialogTitle>
            <DialogDescription>Durable run history with outcomes. Failed runs never contain content.</DialogDescription>
          </DialogHeader>
          <ol className="max-h-72 space-y-2 overflow-y-auto" aria-label="Automation runs">
            {runs.map((run) => (
              <li key={run.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${OUTCOME_STYLING[run.outcome]}`}
                  >
                    {run.outcome}
                  </span>
                  <time dateTime={run.started_at} className="text-xs text-muted-foreground">
                    {formatDate(run.started_at)}
                  </time>
                </div>
                {run.detail && <p className="mt-1.5 text-xs text-muted-foreground">{run.detail}</p>}
              </li>
            ))}
            {runs.length === 0 && (
              <li className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                No runs yet.
              </li>
            )}
          </ol>
        </DialogContent>
      </Dialog>
    </div>
  );
}
