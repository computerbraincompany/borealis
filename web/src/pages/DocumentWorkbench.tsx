import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookTemplate,
  Download,
  Eye,
  FileEdit,
  FilePlus,
  Files,
  GitCompare,
  History,
  Loader2,
  Plus,
  Rocket,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  documentTemplatesApi,
  documentsApi,
  downloadBlob,
  formatApiError,
  isDocumentPublicationErrorCode,
  isDocumentRewriteErrorCode,
  openProtected,
  parseDocumentRevisionConflict,
  parseDocumentRewriteStale,
  DOCUMENT_HEAD_MOVED_CODE,
  DOCUMENT_PUBLICATION_ACTIVE_CODE,
  DOCUMENT_REWRITE_ACTIVE_CODE,
  DOCUMENT_REWRITE_QUOTA_CODE,
  type DocumentConflictHead,
  type DocumentDetail,
  type DocumentExportFormat,
  type DocumentPublicationSummary,
  type DocumentRevisionDiff,
  type DocumentRevisionPayload,
  type DocumentRevisionSummary,
  type DocumentRewrite,
  type DocumentRewriteStatus,
  type DocumentDiffOp,
  type DocumentSummary,
  type DocumentTemplateSummary,
  type DocumentTreeInput,
} from "@/lib/api";
import { sha256Hex, splitsSurrogatePair } from "@/lib/sha256";
import { diffRewriteText } from "@/lib/rewriteDiff";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface DraftSection {
  id: string;
  heading: string;
  markdown: string;
}

interface DraftState {
  title: string;
  subtitle: string;
  sections: DraftSection[];
}

function draftFromRevision(revision: DocumentRevisionPayload): DraftState {
  return {
    title: revision.payload.title,
    subtitle: revision.payload.subtitle,
    sections: revision.payload.sections.map((section) => ({ ...section })),
  };
}

function newSectionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Move a section by its stable UUID; clamped so repeated moves are idempotent at the ends. */
function moveSectionById(sections: readonly DraftSection[], id: string, delta: number): DraftSection[] {
  const from = sections.findIndex((section) => section.id === id);
  if (from < 0) return [...sections];
  const to = Math.max(0, Math.min(sections.length - 1, from + delta));
  if (to === from) return [...sections];
  const next = [...sections];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

function TemplatePickerDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (document: DocumentSummary) => void;
}) {
  const [templates, setTemplates] = useState<DocumentTemplateSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    const requestId = ++requestRef.current;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setTemplates([]);
    setLoadError(null);
    setCreateError(null);
    void (async () => {
      try {
        const page = await documentTemplatesApi.list({ signal: abort.signal });
        if (requestId === requestRef.current && !abort.signal.aborted) setTemplates(page.items);
      } catch (error) {
        if (requestId === requestRef.current && !abort.signal.aborted) {
          setLoadError(formatApiError(error, "Could not load templates"));
        }
      }
    })();
    return () => {
      requestRef.current += 1;
      abort.abort();
    };
  }, [open]);

  const create = async (body: { title?: string; template_id?: string }) => {
    if (creating) return;
    const requestId = ++requestRef.current;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setCreating(body.template_id ?? "blank");
    setCreateError(null);
    try {
      const created = await documentsApi.create(body, abort.signal);
      if (requestId === requestRef.current && !abort.signal.aborted) {
        onCreated(created.document);
      }
    } catch (error) {
      if (requestId === requestRef.current && !abort.signal.aborted) {
        setCreateError(formatApiError(error, "Could not create the document"));
      }
    } finally {
      if (requestId === requestRef.current && !abort.signal.aborted) setCreating(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Block dismissal while a creation is in flight: its failure slot
        // lives inside this dialog (ConfirmDialog busy pattern).
        if (!next && creating) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New document</DialogTitle>
          <DialogDescription>
            Start blank or from a structure-only template. Templates never attach sources or data automatically — you
            add those explicitly afterwards.
          </DialogDescription>
        </DialogHeader>
        {(loadError || createError) && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {createError ?? loadError}
          </p>
        )}
        <div className="space-y-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void create({ title: "Untitled document" })}
            disabled={!!creating}
          >
            {creating === "blank" ? <Loader2 className="animate-spin" /> : <FilePlus className="h-4 w-4" />}
            Blank document
          </Button>
          {templates.map((template) => (
            <div key={template.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{template.name}</span>
                  {template.built_in && <Badge variant="secondary">built-in</Badge>}
                </div>
                {template.description && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{template.description}</p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void create({ template_id: template.id })}
                disabled={!!creating}
              >
                {creating === template.id ? <Loader2 className="animate-spin" /> : <BookTemplate className="h-4 w-4" />}
                Use
              </Button>
            </div>
          ))}
          {templates.length === 0 && !loadError && (
            <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
              Loading templates…
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DocumentCatalog() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DocumentSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const catalogRequestRef = useRef(0);
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreOwnerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const deleteRequestRef = useRef(0);
  const deleteAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const requestId = ++catalogRequestRef.current;
    loadingMoreOwnerRef.current = null;
    setLoadingMore(false);
    setLoading(true);
    setPageError(null);
    try {
      const page = await documentsApi.list();
      if (requestId === catalogRequestRef.current && mountedRef.current) {
        setDocuments(page.items);
        nextCursorRef.current = page.next_cursor;
        setNextCursor(page.next_cursor);
      }
    } catch (error) {
      if (requestId === catalogRequestRef.current && mountedRef.current) {
        setPageError(formatApiError(error, "Could not load documents"));
      }
    } finally {
      if (requestId === catalogRequestRef.current && mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      catalogRequestRef.current += 1;
      loadingMoreOwnerRef.current = null;
      deleteRequestRef.current += 1;
      deleteAbortRef.current?.abort();
    };
  }, [load]);

  const loadMore = async () => {
    const cursor = nextCursorRef.current;
    if (!cursor || loadingMoreOwnerRef.current !== null) return;
    const requestId = ++catalogRequestRef.current;
    loadingMoreOwnerRef.current = requestId;
    setLoadingMore(true);
    try {
      const page = await documentsApi.list({ cursor });
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return;
      nextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
      setDocuments((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
    } catch (error) {
      if (mountedRef.current && requestId === catalogRequestRef.current) {
        setPageError(formatApiError(error, "Could not load older documents"));
      }
    } finally {
      if (loadingMoreOwnerRef.current === requestId) {
        loadingMoreOwnerRef.current = null;
        if (mountedRef.current) setLoadingMore(false);
      }
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    const target = deleteTarget;
    const requestId = ++deleteRequestRef.current;
    const abort = new AbortController();
    deleteAbortRef.current = abort;
    setDeleting(true);
    try {
      await documentsApi.remove(target.id, abort.signal);
      if (deleteRequestRef.current !== requestId || abort.signal.aborted || !mountedRef.current) return;
      // Bump the catalog generation before filtering so an in-flight older
      // list cannot resurrect the deleted row.
      catalogRequestRef.current += 1;
      setDocuments((current) => current.filter((item) => item.id !== target.id));
      setDeleteTarget(null);
    } catch (error) {
      if (deleteRequestRef.current === requestId && !abort.signal.aborted && mountedRef.current) {
        setPageError(formatApiError(error, "Could not delete the document"));
        setDeleteTarget(null);
      }
    } finally {
      if (deleteRequestRef.current === requestId && mountedRef.current) setDeleting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        {deleteTarget && (
          <ConfirmDialog
            title={`Delete “${deleteTarget.title}”?`}
            description="The document and its revision history are removed. Legacy reports and source chats are untouched. This cannot be undone."
            busy={deleting}
            onConfirm={() => void confirmDelete()}
            onCancel={() => {
              if (!deleting) setDeleteTarget(null);
            }}
          />
        )}
        <TemplatePickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onCreated={(doc) => (window.location.hash = `#/documents/${doc.id}`)}
        />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Documents</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Editable documents with immutable revisions. Create blank, from a template, or as an editable copy of a
              report.
            </p>
          </div>
          <Button size="sm" onClick={() => setPickerOpen(true)}>
            <FilePlus className="h-4 w-4" /> New document
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
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        ) : documents.length === 0 ? (
          <Card className="mt-8 flex flex-col items-center gap-3 py-16 text-center">
            <Files className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No documents yet. Start one from a template, or use “Create editable copy” on a report.
            </p>
          </Card>
        ) : (
          <div className="mt-8 space-y-3">
            {documents.map((document) => (
              <Card key={document.id} className="flex items-center gap-4 p-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FileEdit className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <a
                    href={`#/documents/${document.id}`}
                    className="block truncate font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {document.title}
                  </a>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>Revision {document.current_revision}</span>
                    <span>{document.revision_count} revisions</span>
                    <span>Updated {formatDate(document.updated_at)}</span>
                    {document.latest_publication_version !== null && (
                      <Badge variant="secondary">published v{document.latest_publication_version}</Badge>
                    )}
                    {document.origin.report_id && <Badge variant="outline">report copy</Badge>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button variant="outline" size="sm" asChild>
                    <a href={`#/documents/${document.id}`}>Open</a>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setPageError(null);
                      setDeleteTarget(document);
                    }}
                    title="Delete document"
                    aria-label={`Delete ${document.title}`}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            ))}
            {nextCursor && (
              <div className="flex justify-center pt-2">
                <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore && <Loader2 className="animate-spin" />} Load older documents
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function EvidenceInspector({ revision }: { revision: DocumentRevisionPayload | null }) {
  const evidence = revision?.payload.evidence ?? [];
  const markers = useMemo(() => {
    if (!revision) return [] as number[];
    const text = revision.payload.sections.map((section) => section.markdown).join("\n");
    const found = new Set<number>();
    for (const match of text.matchAll(/\[(\d{1,2})\]/g)) found.add(Number(match[1]));
    return [...found].sort((left, right) => left - right);
  }, [revision]);
  const unresolved = markers.filter((marker) => marker < 1 || marker > evidence.length);

  return (
    <section className="mt-8" aria-labelledby="evidence-inspector-heading">
      <h2 id="evidence-inspector-heading" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        Evidence
        {revision &&
          (revision.payload.verified ? (
            <Badge variant="secondary">verified origin</Badge>
          ) : (
            <Badge variant="outline">unverified / manual</Badge>
          ))}
      </h2>
      {evidence.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          This revision carries no evidence references. Manual claims are allowed and stay clearly separate from cited
          claims.
        </p>
      ) : (
        <ol className="mt-3 space-y-3">
          {evidence.map((entry, index) => (
            <li key={entry.id} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">[{index + 1}]</span>
                <span className="font-medium">{entry.source_name}</span>
                {typeof entry.generation === "number" && entry.content_identity !== "unknown" ? (
                  <Badge variant="secondary">provenance verified · generation {entry.generation}</Badge>
                ) : (
                  <Badge variant="outline">unknown provenance</Badge>
                )}
                {entry.locator && <span className="text-xs text-muted-foreground">· {entry.locator}</span>}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{entry.excerpt}</p>
            </li>
          ))}
        </ol>
      )}
      {unresolved.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          {`Unresolved citation markers render as plain text and are never matched against other sources: ${unresolved
            .map((marker) => `[${marker}]`)
            .join(", ")}`}
        </p>
      )}
    </section>
  );
}

function DiffOps({ ops }: { ops: DocumentDiffOp[] }) {
  return (
    <div className="overflow-x-auto p-2 font-mono text-xs leading-5">
      {ops.map((op, index) => (
        <div
          key={index}
          className={cn(
            "whitespace-pre px-2",
            op.kind === "insert" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
            op.kind === "delete" && "bg-destructive/10 text-destructive",
            op.kind === "equal" && "text-muted-foreground",
          )}
        >
          {op.kind === "insert" ? "+" : op.kind === "delete" ? "-" : " "} {op.text}
        </div>
      ))}
    </div>
  );
}

function DiffPanel({ diff }: { diff: DocumentRevisionDiff }) {
  return (
    <div className="mt-4 space-y-4">
      {diff.truncated && (
        <p
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
          role="status"
        >
          The diff hit its output bound; sections are marked as truncated below.
        </p>
      )}
      {(diff.sections.added.length > 0 ||
        diff.sections.removed.length > 0 ||
        diff.sections.moved.length > 0 ||
        diff.fields.title_changed) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {diff.fields.title_changed && <Badge variant="outline">title changed</Badge>}
          {diff.sections.added.map((section) => (
            <Badge key={`add-${section.id}`} variant="secondary">
              + {section.heading || "untitled"}
            </Badge>
          ))}
          {diff.sections.removed.map((section) => (
            <Badge key={`del-${section.id}`} variant="destructive">
              − {section.heading || "untitled"}
            </Badge>
          ))}
          {diff.sections.moved.map((section) => (
            <Badge key={`mv-${section.id}`} variant="outline">
              ↕ {section.heading || "untitled"}
            </Badge>
          ))}
        </div>
      )}
      {diff.text_diffs.length === 0 && (
        <p className="text-sm text-muted-foreground">No text changes between these revisions.</p>
      )}
      {diff.text_diffs.map((sectionDiff) => (
        <Card key={sectionDiff.section_id} className="overflow-hidden">
          <div className="flex items-center justify-between border-b px-3 py-2 text-sm font-medium">
            <span>{sectionDiff.heading || "Untitled section"}</span>
            {sectionDiff.truncated && <Badge variant="outline">truncated</Badge>}
          </div>
          <DiffOps ops={sectionDiff.ops} />
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model-assisted rewrites (M13 stage 3)
// ---------------------------------------------------------------------------

const REWRITE_POLL_BASE_MS = 1500;
const REWRITE_POLL_MAX_MS = 12_000;

interface RewriteProposal {
  rewrite: DocumentRewrite;
  /** Selection text re-derived from the immutable base revision. */
  baseText: string;
  heading: string;
}

function selectionTextFor(revision: DocumentRevisionPayload, rewrite: DocumentRewrite): string {
  const section = revision.payload.sections.find((entry) => entry.id === rewrite.section_id);
  if (!section) return "";
  if (rewrite.range_start === null || rewrite.range_end === null) return section.markdown;
  return section.markdown.slice(rewrite.range_start, rewrite.range_end);
}

function activeRewriteStatus(status: DocumentRewriteStatus): boolean {
  return status === "queued" || status === "running";
}

function RewriteProposalCard({
  proposal,
  busy,
  onAccept,
  onReject,
  onStale,
}: {
  proposal: RewriteProposal;
  busy: boolean;
  onAccept: (rewrite: DocumentRewrite) => Promise<void>;
  onReject: (rewrite: DocumentRewrite) => Promise<void>;
  onStale: (rewrite: DocumentRewrite) => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const rewrite = proposal.rewrite;
  const diff = useMemo(
    () => (rewrite.replacement !== null ? diffRewriteText(proposal.baseText, rewrite.replacement) : null),
    [rewrite.replacement, proposal.baseText],
  );

  if (rewrite.status === "stale") {
    // Stale proposals stay inspectable forever and are never applied.
    return (
      <Card className="space-y-2 p-4" data-rewrite-id={rewrite.id}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{proposal.heading || "Untitled section"}</p>
            <p className="truncate text-xs text-muted-foreground">{rewrite.instruction}</p>
          </div>
          <Badge variant="outline">stale</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          The document changed after this proposal was made. It remains inspectable but can never be applied; make a new
          request against the current revision.
        </p>
        <Button variant="ghost" size="sm" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "Hide proposal" : "Inspect proposal"}
        </Button>
        {expanded && diff && (
          <div className="space-y-1">
            <DiffOps ops={diff.ops} />
            {diff.truncated && <p className="text-xs text-muted-foreground">Diff truncated to its bound.</p>}
          </div>
        )}
        <Button variant="ghost" size="sm" onClick={() => onStale(rewrite)}>
          Dismiss
        </Button>
      </Card>
    );
  }

  if (rewrite.status === "failed" || rewrite.status === "cancelled") {
    return (
      <Card className="flex items-center justify-between gap-2 p-4" data-rewrite-id={rewrite.id}>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{proposal.heading || "Untitled section"}</p>
          <p className="truncate text-xs text-muted-foreground">
            {rewrite.status === "failed"
              ? `The rewrite did not complete (${rewrite.error_code ?? "unspecified"}).`
              : "The rewrite was cancelled."}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void onReject(rewrite)}
          aria-label="Dismiss rewrite"
        >
          Dismiss
        </Button>
      </Card>
    );
  }

  if (activeRewriteStatus(rewrite.status)) {
    return (
      <Card className="flex items-center justify-between gap-2 p-4" data-rewrite-id={rewrite.id}>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{proposal.heading || "Untitled section"}</p>
          <p className="truncate text-xs text-muted-foreground">{rewrite.instruction}</p>
        </div>
        <Badge variant="secondary" role="status">
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          {rewrite.status === "queued" ? "queued" : "rewriting…"}
        </Badge>
      </Card>
    );
  }

  // Completed proposal: review the bounded diff, then accept or reject.
  return (
    <Card className="space-y-2 p-4" data-rewrite-id={rewrite.id}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{proposal.heading || "Untitled section"}</p>
          <p className="truncate text-xs text-muted-foreground">{rewrite.instruction}</p>
        </div>
        <Badge variant="secondary">proposal</Badge>
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}
      {accepted ? (
        <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-400">
          Applied — the document now has a new model-authored revision.
        </p>
      ) : (
        <>
          <div className="rounded-md border">
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
              <span>Current selection</span>
              <span>Proposed replacement</span>
            </div>
            {diff && <DiffOps ops={diff.ops} />}
            {diff?.truncated && <p className="px-3 pb-2 text-xs text-muted-foreground">Diff truncated to its bound.</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onReject(rewrite)}>
              Reject
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setError(null);
                void onAccept(rewrite)
                  .then(() => setAccepted(true))
                  .catch((acceptError: unknown) =>
                    setError(formatApiError(acceptError, "Could not apply the proposal")),
                  );
              }}
            >
              {busy ? <Loader2 className="animate-spin" /> : null} Accept
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function RewritePanel({
  documentId,
  head,
  dirtySectionIds,
  sectionTextareas,
  onApplied,
}: {
  documentId: string;
  head: DocumentRevisionPayload;
  dirtySectionIds: Set<string>;
  sectionTextareas: React.MutableRefObject<Record<string, HTMLTextAreaElement | null>>;
  onApplied: (result: { document: DocumentSummary; revision: DocumentRevisionPayload }) => void;
}) {
  const [proposals, setProposals] = useState<DocumentRewrite[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyRewriteId, setBusyRewriteId] = useState<string | null>(null);
  const [sectionId, setSectionId] = useState<string>(head.payload.sections[0]?.id ?? "");
  const [instruction, setInstruction] = useState("");

  const listRequestRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const submitRequestRef = useRef(0);
  const submitAbortRef = useRef<AbortController | null>(null);
  const busyRequestRef = useRef(0);
  const busyAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listRequestRef.current += 1;
      listAbortRef.current?.abort();
      submitRequestRef.current += 1;
      submitAbortRef.current?.abort();
      busyRequestRef.current += 1;
      busyAbortRef.current?.abort();
    };
  }, []);

  const loadProposals = useCallback(async (): Promise<boolean> => {
    const requestId = ++listRequestRef.current;
    listAbortRef.current?.abort();
    const abort = new AbortController();
    listAbortRef.current = abort;
    try {
      const page = await documentsApi.rewrites(documentId, { signal: abort.signal });
      if (requestId === listRequestRef.current && !abort.signal.aborted && mountedRef.current) {
        setProposals(page.items);
        setListError(null);
      }
      return true;
    } catch (error) {
      if (requestId === listRequestRef.current && !abort.signal.aborted && mountedRef.current) {
        setListError(formatApiError(error, "Could not load rewrite proposals"));
      }
      return false;
    }
  }, [documentId]);

  // Initial + manual refresh; a head change can turn proposals stale.
  useEffect(() => {
    void loadProposals();
  }, [loadProposals, head.id]);

  const hasActive = proposals.some((rewrite) => activeRewriteStatus(rewrite.status));

  // Visibility-aware poll with failure backoff while any operation is active.
  const failuresRef = useRef(0);
  useEffect(() => {
    if (!hasActive) {
      failuresRef.current = 0;
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resumed = false;
    const onVisible = () => {
      if (cancelled || resumed || document.hidden) return;
      resumed = true;
      document.removeEventListener("visibilitychange", onVisible);
      void poll();
    };
    const schedule = () => {
      const backoff = Math.min(REWRITE_POLL_MAX_MS, REWRITE_POLL_BASE_MS * 2 ** failuresRef.current);
      timer = setTimeout(() => {
        if (cancelled) return;
        if (document.hidden) {
          // Do not poll hidden tabs; resume on the next visibility change.
          document.addEventListener("visibilitychange", onVisible);
          return;
        }
        void poll();
      }, backoff);
    };
    const poll = async () => {
      // loadProposals owns staleness of the LISTED STATE via its own request
      // generation; the loop itself must only stop when this activation is
      // cancelled. Comparing against listRequestRef here would always fail
      // because loadProposals increments that same ref (a completed proposal
      // would stay "rewriting…" until a page reload).
      const ok = await loadProposals();
      if (cancelled) return;
      failuresRef.current = ok ? 0 : Math.min(failuresRef.current + 1, 3);
      schedule();
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasActive, loadProposals]);

  const selectedSection = head.payload.sections.find((section) => section.id === sectionId);
  const textarea = selectedSection ? sectionTextareas.current[selectedSection.id] : null;
  const selectionStart = textarea?.selectionStart ?? 0;
  const selectionEnd = textarea?.selectionEnd ?? 0;
  const useSelection = Boolean(textarea) && selectionEnd > selectionStart;
  const sectionText = selectedSection?.markdown ?? "";
  const passage = useSelection ? sectionText.slice(selectionStart, selectionEnd) : sectionText;
  const dirty = selectedSection ? dirtySectionIds.has(selectedSection.id) : false;
  const tooLong = passage.length > 8000;
  const splits =
    useSelection &&
    (splitsSurrogatePair(sectionText, selectionStart) || splitsSurrogatePair(sectionText, selectionEnd));
  const canSubmit =
    Boolean(selectedSection) &&
    instruction.trim().length > 0 &&
    passage.length > 0 &&
    !dirty &&
    !tooLong &&
    !splits &&
    !submitting &&
    !hasActive;

  const submit = async () => {
    if (!selectedSection || !canSubmit) return;
    const requestId = ++submitRequestRef.current;
    submitAbortRef.current?.abort();
    const abort = new AbortController();
    submitAbortRef.current = abort;
    setSubmitting(true);
    setRequestError(null);
    try {
      const created = await documentsApi.createRewrite(
        documentId,
        {
          base_revision_id: head.id,
          section_id: selectedSection.id,
          ...(useSelection ? { range_start: selectionStart, range_end: selectionEnd } : {}),
          selection_sha256: sha256Hex(passage),
          instruction: instruction.trim(),
        },
        abort.signal,
      );
      if (requestId !== submitRequestRef.current || abort.signal.aborted || !mountedRef.current) return;
      setInstruction("");
      setProposals((current) => [created, ...current]);
    } catch (error) {
      if (requestId === submitRequestRef.current && !abort.signal.aborted && mountedRef.current) {
        if (isDocumentRewriteErrorCode(error, DOCUMENT_REWRITE_ACTIVE_CODE)) {
          setRequestError("This document already has an active rewrite. Cancel it or wait for it to finish.");
        } else if (isDocumentRewriteErrorCode(error, DOCUMENT_REWRITE_QUOTA_CODE)) {
          setRequestError("This document reached its 100-proposal limit. Dismiss a retained proposal first.");
        } else {
          setRequestError(formatApiError(error, "Could not request the rewrite"));
        }
        void loadProposals();
      }
    } finally {
      if (requestId === submitRequestRef.current && !abort.signal.aborted && mountedRef.current) setSubmitting(false);
    }
  };

  const acceptRewrite = async (rewrite: DocumentRewrite) => {
    const requestId = ++busyRequestRef.current;
    busyAbortRef.current?.abort();
    const abort = new AbortController();
    busyAbortRef.current = abort;
    setBusyRewriteId(rewrite.id);
    try {
      const result = await documentsApi.acceptRewrite(documentId, rewrite.id, abort.signal);
      if (requestId !== busyRequestRef.current || abort.signal.aborted || !mountedRef.current) return;
      onApplied(result);
    } catch (error) {
      if (requestId !== busyRequestRef.current || abort.signal.aborted || !mountedRef.current) return;
      if (parseDocumentRewriteStale(error)) {
        // The head moved or the selection changed: refresh so the proposal
        // shows its durable stale state with fresh guidance.
        await loadProposals();
      }
      throw error;
    } finally {
      if (requestId === busyRequestRef.current && !abort.signal.aborted && mountedRef.current) {
        setBusyRewriteId(null);
      }
    }
  };

  const rejectRewrite = async (rewrite: DocumentRewrite) => {
    const requestId = ++busyRequestRef.current;
    busyAbortRef.current?.abort();
    const abort = new AbortController();
    busyAbortRef.current = abort;
    setBusyRewriteId(rewrite.id);
    try {
      await documentsApi.deleteRewrite(documentId, rewrite.id, abort.signal);
      if (requestId !== busyRequestRef.current || abort.signal.aborted || !mountedRef.current) return;
      setProposals((current) => current.filter((entry) => entry.id !== rewrite.id));
    } catch (error) {
      if (requestId === busyRequestRef.current && !abort.signal.aborted && mountedRef.current) {
        setListError(formatApiError(error, "Could not dismiss the proposal"));
      }
    } finally {
      if (requestId === busyRequestRef.current && !abort.signal.aborted && mountedRef.current) {
        setBusyRewriteId(null);
      }
    }
  };

  if (head.payload.sections.length === 0) return null;

  const cards: RewriteProposal[] = proposals.map((rewrite) => {
    const section = head.payload.sections.find((entry) => entry.id === rewrite.section_id);
    return { rewrite, baseText: selectionTextFor(head, rewrite), heading: section?.heading ?? "Removed section" };
  });

  return (
    <section className="mt-10" aria-labelledby="rewrite-panel-heading">
      <h2 id="rewrite-panel-heading" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <Sparkles className="h-4 w-4" /> Rewrite with the model
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Select a passage in a section (or leave it unselected to rewrite the whole section) and describe the change. The
        model only sees the selected text and this revision's copied evidence; nothing is applied until you accept the
        proposal.
      </p>
      {(requestError || listError) && (
        <p role="alert" className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {requestError ?? listError}
        </p>
      )}
      <div className="mt-3 space-y-2 rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="rewrite-section">Section</Label>
          <select
            id="rewrite-section"
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
            value={sectionId}
            onChange={(event) => setSectionId(event.target.value)}
          >
            {head.payload.sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.heading || "Untitled section"}
              </option>
            ))}
          </select>
          <Badge variant="outline" role="status">
            {dirty
              ? "Save this section first"
              : useSelection
                ? `${passage.length} selected characters`
                : `whole section (${passage.length} characters)`}
          </Badge>
          {hasActive && <Badge variant="secondary">one rewrite at a time</Badge>}
        </div>
        {tooLong && (
          <p className="text-xs text-destructive">
            The passage exceeds the 8,000-character bound. Select a smaller range.
          </p>
        )}
        {splits && (
          <p className="text-xs text-destructive">The selection would split a character pair; adjust its ends.</p>
        )}
        <Textarea
          value={instruction}
          maxLength={2000}
          aria-label="Rewrite instruction"
          placeholder="e.g. Make the finding sentence more concise and keep the citation."
          className="min-h-16 text-sm"
          onChange={(event) => setInstruction(event.target.value)}
        />
        <div className="flex justify-end">
          <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
            {submitting ? <Loader2 className="animate-spin" /> : <Sparkles className="h-4 w-4" />} Request rewrite
          </Button>
        </div>
      </div>
      {cards.length > 0 && (
        <div className="mt-4 space-y-3">
          {cards.map((proposal) => (
            <RewriteProposalCard
              key={proposal.rewrite.id}
              proposal={proposal}
              busy={busyRewriteId === proposal.rewrite.id}
              onAccept={acceptRewrite}
              onReject={rejectRewrite}
              onStale={rejectRewrite}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Publications
// ---------------------------------------------------------------------------

const EXPORT_FORMATS: Array<{ format: DocumentExportFormat; label: string; extension: string }> = [
  { format: "html", label: "HTML", extension: "html" },
  { format: "pdf", label: "PDF", extension: "pdf" },
  { format: "markdown", label: "Markdown", extension: "zip" },
  { format: "docx", label: "DOCX", extension: "docx" },
];

function PublicationPanel({
  publications,
  error,
  busyKey,
  onExport,
  onPreview,
}: {
  publications: DocumentPublicationSummary[];
  error: string | null;
  busyKey: string | null;
  onExport: (publication: DocumentPublicationSummary, format: DocumentExportFormat) => void;
  onPreview: (publication: DocumentPublicationSummary) => void;
}) {
  return (
    <section className="mt-10" aria-labelledby="publication-history-heading">
      <h2 id="publication-history-heading" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <Rocket className="h-4 w-4" /> Publications
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Each publication freezes one revision with its evidence appendix and validity state, and exports exactly those
        frozen bytes as self-contained HTML, static PDF, a Markdown ZIP bundle, or DOCX.
      </p>
      {error && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {publications.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Nothing published yet.</p>
      ) : (
        <ol className="mt-3 space-y-2 text-sm">
          {publications.map((publication) => (
            <li key={publication.id} className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2">
              <span className="font-medium">v{publication.version}</span>
              <span className="truncate">{publication.title}</span>
              <Badge variant="outline">revision {publication.revision}</Badge>
              <span className="text-xs text-muted-foreground">{formatDate(publication.created_at)}</span>
              <span className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyKey === `${publication.id}:preview`}
                  onClick={() => onPreview(publication)}
                >
                  {busyKey === `${publication.id}:preview` ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                  Preview
                </Button>
                {EXPORT_FORMATS.map((entry) => (
                  <Button
                    key={entry.format}
                    variant="ghost"
                    size="sm"
                    disabled={busyKey === `${publication.id}:${entry.format}`}
                    onClick={() => onExport(publication, entry.format)}
                  >
                    {busyKey === `${publication.id}:${entry.format}` ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    {entry.label}
                  </Button>
                ))}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function DocumentEditor({ documentId }: { documentId: string }) {
  const [document, setDocument] = useState<DocumentDetail | null>(null);
  const [head, setHead] = useState<DocumentRevisionPayload | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<DocumentConflictHead | null>(null);
  const [history, setHistory] = useState<DocumentRevisionSummary[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [publications, setPublications] = useState<DocumentPublicationSummary[]>([]);
  const [publicationError, setPublicationError] = useState<string | null>(null);
  const [publishBusyRevision, setPublishBusyRevision] = useState<string | null>(null);
  const [exportBusyKey, setExportBusyKey] = useState<string | null>(null);
  const [diff, setDiff] = useState<DocumentRevisionDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [baseChoice, setBaseChoice] = useState<string>("");
  const [targetChoice, setTargetChoice] = useState<string>("");
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateSaved, setTemplateSaved] = useState(false);

  const loadRequestRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const saveRequestRef = useRef(0);
  const saveAbortRef = useRef<AbortController | null>(null);
  const historyRequestRef = useRef(0);
  const diffRequestRef = useRef(0);
  const diffAbortRef = useRef<AbortController | null>(null);
  const templateRequestRef = useRef(0);
  const templateAbortRef = useRef<AbortController | null>(null);
  const publicationRequestRef = useRef(0);
  const publishRequestRef = useRef(0);
  const publishAbortRef = useRef<AbortController | null>(null);
  const exportRequestRef = useRef(0);
  // The operation UUID is reused across retries of the same attempt so a
  // retry can never produce a second publication.
  const publishOperationRef = useRef<{ revisionId: string; operationId: string } | null>(null);
  const mountedRef = useRef(false);
  const sectionTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  // Bumping this re-renders so the rewrite panel can mirror the textarea's
  // live selection start/end without owning the selection itself.
  const [, setSelectionVersion] = useState(0);

  const loadHistory = useCallback(async (documentIdValue: string, signal?: AbortSignal) => {
    const requestId = ++historyRequestRef.current;
    try {
      const page = await documentsApi.revisions(documentIdValue, { signal });
      if (requestId === historyRequestRef.current && mountedRef.current && !signal?.aborted) {
        setHistory(page.items);
        setHistoryError(null);
        if (page.items.length >= 2) {
          setBaseChoice(page.items[1]!.id);
          setTargetChoice(page.items[0]!.id);
        } else if (page.items.length === 1) {
          setBaseChoice(page.items[0]!.id);
          setTargetChoice(page.items[0]!.id);
        }
      }
    } catch (error) {
      if (requestId === historyRequestRef.current && mountedRef.current && !signal?.aborted) {
        setHistoryError(formatApiError(error, "Could not load version history"));
      }
    }
  }, []);

  const loadPublications = useCallback(async (documentIdValue: string, signal?: AbortSignal) => {
    const requestId = ++publicationRequestRef.current;
    try {
      const page = await documentsApi.publications(documentIdValue, { signal });
      if (requestId === publicationRequestRef.current && mountedRef.current && !signal?.aborted) {
        setPublications(page.items);
        setPublicationError(null);
      }
    } catch (error) {
      if (requestId === publicationRequestRef.current && mountedRef.current && !signal?.aborted) {
        setPublicationError(formatApiError(error, "Could not load publications"));
      }
    }
  }, []);

  const load = useCallback(
    async (options: { discardDraft?: boolean } = {}) => {
      const requestId = ++loadRequestRef.current;
      loadAbortRef.current?.abort();
      const abort = new AbortController();
      loadAbortRef.current = abort;
      if (options.discardDraft !== false) {
        setDraft(null);
        setDirty(false);
      }
      setLoading(true);
      setPageError(null);
      setConflict(null);
      try {
        const summary = await documentsApi.get(documentId, abort.signal);
        const revision = await documentsApi.revision(documentId, summary.current_revision_id, abort.signal);
        if (requestId !== loadRequestRef.current || abort.signal.aborted || !mountedRef.current) return;
        setDocument(summary);
        setHead(revision);
        setDraft(draftFromRevision(revision));
        setDirty(false);
        void loadHistory(documentId, abort.signal);
        void loadPublications(documentId, abort.signal);
      } catch (error) {
        if (requestId === loadRequestRef.current && !abort.signal.aborted && mountedRef.current) {
          setPageError(formatApiError(error, "Could not load the document"));
        }
      } finally {
        if (requestId === loadRequestRef.current && !abort.signal.aborted && mountedRef.current) setLoading(false);
      }
    },
    [documentId, loadHistory, loadPublications],
  );

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      loadRequestRef.current += 1;
      loadAbortRef.current?.abort();
      saveRequestRef.current += 1;
      saveAbortRef.current?.abort();
      historyRequestRef.current += 1;
      diffRequestRef.current += 1;
      diffAbortRef.current?.abort();
      templateRequestRef.current += 1;
      templateAbortRef.current?.abort();
      publicationRequestRef.current += 1;
      publishRequestRef.current += 1;
      publishAbortRef.current?.abort();
      exportRequestRef.current += 1;
    };
  }, [load]);

  const dirtySectionIds = useMemo(() => {
    const changed = new Set<string>();
    if (!draft || !head) return changed;
    const headById = new Map(head.payload.sections.map((section) => [section.id, section]));
    for (const section of draft.sections) {
      const base = headById.get(section.id);
      if (!base || base.markdown !== section.markdown || base.heading !== section.heading) changed.add(section.id);
    }
    return changed;
  }, [draft, head]);

  const updateDraft = (updater: (current: DraftState) => DraftState) => {
    setDraft((current) => (current ? updater(current) : current));
    setDirty(true);
  };

  const buildTree = (): DocumentTreeInput | null => {
    if (!draft || !head) return null;
    return {
      title: draft.title.trim() || head.payload.title,
      subtitle: draft.subtitle,
      verified: head.payload.verified,
      sections: draft.sections.map((section) => ({
        id: section.id,
        heading: section.heading,
        markdown: section.markdown,
      })),
      // Charts, tables, and evidence are frozen values from the head
      // revision; the section editor passes them through untouched.
      charts: head.payload.charts as DocumentTreeInput["charts"],
      tables: head.payload.tables as DocumentTreeInput["tables"],
      evidence: head.payload.evidence,
    };
  };

  /** Explicit reapply onto a newer head: the user re-targets the base; the server still CAS-checks. */
  const save = async (baseRevisionId: string) => {
    if (!document || !head) return;
    const tree = buildTree();
    if (!tree) return;
    const requestId = ++saveRequestRef.current;
    saveAbortRef.current?.abort();
    const abort = new AbortController();
    saveAbortRef.current = abort;
    setSaving(true);
    setPageError(null);
    try {
      const result = await documentsApi.saveRevision(
        document.id,
        { base_revision_id: baseRevisionId, tree },
        abort.signal,
      );
      if (requestId !== saveRequestRef.current || abort.signal.aborted || !mountedRef.current) return;
      setDocument(result.document);
      setHead(result.revision);
      setDraft(draftFromRevision(result.revision));
      setDirty(false);
      setConflict(null);
      publishOperationRef.current = null;
      void loadHistory(document.id, abort.signal);
      void loadPublications(document.id, abort.signal);
    } catch (error) {
      if (requestId !== saveRequestRef.current || abort.signal.aborted || !mountedRef.current) return;
      const headMetadata = parseDocumentRevisionConflict(error);
      if (headMetadata) {
        // Preserve the local draft and dirty state; the user decides between
        // diff/reload or explicit reapply. The server never merges.
        setConflict(headMetadata);
      } else {
        setPageError(formatApiError(error, "Could not save the revision"));
      }
    } finally {
      if (requestId === saveRequestRef.current && !abort.signal.aborted && mountedRef.current) setSaving(false);
    }
  };

  const compareRevisions = async () => {
    if (!document || !baseChoice || !targetChoice) return;
    const requestId = ++diffRequestRef.current;
    diffAbortRef.current?.abort();
    const abort = new AbortController();
    diffAbortRef.current = abort;
    setDiffError(null);
    try {
      const result = await documentsApi.diff(document.id, baseChoice, targetChoice, abort.signal);
      if (requestId === diffRequestRef.current && !abort.signal.aborted && mountedRef.current) setDiff(result);
    } catch (error) {
      if (requestId === diffRequestRef.current && !abort.signal.aborted && mountedRef.current) {
        setDiff(null);
        setDiffError(formatApiError(error, "Could not compare revisions"));
      }
    }
  };

  const saveAsTemplate = async () => {
    if (!document || templateSaving) return;
    const name = templateName.trim();
    if (!name) return;
    const requestId = ++templateRequestRef.current;
    templateAbortRef.current?.abort();
    const abort = new AbortController();
    templateAbortRef.current = abort;
    setTemplateSaving(true);
    setTemplateError(null);
    try {
      await documentTemplatesApi.create(
        { name, description: templateDescription.trim() || undefined, document_id: document.id },
        abort.signal,
      );
      if (requestId === templateRequestRef.current && !abort.signal.aborted && mountedRef.current) {
        setTemplateSaved(true);
      }
    } catch (error) {
      if (requestId === templateRequestRef.current && !abort.signal.aborted && mountedRef.current) {
        setTemplateError(formatApiError(error, "Could not save the template"));
      }
    } finally {
      if (requestId === templateRequestRef.current && !abort.signal.aborted && mountedRef.current) {
        setTemplateSaving(false);
      }
    }
  };

  const openSaveTemplate = () => {
    templateRequestRef.current += 1;
    templateAbortRef.current?.abort();
    templateAbortRef.current = null;
    setTemplateSaved(false);
    setTemplateError(null);
    setTemplateSaving(false);
    setTemplateName(`${draft?.title ?? document?.title ?? "Document"} layout`);
    setTemplateDescription("");
    setSaveTemplateOpen(true);
  };

  /** Refreshes metadata/publications without discarding the local draft. */
  const refreshDocumentState = useCallback(
    async (signal?: AbortSignal) => {
      const summary = await documentsApi.get(documentId, signal);
      if (signal?.aborted || !mountedRef.current) return;
      setDocument(summary);
      void loadPublications(documentId, signal);
    },
    [documentId, loadPublications],
  );

  const publicationErrorText = (error: unknown): string => {
    if (isDocumentPublicationErrorCode(error, DOCUMENT_PUBLICATION_ACTIVE_CODE)) {
      return "Another publication is already active for this document.";
    }
    if (isDocumentPublicationErrorCode(error, DOCUMENT_HEAD_MOVED_CODE)) {
      return "The document head moved since this publication was requested. Review the newer head, or publish the older revision explicitly from its history row.";
    }
    return formatApiError(error, "Publication failed. The draft and the previous publication are unchanged.");
  };

  /**
   * Busy rule: one publish request at a time per document; the head publish
   * requires a saved draft and always carries the expected head; non-head
   * publishes come from the history rows with the explicit selection bit. The
   * operation UUID survives retries of the same attempt so a retry can never
   * create a second publication.
   */
  const publishRevision = async (revisionId: string, explicitNonHead = false) => {
    if (!document || publishBusyRevision) return;
    if (!explicitNonHead && dirty) {
      setPublicationError("Save the draft before publishing the head revision.");
      return;
    }
    const requestId = ++publishRequestRef.current;
    publishAbortRef.current?.abort();
    const abort = new AbortController();
    publishAbortRef.current = abort;
    setPublishBusyRevision(revisionId);
    setPublicationError(null);
    const operation =
      publishOperationRef.current?.revisionId === revisionId
        ? publishOperationRef.current
        : { revisionId, operationId: newSectionId() };
    publishOperationRef.current = operation;
    try {
      const result = await documentsApi.publish(
        document.id,
        revisionId,
        explicitNonHead
          ? { operation_id: operation.operationId, allow_non_head_revision: true }
          : { operation_id: operation.operationId, expected_revision_id: head?.id },
        abort.signal,
      );
      if (requestId !== publishRequestRef.current || abort.signal.aborted || !mountedRef.current) return;
      if (result.status === "published") {
        publishOperationRef.current = null;
        await refreshDocumentState(abort.signal);
        void loadHistory(document.id, abort.signal);
      } else {
        setPublicationError("This publication is already rendering. Refresh to check its status.");
        void refreshDocumentState(abort.signal);
      }
    } catch (error) {
      if (requestId === publishRequestRef.current && !abort.signal.aborted && mountedRef.current) {
        setPublicationError(publicationErrorText(error));
      }
    } finally {
      if (requestId === publishRequestRef.current && !abort.signal.aborted && mountedRef.current) {
        setPublishBusyRevision(null);
      }
    }
  };

  const exportPublication = async (publication: DocumentPublicationSummary, format: DocumentExportFormat) => {
    if (!document || exportBusyKey) return;
    const requestId = ++exportRequestRef.current;
    const key = `${publication.id}:${format}`;
    setExportBusyKey(key);
    setPublicationError(null);
    try {
      const extension = EXPORT_FORMATS.find((entry) => entry.format === format)?.extension ?? "bin";
      await downloadBlob(
        documentsApi.publicationExportPath(document.id, publication.id, format),
        `${publication.title || "document"}-v${publication.version}.${extension}`,
      );
    } catch (error) {
      if (requestId === exportRequestRef.current && mountedRef.current) {
        setPublicationError(formatApiError(error, "Could not download the export"));
      }
    } finally {
      if (requestId === exportRequestRef.current && mountedRef.current) setExportBusyKey(null);
    }
  };

  const previewPublication = async (publication: DocumentPublicationSummary) => {
    if (!document || exportBusyKey) return;
    const requestId = ++exportRequestRef.current;
    const key = `${publication.id}:preview`;
    setExportBusyKey(key);
    setPublicationError(null);
    try {
      await openProtected(
        "html",
        documentsApi.publicationExportPath(document.id, publication.id, "html"),
        `${publication.title || "document"}-v${publication.version}.html`,
      );
    } catch (error) {
      if (requestId === exportRequestRef.current && mountedRef.current) {
        setPublicationError(formatApiError(error, "Could not open the publication preview"));
      }
    } finally {
      if (requestId === exportRequestRef.current && mountedRef.current) setExportBusyKey(null);
    }
  };

  if (loading && !document) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-4 px-4 py-10 sm:px-6">
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (!document || !head || !draft) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
          <div
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {pageError ?? "Document not found."}
          </div>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => (window.location.hash = "#/documents")}>
            Back to documents
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <a href="#/documents" className="text-xs text-primary hover:underline">
              ← Documents
            </a>
            <h1 className="mt-1 truncate text-2xl font-bold tracking-tight">{document.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Revision {head.revision} · {document.revision_count} revisions ·{" "}
              {document.latest_publication_version === null
                ? "not published yet"
                : `latest publication v${document.latest_publication_version}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {dirty && (
              <Badge variant="outline" role="status">
                Unsaved changes
              </Badge>
            )}
            {document.publication_status?.status === "rendering" && (
              <Badge variant="outline" role="status">
                Publication rendering…
              </Badge>
            )}
            {document.publication_status?.status === "failed" && (
              <Badge variant="destructive" role="status">
                Last publication failed
                {document.publication_status.error_code ? ` · ${document.publication_status.error_code}` : ""}
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={openSaveTemplate}>
              <BookTemplate className="h-4 w-4" /> Save as template
            </Button>
            <Button size="sm" onClick={() => void save(head.id)} disabled={saving || !dirty}>
              {saving ? <Loader2 className="animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? "Saving…" : "Save revision"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              title={dirty ? "Save the draft before publishing the head revision" : `Publish revision ${head.revision}`}
              onClick={() => void publishRevision(head.id)}
              disabled={saving || publishBusyRevision !== null}
            >
              {publishBusyRevision === head.id ? <Loader2 className="animate-spin" /> : <Rocket className="h-4 w-4" />}
              {publishBusyRevision === head.id ? "Publishing…" : "Publish"}
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

        {/* section editor */}
        <div className="mt-6 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="document-title">Title</Label>
            <Input
              id="document-title"
              value={draft.title}
              maxLength={200}
              onChange={(event) => updateDraft((current) => ({ ...current, title: event.target.value }))}
            />
            <Label htmlFor="document-subtitle">Subtitle</Label>
            <Input
              id="document-subtitle"
              value={draft.subtitle}
              maxLength={500}
              placeholder="Optional subtitle"
              onChange={(event) => updateDraft((current) => ({ ...current, subtitle: event.target.value }))}
            />
          </div>

          {draft.sections.map((section, index) => (
            <Card key={section.id} className="space-y-2 p-4" data-section-id={section.id}>
              <div className="flex items-center gap-2">
                <Input
                  value={section.heading}
                  maxLength={200}
                  placeholder="Section heading"
                  aria-label={`Heading of section ${index + 1}`}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      sections: current.sections.map((entry) =>
                        entry.id === section.id ? { ...entry, heading: event.target.value } : entry,
                      ),
                    }))
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  title="Move section up"
                  aria-label={`Move ${section.heading || "section"} up`}
                  disabled={index === 0}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    updateDraft((current) => ({
                      ...current,
                      sections: moveSectionById(current.sections, section.id, -1),
                    }))
                  }
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Move section down"
                  aria-label={`Move ${section.heading || "section"} down`}
                  disabled={index === draft.sections.length - 1}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    updateDraft((current) => ({
                      ...current,
                      sections: moveSectionById(current.sections, section.id, 1),
                    }))
                  }
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Remove section"
                  aria-label={`Remove ${section.heading || "section"}`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    updateDraft((current) => ({
                      ...current,
                      sections: current.sections.filter((entry) => entry.id !== section.id),
                    }))
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <Textarea
                value={section.markdown}
                ref={(element) => {
                  sectionTextareaRefs.current[section.id] = element;
                }}
                onSelect={() => setSelectionVersion((current) => current + 1)}
                aria-label={`Markdown of section ${index + 1}`}
                className="min-h-36 font-mono text-xs"
                placeholder="Markdown content"
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    sections: current.sections.map((entry) =>
                      entry.id === section.id ? { ...entry, markdown: event.target.value } : entry,
                    ),
                  }))
                }
              />
            </Card>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              updateDraft((current) => ({
                ...current,
                sections: [...current.sections, { id: newSectionId(), heading: "", markdown: "" }],
              }))
            }
          >
            <Plus className="h-4 w-4" /> Add section
          </Button>
        </div>

        <EvidenceInspector revision={head} />

        <RewritePanel
          documentId={document.id}
          head={head}
          dirtySectionIds={dirtySectionIds}
          sectionTextareas={sectionTextareaRefs}
          onApplied={(result) => {
            setDocument(result.document);
            setHead(result.revision);
            setDraft(draftFromRevision(result.revision));
            setDirty(false);
            publishOperationRef.current = null;
            void loadHistory(document.id);
          }}
        />

        {/* version history + diff */}
        <section className="mt-10" aria-labelledby="version-history-heading">
          <h2 id="version-history-heading" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <History className="h-4 w-4" /> Version history
          </h2>
          {historyError && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {historyError}
            </p>
          )}
          <ol className="mt-3 space-y-2 text-sm">
            {history.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2">
                <span className="font-medium">Revision {entry.revision}</span>
                <span className="truncate">{entry.title}</span>
                <Badge variant="outline">{entry.author_kind}</Badge>
                {entry.published_version !== null && <Badge variant="secondary">v{entry.published_version}</Badge>}
                <span className="text-xs text-muted-foreground">{formatDate(entry.created_at)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  aria-label={`Publish revision ${entry.revision}`}
                  disabled={publishBusyRevision !== null || saving}
                  title={
                    entry.id === head.id
                      ? "Publish the current head"
                      : "Publish this exact reviewed revision (explicit non-head selection)"
                  }
                  onClick={() => void publishRevision(entry.id, entry.id !== head.id)}
                >
                  {publishBusyRevision === entry.id ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Rocket className="h-4 w-4" />
                  )}
                  Publish
                </Button>
              </li>
            ))}
          </ol>
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="diff-base">Base</Label>
              <select
                id="diff-base"
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                value={baseChoice}
                onChange={(event) => setBaseChoice(event.target.value)}
              >
                {history.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    r{entry.revision} · {entry.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="diff-target">Compare</Label>
              <select
                id="diff-target"
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                value={targetChoice}
                onChange={(event) => setTargetChoice(event.target.value)}
              >
                {history.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    r{entry.revision} · {entry.title}
                  </option>
                ))}
              </select>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void compareRevisions()}
              disabled={!baseChoice || !targetChoice}
            >
              <GitCompare className="h-4 w-4" /> Compare revisions
            </Button>
          </div>
          {diffError && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {diffError}
            </p>
          )}
          {diff && <DiffPanel diff={diff} />}
        </section>

        <PublicationPanel
          publications={publications}
          error={publicationError}
          busyKey={exportBusyKey}
          onExport={(publication, format) => void exportPublication(publication, format)}
          onPreview={(publication) => void previewPublication(publication)}
        />

        {/* conflict dialog: preserve the local draft; diff/reload/reapply only */}
        <Dialog open={!!conflict} onOpenChange={(open) => !open && setConflict(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Revision conflict</DialogTitle>
              <DialogDescription>
                {conflict ? (
                  <>
                    The document head moved to revision {conflict.revision} (“{conflict.title}”) while your draft was
                    pending. Your local text is preserved; nothing is merged automatically.
                  </>
                ) : (
                  ""
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const headId = conflict?.revision_id;
                  setConflict(null);
                  if (headId && document) {
                    void (async () => {
                      const requestId = ++diffRequestRef.current;
                      const abort = new AbortController();
                      diffAbortRef.current?.abort();
                      diffAbortRef.current = abort;
                      try {
                        const result = await documentsApi.diff(document.id, head.id, headId, abort.signal);
                        if (requestId === diffRequestRef.current && !abort.signal.aborted && mountedRef.current) {
                          setBaseChoice(head.id);
                          setTargetChoice(headId);
                          setDiff(result);
                        }
                      } catch {
                        // The explicit "Compare revisions" control remains available.
                      }
                    })();
                  }
                }}
              >
                <GitCompare className="h-4 w-4" /> View diff against new head
              </Button>
              <Button variant="outline" size="sm" onClick={() => void save(conflict!.revision_id)}>
                Reapply my draft onto revision {conflict?.revision}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setConflict(null);
                  void load();
                }}
              >
                Discard my draft and reload the head
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* save-as-template dialog (busy blocks dismissal) */}
        <Dialog
          open={saveTemplateOpen}
          onOpenChange={(open) => {
            if (!open && templateSaving) return;
            setSaveTemplateOpen(open);
          }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Save structure as template</DialogTitle>
              <DialogDescription>
                The snapshot copies headings, instructions, and formatting only. Evidence excerpts, table results, chart
                values, and source bindings are never included.
              </DialogDescription>
            </DialogHeader>
            {templateError && (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {templateError}
              </p>
            )}
            {templateSaved ? (
              <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
                Template saved. You can apply it to a new document from the Documents page.
              </p>
            ) : (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveAsTemplate();
                }}
              >
                <div className="space-y-1">
                  <Label htmlFor="template-name">Name</Label>
                  <Input
                    id="template-name"
                    value={templateName}
                    maxLength={200}
                    autoFocus
                    onChange={(event) => setTemplateName(event.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="template-description">Description</Label>
                  <Input
                    id="template-description"
                    value={templateDescription}
                    maxLength={500}
                    onChange={(event) => setTemplateDescription(event.target.value)}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={templateSaving}
                    onClick={() => setSaveTemplateOpen(false)}
                  >
                    {templateSaved ? "Close" : "Cancel"}
                  </Button>
                  <Button type="submit" size="sm" disabled={templateSaving || !templateName.trim()}>
                    {templateSaving ? "Saving…" : "Save template"}
                  </Button>
                </div>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

export function DocumentWorkbench({ documentId }: { documentId?: string }) {
  return documentId ? <DocumentEditor key={documentId} documentId={documentId} /> : <DocumentCatalog />;
}
