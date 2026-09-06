import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, FolderInput, History, Loader2, RefreshCw, Trash2 } from "lucide-react";
import {
  formatApiError,
  knowledgeApi,
  type KnowledgeConnection,
  type KnowledgePreview,
  type KnowledgePreviewEntry,
  type KnowledgeRefresh,
  type LibrarySummary,
} from "@/lib/api";
import { hasFolderPickerBridge, chooseDesktopFolder } from "@/lib/desktopBootstrap";
import { mergeCatalogContinuation, mergeCatalogHead } from "@/lib/catalogMerge";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ConfirmDialog";

/**
 * Living knowledge connections (M14 stage 4): refreshable desktop-folder and
 * read-only WebDAV collections feeding a library. Status badges distinguish
 * canonical connection status from the actionable `status_code` evidence —
 * including the archive-restore reconnect/reselect codes — and never render
 * secret material (the WebDAV password is write-only; folder paths never
 * reach this surface).
 */

export function knowledgeStatusPresentation(
  status: KnowledgeConnection["status"],
  code: string | null,
  desktopAvailable: boolean
): { label: string; tone: "success" | "pending" | "destructive" } {
  if (code) {
    switch (code) {
      case "CONNECTION_RESTORE_RECONNECT_REQUIRED":
      case "KNOWLEDGE_RESTORE_RECONNECT_REQUIRED":
        return { label: "Stored data intact — reconnect needed after restore", tone: "destructive" };
      case "KNOWLEDGE_FOLDER_RESELECT_REQUIRED":
        return { label: "Folder must be selected again in the desktop app", tone: "destructive" };
      case "KNOWLEDGE_UPSTREAM_UNAUTHORIZED":
        return { label: "Credentials rejected — replace the application password", tone: "destructive" };
      case "KNOWLEDGE_CREDENTIALS_MISSING":
        return { label: "Application password missing", tone: "destructive" };
      case "KNOWLEDGE_FOLDER_UNAVAILABLE":
        return { label: "The granted folder is unavailable", tone: "destructive" };
      default:
        return { label: `${status === "disconnected" ? "Disconnected" : "Needs attention"} (${code})`, tone: "destructive" };
    }
  }
  if (status === "ready") return { label: "Ready", tone: "success" };
  if (status === "untested") return { label: "Not tested yet", tone: "pending" };
  void desktopAvailable;
  return { label: "Needs attention", tone: "destructive" };
}

const REFRESH_LABELS: Record<KnowledgeRefresh["status"], { label: string; tone: "success" | "pending" | "destructive" }> =
  {
    active: { label: "Running", tone: "pending" },
    completed: { label: "Completed", tone: "success" },
    partial: { label: "Partial", tone: "destructive" },
    failed: { label: "Failed", tone: "destructive" },
    cancelled: { label: "Cancelled", tone: "pending" },
  };

const ENTRY_LABELS: Record<KnowledgePreviewEntry["classification"], string> = {
  new: "New",
  changed: "Changed",
  unchanged: "Unchanged",
  duplicate: "Duplicate",
  missing: "Missing upstream",
  unsupported: "Unsupported",
};

const PREVIEW_POLL_MS = 400;
const REFRESH_POLL_MS = 600;

interface PreviewDialogState {
  connection: KnowledgeConnection;
  preview: KnowledgePreview | null;
  entries: KnowledgePreviewEntry[];
  error: string | null;
}

interface Props {
  libraries: LibrarySummary[];
}

export function KnowledgeConnectionsPanel({ libraries }: Props) {
  const desktopAvailable = hasFolderPickerBridge();
  const [connections, setConnections] = useState<KnowledgeConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [webdavOpen, setWebdavOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeConnection | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<PreviewDialogState | null>(null);
  const [historyTarget, setHistoryTarget] = useState<KnowledgeConnection | null>(null);
  const [refreshBusyId, setRefreshBusyId] = useState<string | null>(null);
  const [activeRefresh, setActiveRefresh] = useState<{ connectionId: string; refresh: KnowledgeRefresh } | null>(null);
  const catalogRequestRef = useRef(0);
  const catalogAbortRef = useRef<AbortController | null>(null);
  const previewRequestRef = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);
  const refreshRequestRef = useRef(0);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    const requestId = ++catalogRequestRef.current;
    catalogAbortRef.current?.abort();
    const abort = new AbortController();
    catalogAbortRef.current = abort;
    try {
      const page = await knowledgeApi.list({ signal: abort.signal });
      if (!mountedRef.current || requestId !== catalogRequestRef.current || abort.signal.aborted) return;
      setConnections((current) => mergeCatalogHead(page.items, current));
      setNextCursor(page.next_cursor);
    } catch (error: unknown) {
      if (mountedRef.current && requestId === catalogRequestRef.current && !abort.signal.aborted) {
        setPageError(formatApiError(error, "Could not load knowledge connections"));
      }
    } finally {
      if (mountedRef.current && requestId === catalogRequestRef.current && !abort.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      catalogRequestRef.current += 1;
      catalogAbortRef.current?.abort();
      previewRequestRef.current += 1;
      previewAbortRef.current?.abort();
      refreshRequestRef.current += 1;
      refreshAbortRef.current?.abort();
    };
  }, [load]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const requestId = ++catalogRequestRef.current;
    setLoadingMore(true);
    try {
      const page = await knowledgeApi.list({ cursor: nextCursor });
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return;
      setConnections((current) => mergeCatalogContinuation(current, page.items));
      setNextCursor(page.next_cursor);
    } catch (error: unknown) {
      if (mountedRef.current && requestId === catalogRequestRef.current) {
        setPageError(formatApiError(error, "Could not load older connections"));
      }
    } finally {
      if (mountedRef.current && requestId === catalogRequestRef.current) setLoadingMore(false);
    }
  };

  const createFolder = async (name: string) => {
    if (busyRef.current) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const pick = await chooseDesktopFolder();
    if (pick.cancelled || !pick.grantId || !libraries.length) return;
    busyRef.current = true;
    setPageError(null);
    try {
      const created = await knowledgeApi.create({
        name: trimmed,
        kind: "desktop_folder",
        library_id: libraries[0].id,
        grant_id: pick.grantId,
      });
      setFolderOpen(false);
      setConnections((current) => [created, ...current.filter((entry) => entry.id !== created.id)]);
      void load();
    } catch (error: unknown) {
      setPageError(formatApiError(error, "Could not create the folder connection"));
    } finally {
      busyRef.current = false;
    }
  };

  const startPreview = async (connection: KnowledgeConnection) => {
    const requestId = ++previewRequestRef.current;
    previewAbortRef.current?.abort();
    const abort = new AbortController();
    previewAbortRef.current = abort;
    setPageError(null);
    setPreviewState({ connection, preview: null, entries: [], error: null });
    try {
      const started = await knowledgeApi.createPreview(connection.id, abort.signal);
      let preview = started.preview;
      let entries: KnowledgePreviewEntry[] = [];
      while (preview.status === "pending") {
        await new Promise((resolve) => setTimeout(resolve, PREVIEW_POLL_MS));
        if (!mountedRef.current || requestId !== previewRequestRef.current || abort.signal.aborted) return;
        const poll = await knowledgeApi.getPreview(preview.id, abort.signal);
        preview = poll.preview;
        entries = poll.entries;
      }
      if (!mountedRef.current || requestId !== previewRequestRef.current || abort.signal.aborted) return;
      setPreviewState({
        connection,
        preview,
        entries,
        error:
          preview.status === "failed"
            ? `The scan failed (${preview.error_code ?? "unknown"}). Nothing was imported.`
            : null,
      });
    } catch (error: unknown) {
      if (mountedRef.current && requestId === previewRequestRef.current && !abort.signal.aborted) {
        setPreviewState({
          connection,
          preview: null,
          entries: [],
          error: formatApiError(error, "The preview scan failed"),
        });
      }
    }
  };

  const closePreview = () => {
    previewRequestRef.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    setPreviewState(null);
  };

  const applyPreview = async (
    preview: KnowledgePreview,
    selections: { entry_id: string; selection_token: string }[]
  ) => {
    if (!previewState || busyRef.current) return;
    const connectionId = previewState.connection.id;
    busyRef.current = true;
    setPreviewState((current) => (current ? { ...current, error: null } : current));
    try {
      const applied = await knowledgeApi.applyPreview(preview.id, {
        expected_revision: preview.revision,
        selections,
      });
      const refresh =
        applied.refresh_id !== null ? (await knowledgeApi.getRefresh(applied.refresh_id)).refresh : null;
      closePreview();
      setPageError(null);
      if (refresh) setActiveRefresh({ connectionId, refresh });
      void load();
    } catch (error: unknown) {
      setPreviewState((current) =>
        current
          ? {
              ...current,
              error:
                current.preview && (error as { data?: { code?: string } })?.data?.code === "KNOWLEDGE_PREVIEW_STALE"
                  ? "The preview no longer matches the connection. Run a new preview and re-select."
                  : formatApiError(error, "Could not apply the selection"),
            }
          : current
      );
    } finally {
      busyRef.current = false;
    }
  };

  const startRefresh = async (connection: KnowledgeConnection) => {
    const requestId = ++refreshRequestRef.current;
    refreshAbortRef.current?.abort();
    const abort = new AbortController();
    refreshAbortRef.current = abort;
    setRefreshBusyId(connection.id);
    setPageError(null);
    try {
      const started = await knowledgeApi.startRefresh(connection.id, {}, abort.signal);
      setActiveRefresh({ connectionId: connection.id, refresh: started.refresh });
      let refresh = started.refresh;
      while (refresh.status === "active") {
        await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
        if (!mountedRef.current || requestId !== refreshRequestRef.current || abort.signal.aborted) return;
        refresh = (await knowledgeApi.getRefresh(refresh.id, abort.signal)).refresh;
      }
      if (!mountedRef.current || requestId !== refreshRequestRef.current || abort.signal.aborted) return;
      setActiveRefresh({ connectionId: connection.id, refresh });
      void load();
    } catch (error: unknown) {
      if (mountedRef.current && requestId === refreshRequestRef.current && !abort.signal.aborted) {
        setPageError(formatApiError(error, "Could not start the refresh"));
      }
    } finally {
      if (mountedRef.current && requestId === refreshRequestRef.current && !abort.signal.aborted) {
        setRefreshBusyId(null);
      }
    }
  };

  const cancelRefresh = async (connectionId: string, refreshId: string) => {
    if (busyRef.current || !refreshId) return;
    busyRef.current = true;
    setPageError(null);
    try {
      // Durable, idempotent cancellation request; the poll loop reports the
      // settled terminal state.
      await knowledgeApi.cancelRefresh(refreshId);
    } catch (error: unknown) {
      setPageError(formatApiError(error, "Could not request cancellation"));
    } finally {
      busyRef.current = false;
      void connectionId;
      void load();
    }
  };

  const toggleWatch = async (connection: KnowledgeConnection, enabled: boolean) => {
    setPageError(null);
    try {
      const updated = await knowledgeApi.update(connection.id, {
        expected_revision: connection.revision,
        watch_enabled: enabled,
      });
      setConnections((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (error: unknown) {
      setPageError(formatApiError(error, "Could not change the watch setting"));
    }
  };

  const removeConnection = async (connection: KnowledgeConnection) => {
    if (deletingId === connection.id) return;
    setDeletingId(connection.id);
    setPageError(null);
    try {
      await knowledgeApi.remove(connection.id);
      setConnections((current) => current.filter((entry) => entry.id !== connection.id));
      setDeleteTarget(null);
      void load();
    } catch (error: unknown) {
      setPageError(formatApiError(error, "Could not delete the connection"));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="mt-10" aria-label="Knowledge connections">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Knowledge connections</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Refreshable folders and WebDAV collections. Previewing or deleting a connection never removes your
            sources.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!desktopAvailable}
            title={desktopAvailable ? undefined : "Automatic local watching is available only in the desktop app"}
            onClick={() => {
              if (!desktopAvailable) return;
              if (!libraries.length) {
                setPageError("Create a library first — connections import into a library.");
                return;
              }
              setFolderOpen(true);
            }}
          >
            <FolderInput className="h-4 w-4" /> Folder
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (!libraries.length) {
                setPageError("Create a library first — connections import into a library.");
                return;
              }
              setWebdavOpen(true);
            }}
          >
            WebDAV
          </Button>
        </div>
      </div>
      {!desktopAvailable && (
        <p className="mt-2 text-xs text-muted-foreground">
          Folder connections and automatic watching are available only in the desktop app; WebDAV collections work
          everywhere.
        </p>
      )}

      {loading ? (
        <div className="mt-4 space-y-3">
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      ) : connections.length === 0 ? (
        <Card className="mt-4 flex flex-col items-center gap-2 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            No knowledge connections yet. Connect a folder (desktop) or a WebDAV collection to keep a library fresh.
          </p>
        </Card>
      ) : (
        <div className="mt-4 space-y-3">
          {connections.map((connection) => {
            const badge = knowledgeStatusPresentation(connection.status, connection.status_code, desktopAvailable);
            const running = activeRefresh?.connectionId === connection.id && activeRefresh.refresh.status === "active";
            return (
              <Card key={connection.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{connection.name}</span>
                    <Badge variant="outline">{connection.kind === "webdav" ? "WebDAV" : "Folder"}</Badge>
                    <Badge variant={badge.tone}>{badge.label}</Badge>
                    {running && <Badge variant="pending">Refreshing…</Badge>}
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {connection.kind === "webdav" && connection.webdav
                      ? `${connection.webdav.username}@${connection.label}`
                      : connection.label}
                    {connection.credential_configured ? " · password stored" : ""}
                  </div>
                </div>
                <label
                  className={cn(
                    "flex items-center gap-1.5 text-xs",
                    connection.kind !== "desktop_folder" && "invisible",
                    !desktopAvailable && "opacity-60"
                  )}
                  title={
                    desktopAvailable
                      ? "Automatically rescan the folder while Borealis runs (desktop)"
                      : "Automatic watching is available only in the desktop app; the setting is saved for when you use it"
                  }
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={connection.watch_enabled}
                    disabled={!desktopAvailable && !connection.watch_enabled}
                    onChange={(event) => void toggleWatch(connection, event.target.checked)}
                  />
                  Watch
                </label>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={previewState?.connection.id === connection.id}
                    onClick={() => void startPreview(connection)}
                  >
                    <Eye className="h-4 w-4" /> Preview
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={refreshBusyId === connection.id || running}
                    onClick={() => void startRefresh(connection)}
                  >
                    <RefreshCw className={cn("h-4 w-4", (refreshBusyId === connection.id || running) && "animate-spin")} />
                    Refresh
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setHistoryTarget(connection)}>
                    <History className="h-4 w-4" /> History
                  </Button>
                  {running && (
                    <Button variant="outline" size="sm" onClick={() => void cancelRefresh(connection.id, activeRefresh!.refresh.id)}>
                      Cancel
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${connection.name}`}
                    className="text-muted-foreground hover:text-destructive"
                    disabled={deletingId === connection.id}
                    onClick={() => {
                      setPageError(null);
                      setDeleteTarget(connection);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            );
          })}
          {nextCursor && (
            <div className="flex justify-center pt-1">
              <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />} Load older connections
              </Button>
            </div>
          )}
        </div>
      )}

      {/* folder create (desktop only): picker first, confirm name, consume grant */}
      <Dialog open={folderOpen} onOpenChange={(open) => !open && setFolderOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New folder connection</DialogTitle>
            <DialogDescription>
              Borealis will ask you to choose a folder, then preview the files before importing anything.
            </DialogDescription>
          </DialogHeader>
          <FolderCreateForm libraries={libraries} onCreate={(name) => void createFolder(name)} />
        </DialogContent>
      </Dialog>

      {/* webdav create: write-only password */}
      <Dialog open={webdavOpen} onOpenChange={(open) => !open && setWebdavOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New WebDAV collection</DialogTitle>
            <DialogDescription>
              A read-only DAV collection with an application password. The password is stored once and never shown
              again.
            </DialogDescription>
          </DialogHeader>
          <WebdavCreateForm
            libraries={libraries}
            onCreated={(created) => {
              setWebdavOpen(false);
              setConnections((current) => [created, ...current.filter((entry) => entry.id !== created.id)]);
              void load();
            }}
          />
        </DialogContent>
      </Dialog>

      <PreviewDialog
        state={previewState}
        onClose={closePreview}
        onApply={(preview, selections) => void applyPreview(preview, selections)}
      />

      <Dialog open={!!historyTarget} onOpenChange={(open) => !open && setHistoryTarget(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Refresh history — {historyTarget?.name}</DialogTitle>
            <DialogDescription>The newest refresh runs for this connection, newest first.</DialogDescription>
          </DialogHeader>
          {historyTarget && <RefreshHistory connection={historyTarget} />}
        </DialogContent>
      </Dialog>

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete “${deleteTarget.name}”?`}
          description="The connection mapping, stored password, and watch setting are removed. Your imported sources, library membership, reports, and saved evidence are kept. This cannot be undone."
          busy={deletingId === deleteTarget.id}
          onConfirm={() => void removeConnection(deleteTarget)}
          onCancel={() => {
            if (deletingId !== deleteTarget.id) setDeleteTarget(null);
          }}
        />
      )}
      {activeRefresh && (
        <div className="sr-only" role="status">
          Refresh for this connection: {REFRESH_LABELS[activeRefresh.refresh.status]?.label ?? activeRefresh.refresh.status}
        </div>
      )}
      {pageError && (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {pageError}
        </div>
      )}
    </section>
  );
}

function FolderCreateForm({ libraries, onCreate }: { libraries: LibrarySummary[]; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate(name);
      }}
    >
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={120}
        aria-label="Connection name"
        placeholder="Research notes"
        autoFocus
      />
      <p className="text-xs text-muted-foreground">
        Imports into “{libraries[0]?.name}”. A native folder picker opens when you create the connection; cancelling
        it creates nothing.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="submit" size="sm" disabled={!name.trim()}>
          Choose folder…
        </Button>
      </div>
    </form>
  );
}

function WebdavCreateForm({
  libraries,
  onCreated,
}: {
  libraries: LibrarySummary[];
  onCreated: (connection: KnowledgeConnection) => void;
}) {
  const [name, setName] = useState("");
  const [libraryId, setLibraryId] = useState(libraries[0]?.id ?? "");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState(false);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    []
  );
  const submit = async () => {
    if (busyRef.current) return;
    if (!name.trim() || !libraryId || !url.trim() || !username.trim() || !password) {
      if (!password) setPasswordError(true);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const created = await knowledgeApi.create(
        {
          name: name.trim(),
          kind: "webdav",
          library_id: libraryId,
          config: { url: url.trim(), username: username.trim(), password },
        },
        abort.signal
      );
      if (abort.signal.aborted) return;
      setPassword("");
      abortRef.current = null;
      onCreated(created);
    } catch (caught: unknown) {
      if (!abort.signal.aborted) setError(formatApiError(caught, "Could not create the WebDAV connection"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="Connection name" placeholder="Team docs" autoFocus />
      <select
        aria-label="Target library"
        value={libraryId}
        onChange={(e) => setLibraryId(e.target.value)}
        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
      >
        {libraries.map((library) => (
          <option key={library.id} value={library.id}>
            {library.name}
          </option>
        ))}
      </select>
      <Input value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Collection URL" placeholder="https://dav.example.test/collections/team" />
      <Input value={username} onChange={(e) => setUsername(e.target.value)} aria-label="Username" autoComplete="username" />
      <Input
        type="password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          setPasswordError(false);
        }}
        aria-label="Application password"
        autoComplete="new-password"
        aria-invalid={passwordError}
      />
      {passwordError && (
        <p role="alert" className="text-xs text-destructive">
          An application password is required. It is stored once and never displayed again.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Create connection
        </Button>
      </div>
    </form>
  );
}

function PreviewDialog({
  state,
  onClose,
  onApply,
}: {
  state: PreviewDialogState | null;
  onClose: () => void;
  onApply: (preview: KnowledgePreview, selections: { entry_id: string; selection_token: string }[]) => void;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [applyBusy, setApplyBusy] = useState(false);
  const applyBusyRef = useRef(false);
  useEffect(() => {
    setSelected({});
    setApplyBusy(false);
    applyBusyRef.current = false;
  }, [state?.preview?.id, state?.connection?.id]);
  useEffect(() => {
    if (state?.error) {
      // A refused apply (stale revision, expiry) must leave the dialog
      // usable: close/retry stay possible.
      applyBusyRef.current = false;
      setApplyBusy(false);
    }
  }, [state?.error]);
  if (!state) return null;
  const preview = state.preview;
  const entries = state.entries;
  const selectableEntries = entries.filter((entry) => ["new", "changed", "duplicate"].includes(entry.classification));
  const chosen = selectableEntries.filter((entry) => selected[entry.entry_id]);
  const openApply = () => {
    if (applyBusyRef.current || !preview || chosen.length === 0) return;
    applyBusyRef.current = true;
    setApplyBusy(true);
    onApply(
      preview,
      chosen.map((entry) => ({ entry_id: entry.entry_id, selection_token: entry.selection_token }))
    );
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !applyBusy && onClose()}>
      <DialogContent className="max-w-2xl" aria-busy={applyBusy}>
        <DialogHeader>
          <DialogTitle>Preview — {state.connection.name}</DialogTitle>
          <DialogDescription>
            {preview
              ? `${preview.new_count} new · ${preview.changed_count} changed · ${preview.unchanged_count} unchanged · ${preview.duplicate_count} duplicate · ${preview.missing_count} missing · ${preview.unsupported_count} unsupported · ${preview.skipped_count} skipped`
              : "Scanning the upstream collection…"}
          </DialogDescription>
        </DialogHeader>
        {state.error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {state.error}
          </p>
        )}
        {!preview && (
          <p role="status" className="py-6 text-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Running the bounded scan…
          </p>
        )}
        {preview && preview.status === "complete" && (
          <div className="max-h-72 overflow-y-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5" />
                  <th className="px-2 py-1.5">Path</th>
                  <th className="px-2 py-1.5">Change</th>
                  <th className="px-2 py-1.5 text-right">Size</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.entry_id} className="border-t">
                    <td className="px-2 py-1.5">
                      {["new", "changed", "duplicate"].includes(entry.classification) ? (
                        <input
                          type="checkbox"
                          aria-label={`Select ${entry.relative_path}`}
                          checked={!!selected[entry.entry_id]}
                          disabled={applyBusy}
                          onChange={(event) =>
                            setSelected((current) => ({ ...current, [entry.entry_id]: event.target.checked }))
                          }
                        />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="max-w-[260px] truncate px-2 py-1.5">{entry.relative_path}</td>
                    <td className="px-2 py-1.5">{ENTRY_LABELS[entry.classification]}</td>
                    <td className="px-2 py-1.5 text-right">{entry.size_bytes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {preview && preview.status === "complete" && (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={applyBusy} onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={applyBusy || chosen.length === 0} onClick={openApply}>
              {applyBusy && <Loader2 className="h-4 w-4 animate-spin" />} Import selected ({chosen.length})
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RefreshHistory({ connection }: { connection: KnowledgeConnection }) {
  const [rows, setRows] = useState<KnowledgeRefresh[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    const requestId = ++requestRef.current;
    const abort = new AbortController();
    void knowledgeApi
      .listRefreshes(connection.id)
      .then((page) => {
        if (mountedRef.current && requestId === requestRef.current && !abort.signal.aborted) setRows(page.items);
      })
      .catch((caught: unknown) => {
        if (mountedRef.current && requestId === requestRef.current && !abort.signal.aborted)
          setError(formatApiError(caught, "Could not load the refresh history"));
      });
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      abort.abort();
    };
  }, [connection.id]);
  if (error)
    return (
      <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {error}
      </p>
    );
  if (!rows)
    return (
      <p role="status" className="py-4 text-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading…
      </p>
    );
  return (
    <ul className="max-h-64 space-y-1.5 overflow-y-auto" aria-label="Refresh history">
      {rows.map((row) => (
        <li key={row.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <span className="capitalize">{row.requested_by}</span>
          <Badge variant={REFRESH_LABELS[row.status]?.tone ?? "default"}>
            {REFRESH_LABELS[row.status]?.label ?? row.status}
          </Badge>
          {row.cancel_requested && row.status === "active" && <span className="text-xs text-muted-foreground">cancelling…</span>}
          {row.error_code && <span className="text-xs text-muted-foreground">{row.error_code}</span>}
          <span className="ml-auto text-xs text-muted-foreground">{new Date(row.created_at).toLocaleString()}</span>
        </li>
      ))}
      {rows.length === 0 && <li className="py-4 text-center text-sm text-muted-foreground">No refreshes yet.</li>}
    </ul>
  );
}
