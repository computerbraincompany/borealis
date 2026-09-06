import { useEffect, useRef, useState } from "react";
import { CircleAlert, Library as LibraryIcon, LoaderCircle, Search, X } from "lucide-react";
import {
  formatApiError,
  librariesApi,
  sourcesApi,
  RESEARCH_SOURCES_MAX,
  type LibrarySummary,
  type ResearchSourceAvailability,
  type Source,
} from "@/lib/api";
import { mergeCatalogContinuation } from "@/lib/catalogMerge";
import { cn } from "@/lib/utils";
import { sourceStatusPresentation } from "@/lib/sourceStatus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Explicit research scope picker (M15 stage 4): the definition holds a
 * concrete selected source id set (1–100), never `all`. Selected-empty stays
 * editable for a draft; Start is disabled with an explanation elsewhere.
 * Attaching a library expands its ready members into the explicit set at
 * attach time (the same attach-time contract as chats) — library additions
 * never join a run implicitly. Saved sources that became unready or were
 * removed surface as a precise readiness conflict from the definition's
 * server-computed availability; the user must revise the selection.
 */
export function ResearchScopePicker({
  sourceIds,
  libraryIds,
  availability,
  disabled,
  onChange,
}: {
  sourceIds: string[];
  libraryIds: string[];
  availability: readonly ResearchSourceAvailability[];
  disabled: boolean;
  onChange: (next: { sourceIds: string[]; libraryIds: string[] }) => void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [librariesError, setLibrariesError] = useState<string | null>(null);
  const [attachingLibraryId, setAttachingLibraryId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [noteIsError, setNoteIsError] = useState(false);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const reload = async () => {
    const requestId = ++requestRef.current;
    setListError(null);
    setLoading(true);
    try {
      const [page, libraryPage] = await Promise.all([sourcesApi.list(), librariesApi.list()]);
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setSources(page.items);
      setNextCursor(page.next_cursor);
      setLibraries(libraryPage.items);
      setLibrariesError(null);
    } catch (error: unknown) {
      if (mountedRef.current && requestId === requestRef.current) {
        setListError(formatApiError(error, "Could not load sources"));
      }
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const requestId = ++requestRef.current;
    setLoadingMore(true);
    try {
      const page = await sourcesApi.list({ cursor: nextCursor });
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setSources((current) => mergeCatalogContinuation(current, page.items));
      setNextCursor(page.next_cursor);
    } catch (error: unknown) {
      if (mountedRef.current && requestId === requestRef.current) {
        setListError(formatApiError(error, "Could not load more sources"));
      }
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoadingMore(false);
    }
  };

  const labelFor = (sourceId: string): string => {
    const known = sources.find((source) => source.id === sourceId);
    if (known) return known.display_name || known.name;
    return `Removed or unloaded source ${sourceId.slice(0, 8)}…`;
  };

  const selected = new Set(sourceIds);
  const toggle = (sourceId: string) => {
    setNote(null);
    if (selected.has(sourceId)) {
      onChange({ sourceIds: sourceIds.filter((id) => id !== sourceId), libraryIds });
      return;
    }
    if (sourceIds.length >= RESEARCH_SOURCES_MAX) {
      setNoteIsError(true);
      setNote(`A research run covers at most ${RESEARCH_SOURCES_MAX} sources.`);
      return;
    }
    onChange({ sourceIds: [...sourceIds, sourceId], libraryIds });
  };

  /** Library provenance is recorded explicitly; membership expands NOW, not later. */
  const attachLibrary = async (library: LibrarySummary) => {
    if (disabled || attachingLibraryId) return;
    setNote(null);
    setAttachingLibraryId(library.id);
    try {
      const detail = await librariesApi.get(library.id);
      const readyIds = detail.members.filter((member) => member.status === "ready").map((member) => member.id);
      const merged = [...new Set([...sourceIds, ...readyIds])];
      if (merged.length > RESEARCH_SOURCES_MAX) {
        setNoteIsError(true);
        setNote(
          `“${library.name}” has ${readyIds.length} ready sources; expanding it would exceed the ${RESEARCH_SOURCES_MAX}-source limit. Select sources individually instead.`,
        );
        return;
      }
      const nextLibraries = libraryIds.includes(library.id) ? libraryIds : [...libraryIds, library.id];
      setNoteIsError(false);
      setNote(
        `“${library.name}” expanded to ${readyIds.length} ready source${readyIds.length === 1 ? "" : "s"} now — future library additions will not join this research.`,
      );
      onChange({ sourceIds: merged, libraryIds: nextLibraries });
    } catch (error: unknown) {
      setNoteIsError(true);
      setNote(formatApiError(error, `Could not expand “${library.name}”`));
    } finally {
      setAttachingLibraryId((current) => (current === library.id ? null : current));
    }
  };

  const detachLibrary = (libraryId: string) => {
    setNote(null);
    onChange({ sourceIds, libraryIds: libraryIds.filter((id) => id !== libraryId) });
  };

  const conflicts = availability.filter((entry) => entry.availability !== "ready");
  const query = search.trim().toLowerCase();
  const filtered = query
    ? sources.filter((source) => (source.display_name || source.name).toLowerCase().includes(query))
    : sources;

  return (
    <div className="space-y-2" aria-label="Research sources">
      <p className="text-xs text-muted-foreground">
        Research searches exactly these selected sources. An empty selection is a legal draft; Start stays disabled
        until at least one ready source is selected.
      </p>
      {conflicts.length > 0 && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          <p className="flex items-center gap-1.5 font-medium">
            <CircleAlert className="h-4 w-4" /> Readiness conflict
          </p>
          <ul className="mt-1 list-inside list-disc text-xs">
            {conflicts.map((entry) => (
              <li key={entry.source_id}>
                {labelFor(entry.source_id)} —{" "}
                {entry.availability === "missing" ? "removed from this account" : "not ready for retrieval"}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs">Revise the selection and save a new revision before starting.</p>
        </div>
      )}
      {libraryIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {libraryIds.map((libraryId) => {
            const library = libraries.find((entry) => entry.id === libraryId);
            return (
              <Badge key={libraryId} variant="outline" className="gap-1">
                <LibraryIcon className="h-3 w-3" /> {library?.name ?? `Library ${libraryId.slice(0, 8)}…`}
                {!disabled && (
                  <button
                    type="button"
                    aria-label={`Detach library ${library?.name ?? libraryId}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => detachLibrary(libraryId)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </Badge>
            );
          })}
        </div>
      )}
      {sourceIds.length === 0 && (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          No sources selected — this draft cannot start yet.
        </p>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search sources"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search sources"
          className="h-8 pl-8 text-sm"
        />
      </div>
      <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
        {loading && (
          <p className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground" role="status">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Loading sources…
          </p>
        )}
        {listError && (
          <div className="flex items-center gap-2 text-xs" role="alert">
            <span className="text-destructive">{listError}</span>
            <Button variant="outline" size="sm" disabled={loading} onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        )}
        {filtered.map((source) => {
          const isSelected = selected.has(source.id);
          const status = sourceStatusPresentation(source.status);
          return (
            <label key={source.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm">
              <input
                type="checkbox"
                aria-label={`Select source: ${source.display_name || source.name}`}
                checked={isSelected}
                disabled={disabled || (!isSelected && source.status !== "ready")}
                onChange={() => toggle(source.id)}
              />
              <span className="min-w-0 flex-1 truncate" title={source.display_name || source.name}>
                {source.display_name || source.name}
              </span>
              {isSelected && (
                <span
                  className={cn(
                    "shrink-0 text-[11px]",
                    status.tone === "success"
                      ? "text-success"
                      : status.tone === "pending"
                        ? "text-warning"
                        : "text-destructive",
                  )}
                >
                  {status.label}
                </span>
              )}
            </label>
          );
        })}
        {!loading && !listError && filtered.length === 0 && (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            {query ? `No sources match “${query}”.` : "No sources yet — upload one first."}
          </p>
        )}
        {nextCursor && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-center text-xs text-muted-foreground"
            disabled={loading || loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? "Loading more sources…" : "Load more sources"}
          </Button>
        )}
      </div>
      {libraries.length > 0 && !disabled && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Attach library (expands now):</span>
          {libraries.slice(0, 6).map((library) => (
            <Button
              key={library.id}
              type="button"
              variant="outline"
              size="sm"
              disabled={Boolean(attachingLibraryId)}
              onClick={() => void attachLibrary(library)}
            >
              {attachingLibraryId === library.id ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-label={`Expanding ${library.name}`} />
              ) : (
                <LibraryIcon className="h-3.5 w-3.5" />
              )}
              {library.name}
            </Button>
          ))}
        </div>
      )}
      {librariesError && (
        <p className="text-xs text-destructive" role="alert">
          {librariesError}
        </p>
      )}
      {note && (
        <p
          role={noteIsError ? "alert" : "status"}
          className={cn("text-xs", noteIsError ? "text-destructive" : "text-muted-foreground")}
        >
          {note}
        </p>
      )}
    </div>
  );
}
