import { useCallback, useEffect, useState } from "react";
import { BookOpen, Library as LibraryIcon, MessageSquare, Plus, RefreshCw, Trash2, X } from "lucide-react";
import {
  formatApiError,
  librariesApi,
  sourcesApi,
  chatsApi,
  MAX_LIBRARY_MEMBERS,
  type LibrarySummary,
  type Source,
} from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

interface LibraryDetailState {
  summary: LibrarySummary;
  members: Source[];
}

export function LibrariesView() {
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [open, setOpen] = useState<LibraryDetailState | null>(null);
  const [availableSources, setAvailableSources] = useState<Source[]>([]);
  const [selectedSource, setSelectedSource] = useState("");
  const [membersBusy, setMembersBusy] = useState(false);
  const [renamingTarget, setRenamingTarget] = useState<LibrarySummary | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const load = useCallback(async () => {
    setPageError(null);
    try {
      setLibraries(await librariesApi.list());
    } catch (error: unknown) {
      setPageError(formatError(error, "Could not load libraries"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openLibrary = useCallback(async (library: LibrarySummary) => {
    setPageError(null);
    try {
      const [detail, sources] = await Promise.all([librariesApi.get(library.id), sourcesApi.list()]);
      setOpen({ summary: { ...library, ...detail, member_count: detail.members.length }, members: detail.members });
      setAvailableSources(sources);
    } catch (error: unknown) {
      setPageError(formatError(error, "Could not load the library"));
    }
  }, []);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setPageError(null);
    try {
      await librariesApi.create(name);
      setNewName("");
      setCreating(false);
      await load();
    } catch (error: unknown) {
      setPageError(formatError(error, "Could not create the library"));
    }
  };

  const submitRename = async () => {
    if (!renamingTarget) return;
    const name = renameValue.trim();
    if (!name) return;
    setPageError(null);
    try {
      const renamed = await librariesApi.rename(renamingTarget.id, name);
      setLibraries((current) => current.map((library) => (library.id === renamed.id ? renamed : library)));
      setOpen((current) =>
        current && current.summary.id === renamed.id
          ? { ...current, summary: { ...current.summary, name: renamed.name } }
          : current,
      );
      setRenamingTarget(null);
    } catch (error: unknown) {
      setPageError(formatError(error, "Could not rename the library"));
    }
  };

  const remove = async (library: LibrarySummary) => {
    setPageError(null);
    try {
      await librariesApi.remove(library.id);
      setLibraries((current) => current.filter((entry) => entry.id !== library.id));
      setOpen((current) => (current?.summary.id === library.id ? null : current));
    } catch (error: unknown) {
      setPageError(formatError(error, "Could not delete the library"));
    }
  };

  const saveMembers = async (libraryId: string, memberIds: string[]) => {
    setMembersBusy(true);
    setPageError(null);
    try {
      await librariesApi.setMembers(libraryId, memberIds);
      const detail = await librariesApi.get(libraryId);
      setOpen({ summary: { ...detail, member_count: detail.members.length }, members: detail.members });
      setLibraries((current) =>
        current.map((library) =>
          library.id === libraryId ? { ...library, member_count: detail.members.length } : library,
        ),
      );
    } catch (error: unknown) {
      setPageError(formatError(error, "Could not update library members"));
    } finally {
      setMembersBusy(false);
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
    const readyIds = library.members.filter((member) => member.status === "ready").map((member) => member.id);
    if (readyIds.length > MAX_LIBRARY_MEMBERS) return;
    setPageError(null);
    try {
      const chat = await chatsApi.create(undefined, { source_mode: "selected", source_ids: readyIds });
      window.location.hash = `#/chat/${chat.id}`;
    } catch (error: unknown) {
      setPageError(formatError(error, "Could not attach the library to a new chat"));
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
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
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
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => void remove(library)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* member manager */}
      <Dialog open={!!open} onOpenChange={(value) => !value && setOpen(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{open?.summary.name}</DialogTitle>
            <DialogDescription>
              Members reference your existing sources. Attaching a library to a new chat selects its ready members.
            </DialogDescription>
          </DialogHeader>
          {open && (
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
              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRenamingTarget(open.summary);
                    setRenameValue(open.summary.name);
                  }}
                >
                  Rename
                </Button>
                <Button
                  size="sm"
                  onClick={() => void attachToNewChat(open)}
                  disabled={
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
          )}
        </DialogContent>
      </Dialog>

      {/* create dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New library</DialogTitle>
            <DialogDescription>Group related sources under one governed name.</DialogDescription>
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
              maxLength={120}
              aria-label="Library name"
              placeholder="Finance data room"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!newName.trim()}>
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* rename dialog */}
      <Dialog open={!!renamingTarget} onOpenChange={(value) => !value && setRenamingTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename library</DialogTitle>
            <DialogDescription>Give this library a name you can recognize later.</DialogDescription>
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
              maxLength={120}
              aria-label="Library name"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setRenamingTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!renameValue.trim()}>
                Rename
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatError(error: unknown, fallback: string): string {
  return formatApiError(error, fallback);
}
