import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarClock, Loader2, Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  automationsApi,
  connectorsApi,
  formatApiError,
  chatsApi,
  type Automation,
  type AutomationRun,
  type Connector,
} from "@/lib/api";
import { mergeCatalogContinuation, mergeCatalogHead } from "@/lib/catalogMerge";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useEgressConsentGate } from "@/hooks/useEgressConsentGate";

const OUTCOME_STYLING: Record<AutomationRun["outcome"], string> = {
  succeeded: "border-success/30 bg-success/10 text-success",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  skipped: "border-warning/30 bg-warning/10 text-warning",
};

const SCHEDULE_MIN_MINUTES = 15;
const SCHEDULE_MAX_MINUTES = 10_080;

export function AutomationsView() {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [chats, setChats] = useState<Array<{ id: string; title: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [connectorsNextCursor, setConnectorsNextCursor] = useState<string | null>(null);
  const [chatsNextCursor, setChatsNextCursor] = useState<string | null>(null);
  const [targetsLoadingMore, setTargetsLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  // Mutations that fail while a dialog is open must surface inside that dialog;
  // the page banner is hidden behind the modal overlay.
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"connector_sync" | "agent_turn">("connector_sync");
  const [targetId, setTargetId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [scheduleDraft, setScheduleDraft] = useState("60");
  const [busy, setBusy] = useState(false);
  const [runsTarget, setRunsTarget] = useState<Automation | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const createRequestRef = useRef(0);
  const createAbortRef = useRef<AbortController | null>(null);
  const rowMutationRequestRef = useRef(0);
  const rowMutationRequestsRef = useRef(new Map<string, { requestId: number; abort: AbortController }>());
  const runsRequestRef = useRef(0);
  const runsAbortRef = useRef<AbortController | null>(null);
  const catalogRequestRef = useRef(0);
  const catalogNextCursorRef = useRef<string | null>(null);
  const catalogLoadingMoreOwnerRef = useRef<number | null>(null);
  const targetsRequestRef = useRef(0);
  const targetsAbortRef = useRef<AbortController | null>(null);
  const kindRef = useRef(kind);
  const connectorsNextCursorRef = useRef<string | null>(null);
  const chatsNextCursorRef = useRef<string | null>(null);
  const targetsLoadingMoreOwnerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const { handleConsentError, dialog: consentDialog } = useEgressConsentGate();

  const invalidateCatalog = () => {
    catalogRequestRef.current += 1;
    catalogLoadingMoreOwnerRef.current = null;
    setLoadingMore(false);
    setLoading(false);
  };

  const invalidateTargetPagination = () => {
    if (targetsLoadingMoreOwnerRef.current === null) return;
    targetsRequestRef.current += 1;
    targetsAbortRef.current?.abort();
    targetsAbortRef.current = null;
    targetsLoadingMoreOwnerRef.current = null;
    setTargetsLoadingMore(false);
  };

  const load = useCallback(async () => {
    const catalogRequestId = ++catalogRequestRef.current;
    const targetsRequestId = ++targetsRequestRef.current;
    targetsAbortRef.current?.abort();
    targetsAbortRef.current = null;
    catalogLoadingMoreOwnerRef.current = null;
    targetsLoadingMoreOwnerRef.current = null;
    setLoadingMore(false);
    setTargetsLoadingMore(false);
    setPageError(null);
    // Independent lists: a target-list failure should not discard successfully
    // loaded automations, and vice versa.
    const [rowsResult, connectorsResult, chatsResult] = await Promise.allSettled([
      automationsApi.list(),
      connectorsApi.list(),
      chatsApi.list(),
    ]);
    if (!mountedRef.current) return;
    let automationsError: string | null = null;
    if (rowsResult.status === "fulfilled") {
      if (catalogRequestId === catalogRequestRef.current) {
        setAutomations((current) => mergeCatalogHead(rowsResult.value.items, current));
        catalogNextCursorRef.current = rowsResult.value.next_cursor;
        setNextCursor(rowsResult.value.next_cursor);
      }
    } else {
      automationsError = formatApiError(rowsResult.reason, "Could not load automations");
    }
    let targetsError: string | null = null;
    if (connectorsResult.status === "fulfilled" && chatsResult.status === "fulfilled") {
      if (targetsRequestId === targetsRequestRef.current) {
        setConnectors((current) => mergeCatalogHead(connectorsResult.value.items, current));
        setChats((current) =>
          mergeCatalogHead(
            chatsResult.value.items.map((chat) => ({ id: chat.id, title: chat.title })),
            current,
          ),
        );
        connectorsNextCursorRef.current = connectorsResult.value.next_cursor;
        chatsNextCursorRef.current = chatsResult.value.next_cursor;
        setConnectorsNextCursor(connectorsResult.value.next_cursor);
        setChatsNextCursor(chatsResult.value.next_cursor);
      }
    } else {
      const failure =
        connectorsResult.status === "rejected"
          ? connectorsResult.reason
          : chatsResult.status === "rejected"
            ? chatsResult.reason
            : new Error("Could not load automation targets");
      targetsError = formatApiError(failure, "Could not load automation targets");
    }
    if (mountedRef.current && (automationsError || targetsError)) {
      setPageError([automationsError, targetsError].filter(Boolean).join(" "));
    }
    if (mountedRef.current && catalogRequestId === catalogRequestRef.current) setLoading(false);
  }, []);

  const loadMore = async () => {
    const cursor = catalogNextCursorRef.current;
    if (!cursor || catalogLoadingMoreOwnerRef.current !== null) return;
    const requestId = ++catalogRequestRef.current;
    catalogLoadingMoreOwnerRef.current = requestId;
    setLoadingMore(true);
    try {
      const page = await automationsApi.list({ cursor });
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return;
      setAutomations((current) => mergeCatalogContinuation(current, page.items));
      catalogNextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === catalogRequestRef.current) {
        setPageError(formatApiError(failure, "Could not load older automations"));
      }
    } finally {
      if (catalogLoadingMoreOwnerRef.current === requestId) {
        catalogLoadingMoreOwnerRef.current = null;
        if (mountedRef.current) setLoadingMore(false);
      }
    }
  };

  const loadMoreTargets = async () => {
    const cursor = kind === "connector_sync" ? connectorsNextCursorRef.current : chatsNextCursorRef.current;
    if (!cursor || targetsLoadingMoreOwnerRef.current !== null) return;
    const requestId = ++targetsRequestRef.current;
    targetsLoadingMoreOwnerRef.current = requestId;
    const targetKind = kind;
    const abort = new AbortController();
    targetsAbortRef.current = abort;
    setTargetsLoadingMore(true);
    try {
      if (targetKind === "connector_sync") {
        const page = await connectorsApi.list({ cursor, signal: abort.signal });
        if (
          !mountedRef.current ||
          requestId !== targetsRequestRef.current ||
          abort.signal.aborted ||
          kindRef.current !== targetKind
        )
          return;
        setConnectors((current) => mergeCatalogContinuation(current, page.items));
        connectorsNextCursorRef.current = page.next_cursor;
        setConnectorsNextCursor(page.next_cursor);
      } else {
        const page = await chatsApi.list({ cursor, signal: abort.signal });
        if (
          !mountedRef.current ||
          requestId !== targetsRequestRef.current ||
          abort.signal.aborted ||
          kindRef.current !== targetKind
        )
          return;
        setChats((current) =>
          mergeCatalogContinuation(
            current,
            page.items.map((chat) => ({ id: chat.id, title: chat.title })),
          ),
        );
        chatsNextCursorRef.current = page.next_cursor;
        setChatsNextCursor(page.next_cursor);
      }
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === targetsRequestRef.current && !abort.signal.aborted) {
        // Target pagination only happens inside the create dialog; keep the
        // message visible instead of hiding it behind the modal overlay.
        setDialogError(formatApiError(failure, "Could not load older automation targets"));
      }
    } finally {
      if (targetsLoadingMoreOwnerRef.current === requestId) {
        targetsLoadingMoreOwnerRef.current = null;
        if (targetsAbortRef.current === abort) targetsAbortRef.current = null;
        if (mountedRef.current) setTargetsLoadingMore(false);
      }
    }
  };

  useEffect(() => {
    const rowMutationRequests = rowMutationRequestsRef.current;
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      catalogRequestRef.current += 1;
      targetsRequestRef.current += 1;
      targetsAbortRef.current?.abort();
      targetsAbortRef.current = null;
      catalogLoadingMoreOwnerRef.current = null;
      targetsLoadingMoreOwnerRef.current = null;
      createRequestRef.current += 1;
      createAbortRef.current?.abort();
      createAbortRef.current = null;
      for (const request of rowMutationRequests.values()) request.abort.abort();
      rowMutationRequests.clear();
      runsRequestRef.current += 1;
      runsAbortRef.current?.abort();
    };
  }, [load]);

  // Schedules fire in the background, so keep Last run/next run and the
  // failure badge fresh while anything is active. Visibility-aware and
  // request-guarded, mirroring the other live surfaces.
  const hasActiveAutomation = automations.some((automation) => automation.state === "active");
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!hasActiveAutomation) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadRef.current();
    }, 45_000);
    return () => window.clearInterval(timer);
  }, [hasActiveAutomation]);

  const openCreateDialog = () => {
    invalidateTargetPagination();
    createRequestRef.current += 1;
    createAbortRef.current?.abort();
    createAbortRef.current = null;
    setDialogError(null);
    setBusy(false);
    setCreating(true);
  };

  const closeCreateDialog = () => {
    invalidateTargetPagination();
    createRequestRef.current += 1;
    createAbortRef.current?.abort();
    createAbortRef.current = null;
    setDialogError(null);
    setBusy(false);
    setCreating(false);
  };

  const create = async () => {
    const parsedSchedule = Number.parseInt(scheduleDraft, 10);
    if (
      !Number.isInteger(parsedSchedule) ||
      parsedSchedule < SCHEDULE_MIN_MINUTES ||
      parsedSchedule > SCHEDULE_MAX_MINUTES
    ) {
      setDialogError(`Schedule must be between ${SCHEDULE_MIN_MINUTES} and ${SCHEDULE_MAX_MINUTES} minutes.`);
      return;
    }
    const createInput = {
      name: name.trim(),
      kind,
      target_id: targetId,
      ...(kind === "agent_turn" ? { prompt: prompt.trim() } : {}),
      schedule_minutes: parsedSchedule,
    };
    if (!createInput.name || !createInput.target_id) return;
    const requestId = ++createRequestRef.current;
    createAbortRef.current?.abort();
    const abort = new AbortController();
    createAbortRef.current = abort;
    setBusy(true);
    setDialogError(null);
    try {
      const created = await automationsApi.create(createInput, abort.signal);
      if (requestId !== createRequestRef.current || abort.signal.aborted) return;
      invalidateCatalog();
      setAutomations((current) => mergeCatalogHead([created], current));
      void load();
      setName("");
      setTargetId("");
      setPrompt("");
      setScheduleDraft("60");
      createAbortRef.current = null;
      closeCreateDialog();
    } catch (failure: unknown) {
      if (requestId !== createRequestRef.current || abort.signal.aborted) return;
      // A connector refresh automation needs remote-egress consent like any
      // other sync; the consent card resumes this exact create on approval.
      if (handleConsentError(failure, () => void create())) return;
      setDialogError(formatApiError(failure, "Could not create the automation"));
    } finally {
      if (requestId === createRequestRef.current && !abort.signal.aborted) {
        createAbortRef.current = null;
        setBusy(false);
      }
    }
  };

  const toggleState = async (automation: Automation) => {
    const targetId = automation.id;
    if (togglingId === targetId || deletingId === targetId) return;
    const patch = { state: automation.state === "active" ? ("paused" as const) : ("active" as const) };
    const requestId = ++rowMutationRequestRef.current;
    rowMutationRequestsRef.current.get(targetId)?.abort.abort();
    const abort = new AbortController();
    rowMutationRequestsRef.current.set(targetId, { requestId, abort });
    setPageError(null);
    setTogglingId(targetId);
    try {
      const updated = await automationsApi.update(targetId, patch, abort.signal);
      if (rowMutationRequestsRef.current.get(targetId)?.requestId !== requestId || abort.signal.aborted) return;
      invalidateCatalog();
      setAutomations((current) => current.map((entry) => (entry.id === targetId ? updated : entry)));
    } catch (failure: unknown) {
      if (rowMutationRequestsRef.current.get(targetId)?.requestId === requestId && !abort.signal.aborted) {
        setPageError(formatApiError(failure, "Could not update the automation"));
      }
    } finally {
      if (rowMutationRequestsRef.current.get(targetId)?.requestId === requestId) {
        rowMutationRequestsRef.current.delete(targetId);
      }
      setTogglingId((current) => (current === targetId ? null : current));
    }
  };

  const remove = async (automation: Automation) => {
    const targetId = automation.id;
    const requestId = ++rowMutationRequestRef.current;
    rowMutationRequestsRef.current.get(targetId)?.abort.abort();
    const abort = new AbortController();
    rowMutationRequestsRef.current.set(targetId, { requestId, abort });
    setPageError(null);
    try {
      await automationsApi.remove(targetId, abort.signal);
      if (rowMutationRequestsRef.current.get(targetId)?.requestId !== requestId || abort.signal.aborted) return;
      invalidateCatalog();
      setAutomations((current) => current.filter((entry) => entry.id !== targetId));
    } catch (failure: unknown) {
      if (rowMutationRequestsRef.current.get(targetId)?.requestId === requestId && !abort.signal.aborted) {
        setPageError(formatApiError(failure, "Could not delete the automation"));
      }
    } finally {
      if (rowMutationRequestsRef.current.get(targetId)?.requestId === requestId) {
        rowMutationRequestsRef.current.delete(targetId);
      }
    }
  };

  const confirmRemove = async () => {
    if (!deleteTarget || deletingId === deleteTarget.id) return;
    const automation = deleteTarget;
    setDeletingId(automation.id);
    setPageError(null);
    try {
      await remove(automation);
      setDeleteTarget(null);
    } finally {
      setDeletingId(null);
    }
  };

  const openRuns = async (automation: Automation) => {
    const requestId = ++runsRequestRef.current;
    runsAbortRef.current?.abort();
    const abort = new AbortController();
    runsAbortRef.current = abort;
    setRunsTarget(automation);
    setRuns([]);
    setRunsError(null);
    setRunsLoading(true);
    try {
      const nextRuns = await automationsApi.runs(automation.id, 20, abort.signal);
      if (requestId === runsRequestRef.current && !abort.signal.aborted) setRuns(nextRuns);
    } catch (failure: unknown) {
      if (requestId === runsRequestRef.current && !abort.signal.aborted) {
        setRunsError(formatApiError(failure, "Could not load automation runs"));
      }
    } finally {
      if (requestId === runsRequestRef.current && !abort.signal.aborted) setRunsLoading(false);
    }
  };

  const closeRuns = () => {
    runsRequestRef.current += 1;
    runsAbortRef.current?.abort();
    runsAbortRef.current = null;
    setRunsTarget(null);
    setRuns([]);
    setRunsError(null);
    setRunsLoading(false);
  };

  const targets =
    kind === "connector_sync"
      ? connectors.map((connector) => ({ id: connector.id, label: connector.name }))
      : chats.map((chat) => ({ id: chat.id, label: chat.title }));

  return (
    <div className="h-full overflow-y-auto">
      {consentDialog}
      {deleteTarget && (
        <ConfirmDialog
          title={`Delete “${deleteTarget.name}”?`}
          description="This removes the automation and stops its schedule. Recorded run history stays available in sync history where applicable. This cannot be undone."
          busy={deletingId === deleteTarget.id}
          onConfirm={() => void confirmRemove()}
          onCancel={() => {
            if (deletingId !== deleteTarget.id) setDeleteTarget(null);
          }}
        />
      )}
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
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /> Refresh
            </Button>
            <Button size="sm" onClick={openCreateDialog}>
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
                      <Badge variant="pending">paused</Badge>
                    ) : automation.consecutive_failures > 0 ? (
                      <Badge variant="destructive">{automation.consecutive_failures} recent failures</Badge>
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
                    title={
                      togglingId === automation.id
                        ? "Saving…"
                        : automation.state === "active"
                          ? "Pause automation"
                          : "Resume automation"
                    }
                    aria-label={
                      automation.state === "active" ? `Pause ${automation.name}` : `Resume ${automation.name}`
                    }
                    aria-busy={togglingId === automation.id}
                    className="text-muted-foreground hover:text-primary"
                    disabled={togglingId === automation.id || deletingId === automation.id}
                    onClick={() => void toggleState(automation)}
                  >
                    {togglingId === automation.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : automation.state === "active" ? (
                      <Pause className="h-4 w-4" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Delete automation"
                    aria-label={`Delete ${automation.name}`}
                    className="text-muted-foreground hover:text-destructive"
                    disabled={deletingId === automation.id}
                    onClick={() => {
                      setPageError(null);
                      setDeleteTarget(automation);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            ))}
            {nextCursor && (
              <div className="flex justify-center pt-2">
                <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                  Load older automations
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* create dialog */}
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (open) openCreateDialog();
          else if (!busy) closeCreateDialog();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New automation</DialogTitle>
            <DialogDescription>
              Runs every interval through the same gates as a manual action. Agent turns are reviewable in their chat.
            </DialogDescription>
          </DialogHeader>
          {dialogError && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {dialogError}
            </p>
          )}
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
                const nextKind = event.target.value as "connector_sync" | "agent_turn";
                invalidateTargetPagination();
                kindRef.current = nextKind;
                setKind(nextKind);
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
            {(kind === "connector_sync" ? connectorsNextCursor : chatsNextCursor) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void loadMoreTargets()}
                disabled={targetsLoadingMore}
              >
                {targetsLoadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                Load older {kind === "connector_sync" ? "connectors" : "chats"}
              </Button>
            )}
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
                min={SCHEDULE_MIN_MINUTES}
                max={SCHEDULE_MAX_MINUTES}
                value={scheduleDraft}
                onChange={(event) => setScheduleDraft(event.target.value)}
                aria-label="Schedule minutes"
                aria-invalid={Boolean(dialogError && dialogError.startsWith("Schedule"))}
                className="w-24"
              />
              minutes
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={closeCreateDialog}>
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
      <Dialog open={!!runsTarget} onOpenChange={(open) => !open && closeRuns()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{runsTarget?.name} runs</DialogTitle>
            <DialogDescription>Durable run history with outcomes. Failed runs never contain content.</DialogDescription>
          </DialogHeader>
          <ol className="max-h-72 space-y-2 overflow-y-auto" aria-label="Automation runs" aria-busy={runsLoading}>
            {runsLoading && (
              <li className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                Loading runs…
              </li>
            )}
            {!runsLoading && runsError && (
              <li
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive"
                role="alert"
              >
                {runsError}{" "}
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => runsTarget && void openRuns(runsTarget)}
                >
                  Retry
                </Button>
              </li>
            )}
            {!runsLoading &&
              !runsError &&
              runs.map((run) => (
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
            {!runsLoading && !runsError && runs.length === 0 && (
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
