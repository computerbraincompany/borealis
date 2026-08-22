import { useCallback, useEffect, useRef, useState } from "react";
import { UploadCloud, Trash2, FileSpreadsheet, FileText as FileDoc, RefreshCw, Loader2, Inbox } from "lucide-react";
import { sourcesApi, type Source } from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

export function SourcesView() {
  const [sources, setSources] = useState<Source[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setSources(await sourcesApi.list());
    } catch {}
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [load]);

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        setUploading(f.name);
        try {
          await sourcesApi.upload(f);
        } catch (e: any) {
          alert(`Upload failed: ${e.message}`);
        }
      }
    } finally {
      setUploading(null);
      setBusy(false);
      await load();
    }
  };

  const remove = async (id: string) => {
    await sourcesApi.remove(id);
    await load();
  };

  const readyCount = sources.filter((s) => s.status === "ready").length;
  const pendingCount = sources.length - readyCount;

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
          <Button variant="secondary" onClick={load} disabled={busy} size="sm">
            <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} /> Refresh
          </Button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".csv,.tsv,.xlsx,.xls,.parquet,.jsonl,.pdf,.docx,.doc,.txt,.md"
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
          Uploading <span className="font-mono text-aurora-teal">{uploading}</span> — chunking and embedding in progress…
        </div>
      )}

      <div className="mt-8 space-y-3">
        {sources.length === 0 && !uploading && (
          <Card className="flex flex-col items-center gap-3 py-16 text-center">
            <Inbox className="h-10 w-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              No sources yet. Upload CSVs, spreadsheets, PDFs or documents so North can answer grounded questions.
            </p>
            <p className="text-xs text-muted-foreground/70">
              Tip: run <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]">python data/generate_sample.py</code> for sample personal-finance data.
            </p>
          </Card>
        )}
        {sources.map((s) => (
          <Card key={s.id} className="flex items-center gap-4 p-4 transition-colors hover:border-white/10">
            <div
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
                s.kind === "tabular" ? "bg-aurora-teal/15 text-aurora-teal" : "bg-aurora-violet/15 text-aurora-violet"
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
                  <Badge variant="outline">{s.status}</Badge>
                )}
                <Badge variant="secondary">{s.kind}</Badge>
              </div>
              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="font-mono">{s.name}</span>
                <span>· {s.mime}</span>
                {s.tabular && <span className="text-aurora-teal">· {s.tabular.rows.toLocaleString()} rows · DuckDB table</span>}
                <span>· uploaded {formatDate(s.created_at)}</span>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={() => remove(s.id)} title="Delete source" className="shrink-0 text-muted-foreground hover:text-destructive">
              <Trash2 className="h-4 w-4" />
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
