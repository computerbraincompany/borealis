import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Library as LibraryIcon, Loader2, MessageSquare, Plus, RefreshCw, Trash2, X } from "lucide-react";
import {
  formatApiError,
  librariesApi,
  sourcesApi,
  chatsApi,
  MAX_LIBRARY_MEMBERS,
  type LibrarySummary,
  type Source,
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

interface LibraryDetailState {
  summary: LibrarySummary;
  members: Source[];
}

export function LibrariesView() {
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [open, setOpen] = useState<LibraryDetailState | null>(null);
  const [availableSources, setAvailableSources] = useState<Source[]>([]);
  const [sourcesNextCursor, setSourcesNextCursor] = useState<string | null>(null);
  const [sourcesLoadingMore, setSourcesLoadingMore] = useState(false);
  const [selectedSource, setSelectedSource] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [membersBusy, setMembersBusy] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [renamingTarget, setRenamingTarget] = useState<LibrarySummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  // Mutations that fail while a dialog is open must surface inside that dialog;
  // the page banner is hidden behind the modal overlay.
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LibrarySummary | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const createRequestRef = useRef(0);
  const createAbortRef = useRef<AbortController | null>(null);
  const attachRequestRef = useRef(0);
  const attachAbortRef = useRef<AbortController | null>(null);
  const attachTargetIdRef = useRef<string | null>(null);
  const attachBusyRef = useRef(false);
  const detailRequestRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);
  const openLibraryIdRef = useRef<string | null>(null);
  const catalogRequestRef = useRef(0);
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreOwnerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const sourcePageRequestRef = useRef(0);
  const sourcePageAbortRef = useRef<AbortController | null>(null);
  const renameRequestRef = useRef(0);
  const renameAbortRef = useRef<AbortController | null>(null);
  const renameTargetIdRef = useRef<string | null>(null);
  const deleteRequestRef = useRef(0);
  const deleteRequestsRef = useRef(new Map<string, { requestId: number; abort: AbortController }>());

  const invalidateCatalog = () => {
    catalogRequestRef.current += 1;
    loadingMoreOwnerRef.current = null;
    setLoadingMore(false);
    setLoading(false);
  };

  const load = useCallback(async () => {
    const requestId = ++catalogRequestRef.current;
    loadingMoreOwnerRef.current = null;
    setLoadingMore(false);
    setPageError(null);
    try {
      const page = await librariesApi.list();
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return;
      setLibraries((current) => mergeCatalogHead(page.items, current));
      nextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
    } catch (error: unknown) {
      if (mountedRef.current && requestId === catalogRequestRef.current) {
        setPageError(formatError(error, "Could not load libraries"));
      }
    } finally {
      if (mountedRef.current && requestId === catalogRequestRef.current) setLoading(false);
    }
  }, []);

  const loadMore = async () => {
    const cursor = nextCursorRef.current;
    if (!cursor || loadingMoreOwnerRef.current !== null) return;
    const requestId = ++catalogRequestRef.current;
    loadingMoreOwnerRef.current = requestId;
    setLoadingMore(true);
    try {
      const page = await librariesApi.list({ cursor });
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return;
      setLibraries((current) => mergeCatalogContinuation(current, page.items));
      nextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
    } catch (error: unknown) {
      if (mountedRef.current && requestId === catalogRequestRef.current) {
        setPageError(formatError(error, "Could not load older libraries"));
      }
    } finally {
      if (loadingMoreOwnerRef.current === requestId) {
        loadingMoreOwnerRef.current = null;
        if (mountedRef.current) setLoadingMore(false);
      }
    }
  };

  useEffect(() => {
    const deleteRequests = deleteRequestsRef.current;
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      catalogRequestRef.current += 1;
      loadingMoreOwnerRef.current = null;
      createRequestRef.current += 1;
      createAbortRef.current?.abort();
      createAbortRef.current = null;
      attachRequestRef.current += 1;
      attachAbortRef.current?.abort();
      attachAbortRef.current = null;
      attachTargetIdRef.current = null;
      attachBusyRef.current = false;
      detailRequestRef.current += 1;
      detailAbortRef.current?.abort();
      sourcePageRequestRef.current += 1;
      sourcePageAbortRef.current?.abort();
      renameRequestRef.current += 1;
      renameAbortRef.current?.abort();
      for (const request of deleteRequests.values()) request.abort.abort();
      deleteRequests.clear();
    };
  }, [load]);

  const openLibrary = useCallback(async (library: LibrarySummary) => {
    attachRequestRef.current += 1;
    attachAbortRef.current?.abort();
    attachAbortRef.current = null;
    attachTargetIdRef.current = null;
    attachBusyRef.current = false;
    const requestId = ++detailRequestRef.current;
    detailAbortRef.current?.abort();
    sourcePageRequestRef.current += 1;
    sourcePageAbortRef.current?.abort();
    sourcePageAbortRef.current = null;
    openLibraryIdRef.current = library.id;
    const abort = new AbortController();
    detailAbortRef.current = abort;
    setPageError(null);
    setDialogError(null);
    setOpen({ summary: library, members: [] });
    setAvailableSources([]);
    setSourcesNextCursor(null);
    setSourcesLoadingMore(false);
    setSelectedSource("");
    setDetailLoading(true);
    setMembersBusy(false);
    setAttaching(false);
    try {
      const [detail, sources] = await Promise.all([
        librariesApi.get(library.id, abort.signal),
        sourcesApi.list({ signal: abort.signal }),
      ]);
      if (requestId === detailRequestRef.current && !abort.signal.aborted && openLibraryIdRef.current === library.id) {
        setOpen({ summary: { ...library, ...detail, member_count: detail.members.length }, members: detail.members });
        setAvailableSources(sources.items);
        setSourcesNextCursor(sources.next_cursor);
      }
    } catch (error: unknown) {
      if (requestId === detailRequestRef.current && !abort.signal.aborted) {
        setDialogError(formatError(error, "Could not load the library"));
      }
    } finally {
      if (requestId === detailRequestRef.current && !abort.signal.aborted) setDetailLoading(false);
    }
  }, []);

  const closeLibrary = () => {
    attachRequestRef.current += 1;
    attachAbortRef.current?.abort();
    attachAbortRef.current = null;
    attachTargetIdRef.current = null;
    attachBusyRef.current = false;
    openLibraryIdRef.current = null;
    detailRequestRef.current += 1;
    detailAbortRef.current?.abort();
    detailAbortRef.current = null;
    sourcePageRequestRef.current += 1;
    sourcePageAbortRef.current?.abort();
    sourcePageAbortRef.current = null;
    setOpen(null);
    setAvailableSources([]);
    setSourcesNextCursor(null);
    setSourcesLoadingMore(false);
    setSelectedSource("");
    setDetailLoading(false);
    setMembersBusy(false);
    setAttaching(false);
    setDialogError(null);
  };

  const loadMoreSources = async () => {
    if (!open || !sourcesNextCursor || sourcesLoadingMore) return;
    const targetId = open.summary.id;
    const requestId = ++sourcePageRequestRef.current;
    sourcePageAbortRef.current?.abort();
    const abort = new AbortController();
    sourcePageAbortRef.current = abort;
    setSourcesLoadingMore(true);
    try {
      const page = await sourcesApi.list({ cursor: sourcesNextCursor, signal: abort.signal });
      if (requestId !== sourcePageRequestRef.current || abort.signal.aborted || openLibraryIdRef.current !== targetId)
        return;
      setAvailableSources((current) => mergeCatalogContinuation(current, page.items));
      setSourcesNextCursor(page.next_cursor);
    } catch (error: unknown) {
      if (
        requestId === sourcePageRequestRef.current &&
        !abort.signal.aborted &&
        openLibraryIdRef.current === targetId
      ) {
        setDialogError(formatError(error, "Could not load older sources"));
      }
    } finally {
      if (requestId === sourcePageRequestRef.current && !abort.signal.aborted && openLibraryIdRef.current === targetId)
        setSourcesLoadingMore(false);
    }
  };

  const openRenameDialog = (library: LibrarySummary) => {
    renameRequestRef.current += 1;
    renameAbortRef.current?.abort();
    renameAbortRef.current = null;
    renameTargetIdRef.current = library.id;
    setDialogError(null);
    setRenaming(false);
    setRenamingTarget(library);
    setRenameValue(library.name);
  };

  const closeRenameDialog = () => {
    renameTargetIdRef.current = null;
    renameRequestRef.current += 1;
    renameAbortRef.current?.abort();
    renameAbortRef.current = null;
    setDialogError(null);
    setRenaming(false);
    setRenamingTarget(null);
  };

  const openCreateDialog = () => {
    createRequestRef.current += 1;
    createAbortRef.current?.abort();
    createAbortRef.current = null;
    setDialogError(null);
    setCreateBusy(false);
    setCreating(true);
  };

  const closeCreateDialog = () => {
    createRequestRef.current += 1;
    createAbortRef.current?.abort();
    createAbortRef.current = null;
    setDialogError(null);
    setCreateBusy(false);
    setCreating(false);
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    const requestId = ++createRequestRef.current;
    createAbortRef.current?.abort();
    const abort = new AbortController();
    createAbortRef.current = abort;
    setCreateBusy(true);
    setPageError(null);
    try {
      const created = await librariesApi.create(name, abort.signal);
      if (requestId !== createRequestRef.current || abort.signal.aborted) return;
      invalidateCatalog();
      setLibraries((current) => {
        const remaining = current.filter((library) => library.id !== created.id);
        return [created, ...remaining];
      });
      void load();
      setNewName("");
      createAbortRef.current = null;
      closeCreateDialog();
    } catch (error: unknown) {
      if (requestId === createRequestRef.current && !abort.signal.aborted) {
        setDialogError(formatError(error, "Could not create the library"));
      }
    } finally {
      if (requestId === createRequestRef.current && !abort.signal.aborted) {
        createAbortRef.current = null;
        setCreateBusy(false);
      }
    }
  };

  const submitRename = async () => {
    if (!renamingTarget) return;
    const targetId = renamingTarget.id;
    const name = renameValue.trim();
    if (!name) return;
    const requestId = ++renameRequestRef.current;
    renameAbortRef.current?.abort();
    const abort = new AbortController();
    renameAbortRef.current = abort;
    setRenaming(true);
    setPageError(null);
    try {
      const renamed = await librariesApi.rename(targetId, name, abort.signal);
      if (requestId !== renameRequestRef.current || abort.signal.aborted || renameTargetIdRef.current !== targetId)
        return;
      invalidateCatalog();
      setLibraries((current) => current.map((library) => (library.id === renamed.id ? renamed : library)));
      setOpen((current) =>
        current && current.summary.id === renamed.id
          ? { ...current, summary: { ...current.summary, name: renamed.name } }
          : current,
      );
      closeRenameDialog();
    } catch (error: unknown) {
      if (requestId === renameRequestRef.current && !abort.signal.aborted && renameTargetIdRef.current === targetId) {
        setDialogError(formatError(error, "Could not rename the library"));
      }
    } finally {
      if (requestId === renameRequestRef.current && !abort.signal.aborted && renameTargetIdRef.current === targetId)
        setRenaming(false);
    }
  };

  const remove = async (library: LibrarySummary) => {
    const requestId = ++deleteRequestRef.current;
    deleteRequestsRef.current.get(library.id)?.abort.abort();
    const abort = new AbortController();
    deleteRequestsRef.current.set(library.id, { requestId, abort });
    setPageError(null);
    try {
      await librariesApi.remove(library.id, abort.signal);
      if (deleteRequestsRef.current.get(library.id)?.requestId !== requestId || abort.signal.aborted) return;
      invalidateCatalog();
      setLibraries((current) => current.filter((entry) => entry.id !== library.id));
      if (openLibraryIdRef.current === library.id) closeLibrary();
    } catch (error: unknown) {
      if (deleteRequestsRef.current.get(library.id)?.requestId === requestId && !abort.signal.aborted) {
        setPageError(formatError(error, "Could not delete the library"));
      }
    } finally {
      if (deleteRequestsRef.current.get(library.id)?.requestId === requestId) {
        deleteRequestsRef.current.delete(library.id);
      }
    }
  };

  const confirmRemove = async () => {
    if (!deleteTarget || deletingId === deleteTarget.id) return;
    const library = deleteTarget;
    setDeletingId(library.id);
    setPageError(null);
    try {
      await remove(library);
      setDeleteTarget(null);
    } finally {
      setDeletingId(null);
    }
  };

  const saveMembers = async (libraryId: string, memberIds: string[]) => {
    const requestId = ++detailRequestRef.current;
    detailAbortRef.current?.abort();
    const abort = new AbortController();
    detailAbortRef.current = abort;
    setMembersBusy(true);
    setPageError(null);
    try {
      await librariesApi.setMembers(libraryId, memberIds, abort.signal);
      const detail = await librariesApi.get(libraryId, abort.signal);
      if (requestId === detailRequestRef.current && !abort.signal.aborted) {
        invalidateCatalog();
        setOpen((current) =>
          current?.summary.id === libraryId
            ? { summary: { ...detail, member_count: detail.members.length }, members: detail.members }
            : current,
        );
        setLibraries((current) =>
          current.map((library) =>
            library.id === libraryId ? { ...library, member_count: detail.members.length } : library,
          ),
        );
      }
    } catch (error: unknown) {
      if (requestId === detailRequestRef.current && !abort.signal.aborted) {
        setDialogError(formatError(error, "Could not update library members"));
      }
    } finally {
      if (requestId === detailRequestRef.current && !abort.signal.aborted) setMembersBusy(false);
    }
  };

  const addMember = async () => {
    if (!open || !selectedSource) return;
    if (open.members.some((member) => member.id === selectedSource)) return;
    if (open.members.length >= MAX_LIBRARY_MEMBERS) return;
    const nextIds = [...open.members.map((member) => member.id), selectedSource];
    setSelectedSource("");
    await saveMembers(open.summary.id, nextIds);
  };

  const removeMember = async (sourceId: string) => {
    if (!open) return;
    await saveMembers(
      open.summary.id,
      open.members.map((member) => member.id).filter((id) => id !== sourceId),
    );
  };

  const attachToNewChat = async (library: LibraryDetailState) => {
    const targetId = library.summary.id;
    const readyIds = library.members.filter((member) => member.status === "ready").map((member) => member.id);
    const scope = { source_mode: "selected" as const, source_ids: readyIds };
    if (readyIds.length > MAX_LIBRARY_MEMBERS || openLibraryIdRef.current !== targetId || attachBusyRef.current) return;
    const requestId = ++attachRequestRef.current;
    attachAbortRef.current?.abort();
    const abort = new AbortController();
    attachAbortRef.current = abort;
    attachTargetIdRef.current = targetId;
    attachBusyRef.current = true;
    setAttaching(true);
    setPageError(null);
    try {
      const chat = await chatsApi.create(undefined, scope, undefined, abort.signal);
      if (
        !mountedRef.current ||
        requestId !== attachRequestRef.current ||
        abort.signal.aborted ||
        attachTargetIdRef.current !== targetId ||
        openLibraryIdRef.current !== targetId
      )
        return;
      window.location.hash = `#/chat/${chat.id}`;
    } catch (error: unknown) {
      if (
        mountedRef.current &&
        requestId === attachRequestRef.current &&
        !abort.signal.aborted &&
        attachTargetIdRef.current === targetId &&
        openLibraryIdRef.current === targetId
      ) {
        setDialogError(formatError(error, "Could not attach the library to a new chat"));
      }
    } finally {
      if (requestId === attachRequestRef.current && !abort.signal.aborted && attachTargetIdRef.current === targetId) {
        attachAbortRef.current = null;
        attachTargetIdRef.current = null;
        attachBusyRef.current = false;
        if (mountedRef.current && openLibraryIdRef.current === targetId) setAttaching(false);
      }
    }
  };

  const addableSources = availableSources.filter((source) => !open?.members.some((member) => member.id === source.id));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Libraries</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Named collections above your sources. Members stay referenced, never copied.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /> Refresh
            </Button>
            <Button size="sm" onClick={openCreateDialog}>
              <Plus className="h-4 w-4" /> New library
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
        ) : libraries.length === 0 ? (
          <Card className="mt-8 flex flex-col items-center gap-3 py-16 text-center">
            <LibraryIcon className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No libraries yet. Create one to curate a governed collection of your sources.
            </p>
          </Card>
        ) : (
          <div className="mt-8 space-y-3">
            {libraries.map((library) => (
              <Card
                key={library.id}
                className="flex items-center gap-4 p-4 transition-colors hover:border-foreground/20"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <BookOpen className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void openLibrary(library)}
                      className="truncate font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {library.name}
                    </button>
                    <Badge variant="secondary">
                      {library.member_count} {library.member_count === 1 ? "member" : "members"}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">Created {formatDate(library.created_at)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => void openLibrary(library)}>
                    Manage
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Delete library"
                    aria-label={`Delete ${library.name}`}
                    className="text-muted-foreground hover:text-destructive"
                    disabled={deletingId === library.id}
                    onClick={() => {
                      setPageError(null);
                      setDeleteTarget(library);
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
                  Load older libraries
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* member manager */}
      <Dialog open={!!open} onOpenChange={(value) => !value && closeLibrary()}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{open?.summary.name}</DialogTitle>
            <DialogDescription>
              Members reference your existing sources. Attaching a library to a new chat selects its ready members.
            </DialogDescription>
          </DialogHeader>
          {dialogError && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {dialogError}
            </p>
          )}
          {open && detailLoading ? (
            <div className="space-y-3" aria-label="Loading library" aria-busy="true">
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-9 w-full rounded-lg" />
            </div>
          ) : open ? (
            <div className="space-y-3">
              <ul className="max-h-56 space-y-1.5 overflow-y-auto" aria-label="Library members">
                {open.members.map((member) => (
                  <li key={member.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{member.display_name || member.name}</span>
                    <Badge variant="secondary">{member.status}</Badge>
                    <Button
                      variant="ghost"
                      size="icon"
                      title={`Remove ${member.display_name || member.name}`}
                      disabled={membersBusy}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => void removeMember(member.id)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
                {open.members.length === 0 && (
                  <li className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                    No members yet.
                  </li>
                )}
              </ul>
              <div className="flex items-center gap-2">
                <select
                  aria-label="Add a source to this library"
                  value={selectedSource}
                  onChange={(event) => setSelectedSource(event.target.value)}
                  className="h-9 flex-1 rounded-md border bg-background px-2 text-sm"
                >
                  <option value="">Add a source…</option>
                  {addableSources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.display_name || source.name}
                    </option>
                  ))}
                </select>
                <Button size="sm" onClick={() => void addMember()} disabled={!selectedSource || membersBusy}>
                  Add
                </Button>
              </div>
              {sourcesNextCursor && (
                <Button variant="ghost" size="sm" onClick={() => void loadMoreSources()} disabled={sourcesLoadingMore}>
                  {sourcesLoadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                  Load older sources
                </Button>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                <Button variant="ghost" size="sm" onClick={() => openRenameDialog(open.summary)}>
                  Rename
                </Button>
                <Button
                  size="sm"
                  onClick={() => void attachToNewChat(open)}
                  disabled={
                    attaching ||
                    membersBusy ||
                    open.members.filter((member) => member.status === "ready").length > MAX_LIBRARY_MEMBERS
                  }
                  title={
                    open.members.filter((member) => member.status === "ready").length > MAX_LIBRARY_MEMBERS
                      ? `Ready members exceed the ${MAX_LIBRARY_MEMBERS}-source chat scope cap`
                      : undefined
                  }
                >
                  <MessageSquare className="h-4 w-4" /> Attach to new chat
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* create dialog */}
      <Dialog open={creating} onOpenChange={(open) => (open ? openCreateDialog() : closeCreateDialog())}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New library</DialogTitle>
            <DialogDescription>Group related sources under one governed name.</DialogDescription>
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
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              maxLength={120}
              aria-label="Library name"
              placeholder="Finance data room"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={closeCreateDialog}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={createBusy || !newName.trim()}>
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* rename dialog */}
      <Dialog open={!!renamingTarget} onOpenChange={(value) => !value && closeRenameDialog()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename library</DialogTitle>
            <DialogDescription>Give this library a name you can recognize later.</DialogDescription>
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
              void submitRename();
            }}
          >
            <Input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={120}
              aria-label="Library name"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={closeRenameDialog}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={renaming || !renameValue.trim()}>
                {renaming ? "Renaming…" : "Rename"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete “${deleteTarget.name}”?`}
          description="This removes the library and its member list. Your sources and their data are kept. This cannot be undone."
          busy={deletingId === deleteTarget.id}
          onConfirm={() => void confirmRemove()}
          onCancel={() => {
            if (deletingId !== deleteTarget.id) setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}

function formatError(error: unknown, fallback: string): string {
  return formatApiError(error, fallback);
}
