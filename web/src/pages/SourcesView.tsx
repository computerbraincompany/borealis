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
import { formatApiError, sourcesApi } from "@/lib/api";
import { useSourceCatalog } from "@/hooks/useSourceCatalog";
import { cn, formatDate } from "@/lib/utils";
import { SOURCE_FILE_ACCEPT } from "@/lib/sourceFiles";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

export function SourcesView() {
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { sources, loading, error: catalogError, refresh, addPending } = useSourceCatalog();

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    setOperationError(null);
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        setUploading(f.name);
        try {
          addPending(await sourcesApi.upload(f));
        } catch (error: unknown) {
          setOperationError(formatApiError(error, `Upload failed for ${f.name}`));
        }
      }
    } finally {
      setUploading(null);
      setBusy(false);
      await refresh();
    }
  };

  const remove = async (id: string) => {
    setOperationError(null);
    try {
      await sourcesApi.remove(id);
      await refresh();
    } catch (error: unknown) {
      setOperationError(formatApiError(error, "Could not delete the source"));
    }
  };

  const retry = async (id: string) => {
    setRetrying(id);
    setOperationError(null);
    try {
      addPending(await sourcesApi.reingest(id));
      await refresh();
    } catch (error: unknown) {
      setOperationError(formatApiError(error, "Could not retry source processing"));
    } finally {
      setRetrying(null);
    }
  };

  const pendingCount = sources.filter((s) => s.status === "index").length;

  return (
    <div className="h-full overflow-y-auto">
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
              onChange={(e) => onFiles(e.target.files)}
            />
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
              <UploadCloud className="h-4 w-4" />
              {uploading ? "Uploading…" : "Upload files"}
            </Button>
          </div>
        </div>

        {uploading && (
          <div className="mt-4 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm text-foreground">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin text-primary" />
            Uploading <span className="font-mono text-foreground">{uploading}</span> — chunking and embedding in
            progress…
          </div>
        )}

        {(operationError || catalogError) && (
          <div
            className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            {operationError || catalogError}
          </div>
        )}

        <div className="mt-8 space-y-3">
          {sources.length === 0 && !uploading && (
            <Card className="flex flex-col items-center gap-3 px-5 py-12 text-center sm:py-16">
              <Inbox className="h-10 w-10 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                No sources yet. Upload CSVs, spreadsheets, PDFs or documents so Borealis can answer grounded questions.
              </p>
              <p className="text-xs text-muted-foreground/70">
                Tip: run{" "}
                <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]">
                  python data/generate_sample.py
                </code>{" "}
                for sample personal-finance data.
              </p>
            </Card>
          )}
          {sources.map((s) => (
            <Card key={s.id} className="relative p-4 transition-colors hover:border-foreground/20 sm:p-5">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => remove(s.id)}
                title="Delete source"
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
                    {s.status === "ready" ? (
                      <Badge variant="success">ready</Badge>
                    ) : s.status === "index" ? (
                      <Badge variant="pending">processing</Badge>
                    ) : (
                      <Badge variant="destructive">{s.status}</Badge>
                    )}
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
        </div>
      </div>
    </div>
  );
}
