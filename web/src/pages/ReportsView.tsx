import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, Trash2, FileText, Eye, Download, MessageSquare, Pencil } from "lucide-react";
import {
  reportsApi,
  chartsApi,
  type Report,
  type ChartArtifactSummary,
  apiText,
  formatApiError,
  openProtected,
} from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

const GALLERY_LIMIT = 24;

function ChartArtifactCard({ chart }: { chart: ChartArtifactSummary }) {
  const [png, setPng] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    chartsApi
      .get(chart.id)
      .then((payload) => {
        if (!cancelled && payload.png_base64) setPng(payload.png_base64);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [chart.id]);

  return (
    <Card className="overflow-hidden transition-colors hover:border-foreground/20">
      <div className="flex h-28 items-center justify-center bg-secondary/40">
        {png ? (
          <img
            src={`data:image/png;base64,${png}`}
            alt={`Chart ${chart.title || chart.id}`}
            className="max-h-28 w-auto object-contain"
          />
        ) : (
          <BarChart3 className="h-8 w-8 text-muted-foreground/40" aria-hidden />
        )}
      </div>
      <div className="space-y-1 p-3">
        <div className="truncate text-sm font-medium text-foreground" title={chart.title || undefined}>
          {chart.title || "Untitled chart"}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">{chart.kind}</Badge>
          <span>{formatDate(chart.created_at)}</span>
          {chart.chat_id && (
            <a
              href={`#/chat/${chart.chat_id}`}
              className="inline-flex items-center gap-1 text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MessageSquare className="h-3 w-3" />
              source chat
            </a>
          )}
        </div>
      </div>
    </Card>
  );
}

export function ReportsView() {
  const [reports, setReports] = useState<Report[]>([]);
  const [charts, setCharts] = useState<ChartArtifactSummary[]>([]);
  const [chartsError, setChartsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Report | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const previewRequestRef = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    setPageError(null);
    setChartsError(null);
    try {
      const [reportRows, chartRows] = await Promise.all([reportsApi.list(), chartsApi.list()]);
      setReports(reportRows);
      setCharts(chartRows);
    } catch (failure: unknown) {
      // Reports stay usable when only the chart registry fails.
      try {
        setReports(await reportsApi.list());
        setChartsError(formatApiError(failure, "Could not load the chart gallery"));
      } catch (reportFailure: unknown) {
        setPageError(formatApiError(reportFailure, "Could not load reports"));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => previewAbortRef.current?.abort();
  }, [load]);

  const remove = async (r: Report) => {
    setPageError(null);
    try {
      await reportsApi.remove(r.id);
      await load();
    } catch (failure: unknown) {
      setPageError(formatApiError(failure, "Could not delete the report"));
    }
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const title = renameValue.trim();
    if (!title) return;
    setRenaming(true);
    setPageError(null);
    try {
      const renamed = await reportsApi.rename(renameTarget.id, title);
      setReports((current) => current.map((report) => (report.id === renamed.id ? renamed : report)));
      setRenameTarget(null);
    } catch (failure: unknown) {
      setPageError(formatApiError(failure, "Could not rename the report"));
    } finally {
      setRenaming(false);
    }
  };

  const download = async (report: Report) => {
    setPageError(null);
    try {
      await openProtected("pdf", `/api/reports/${report.id}/pdf`, `${report.title}.pdf`);
    } catch (failure: unknown) {
      setPageError(formatApiError(failure, "Could not download the report PDF"));
    }
  };

  const openPreview = async (r: Report) => {
    const requestId = ++previewRequestRef.current;
    previewAbortRef.current?.abort();
    const abort = new AbortController();
    previewAbortRef.current = abort;
    setPreview(r.id);
    setPreviewTitle(r.title);
    setPreviewHtml(null);
    setPreviewErr(null);
    try {
      const html = await apiText(`/api/reports/${r.id}/html`, abort.signal);
      if (requestId === previewRequestRef.current && !abort.signal.aborted) setPreviewHtml(html);
    } catch (error: unknown) {
      if (requestId === previewRequestRef.current && !abort.signal.aborted) {
        setPreviewErr(formatApiError(error, "Could not load report HTML"));
      }
    }
  };

  const closePreview = () => {
    previewRequestRef.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    setPreview(null);
    setPreviewHtml(null);
    setPreviewErr(null);
  };

  const versionOf = (id: string | null) => (id ? reports.find((report) => report.id === id) : undefined);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Self-contained HTML and PDF reports generated by Borealis from your chats.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={load}>
          Refresh
        </Button>
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
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : reports.length === 0 ? (
        <Card className="mt-8 flex flex-col items-center gap-3 py-16 text-center">
          <FileText className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            No reports yet. Ask Borealis in a chat to "create a report" and it will land here as HTML + PDF.
          </p>
        </Card>
      ) : (
        <div className="mt-8 space-y-3">
          {reports.map((r) => {
            const previous = versionOf(r.supersedes);
            return (
              <Card key={r.id} className="flex items-center gap-4 p-4 transition-colors hover:border-foreground/20">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FileText className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-foreground">{r.title}</span>
                    <Badge variant="secondary">v{r.version}</Badge>
                    <Badge variant="secondary">HTML + PDF</Badge>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{r.subtitle || "No subtitle"}</div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>Created {formatDate(r.created_at)}</span>
                    {r.chat_id && (
                      <a
                        href={`#/chat/${r.chat_id}`}
                        className="inline-flex items-center gap-1 text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <MessageSquare className="h-3 w-3" />
                        {r.chat_title || "source chat"}
                      </a>
                    )}
                    {previous && (
                      <button
                        type="button"
                        onClick={() => void openPreview(previous)}
                        className="text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        supersedes v{previous.version}
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => openPreview(r)}>
                    <Eye className="h-4 w-4" /> Preview
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setRenameTarget(r);
                      setRenameValue(r.title);
                    }}
                    title="Rename report"
                    className="text-muted-foreground hover:text-primary"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void download(r)}
                    title="Download PDF"
                    className="text-muted-foreground hover:text-primary"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void remove(r)}
                    title="Delete report"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {charts.length > 0 && (
        <section className="mt-12" aria-labelledby="chart-gallery-heading">
          <h2 id="chart-gallery-heading" className="text-lg font-semibold tracking-tight">
            Charts
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Chart artifacts kept from your chats, newest first. Each one is a durable, re-renderable object.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {charts.slice(0, GALLERY_LIMIT).map((chart) => (
              <ChartArtifactCard key={chart.id} chart={chart} />
            ))}
          </div>
        </section>
      )}
      {chartsError && (
        <p className="mt-3 text-xs text-muted-foreground" role="alert">
          {chartsError}
        </p>
      )}

      {/* rename dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename report</DialogTitle>
            <DialogDescription>Give this report a title you can recognize later.</DialogDescription>
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
              maxLength={200}
              aria-label="Report title"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setRenameTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={renaming || !renameValue.trim()}>
                {renaming ? "Renaming…" : "Rename"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* report preview dialog */}
      <Dialog open={!!preview} onOpenChange={(open) => !open && closePreview()}>
        <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col overflow-hidden p-0">
          <DialogHeader className="px-6 pt-5">
            <DialogTitle>{previewTitle}</DialogTitle>
            <DialogDescription>
              This export uses a fixed light, print-oriented document theme and renders identically to the PDF.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden px-6 pb-6">
            {previewHtml ? (
              <iframe
                srcDoc={previewHtml}
                className="h-[70vh] w-full rounded-lg border bg-white"
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                title="Report preview"
              />
            ) : previewErr ? (
              <div
                className="flex h-[calc(70vh-2rem)] items-center justify-center rounded-lg border border-destructive/30 bg-destructive/10 text-sm text-destructive"
                role="alert"
              >
                {previewErr}
              </div>
            ) : (
              <div className="space-y-3 p-2">
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-64 w-full" />
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
