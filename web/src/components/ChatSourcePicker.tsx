import { useId, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  Database,
  FileText,
  Info,
  Library as LibraryIcon,
  LoaderCircle,
  Search,
  Table2,
  UploadCloud,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatApiError,
  librariesApi,
  MAX_LIBRARY_MEMBERS,
  type AttachedSource,
  type LibrarySummary,
  type Source,
  type SourceMode,
  type SourceScopeInput,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { SOURCE_FILE_ACCEPT } from "@/lib/sourceFiles";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

interface ChatSourcePickerProps {
  sourceMode: SourceMode;
  attachedSources: AttachedSource[];
  sources: Source[];
  sourcesLoading: boolean;
  sourcesHasMore?: boolean;
  sourcesLoadingMore?: boolean;
  sourcesError: string | null;
  disabled: boolean;
  saving: boolean;
  hasMessages: boolean;
  onApply: (scope: SourceScopeInput) => Promise<void>;
  onUpload: (file: File) => Promise<Source>;
  onRetrySources: () => Promise<void>;
  onLoadMoreSources?: () => void | Promise<void>;
  libraries?: LibrarySummary[] | null;
  librariesLoading?: boolean;
  librariesHasMore?: boolean;
  librariesLoadingMore?: boolean;
  librariesError?: string | null;
  onRetryLibraries?: () => void;
  onLoadMoreLibraries?: () => void | Promise<void>;
}

export function ChatSourcePicker({
  sourceMode,
  attachedSources,
  sources,
  sourcesLoading,
  sourcesHasMore = false,
  sourcesLoadingMore = false,
  sourcesError,
  disabled,
  saving,
  hasMessages,
  onApply,
  onUpload,
  onRetrySources,
  onLoadMoreSources,
  libraries = null,
  librariesLoading = false,
  librariesHasMore = false,
  librariesLoadingMore = false,
  librariesError = null,
  onRetryLibraries,
  onLoadMoreLibraries,
}: ChatSourcePickerProps) {
  const searchId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [attachingLibraryName, setAttachingLibraryName] = useState<string | null>(null);

  const selectedIds = useMemo(
    () => new Set(sourceMode === "selected" ? attachedSources.map((source) => source.id) : []),
    [attachedSources, sourceMode],
  );
  const isUploading = uploadingFileName !== null;
  const isAttachingLibrary = attachingLibraryName !== null;
  const busy = disabled || saving || pending || isUploading || isAttachingLibrary;
  const hasLibraries = (libraries?.length ?? 0) > 0;

  const filteredSources = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const filtered = query
      ? sources.filter((source) => source.display_name.toLocaleLowerCase().includes(query))
      : sources;
    return [...filtered].sort((left, right) => {
      const selectedDifference = Number(selectedIds.has(right.id)) - Number(selectedIds.has(left.id));
      return selectedDifference || left.display_name.localeCompare(right.display_name);
    });
  }, [search, selectedIds, sources]);

  const triggerLabel =
    sourceMode === "all"
      ? "All sources"
      : attachedSources.length === 0
        ? "No sources"
        : `${attachedSources.length} ${attachedSources.length === 1 ? "source" : "sources"}`;

  const summary =
    sourceMode === "all"
      ? "Current and future uploads"
      : attachedSources.length === 0
        ? "Stored data is off"
        : `${attachedSources.length} selected for this chat`;

  const commit = async (scope: SourceScopeInput) => {
    if (pending || saving || isUploading) return;
    setError(null);
    setPending(true);
    try {
      await onApply(scope);
    } catch (reason: unknown) {
      setError(formatApiError(reason, "Could not update this chat's sources"));
    } finally {
      setPending(false);
    }
  };

  const toggleSource = (sourceId: string) => {
    const next = new Set(sourceMode === "selected" ? selectedIds : []);
    if (next.has(sourceId)) {
      next.delete(sourceId);
    } else {
      if (next.size >= 100) {
        setError("A chat can use at most 100 selected sources.");
        return;
      }
      next.add(sourceId);
    }
    void commit({ source_mode: "selected", source_ids: [...next] });
  };

  // Attaching a library expands its ready members into an explicit `selected`
  // scope at attach time (the same contract as the Libraries view). The fetch
  // never widens the scope: over-cap libraries fail instead of truncating.
  const attachLibrary = async (library: LibrarySummary) => {
    if (busy) return;
    setError(null);
    setAttachingLibraryName(library.name);
    try {
      const detail = await librariesApi.get(library.id);
      const readyIds = detail.members.filter((member) => member.status === "ready").map((member) => member.id);
      if (readyIds.length === 0) {
        setError(`“${library.name}” has no ready members yet.`);
        return;
      }
      if (readyIds.length > MAX_LIBRARY_MEMBERS) {
        setError(
          `“${library.name}” has more than ${MAX_LIBRARY_MEMBERS} ready sources; a chat can use at most ${MAX_LIBRARY_MEMBERS} selected sources.`,
        );
        return;
      }
      await commit({ source_mode: "selected", source_ids: readyIds });
    } catch (reason: unknown) {
      setError(formatApiError(reason, `Could not attach “${library.name}”`));
    } finally {
      setAttachingLibraryName(null);
    }
  };

  const uploadFile = async (file: File) => {
    setError(null);
    setUploadError(null);
    setUploadingFileName(file.name);
    try {
      const uploaded = await onUpload(file);
      if (sourceMode === "selected") {
        const next = new Set(selectedIds);
        if (!next.has(uploaded.id) && next.size >= 100) {
          setUploadError(`${file.name} was uploaded to Sources, but this chat already has 100 selected sources.`);
          return;
        }
        next.add(uploaded.id);
        try {
          await onApply({ source_mode: "selected", source_ids: [...next] });
        } catch (reason: unknown) {
          setUploadError(formatApiError(reason, `${file.name} was uploaded, but could not be added to this chat.`));
        }
      }
    } catch (reason: unknown) {
      setUploadError(
        formatApiError(reason, `Could not upload ${file.name}. Check the file type and size, then try again.`),
      );
    } finally {
      setUploadingFileName(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <input
        ref={fileInputRef}
        type="file"
        accept={SOURCE_FILE_ACCEPT}
        className="hidden"
        aria-label="Upload a source file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void uploadFile(file);
        }}
      />

      <DropdownMenu
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setSearch("");
            setError(null);
            setUploadError(null);
            setOpen(true);
            return;
          }
          if (!pending && !saving && !isUploading) setOpen(false);
        }}
        modal={false}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || sourcesLoading}
            className="h-8 max-w-full justify-start px-2.5"
            aria-label={`Chat sources: ${triggerLabel}`}
            title={triggerLabel}
          >
            {sourcesLoading || saving || pending ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <Database data-icon="inline-start" />
            )}
            <span className="truncate">{triggerLabel}</span>
            <ChevronDown data-icon="inline-end" className="ml-auto" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={8}
          collisionPadding={12}
          sticky="always"
          aria-busy={
            saving || pending || isUploading || isAttachingLibrary || sourcesLoadingMore || librariesLoadingMore
          }
          className="flex max-h-[calc(100vh-1.5rem)] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg p-0 shadow-lg"
        >
          <div className="flex items-center gap-3 px-3 py-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Database className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-foreground">Chat sources</span>
              <span className="block truncate text-xs text-muted-foreground">{summary}</span>
            </span>
            {(pending || saving || isUploading) && (
              <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
            )}
          </div>

          <DropdownMenuSeparator className="mx-0 my-0" />

          {sourcesError && (
            <div className="m-2 flex items-start gap-2 rounded-md bg-warning/10 px-2.5 py-2 text-xs" role="alert">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span className="min-w-0 flex-1 text-foreground">{sourcesError}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={sourcesLoading || busy}
                onClick={() => void onRetrySources()}
                className="h-6 shrink-0 px-2"
              >
                Retry
              </Button>
            </div>
          )}

          <DropdownMenuGroup className="p-1.5">
            <DropdownMenuItem
              disabled={busy}
              onSelect={(event) => {
                event.preventDefault();
                if (sourceMode !== "all") void commit({ source_mode: "all" });
              }}
              className={cn("min-h-11 px-2.5 py-2", sourceMode === "all" && "bg-primary/5")}
            >
              <Database />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">All sources</span>
                <span className="block text-[11px] text-muted-foreground">Include current and future uploads</span>
              </span>
              {sourceMode === "all" && <Check className="text-primary" aria-label="Selected" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy}
              onSelect={(event) => {
                event.preventDefault();
                if (sourceMode !== "selected" || selectedIds.size > 0) {
                  void commit({ source_mode: "selected", source_ids: [] });
                }
              }}
              className={cn(
                "min-h-11 px-2.5 py-2",
                sourceMode === "selected" && selectedIds.size === 0 && "bg-primary/5",
              )}
            >
              <X />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">No sources</span>
                <span className="block text-[11px] text-muted-foreground">Answer without stored data</span>
              </span>
              {sourceMode === "selected" && selectedIds.size === 0 && (
                <Check className="text-primary" aria-label="Selected" />
              )}
            </DropdownMenuItem>
          </DropdownMenuGroup>

          {(hasLibraries || librariesLoading || librariesHasMore || librariesError) && (
            <>
              <DropdownMenuSeparator className="mx-0 my-0" />
              <DropdownMenuGroup className="p-1.5">
                <DropdownMenuLabel className="px-2.5 py-1">Attach a library</DropdownMenuLabel>
                {librariesLoading && (
                  <p className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                    <LoaderCircle className="size-3 animate-spin" /> Loading libraries…
                  </p>
                )}
                {librariesError && (
                  <div className="m-1 flex items-start gap-2 rounded-md bg-warning/10 px-2.5 py-2 text-xs" role="alert">
                    <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <span className="min-w-0 flex-1 text-foreground">{librariesError}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={librariesLoading || busy}
                      onClick={() => onRetryLibraries?.()}
                      className="h-6 shrink-0 px-2"
                    >
                      Retry
                    </Button>
                  </div>
                )}
                {(libraries ?? []).map((library) => (
                  <DropdownMenuItem
                    key={library.id}
                    disabled={busy}
                    onSelect={(event) => {
                      event.preventDefault();
                      void attachLibrary(library);
                    }}
                    className="min-h-11 px-2.5 py-2"
                  >
                    <LibraryIcon />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground" title={library.name}>
                        {library.name}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {library.member_count} {library.member_count === 1 ? "member" : "members"}
                      </span>
                    </span>
                    {attachingLibraryName === library.name && (
                      <LoaderCircle className="animate-spin text-primary" aria-label={`Attaching ${library.name}`} />
                    )}
                  </DropdownMenuItem>
                ))}
                {librariesHasMore && (
                  <DropdownMenuItem
                    disabled={busy || librariesLoading || librariesLoadingMore}
                    onSelect={(event) => {
                      event.preventDefault();
                      void onLoadMoreLibraries?.();
                    }}
                    className="justify-center text-xs text-muted-foreground"
                  >
                    {librariesLoadingMore && <LoaderCircle className="animate-spin" aria-hidden="true" />}
                    {librariesLoadingMore ? "Loading more libraries…" : "Load more libraries"}
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </>
          )}

          <DropdownMenuSeparator className="mx-0 my-0" />

          <div className="flex min-h-0 flex-1 flex-col px-1.5 py-2">
            <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
              <DropdownMenuLabel className="p-0">Choose individual sources</DropdownMenuLabel>
              {sourceMode === "selected" && selectedIds.size > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  onClick={() => void commit({ source_mode: "selected", source_ids: [] })}
                >
                  Clear
                </button>
              )}
            </div>

            {sources.length > 5 && (
              <div className="relative mb-1.5 px-1">
                <label htmlFor={searchId} className="sr-only">
                  Search sources by display name
                </label>
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id={searchId}
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => event.stopPropagation()}
                  placeholder="Search sources"
                  disabled={busy}
                  className="h-8 pl-8 text-xs"
                />
              </div>
            )}

            <div className="min-h-0 overflow-y-auto overscroll-contain">
              {filteredSources.map((source) => {
                const selected = sourceMode === "selected" && selectedIds.has(source.id);
                return (
                  <DropdownMenuCheckboxItem
                    key={source.id}
                    checked={selected}
                    disabled={busy || Boolean(sourcesError)}
                    aria-label={`${selected ? "Remove" : "Select"} source: ${source.display_name}`}
                    onCheckedChange={() => toggleSource(source.id)}
                    onSelect={(event) => event.preventDefault()}
                    className={cn(
                      "group/source min-h-12 items-start gap-2 py-2 pl-8 pr-2.5",
                      selected && "bg-accent font-medium",
                    )}
                  >
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      {source.kind === "tabular" ? <Table2 className="size-3.5" /> : <FileText className="size-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-foreground" title={source.display_name}>
                        {source.display_name}
                      </span>
                      <SourceStatus status={source.status} />
                    </span>
                  </DropdownMenuCheckboxItem>
                );
              })}

              {!sourcesLoading && !sourcesError && sources.length === 0 && (
                <p className="px-3 py-5 text-center text-xs text-muted-foreground">
                  No stored sources yet. Upload a file to add one.
                </p>
              )}
              {sources.length > 0 && filteredSources.length === 0 && (
                <p className="px-3 py-5 text-center text-xs text-muted-foreground">
                  No sources match “{search.trim()}”.
                </p>
              )}
              {sourcesHasMore && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || sourcesLoading || sourcesLoadingMore}
                  onClick={() => void onLoadMoreSources?.()}
                  className="mt-1 w-full justify-center text-xs text-muted-foreground"
                >
                  {sourcesLoadingMore && <LoaderCircle data-icon="inline-start" className="animate-spin" />}
                  {sourcesLoadingMore ? "Loading more sources…" : "Load more sources"}
                </Button>
              )}
            </div>
          </div>

          {(error || uploadError || uploadingFileName) && (
            <div className="border-t px-3 py-2 text-xs" aria-live="polite">
              {uploadingFileName && (
                <p className="truncate text-muted-foreground" title={uploadingFileName}>
                  Uploading <span className="font-medium text-foreground">{uploadingFileName}</span>…
                </p>
              )}
              {uploadError && <p className="text-destructive">{uploadError}</p>}
              {error && <p className="text-destructive">Source selection unchanged: {error}</p>}
            </div>
          )}

          {hasMessages && (
            <p className="flex items-center gap-1.5 border-t px-3 py-2 text-[11px] text-muted-foreground">
              <Info className="size-3.5 shrink-0" /> Changes affect future answers.
            </p>
          )}

          <DropdownMenuSeparator className="mx-0 my-0" />
          <DropdownMenuGroup className="grid grid-cols-2 gap-1 p-1.5">
            <DropdownMenuItem
              disabled={busy}
              onSelect={(event) => {
                event.preventDefault();
                fileInputRef.current?.click();
              }}
              className="justify-center px-2 py-2"
            >
              <UploadCloud /> Upload file
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="justify-center px-2 py-2">
              <a href="#/sources">
                <ArrowUpRight /> Manage sources
              </a>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SourceStatus({ status }: { status: string }) {
  if (status === "ready") {
    return (
      <span className="mt-0.5 flex items-center gap-1 text-[11px] text-success">
        <span className="size-1.5 rounded-full bg-success" /> Ready
      </span>
    );
  }
  if (status === "index") {
    return (
      <span className="mt-0.5 flex items-center gap-1 text-[11px] text-warning">
        <LoaderCircle className="size-3 animate-spin" /> Processing
      </span>
    );
  }
  return (
    <span className="mt-0.5 flex items-center gap-1 text-[11px] text-destructive">
      <CircleAlert className="size-3" /> {status === "error" ? "Needs attention" : status}
    </span>
  );
}
