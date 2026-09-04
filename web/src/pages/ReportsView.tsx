import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, Trash2, FileText, Eye, Download, MessageSquare, Pencil, Loader2, RefreshCw } from "lucide-react";
import {
  api,
  reportsApi,
  chartsApi,
  type Report,
  type ChartArtifactSummary,
  type ReportShare,
  type SharedReport,
  apiText,
  formatApiError,
  openProtected,
} from "@/lib/api";
import { mergeCatalogContinuation, mergeCatalogHead } from "@/lib/catalogMerge";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ConfirmDialog";

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
  const [reportsNextCursor, setReportsNextCursor] = useState<string | null>(null);
  const [reportsLoadingMore, setReportsLoadingMore] = useState(false);
  const [charts, setCharts] = useState<ChartArtifactSummary[]>([]);
  const [chartsError, setChartsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  // Mutations that fail while a dialog is open must surface inside that dialog;
  // the page banner is hidden behind the modal overlay.
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Report | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [sharedReports, setSharedReports] = useState<SharedReport[]>([]);
  const [sharedError, setSharedError] = useState<string | null>(null);
  const [sharedNextCursor, setSharedNextCursor] = useState<string | null>(null);
  const [sharedLoadingMore, setSharedLoadingMore] = useState(false);
  const [shareTarget, setShareTarget] = useState<Report | null>(null);
  const [shareAccounts, setShareAccounts] = useState<Array<{ id: string; email: string }>>([]);
  const [shareList, setShareList] = useState<ReportShare[]>([]);
  const [sharing, setSharing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Report | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const previewRequestRef = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);
  const shareRequestRef = useRef(0);
  const shareAbortRef = useRef<AbortController | null>(null);
  const renameRequestRef = useRef(0);
  const renameAbortRef = useRef<AbortController | null>(null);
  const renameTargetIdRef = useRef<string | null>(null);
  const deleteRequestRef = useRef(0);
  const deleteRequestsRef = useRef(new Map<string, { requestId: number; abort: AbortController }>());
  const reportsCatalogRequestRef = useRef(0);
  const reportsNextCursorRef = useRef<string | null>(null);
  const reportsLoadingMoreOwnerRef = useRef<number | null>(null);
  const sharedCatalogRequestRef = useRef(0);
  const sharedNextCursorRef = useRef<string | null>(null);
  const sharedLoadingMoreOwnerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);

  const invalidateReportsCatalog = () => {
    reportsCatalogRequestRef.current += 1;
    reportsLoadingMoreOwnerRef.current = null;
    setReportsLoadingMore(false);
    setLoading(false);
  };

  const load = useCallback(async () => {
    const reportsRequestId = ++reportsCatalogRequestRef.current;
    const sharedRequestId = ++sharedCatalogRequestRef.current;
    reportsLoadingMoreOwnerRef.current = null;
    sharedLoadingMoreOwnerRef.current = null;
    setReportsLoadingMore(false);
    setSharedLoadingMore(false);
    setPageError(null);
    setChartsError(null);
    try {
      const [reportPage, chartRows] = await Promise.all([reportsApi.list(), chartsApi.list()]);
      if (mountedRef.current && reportsRequestId === reportsCatalogRequestRef.current) {
        setReports((current) => mergeCatalogHead(reportPage.items, current));
        reportsNextCursorRef.current = reportPage.next_cursor;
        setReportsNextCursor(reportPage.next_cursor);
        setCharts(chartRows);
      }
    } catch (failure: unknown) {
      // Reports stay usable when only the chart registry fails.
      try {
        const reportPage = await reportsApi.list();
        if (mountedRef.current && reportsRequestId === reportsCatalogRequestRef.current) {
          setReports((current) => mergeCatalogHead(reportPage.items, current));
          reportsNextCursorRef.current = reportPage.next_cursor;
          setReportsNextCursor(reportPage.next_cursor);
          setChartsError(formatApiError(failure, "Could not load the chart gallery"));
        }
      } catch (reportFailure: unknown) {
        if (mountedRef.current && reportsRequestId === reportsCatalogRequestRef.current) {
          setPageError(formatApiError(reportFailure, "Could not load reports"));
        }
      }
    } finally {
      if (mountedRef.current && reportsRequestId === reportsCatalogRequestRef.current) setLoading(false);
    }
    try {
      const sharedPage = await reportsApi.listShared();
      if (!mountedRef.current || sharedRequestId !== sharedCatalogRequestRef.current) return;
      setSharedReports((current) => mergeCatalogHead(sharedPage.items, current));
      sharedNextCursorRef.current = sharedPage.next_cursor;
      setSharedNextCursor(sharedPage.next_cursor);
      setSharedError(null);
    } catch (failure: unknown) {
      // The "Shared with me" section must not silently disappear on failure.
      if (mountedRef.current && sharedRequestId === sharedCatalogRequestRef.current) {
        setSharedError(formatApiError(failure, "Could not load shared reports"));
      }
    }
  }, []);

  const loadMoreReports = async () => {
    const cursor = reportsNextCursorRef.current;
    if (!cursor || reportsLoadingMoreOwnerRef.current !== null) return;
    const requestId = ++reportsCatalogRequestRef.current;
    reportsLoadingMoreOwnerRef.current = requestId;
    setReportsLoadingMore(true);
    setPageError(null);
    try {
      const page = await reportsApi.list({ cursor });
      if (!mountedRef.current || requestId !== reportsCatalogRequestRef.current) return;
      reportsNextCursorRef.current = page.next_cursor;
      setReportsNextCursor(page.next_cursor);
      setReports((current) => mergeCatalogContinuation(current, page.items));
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === reportsCatalogRequestRef.current) {
        setPageError(formatApiError(failure, "Could not load older reports"));
      }
    } finally {
      if (reportsLoadingMoreOwnerRef.current === requestId) {
        reportsLoadingMoreOwnerRef.current = null;
        if (mountedRef.current) setReportsLoadingMore(false);
      }
    }
  };

  const loadMoreSharedReports = async () => {
    const cursor = sharedNextCursorRef.current;
    if (!cursor || sharedLoadingMoreOwnerRef.current !== null) return;
    const requestId = ++sharedCatalogRequestRef.current;
    sharedLoadingMoreOwnerRef.current = requestId;
    setSharedLoadingMore(true);
    setPageError(null);
    try {
      const page = await reportsApi.listShared({ cursor });
      if (!mountedRef.current || requestId !== sharedCatalogRequestRef.current) return;
      sharedNextCursorRef.current = page.next_cursor;
      setSharedNextCursor(page.next_cursor);
      setSharedReports((current) => mergeCatalogContinuation(current, page.items));
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === sharedCatalogRequestRef.current) {
        setPageError(formatApiError(failure, "Could not load older shared reports"));
      }
    } finally {
      if (sharedLoadingMoreOwnerRef.current === requestId) {
        sharedLoadingMoreOwnerRef.current = null;
        if (mountedRef.current) setSharedLoadingMore(false);
      }
    }
  };

  useEffect(() => {
    const deleteRequests = deleteRequestsRef.current;
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      reportsCatalogRequestRef.current += 1;
      sharedCatalogRequestRef.current += 1;
      reportsLoadingMoreOwnerRef.current = null;
      sharedLoadingMoreOwnerRef.current = null;
      previewRequestRef.current += 1;
      previewAbortRef.current?.abort();
      shareRequestRef.current += 1;
      shareAbortRef.current?.abort();
      renameRequestRef.current += 1;
      renameAbortRef.current?.abort();
      for (const request of deleteRequests.values()) request.abort.abort();
      deleteRequests.clear();
    };
  }, [load]);

  const openRenameDialog = (report: Report) => {
    renameRequestRef.current += 1;
    renameAbortRef.current?.abort();
    renameAbortRef.current = null;
    renameTargetIdRef.current = report.id;
    setDialogError(null);
    setRenaming(false);
    setRenameTarget(report);
    setRenameValue(report.title);
  };

  const closeRenameDialog = () => {
    renameTargetIdRef.current = null;
    renameRequestRef.current += 1;
    renameAbortRef.current?.abort();
    renameAbortRef.current = null;
    setDialogError(null);
    setRenaming(false);
    setRenameTarget(null);
  };

  const confirmRemove = async () => {
    if (!deleteTarget || deletingId === deleteTarget.id) return;
    const report = deleteTarget;
    setDeletingId(report.id);
    setPageError(null);
    try {
      await remove(report);
      setDeleteTarget(null);
    } finally {
      setDeletingId(null);
    }
  };

  const remove = async (r: Report) => {
    const targetId = r.id;
    const requestId = ++deleteRequestRef.current;
    deleteRequestsRef.current.get(targetId)?.abort.abort();
    const abort = new AbortController();
    deleteRequestsRef.current.set(targetId, { requestId, abort });
    setPageError(null);
    try {
      await reportsApi.remove(targetId, abort.signal);
      if (deleteRequestsRef.current.get(targetId)?.requestId !== requestId || abort.signal.aborted) return;
      invalidateReportsCatalog();
      setReports((current) => current.filter((report) => report.id !== targetId));
    } catch (failure: unknown) {
      if (deleteRequestsRef.current.get(targetId)?.requestId === requestId && !abort.signal.aborted) {
        setPageError(formatApiError(failure, "Could not delete the report"));
      }
    } finally {
      if (deleteRequestsRef.current.get(targetId)?.requestId === requestId) {
        deleteRequestsRef.current.delete(targetId);
      }
    }
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const targetId = renameTarget.id;
    const title = renameValue.trim();
    if (!title) return;
    const requestId = ++renameRequestRef.current;
    renameAbortRef.current?.abort();
    const abort = new AbortController();
    renameAbortRef.current = abort;
    setRenaming(true);
    setPageError(null);
    try {
      const renamed = await reportsApi.rename(targetId, title, abort.signal);
      if (requestId !== renameRequestRef.current || abort.signal.aborted || renameTargetIdRef.current !== targetId)
        return;
      invalidateReportsCatalog();
      setReports((current) => current.map((report) => (report.id === renamed.id ? renamed : report)));
      closeRenameDialog();
    } catch (failure: unknown) {
      if (requestId === renameRequestRef.current && !abort.signal.aborted && renameTargetIdRef.current === targetId) {
        setDialogError(formatApiError(failure, "Could not rename the report"));
      }
    } finally {
      if (requestId === renameRequestRef.current && !abort.signal.aborted && renameTargetIdRef.current === targetId)
        setRenaming(false);
    }
  };

  const openShareDialog = async (report: Report) => {
    const requestId = ++shareRequestRef.current;
    shareAbortRef.current?.abort();
    const abort = new AbortController();
    shareAbortRef.current = abort;
    setShareTarget(report);
    setShareAccounts([]);
    setShareList([]);
    setSharing(true);
    setDialogError(null);
    setPageError(null);
    try {
      const [accounts, shares] = await Promise.all([
        api<Array<{ id: string; email: string }>>("/api/accounts", { signal: abort.signal }),
        reportsApi.listShares(report.id, abort.signal),
      ]);
      if (requestId === shareRequestRef.current && !abort.signal.aborted) {
        setShareAccounts(accounts);
        setShareList(shares);
      }
    } catch (failure: unknown) {
      if (requestId === shareRequestRef.current && !abort.signal.aborted) {
        setDialogError(formatApiError(failure, "Could not load sharing state"));
      }
    } finally {
      if (requestId === shareRequestRef.current && !abort.signal.aborted) setSharing(false);
    }
  };

  const shareWith = async (recipientAccountId: string) => {
    if (!shareTarget) return;
    const reportId = shareTarget.id;
    const requestId = ++shareRequestRef.current;
    shareAbortRef.current?.abort();
    const abort = new AbortController();
    shareAbortRef.current = abort;
    setSharing(true);
    setDialogError(null);
    try {
      await reportsApi.share(reportId, recipientAccountId, abort.signal);
      const shares = await reportsApi.listShares(reportId, abort.signal);
      if (requestId === shareRequestRef.current && !abort.signal.aborted) setShareList(shares);
    } catch (failure: unknown) {
      if (requestId === shareRequestRef.current && !abort.signal.aborted) {
        setDialogError(formatApiError(failure, "Could not share the report"));
      }
    } finally {
      if (requestId === shareRequestRef.current && !abort.signal.aborted) setSharing(false);
    }
  };

  const revokeShare = async (recipientAccountId: string) => {
    if (!shareTarget) return;
    const reportId = shareTarget.id;
    const requestId = ++shareRequestRef.current;
    shareAbortRef.current?.abort();
    const abort = new AbortController();
    shareAbortRef.current = abort;
    setSharing(true);
    setDialogError(null);
    try {
      await reportsApi.revoke(reportId, recipientAccountId, abort.signal);
      const shares = await reportsApi.listShares(reportId, abort.signal);
      if (requestId === shareRequestRef.current && !abort.signal.aborted) setShareList(shares);
    } catch (failure: unknown) {
      if (requestId === shareRequestRef.current && !abort.signal.aborted) {
        setDialogError(formatApiError(failure, "Could not revoke the share"));
      }
    } finally {
      if (requestId === shareRequestRef.current && !abort.signal.aborted) setSharing(false);
    }
  };

  const closeShareDialog = () => {
    shareRequestRef.current += 1;
    shareAbortRef.current?.abort();
    shareAbortRef.current = null;
    setShareTarget(null);
    setShareAccounts([]);
    setShareList([]);
    setSharing(false);
    setDialogError(null);
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
      {deleteTarget && (
        <ConfirmDialog
          title={`Delete “${deleteTarget.title}”?`}
          description="This permanently removes the report, its HTML export, and its PDF. The source chat stays. This cannot be undone."
          busy={deletingId === deleteTarget.id}
          onConfirm={() => void confirmRemove()}
          onCancel={() => {
            if (deletingId !== deleteTarget.id) setDeleteTarget(null);
          }}
        />
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Self-contained HTML and PDF reports generated by Borealis from your chats.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /> Refresh
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
            const artifactsLabel =
              r.has_html === false && r.has_pdf === false
                ? "Artifacts unavailable"
                : r.has_html === false
                  ? "PDF only"
                  : r.has_pdf === false
                    ? "HTML only"
                    : "HTML + PDF";
            return (
              <Card key={r.id} className="flex items-center gap-4 p-4 transition-colors hover:border-foreground/20">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FileText className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-foreground">{r.title}</span>
                    <Badge variant="secondary">v{r.version}</Badge>
                    <Badge variant={r.has_html === false && r.has_pdf === false ? "destructive" : "secondary"}>
                      {artifactsLabel}
                    </Badge>
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
                    {r.supersedes &&
                      (previous ? (
                        <button
                          type="button"
                          onClick={() => void openPreview(previous)}
                          className="text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          supersedes v{previous.version}
                        </button>
                      ) : (
                        <span>supersedes an earlier version</span>
                      ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => openPreview(r)}>
                    <Eye className="h-4 w-4" /> Preview
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void openShareDialog(r)} title="Share snapshot">
                    Share
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => openRenameDialog(r)}
                    title="Rename report"
                    className="text-muted-foreground hover:text-primary"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void download(r)}
                    disabled={r.has_pdf === false}
                    title={r.has_pdf === false ? "PDF artifact is not available" : "Download PDF"}
                    aria-label={`Download PDF of ${r.title}`}
                    className="text-muted-foreground hover:text-primary"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setPageError(null);
                      setDeleteTarget(r);
                    }}
                    disabled={deletingId === r.id}
                    title="Delete report"
                    aria-label={`Delete ${r.title}`}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            );
          })}
          {reportsNextCursor && (
            <div className="flex justify-center pt-2">
              <Button variant="outline" size="sm" onClick={() => void loadMoreReports()} disabled={reportsLoadingMore}>
                {reportsLoadingMore && <Loader2 className="animate-spin" />}
                Load older reports
              </Button>
            </div>
          )}
        </div>
      )}

      {(sharedReports.length > 0 || sharedError) && (
        <section className="mt-12" aria-labelledby="shared-with-me-heading">
          <h2 id="shared-with-me-heading" className="text-lg font-semibold tracking-tight">
            Shared with me
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Read-only report snapshots other workspace accounts shared with you.
          </p>
          {sharedError && (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {sharedError}
              <button
                type="button"
                onClick={() => void load()}
                className="ml-2 rounded-md font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Retry
              </button>
            </p>
          )}
          <div className="mt-4 space-y-3">
            {sharedReports.map((shared) => (
              <Card key={shared.id} className="flex items-center gap-4 p-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                  <FileText className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-foreground">{shared.title}</span>
                    <Badge variant="secondary">v{shared.version}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    From {shared.owner_email} · {formatDate(shared.shared_at)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void openPreview({
                        id: shared.id,
                        title: shared.title,
                        subtitle: shared.subtitle,
                        created_at: shared.created_at,
                        updated_at: shared.created_at,
                        chat_title: null,
                        chat_id: null,
                        version: shared.version,
                        supersedes: null,
                      })
                    }
                  >
                    <Eye className="h-4 w-4" /> Preview
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Download PDF"
                    className="text-muted-foreground hover:text-primary"
                    onClick={() =>
                      void openProtected("pdf", `/api/reports/${shared.id}/pdf`, `${shared.title}.pdf`).catch(
                        (failure: unknown) =>
                          setPageError(formatApiError(failure, "Could not download the shared report PDF")),
                      )
                    }
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            ))}
            {sharedNextCursor && (
              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadMoreSharedReports()}
                  disabled={sharedLoadingMore}
                >
                  {sharedLoadingMore && <Loader2 className="animate-spin" />}
                  Load older shared reports
                </Button>
              </div>
            )}
          </div>
        </section>
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
      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && closeRenameDialog()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename report</DialogTitle>
            <DialogDescription>Give this report a title you can recognize later.</DialogDescription>
          </DialogHeader>
          {dialogError && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {dialogError}
            </p>
          )}
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
              <Button type="button" variant="ghost" size="sm" onClick={closeRenameDialog}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={renaming || !renameValue.trim()}>
                {renaming ? "Renaming…" : "Rename"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* share dialog */}
      <Dialog open={!!shareTarget} onOpenChange={(open) => !open && closeShareDialog()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Share "{shareTarget?.title}"</DialogTitle>
            <DialogDescription>
              Share this report snapshot with another account of this Borealis instance. Recipients get read-only
              Preview and PDF access; you can revoke at any time.
            </DialogDescription>
          </DialogHeader>
          {dialogError && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {dialogError}
            </p>
          )}
          <div className="space-y-2">
            {shareAccounts
              .filter((account) => account.id !== undefined)
              .map((account) => {
                const existing = shareList.find((share) => share.recipient_account_id === account.id);
                return (
                  <div
                    key={account.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate">{account.email}</span>
                    {existing ? (
                      <Button variant="ghost" size="sm" onClick={() => void revokeShare(account.id)} disabled={sharing}>
                        Revoke
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => void shareWith(account.id)} disabled={sharing}>
                        Share
                      </Button>
                    )}
                  </div>
                );
              })}
            {sharing && shareAccounts.length === 0 && (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                Loading workspace accounts…
              </p>
            )}
            {!sharing && shareAccounts.length === 0 && !dialogError && (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                No other accounts on this instance to share with.
              </p>
            )}
          </div>
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
