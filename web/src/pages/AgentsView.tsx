import { useCallback, useEffect, useState } from "react";
import { Bot, Plus, RefreshCw, Trash2, History } from "lucide-react";
import { agentsApi, formatApiError, type AgentDetail, type AgentSummary } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

const EMPTY_INSTRUCTIONS = "";

export function AgentsView() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newInstructions, setNewInstructions] = useState(EMPTY_INSTRUCTIONS);
  const [busy, setBusy] = useState(false);
  const [reviseTarget, setReviseTarget] = useState<AgentSummary | null>(null);
  const [reviseInstructions, setReviseInstructions] = useState("");
  const [renameTarget, setRenameTarget] = useState<AgentSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [historyTarget, setHistoryTarget] = useState<AgentSummary | null>(null);
  const [historyDetail, setHistoryDetail] = useState<AgentDetail | null>(null);

  useEffect(() => {
    if (!historyTarget) {
      setHistoryDetail(null);
      return;
    }
    let cancelled = false;
    agentsApi
      .get(historyTarget.id)
      .then((detail) => {
        if (!cancelled) setHistoryDetail(detail);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [historyTarget]);

  const load = useCallback(async () => {
    setPageError(null);
    try {
      setAgents(await agentsApi.list());
    } catch (error: unknown) {
      setPageError(formatApiError(error, "Could not load agents"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const name = newName.trim();
    const instructions = newInstructions.trim();
    if (!name || !instructions) return;
    setBusy(true);
    setPageError(null);
    try {
      await agentsApi.create(name, newInstructions);
      setCreating(false);
      setNewName("");
      setNewInstructions(EMPTY_INSTRUCTIONS);
      await load();
    } catch (error: unknown) {
      setPageError(formatApiError(error, "Could not create the agent"));
    } finally {
      setBusy(false);
    }
  };

  const submitRevise = async () => {
    if (!reviseTarget) return;
    if (!reviseInstructions.trim() || reviseInstructions === reviseTarget.instructions) return;
    setBusy(true);
    setPageError(null);
    try {
      await agentsApi.update(reviseTarget.id, { instructions: reviseInstructions });
      setReviseTarget(null);
      await load();
    } catch (error: unknown) {
      setPageError(formatApiError(error, "Could not revise the agent"));
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name || name === renameTarget.name) return;
    setBusy(true);
    setPageError(null);
    try {
      await agentsApi.update(renameTarget.id, { name });
      setRenameTarget(null);
      await load();
    } catch (error: unknown) {
      setPageError(formatApiError(error, "Could not rename the agent"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (agent: AgentSummary) => {
    setPageError(null);
    try {
      await agentsApi.remove(agent.id);
      setAgents((current) => current.filter((entry) => entry.id !== agent.id));
    } catch (error: unknown) {
      setPageError(formatApiError(error, "Could not delete the agent"));
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Agents</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Named, versioned instruction sets for a job. An agent shapes how a chat works; it never widens what the
              runner can see or do.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New agent
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
        ) : agents.length === 0 ? (
          <Card className="mt-8 flex flex-col items-center gap-3 py-16 text-center">
            <Bot className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No agents yet. Create one — for example "Finance analyst" — and bind it when starting a chat.
            </p>
          </Card>
        ) : (
          <div className="mt-8 space-y-3">
            {agents.map((agent) => (
              <Card key={agent.id} className="p-4 transition-colors hover:border-foreground/20">
                <div className="flex items-start gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Bot className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-foreground">{agent.name}</span>
                      <Badge variant="secondary">v{agent.current_version}</Badge>
                      <span className="text-xs text-muted-foreground">{agent.instructions_chars} chars</span>
                    </div>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
                      {agent.instructions}
                    </p>
                    <div className="mt-1.5 text-xs text-muted-foreground">Created {formatDate(agent.created_at)}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setReviseTarget(agent);
                        setReviseInstructions(agent.instructions);
                      }}
                    >
                      Revise
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Revision history"
                      className="text-muted-foreground hover:text-primary"
                      onClick={() => setHistoryTarget(agent)}
                    >
                      <History className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Rename agent"
                      className="text-muted-foreground hover:text-primary"
                      onClick={() => {
                        setRenameTarget(agent);
                        setRenameValue(agent.name);
                      }}
                    >
                      <RefreshCw className="h-4 w-4 rotate-90" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Delete agent"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => void remove(agent)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
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
            <DialogTitle>New agent</DialogTitle>
            <DialogDescription>
              Instructions are versioned: revising an agent later never changes chats already underway.
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
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              maxLength={80}
              aria-label="Agent name"
              placeholder="Finance analyst"
              autoFocus
            />
            <textarea
              value={newInstructions}
              onChange={(event) => setNewInstructions(event.target.value)}
              maxLength={8_000}
              aria-label="Agent instructions"
              placeholder="How this agent should work: tone, checklists, analysis habits."
              className="min-h-40 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy || !newName.trim() || !newInstructions.trim()}>
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* revise dialog */}
      <Dialog open={!!reviseTarget} onOpenChange={(value) => !value && setReviseTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Revise {reviseTarget?.name}</DialogTitle>
            <DialogDescription>
              Saving creates version {(reviseTarget?.current_version ?? 0) + 1}. Earlier revisions are kept and bound
              chats keep the revision they started with.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRevise();
            }}
          >
            <textarea
              value={reviseInstructions}
              onChange={(event) => setReviseInstructions(event.target.value)}
              maxLength={8_000}
              aria-label="Agent instructions"
              className="min-h-40 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setReviseTarget(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={busy || !reviseInstructions.trim() || reviseInstructions === reviseTarget?.instructions}
              >
                Save revision
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* rename dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(value) => !value && setRenameTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename agent</DialogTitle>
            <DialogDescription>Give this agent a name you can recognize later.</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <Input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={80}
              aria-label="Agent name"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setRenameTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy || !renameValue.trim()}>
                Rename
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* history dialog */}
      <Dialog open={!!historyTarget} onOpenChange={(value) => !value && setHistoryTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{historyTarget?.name} revisions</DialogTitle>
            <DialogDescription>Instructions are immutable per version; the newest one runs next.</DialogDescription>
          </DialogHeader>
          <ol className="max-h-72 space-y-2 overflow-y-auto" aria-label="Agent revisions">
            {(historyDetail?.revisions ?? []).map((revision) => (
              <li key={revision.version} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="secondary">v{revision.version}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(revision.created_at)} · {revision.instructions.length} chars
                  </span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-xs text-muted-foreground">{revision.instructions}</p>
              </li>
            ))}
            {historyTarget && !historyDetail && (
              <li className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                Loading revisions…
              </li>
            )}
          </ol>
        </DialogContent>
      </Dialog>
    </div>
  );
}
