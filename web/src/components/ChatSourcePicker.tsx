import { useId, useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Database, FileText, Info, LoaderCircle, Table2, UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type AttachedSource,
  type Source,
  type SourceMode,
  type SourceScopeInput,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface ChatSourcePickerProps {
  sourceMode: SourceMode;
  attachedSources: AttachedSource[];
  sources: Source[];
  sourcesLoading: boolean;
  sourcesError: string | null;
  disabled: boolean;
  saving: boolean;
  hasMessages: boolean;
  onApply: (scope: SourceScopeInput) => Promise<void>;
  onUpload: (file: File) => Promise<Source>;
  onRetrySources: () => Promise<void>;
}

export function ChatSourcePicker({
  sourceMode,
  attachedSources,
  sources,
  sourcesLoading,
  sourcesError,
  disabled,
  saving,
  hasMessages,
  onApply,
  onUpload,
  onRetrySources,
}: ChatSourcePickerProps) {
  const radioName = useId();
  const searchId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [draftMode, setDraftMode] = useState<SourceMode>(sourceMode);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => selectedSourceIds(sourceMode, attachedSources)
  );
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const isUploading = uploadingFileName !== null;

  const filteredSources = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return sources;
    return sources.filter((source) => source.display_name.toLocaleLowerCase().includes(query));
  }, [search, sources]);

  const triggerLabel =
    sourceMode === "all"
      ? "All sources"
      : attachedSources.length === 0
        ? "No sources"
        : `${attachedSources.length} ${attachedSources.length === 1 ? "source" : "sources"}`;

  const toggleSource = (id: string, checked: boolean) => {
    setError(null);
    if (checked && !selectedIds.has(id) && selectedIds.size >= 100) {
      setError("A chat can use at most 100 selected sources.");
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const apply = async () => {
    const scope: SourceScopeInput =
      draftMode === "all"
        ? { source_mode: "all" }
        : { source_mode: "selected", source_ids: [...selectedIds] };
    setError(null);
    try {
      await onApply(scope);
      setOpen(false);
    } catch (reason: any) {
      setError(reason?.message || "Could not update this chat's sources");
    }
  };

  const uploadFile = async (file: File) => {
    const uploadMode = draftMode;
    const selectedAtUpload = new Set(selectedIds);
    setError(null);
    setUploadError(null);
    setUploadingFileName(file.name);
    try {
      const uploaded = await onUpload(file);
      if (uploadMode === "selected") {
        if (!selectedAtUpload.has(uploaded.id) && selectedAtUpload.size >= 100) {
          setUploadError(
            `${file.name} was uploaded to Sources but was not selected because this chat already has 100 sources.`
          );
        } else {
          selectedAtUpload.add(uploaded.id);
          setSelectedIds(selectedAtUpload);
        }
      }
    } catch {
      setUploadError(`Could not upload ${file.name}. Check the file type and size, then try again.`);
    } finally {
      setUploadingFileName(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setDraftMode(sourceMode);
          setSelectedIds(selectedSourceIds(sourceMode, attachedSources));
          setSearch("");
          setError(null);
          setUploadError(null);
          setOpen(true);
          return;
        }
        if (!saving && !isUploading) setOpen(false);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || sourcesLoading}
          className="h-8 max-w-full justify-start px-2.5"
          aria-label={`Chat sources: ${triggerLabel}`}
        >
          {sourcesLoading || saving ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <Database data-icon="inline-start" />
          )}
          <span className="truncate">{triggerLabel}</span>
        </Button>
      </DialogTrigger>

      <DialogContent
        className="flex max-h-[85vh] max-w-xl flex-col gap-0 overflow-hidden p-0"
        aria-busy={saving || isUploading}
        onEscapeKeyDown={(event) => {
          if (saving || isUploading) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (saving || isUploading) event.preventDefault();
        }}
      >
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <DialogTitle>Choose sources for this chat</DialogTitle>
          <DialogDescription>
            Control which stored sources Borealis may use in future turns.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
          {sourcesError && (
            <div
              className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-foreground"
              role="alert"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <span className="min-w-0 flex-1">{sourcesError}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={sourcesLoading}
                onClick={() => void onRetrySources()}
                className="shrink-0"
              >
                {sourcesLoading && <LoaderCircle data-icon="inline-start" className="animate-spin" />}
                Retry
              </Button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-surface-subtle px-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Add a file from this device</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                The file stays in Sources even if you cancel this selection.
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.xlsx,.xls,.parquet,.jsonl,.pdf,.docx,.doc,.txt,.md"
              className="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void uploadFile(file);
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled || saving || isUploading}
              onClick={() => fileInputRef.current?.click()}
              className="max-w-full shrink-0"
            >
              {isUploading ? (
                <LoaderCircle data-icon="inline-start" className="animate-spin" />
              ) : (
                <UploadCloud data-icon="inline-start" />
              )}
              Upload file
            </Button>
            {uploadingFileName && (
              <p className="w-full truncate text-xs text-muted-foreground" aria-live="polite" title={uploadingFileName}>
                Uploading <span className="font-medium text-foreground">{uploadingFileName}</span>…
              </p>
            )}
            {uploadError && (
              <p className="w-full text-xs text-destructive" role="alert">
                {uploadError}
              </p>
            )}
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Source scope
            </legend>
            <label
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3 focus-within:ring-2 focus-within:ring-ring",
                draftMode === "all" && "border-primary/40 bg-primary/5"
              )}
            >
              <input
                type="radio"
                name={radioName}
                value="all"
                checked={draftMode === "all"}
                onChange={() => {
                  setDraftMode("all");
                  setError(null);
                }}
                disabled={saving || isUploading}
                className="mt-0.5 size-4 accent-primary"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">Use all current and future sources</span>
                <span className="text-xs text-muted-foreground">
                  New uploads become available to this chat automatically.
                </span>
              </span>
            </label>
            <label
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3 focus-within:ring-2 focus-within:ring-ring",
                draftMode === "selected" && "border-primary/40 bg-primary/5"
              )}
            >
              <input
                type="radio"
                name={radioName}
                value="selected"
                checked={draftMode === "selected"}
                onChange={() => {
                  setDraftMode("selected");
                  setError(null);
                }}
                disabled={saving || isUploading}
                className="mt-0.5 size-4 accent-primary"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">Use selected sources</span>
                <span className="text-xs text-muted-foreground">
                  Choose any subset, including an explicit empty selection.
                </span>
              </span>
            </label>
          </fieldset>

          {draftMode === "selected" && (
            <fieldset className="flex min-h-0 flex-col gap-3">
              <legend className="sr-only">Selected sources</legend>
              <div>
                <label htmlFor={searchId} className="sr-only">
                  Search sources by display name
                </label>
                <Input
                  id={searchId}
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search sources by name…"
                  disabled={saving || isUploading}
                />
              </div>

              <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border bg-background p-1">
                {filteredSources.map((source) => {
                  const selected = selectedIds.has(source.id);
                  return (
                    <label
                      key={source.id}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-md border border-transparent px-3 py-2.5 focus-within:ring-2 focus-within:ring-ring",
                        selected && "border-primary/30 bg-primary/5"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(event) => toggleSource(source.id, event.target.checked)}
                        disabled={saving || isUploading || Boolean(sourcesError)}
                        className="mt-1 size-4 shrink-0 accent-primary"
                      />
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        {source.kind === "tabular" ? <Table2 className="size-4" /> : <FileText className="size-4" />}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate text-sm font-medium text-foreground" title={source.display_name}>
                          {source.display_name}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                          <span>{source.kind}</span>
                          <SourceStatus status={source.status} />
                        </span>
                      </span>
                    </label>
                  );
                })}

                {!sourcesLoading && !sourcesError && sources.length === 0 && (
                  <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No stored sources yet. Upload a file above or keep this selection empty.
                  </p>
                )}
                {sources.length > 0 && filteredSources.length === 0 && (
                  <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No sources match “{search.trim()}”.
                  </p>
                )}
              </div>

              {selectedIds.size === 0 && (
                <p className="text-xs text-muted-foreground">
                  No sources selected. Borealis will not use stored sources for future turns.
                </p>
              )}
            </fieldset>
          )}

          {hasMessages && (
            <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" />
              Changes apply to future answers. Earlier messages, charts, and reports remain in this chat.
            </p>
          )}

          {error && (
            <p className="text-sm text-destructive" role="alert">
              Source selection unchanged: {error}
            </p>
          )}
        </div>

        <DialogFooter className="border-t px-6 py-4">
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={saving || isUploading}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={() => void apply()} disabled={saving || isUploading}>
            {saving && <LoaderCircle data-icon="inline-start" className="animate-spin" />}
            Apply sources
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function selectedSourceIds(mode: SourceMode, sources: AttachedSource[]): Set<string> {
  return new Set(mode === "selected" ? sources.map((source) => source.id) : []);
}

function SourceStatus({ status }: { status: string }) {
  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1 text-success">
        <CheckCircle2 className="size-3.5" /> Ready
      </span>
    );
  }
  if (status === "index") {
    return (
      <span className="inline-flex items-center gap-1 text-warning">
        <LoaderCircle className="size-3.5 animate-spin" /> Processing · unavailable until ready
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-destructive">
      <CircleAlert className="size-3.5" /> {status === "error" ? "Error" : status} · unavailable until ready
    </span>
  );
}
