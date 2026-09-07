import { useCallback, useEffect, useRef, useState } from "react";
import { BellOff, CalendarClock, Loader2, Pause, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  briefScheduleLabel,
  briefsApi,
  formatApiError,
  type BriefRecipe,
} from "@/lib/api";
import { mergeCatalogContinuation, mergeCatalogHead } from "@/lib/catalogMerge";
import { cn, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useEgressConsentGate } from "@/hooks/useEgressConsentGate";
import { BriefRecipeWizard } from "@/components/briefs/BriefRecipeWizard";
import { BriefRunsPanel } from "@/components/briefs/BriefRunsPanel";
import { RUNNING_APP_CAVEAT } from "@/components/briefs/BriefRecipeWizard";

/**
 * Reviewed-brief recipes (M16 slice 4) — a section of its own inside
 * Automations, deliberately separate from the untouched interval automations
 * above it: briefs bind a saved analysis revision, run the refresh→wait→
 * analyze→draft pipeline, and land drafts in the review inbox. Nothing here
 * publishes without an explicit approval in Reviews.
 */

const DELETE_KEEP_NOTE =
  "Pending and rejected drafts are preserved (default): they stay in the review inbox for inspection through their run snapshots and are never auto-approved, auto-deleted, or published.";

export function BriefRecipeSection() {
  const [recipes, setRecipes] = useState<BriefRecipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [wizard, setWizard] = useState<{ recipe: BriefRecipe | null } | null>(null);
  const [manageId, setManageId] = useState<string | null>(null);
  const [manage, setManage] = useState<BriefRecipe | null>(null);
  const [manageError, setManageError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BriefRecipe | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [notificationsBusyId, setNotificationsBusyId] = useState<string | null>(null);

  const mountedRef = useRef(false);
  const catalogRequestRef = useRef(0);
  const catalogNextCursorRef = useRef<string | null>(null);
  const catalogLoadingMoreOwnerRef = useRef<number | null>(null);
  const manageRequestRef = useRef(0);
  const manageAbortRef = useRef<AbortController | null>(null);
  const rowMutationRequestRef = useRef(0);
  const rowMutationRequestsRef = useRef(new Map<string, { requestId: number; abort: AbortController }>());
  const deleteRequestRef = useRef(0);
  const { handleConsentError, dialog: consentDialog } = useEgressConsentGate();

  const invalidateCatalog = () => {
    catalogRequestRef.current += 1;
    catalogLoadingMoreOwnerRef.current = null;
    setLoadingMore(false);
    setLoading(false);
  };

  const load = useCallback(async () => {
    const requestId = ++catalogRequestRef.current;
    catalogLoadingMoreOwnerRef.current = null;
    setLoadingMore(false);
    setPageError(null);
    try {
      const page = await briefsApi.list();
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return;
      setRecipes((current) => mergeCatalogHead(page.items, current));
      catalogNextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === catalogRequestRef.current)
        setPageError(formatApiError(failure, "Could not load reviewed briefs"));
    } finally {
      if (mountedRef.current && requestId === catalogRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      catalogRequestRef.current += 1;
      catalogLoadingMoreOwnerRef.current = null;
      manageRequestRef.current += 1;
      manageAbortRef.current?.abort();
      for (const request of rowMutationRequestsRef.current.values()) request.abort.abort();
      rowMutationRequestsRef.current.clear();
      deleteRequestRef.current += 1;
    };
  }, [load]);

  // Scheduled briefs advance on their own; keep next-run/failure badges fresh
  // while anything is active — visibility-aware, request-guarded.
  const hasActiveBrief = recipes.some((recipe) => recipe.state === "active");
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!hasActiveBrief) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadRef.current();
    }, 45_000);
    return () => window.clearInterval(timer);
  }, [hasActiveBrief]);

  const loadMore = async () => {
    const cursor = catalogNextCursorRef.current;
    if (!cursor || catalogLoadingMoreOwnerRef.current !== null) return;
    const requestId = ++catalogRequestRef.current;
    catalogLoadingMoreOwnerRef.current = requestId;
    setLoadingMore(true);
    try {
      const page = await briefsApi.list({ cursor });
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return;
      setRecipes((current) => mergeCatalogContinuation(current, page.items));
      catalogNextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === catalogRequestRef.current)
        setPageError(formatApiError(failure, "Could not load older briefs"));
    } finally {
      if (catalogLoadingMoreOwnerRef.current === requestId) {
        catalogLoadingMoreOwnerRef.current = null;
        if (mountedRef.current) setLoadingMore(false);
      }
    }
  };

  const replaceRecipe = (updated: BriefRecipe) => {
    setRecipes((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    setManage((current) => (current && current.id === updated.id ? updated : current));
    setManageError(null);
  };

  const openManage = (recipe: BriefRecipe) => {
    const requestId = ++manageRequestRef.current;
    manageAbortRef.current?.abort();
    const abort = new AbortController();
    manageAbortRef.current = abort;
    setManage(recipe);
    setManageError(null);
    setManageId(recipe.id);
    void (async () => {
      try {
        const detail = await briefsApi.get(recipe.id, abort.signal);
        if (!mountedRef.current || requestId !== manageRequestRef.current || abort.signal.aborted) return;
        setManage(detail);
      } catch (failure: unknown) {
        if (mountedRef.current && requestId === manageRequestRef.current && !abort.signal.aborted) {
          setManageError(formatApiError(failure, "Could not refresh the recipe (the list values are shown instead)"));
        }
      }
    })();
  };

  const closeManage = () => {
    manageRequestRef.current += 1;
    manageAbortRef.current?.abort();
    manageAbortRef.current = null;
    setManageId(null);
    setManage(null);
    setManageError(null);
  };

  const togglePause = async (recipe: BriefRecipe) => {
    const targetId = recipe.id;
    if (togglingId === targetId || deletingId === targetId) return;
    const requestId = ++rowMutationRequestRef.current;
    rowMutationRequestsRef.current.get(targetId)?.abort.abort();
    const abort = new AbortController();
    rowMutationRequestsRef.current.set(targetId, { requestId, abort });
    setPageError(null);
    setTogglingId(targetId);
    try {
      const updated = recipe.state === "active" ? await briefsApi.pause(targetId, abort.signal) : await briefsApi.resume(targetId, abort.signal);
      if (rowMutationRequestsRef.current.get(targetId)?.requestId !== requestId || abort.signal.aborted) return;
      invalidateCatalog();
      replaceRecipe(updated);
      void load();
    } catch (failure: unknown) {
      if (rowMutationRequestsRef.current.get(targetId)?.requestId === requestId && !abort.signal.aborted) {
        setPageError(formatApiError(failure, "Could not update the brief"));
      }
    } finally {
      if (rowMutationRequestsRef.current.get(targetId)?.requestId === requestId) {
        rowMutationRequestsRef.current.delete(targetId);
      }
      setTogglingId((current) => (current === targetId ? null : current));
    }
  };

  const toggleNotifications = async (recipe: BriefRecipe, enabled: boolean) => {
    const targetId = recipe.id;
    if (notificationsBusyId === targetId) return;
    const requestId = ++rowMutationRequestRef.current;
    rowMutationRequestsRef.current.get(targetId)?.abort.abort();
    const abort = new AbortController();
    rowMutationRequestsRef.current.set(targetId, { requestId, abort });
    setNotificationsBusyId(targetId);
    setManageError(null);
    try {
      const updated = await briefsApi.setNotifications(targetId, enabled, abort.signal);
      if (rowMutationRequestsRef.current.get(targetId)?.requestId !== requestId || abort.signal.aborted) return;
      replaceRecipe(updated);
    } catch (failure: unknown) {
      if (rowMutationRequestsRef.current.get(targetId)?.requestId === requestId && !abort.signal.aborted) {
        setManageError(formatApiError(failure, "Could not update the notification preference"));
      }
    } finally {
      if (rowMutationRequestsRef.current.get(targetId)?.requestId === requestId) {
        rowMutationRequestsRef.current.delete(targetId);
      }
      setNotificationsBusyId((current) => (current === targetId ? null : current));
    }
  };

  const removeRecipe = async (recipe: BriefRecipe) => {
    const targetId = recipe.id;
    const requestId = ++deleteRequestRef.current;
    rowMutationRequestsRef.current.get(targetId)?.abort.abort();
    const abort = new AbortController();
    rowMutationRequestsRef.current.set(targetId, { requestId, abort });
    setPageError(null);
    try {
      await briefsApi.remove(targetId, abort.signal);
      if (deleteRequestRef.current !== requestId || abort.signal.aborted) return;
      // Bump the catalog generation before filtering so a still-in-flight list
      // response can never resurrect the deleted recipe.
      invalidateCatalog();
      setRecipes((current) => current.filter((entry) => entry.id !== targetId));
      closeManage();
      setDeleteTarget(null);
    } catch (failure: unknown) {
      if (deleteRequestRef.current === requestId && rowMutationRequestsRef.current.get(targetId)?.requestId === requestId && !abort.signal.aborted) {
        setPageError(formatApiError(failure, "Could not delete the brief"));
      }
    } finally {
      if (rowMutationRequestsRef.current.get(targetId)?.requestId === requestId) {
        rowMutationRequestsRef.current.delete(targetId);
      }
    }
  };

  const confirmRemove = async () => {
    if (!deleteTarget || deletingId === deleteTarget.id) return;
    setDeletingId(deleteTarget.id);
    try {
      await removeRecipe(deleteTarget);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="mt-12" aria-labelledby="reviewed-briefs-heading">
      {consentDialog}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="reviewed-briefs-heading" className="text-xl font-bold tracking-tight">
            Reviewed briefs
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Scheduled saved-analysis runs that refresh their inputs, rerun the analysis, compare results, and prepare a
            report draft in the <a className="text-primary underline" href="#/reviews">review inbox</a>. Briefs never
            publish or send anything before you approve the exact draft revision.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" aria-label="Refresh briefs" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /> Refresh
          </Button>
          <Button size="sm" onClick={() => setWizard({ recipe: null })}>
            <Plus className="h-4 w-4" /> New brief
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
        <div className="mt-6 space-y-3">
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      ) : recipes.length === 0 ? (
        <Card className="mt-6 flex flex-col items-center gap-3 py-12 text-center">
          <CalendarClock className="h-10 w-10 text-muted-foreground/40" />
          <p className="max-w-md text-sm text-muted-foreground">
            No reviewed briefs yet. Bind a saved analysis to a civil schedule and the run lands a draft here for your
            review.
          </p>
        </Card>
      ) : (
        <div className="mt-6 space-y-3">
          {recipes.map((recipe) => (
            <Card key={recipe.id} className="flex items-center gap-4 p-4 transition-colors hover:border-foreground/20">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <CalendarClock className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-foreground">{recipe.name}</span>
                  <Badge variant="secondary">reviewed brief</Badge>
                  <Badge variant="outline">{briefScheduleLabel(recipe.schedule)}</Badge>
                  {recipe.state === "paused" ? (
                    <Badge variant="pending" title={recipe.paused_reason ?? undefined}>
                      paused{recipe.paused_reason ? `: ${recipe.paused_reason}` : ""}
                    </Badge>
                  ) : recipe.consecutive_failures > 0 ? (
                    <Badge variant="destructive">{recipe.consecutive_failures} recent failures</Badge>
                  ) : null}
                  {!recipe.notifications_enabled && <Badge variant="outline">notifications off</Badge>}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Analysis rev {recipe.analysis_revision} · {recipe.source_ids.length} source
                  {recipe.source_ids.length === 1 ? "" : "s"} · last run{" "}
                  {recipe.last_run_at ? formatDate(recipe.last_run_at) : "never"} · next{" "}
                  {formatDate(recipe.next_run_at)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button variant="outline" size="sm" onClick={() => openManage(recipe)}>
                  Manage
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title={togglingId === recipe.id ? "Saving…" : recipe.state === "active" ? "Pause brief" : "Resume brief"}
                  aria-label={recipe.state === "active" ? `Pause ${recipe.name}` : `Resume ${recipe.name}`}
                  aria-busy={togglingId === recipe.id}
                  className="text-muted-foreground hover:text-primary"
                  disabled={togglingId === recipe.id || deletingId === recipe.id}
                  onClick={() => void togglePause(recipe)}
                >
                  {togglingId === recipe.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : recipe.state === "active" ? (
                    <Pause className="h-4 w-4" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Delete brief"
                  aria-label={`Delete ${recipe.name}`}
                  className="text-muted-foreground hover:text-destructive"
                  disabled={deletingId === recipe.id}
                  onClick={() => {
                    setPageError(null);
                    setDeleteTarget(recipe);
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
                Load older briefs
              </Button>
            </div>
          )}
        </div>
      )}

      {wizard && (
        <BriefRecipeWizard
          recipe={wizard.recipe}
          handleConsentError={handleConsentError}
          onClose={() => setWizard(null)}
          onSaved={(saved) => {
            setWizard(null);
            invalidateCatalog();
            setRecipes((current) => mergeCatalogHead([saved], current));
            void load();
            if (manageId === saved.id) openManage(saved);
          }}
        />
      )}

      <Dialog open={manageId !== null && manage !== null} onOpenChange={(open) => !open && closeManage()}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {manage && (
            <>
              <DialogHeader>
                <DialogTitle>{manage.name}</DialogTitle>
                <DialogDescription>
                  {briefScheduleLabel(manage.schedule)} · recipe revision {manage.revision} ·{" "}
                  {manage.state === "active" ? "active" : `paused: ${manage.paused_reason ?? "manual"}`}
                </DialogDescription>
              </DialogHeader>
              {manageError && (
                <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {manageError}
                </p>
              )}
              <div className="space-y-1 rounded-md border bg-secondary/30 px-3 py-2 text-xs">
                <p className="text-foreground">
                  Next runs on this recipe&apos;s calendar (server-resolved, DST-aware):
                </p>
                {manage.next_occurrences && manage.next_occurrences.length > 0 ? (
                  <ul className="space-y-0.5 text-muted-foreground">
                    {manage.next_occurrences.map((occurrence) => (
                      <li key={occurrence.occurrence_key}>
                        <span className="text-foreground">{occurrence.civil.replace("T", " ")}</span> local (
                        {manage.schedule.time_zone}) ·{" "}
                        <span className="font-mono">{occurrence.utc_at.replace("T", " ").replace(".000Z", "Z")}</span>{" "}
                        UTC
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">No upcoming occurrence on the paused calendar.</p>
                )}
                <p className="text-muted-foreground">{RUNNING_APP_CAVEAT}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={manage.notifications_enabled}
                    disabled={notificationsBusyId === manage.id}
                    aria-label="Local notifications for this brief"
                    onChange={(event) => void toggleNotifications(manage, event.target.checked)}
                  />
                  Local notifications (inbox only — never outbound)
                  {notificationsBusyId === manage.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {!manage.notifications_enabled && <BellOff className="h-3.5 w-3.5" />}
                </label>
                <div className="ml-auto flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const target = manage;
                      closeManage();
                      setWizard({ recipe: target });
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={togglingId === manage.id}
                    onClick={() => void togglePause(manage)}
                  >
                    {manage.state === "active" ? (
                      <>
                        <Pause className="h-3.5 w-3.5" /> Pause
                      </>
                    ) : (
                      <>
                        <Play className="h-3.5 w-3.5" /> Resume
                      </>
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setDeleteTarget(manage)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </Button>
                </div>
              </div>
              <BriefRunsPanel recipe={manage} />
            </>
          )}
        </DialogContent>
      </Dialog>

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete “${deleteTarget.name}”?`}
          description={`This stops the schedule and requests cancellation of an active run. Saved results and already-published reports survive. ${DELETE_KEEP_NOTE}`}
          busy={deletingId === deleteTarget.id}
          onConfirm={() => void confirmRemove()}
          onCancel={() => {
            if (deletingId !== deleteTarget.id) setDeleteTarget(null);
          }}
        />
      )}
    </section>
  );
}
