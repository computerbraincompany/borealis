import { useEffect, useRef, useState } from "react";
import { UploadCloud, Trash2, FileSpreadsheet, FileText as FileDoc, RefreshCw, Loader2, Inbox } from "lucide-react";
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
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Sources</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Uploaded files and datasets your agent can query. {pendingCount > 0 && `${pendingCount} still processing.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
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
          <Button variant="aurora" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
            <UploadCloud className="h-4 w-4" />
            {uploading ? "Uploading…" : "Upload files"}
          </Button>
        </div>
      </div>

      {uploading && (
        <div className="mt-4 rounded-xl border border-aurora-teal/20 bg-aurora-teal/5 px-4 py-3 text-sm text-foreground">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin text-aurora-teal" />
          Uploading <span className="font-mono text-foreground">{uploading}</span> — chunking and embedding in progress…
        </div>
      )}

      {(operationError || catalogError) && (
        <div
          className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {operationError || catalogError}
        </div>
      )}

      <div className="mt-8 space-y-3">
        {sources.length === 0 && !uploading && (
          <Card className="flex flex-col items-center gap-3 py-16 text-center">
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
          <Card key={s.id} className="flex items-center gap-4 p-4 transition-colors hover:border-foreground/20">
            <div
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
                s.kind === "tabular" ? "bg-aurora-teal/15 text-aurora-teal" : "bg-aurora-violet/15 text-aurora-violet",
              )}
            >
              {s.kind === "tabular" ? <FileSpreadsheet className="h-5 w-5" /> : <FileDoc className="h-5 w-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-foreground">{s.display_name}</span>
                {s.status === "ready" ? (
                  <Badge variant="success">ready</Badge>
                ) : s.status === "index" ? (
                  <Badge variant="pending">processing</Badge>
                ) : (
                  <Badge variant="destructive">{s.status}</Badge>
                )}
                <Badge variant="secondary">{s.kind}</Badge>
              </div>
              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="font-mono">{s.name}</span>
                <span>· {s.mime}</span>
                {s.tabular && (
                  <span className="text-aurora-teal">· {s.tabular.rows.toLocaleString()} rows · DuckDB table</span>
                )}
                <span>· uploaded {formatDate(s.created_at)}</span>
              </div>
              {s.status === "error" && s.meta?.error && (
                <p className="mt-1 truncate text-xs text-destructive" title={s.meta.error}>
                  {s.meta.error}
                </p>
              )}
            </div>
            {s.status === "error" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => retry(s.id)}
                disabled={retrying === s.id}
                className="shrink-0"
              >
                <RefreshCw className={cn("h-4 w-4", retrying === s.id && "animate-spin")} /> Retry
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => remove(s.id)}
              title="Delete source"
              className="shrink-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
