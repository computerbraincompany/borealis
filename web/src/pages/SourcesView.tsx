import { useEffect, useRef, useState } from "react";
import {
  UploadCloud,
  Trash2,
  FileSpreadsheet,
  FileText as FileDoc,
  RefreshCw,
  Loader2,
  Inbox,
  ChevronDown,
  CircleAlert,
} from "lucide-react";
import { formatApiError, sourcesApi, type Source } from "@/lib/api";
import { useSourceCatalog } from "@/hooks/useSourceCatalog";
import { useEgressConsentGate } from "@/hooks/useEgressConsentGate";
import { cn, formatDate } from "@/lib/utils";
import { SOURCE_FILE_ACCEPT } from "@/lib/sourceFiles";
import { sourceStatusPresentation } from "@/lib/sourceStatus";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export function SourcesView() {
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Source | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const {
    sources,
    loading,
    loadingMore,
    hasMore,
    error: catalogError,
    refresh,
    loadMore,
    addPending,
    applyOne,
    removeOne,
  } = useSourceCatalog();
  const { handleConsentError, dialog: consentDialog } = useEgressConsentGate();

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const onFiles = async (files: File[]) => {
    if (files.length === 0) return;
    await uploadBatch(files);
  };

  const uploadBatch = async (files: File[]) => {
    setOperationError(null);
    setBusy(true);
    const failures: string[] = [];
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setUploading(file.name);
        try {
          addPending(await sourcesApi.upload(file));
        } catch (error: unknown) {
          // Consent takes over the flow: uploads halt and resume from the
          // blocked file after acknowledgment, so nothing is uploaded twice.
          if (handleConsentError(error, () => void uploadBatch(files.slice(index)))) return;
          failures.push(`${file.name}: ${formatApiError(error, "upload failed")}`);
        }
      }
    } finally {
      setUploading(null);
      setBusy(false);
      await refresh();
    }
    if (failures.length > 0) setOperationError(failures.join("\n"));
  };

  const confirmRemove = async () => {
    if (!deleteTarget || deletingId === deleteTarget.id) return;
    const id = deleteTarget.id;
    setDeletingId(id);
    setOperationError(null);
    try {
      await sourcesApi.remove(id);
      removeOne(id);
      await refresh();
      setDeleteTarget(null);
    } catch (error: unknown) {
      setOperationError(formatApiError(error, "Could not delete the source"));
      setDeleteTarget(null);
    } finally {
      setDeletingId(null);
    }
  };

  const retry = async (id: string) => {
    setRetrying(id);
    setOperationError(null);
    try {
      applyOne(await sourcesApi.reingest(id));
      await refresh();
    } catch (error: unknown) {
      if (!handleConsentError(error, () => void retry(id))) {
        setOperationError(formatApiError(error, "Could not retry source processing"));
      }
    } finally {
      setRetrying(null);
    }
  };

  const pendingCount = sources.filter((s) => s.status === "index").length;

  return (
    <div className="h-full overflow-y-auto">
      {consentDialog}
      {deleteTarget && (
        <ConfirmDialog
          title={`Delete “${deleteTarget.display_name}”?`}
          description="This removes the uploaded file, its extracted text, and its search index. This cannot be undone."
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
            <h1 className="text-2xl font-bold tracking-tight">Sources</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Uploaded files and datasets your agent can query.{" "}
              {pendingCount > 0 && `${pendingCount} still processing.`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => void refresh(true)} disabled={busy || loading} size="sm">
              <RefreshCw className={cn("h-4 w-4", (busy || loading) && "animate-spin")} /> Refresh
            </Button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={SOURCE_FILE_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                // Reset the value so re-selecting the same file (e.g. after a
                // failed upload) still fires a change event.
                e.target.value = "";
                void onFiles(files);
              }}
            />
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
              <UploadCloud className="h-4 w-4" />
              {uploading ? "Uploading…" : "Upload files"}
            </Button>
          </div>
        </div>

        {uploading && (
          <div
            role="status"
            className="mt-4 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm text-foreground"
          >
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin text-primary" />
            Uploading <span className="font-mono text-foreground">{uploading}</span> — chunking and embedding in
            progress…
          </div>
        )}

        {(operationError || catalogError) && (
          <div
            className="mt-4 whitespace-pre-line rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            {operationError || catalogError}
          </div>
        )}

        <div className="mt-8 space-y-3">
          {sources.length === 0 && loading && !catalogError && (
            <Card className="px-5 py-12" aria-hidden="true">
              <div className="mx-auto flex max-w-md flex-col gap-3">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="h-10 animate-pulse rounded-lg bg-accent/60" />
                ))}
              </div>
            </Card>
          )}
          {sources.length === 0 && !loading && !uploading && !catalogError && (
            <Card className="flex flex-col items-center gap-3 px-5 py-12 text-center sm:py-16">
              <Inbox className="h-10 w-10 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                No sources yet. Upload CSVs, spreadsheets, PDFs or documents so Borealis can answer grounded questions.
              </p>
              {import.meta.env.DEV && (
                <p className="text-xs text-muted-foreground/70">
                  Tip (development builds): run{" "}
                  <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]">
                    pnpm --filter borealis-server exec tsx ../data/generate_sample.ts
                  </code>{" "}
                  for sample personal-finance data.
                </p>
              )}
            </Card>
          )}
          {sources.map((s) => (
            <Card key={s.id} className="relative p-4 transition-colors hover:border-foreground/20 sm:p-5">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDeleteTarget(s)}
                disabled={deletingId === s.id}
                title="Delete source"
                aria-label={`Delete ${s.display_name}`}
                className="absolute right-2 top-2 text-muted-foreground hover:text-destructive sm:right-3 sm:top-3"
              >
                <Trash2 className="h-4 w-4" />
              </Button>

              <div className="grid min-w-0 gap-4 pr-9 sm:grid-cols-[auto_minmax(0,1fr)] sm:pr-10">
                <div
                  className={cn(
                    "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg",
                    s.kind === "tabular" ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground",
                  )}
                >
                  {s.kind === "tabular" ? <FileSpreadsheet className="h-5 w-5" /> : <FileDoc className="h-5 w-5" />}
                </div>

                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-all font-medium leading-5 text-foreground">{s.display_name}</span>
                    <Badge variant={sourceStatusPresentation(s.status).tone}>
                      {sourceStatusPresentation(s.status).label}
                    </Badge>
                    <Badge variant="secondary">{s.kind}</Badge>
                  </div>
                  <div className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="min-w-0 break-all font-mono">{s.name}</span>
                    <span>{s.mime}</span>
                    {s.tabular && (
                      <span className="text-primary">{s.tabular.rows.toLocaleString()} rows · DuckDB table</span>
                    )}
                    <span>Uploaded {formatDate(s.created_at)}</span>
                  </div>

                  {s.status === "error" && s.meta?.error && (
                    <div className="mt-3 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2.5">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <p className="flex min-w-0 items-start gap-2 text-sm text-destructive">
                          <CircleAlert className="mt-0.5 size-4 shrink-0" />
                          <span className="min-w-0 break-words">{s.meta.error}</span>
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => retry(s.id)}
                          disabled={retrying === s.id}
                          className="self-start"
                        >
                          <RefreshCw className={cn("h-4 w-4", retrying === s.id && "animate-spin")} /> Retry
                        </Button>
                      </div>
                      <details className="group mt-2 text-xs text-muted-foreground">
                        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                          <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                          View error details
                        </summary>
                        <dl className="mt-3 grid gap-2 border-t pt-3 sm:grid-cols-[7rem_minmax(0,1fr)]">
                          <dt className="font-medium text-foreground">What happened</dt>
                          <dd className="break-words">{s.meta.error_detail || s.meta.error}</dd>
                          {s.meta.error_stage && (
                            <>
                              <dt className="font-medium text-foreground">Stage</dt>
                              <dd className="capitalize">{s.meta.error_stage}</dd>
                            </>
                          )}
                          {s.ingestion && (
                            <>
                              <dt className="font-medium text-foreground">Attempts</dt>
                              <dd>{s.ingestion.attempts}</dd>
                              <dt className="font-medium text-foreground">Last attempt</dt>
                              <dd>{formatDate(s.ingestion.updated_at)}</dd>
                            </>
                          )}
                          {s.meta.error_code && (
                            <>
                              <dt className="font-medium text-foreground">Error code</dt>
                              <dd className="break-all font-mono text-[11px] text-foreground">{s.meta.error_code}</dd>
                            </>
                          )}
                        </dl>
                      </details>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          ))}
          {hasMore && (
            <div className="flex justify-center pt-3">
              <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                Load older sources
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
