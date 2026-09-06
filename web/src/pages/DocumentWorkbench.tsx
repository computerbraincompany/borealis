import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookTemplate,
  FileEdit,
  FilePlus,
  Files,
  GitCompare,
  History,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import {
  documentTemplatesApi,
  documentsApi,
  formatApiError,
  parseDocumentRevisionConflict,
  type DocumentConflictHead,
  type DocumentRevisionDiff,
  type DocumentRevisionPayload,
  type DocumentRevisionSummary,
  type DocumentSummary,
  type DocumentTemplateSummary,
  type DocumentTreeInput,
} from "@/lib/api";
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
                {typeof entry.generation === "number" ? (
                  <Badge variant="secondary">generation {entry.generation}</Badge>
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
          <div className="overflow-x-auto p-2 font-mono text-xs leading-5">
            {sectionDiff.ops.map((op, index) => (
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
        </Card>
      ))}
    </div>
  );
}

function DocumentEditor({ documentId }: { documentId: string }) {
  const [document, setDocument] = useState<DocumentSummary | null>(null);
  const [head, setHead] = useState<DocumentRevisionPayload | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<DocumentConflictHead | null>(null);
  const [history, setHistory] = useState<DocumentRevisionSummary[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
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
  const mountedRef = useRef(false);

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
      } catch (error) {
        if (requestId === loadRequestRef.current && !abort.signal.aborted && mountedRef.current) {
          setPageError(formatApiError(error, "Could not load the document"));
        }
      } finally {
        if (requestId === loadRequestRef.current && !abort.signal.aborted && mountedRef.current) setLoading(false);
      }
    },
    [documentId, loadHistory],
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
    };
  }, [load]);

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
      void loadHistory(document.id, abort.signal);
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
                ? "not published (publishing arrives with the next stage)"
                : `published v${document.latest_publication_version}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {dirty && (
              <Badge variant="outline" role="status">
                Unsaved changes
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={openSaveTemplate}>
              <BookTemplate className="h-4 w-4" /> Save as template
            </Button>
            <Button size="sm" onClick={() => void save(head.id)} disabled={saving || !dirty}>
              {saving ? <Loader2 className="animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? "Saving…" : "Save revision"}
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
