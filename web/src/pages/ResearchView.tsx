import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CalendarClock,
  ExternalLink,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  formatApiError,
  isRemoteEgressConsentError,
  isResearchErrorCode,
  isTerminalResearchRunStatus,
  modelsApi,
  researchActiveRunId,
  researchApi,
  researchUnreadySourceIds,
  RESEARCH_ACTIVE_RUN_CODE,
  RESEARCH_INPUTS_NOT_READY_CODE,
  RESEARCH_MODEL_UNAVAILABLE_CODE,
  RESEARCH_QUESTION_MAX_CHARS,
  RESEARCH_REVISION_CONFLICT_CODE,
  RESEARCH_TITLE_MAX_CHARS,
  sourcesApi,
  type ChatModelOption,
  type ResearchArtifactResult,
  type ResearchColumnDeclaration,
  type ResearchDefinition,
  type ResearchDefinitionSummaryItem,
  type ResearchOutputKind,
  type ResearchPlan,
  type ResearchPlanProposal,
  type ResearchRunDetail,
  type ResearchRunSummary,
  type ResearchReviewOp,
} from "@/lib/api";
import { EGRESS_PAYLOAD_CLASSES } from "@/lib/egressDisclosure";
import { takeResearchHandoff } from "@/lib/researchHandoff";
import { mergeCatalogContinuation, mergeCatalogHead } from "@/lib/catalogMerge";
import { cn, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ColumnEditor } from "@/components/research/ColumnEditor";
import { PlanEditor } from "@/components/research/PlanEditor";
import { ResearchScopePicker } from "@/components/research/ResearchScopePicker";
import { ArtifactCard, RunPanel, runStatusLabel } from "@/components/research/RunPanel";
import { TablePanel } from "@/components/research/TablePanel";

const RUN_POLL_BASE_MS = 1_000;
const RUN_POLL_MAX_MS = 15_000;
const RUN_POLL_HIDDEN_MS = 5_000;

interface DraftForm {
  title: string;
  question: string;
  outputKind: ResearchOutputKind;
  chatModel: string;
  sourceIds: string[];
  libraryIds: string[];
  columns: ResearchColumnDeclaration[];
  plan: ResearchPlan;
}

const EMPTY_FORM: DraftForm = {
  title: "",
  question: "",
  outputKind: "memo",
  chatModel: "",
  sourceIds: [],
  libraryIds: [],
  columns: [],
  plan: { steps: [] },
};

function formFromDefinition(definition: ResearchDefinition): DraftForm {
  return {
    title: definition.title,
    question: definition.question,
    outputKind: definition.output_kind,
    chatModel: definition.chat_model,
    sourceIds: [...definition.source_ids],
    libraryIds: [...definition.library_ids],
    columns: definition.columns.map((column) => ({ ...column })),
    plan: { steps: definition.plan.steps.map((step) => ({ ...step, questions: [...step.questions] })) },
  };
}

function definitionStateBadge(definition: ResearchDefinitionSummaryItem): {
  label: string;
  tone: "pending" | "secondary";
} {
  return definition.current_revision > 1
    ? { label: "Revised", tone: "secondary" }
    : { label: "Draft", tone: "secondary" };
}

/**
 * Durable local research workspace (M15 stage 4): definitions catalog with
 * explicit-scope editing, bounded editable plans, run progress with
 * visibility-aware exact-ID polling, the evidence dossier with claim review,
 * the typed comparison table, and reviewed M13 draft creation. Plan
 * generation never starts execution; a `needs_review` run is never labelled
 * complete; provider reasoning and raw payloads are never rendered.
 */
export function ResearchView({ definitionId, newRequest }: { definitionId?: string; newRequest?: string }) {
  if (definitionId) return <ResearchDetail key={definitionId} definitionId={definitionId} />;
  if (newRequest !== undefined) return <ResearchNewDraft key={newRequest} />;
  return <ResearchCatalog />;
}

// ------------------------------------------------------------------ catalog

function ResearchCatalog() {
  const [items, setItems] = useState<ResearchDefinitionSummaryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setError(null);
    setLoading(true);
    try {
      const page = await researchApi.list();
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setItems((current) => mergeCatalogHead(page.items, current));
      setNextCursor(page.next_cursor);
    } catch (caught: unknown) {
      if (mountedRef.current && requestId === requestRef.current) {
        setError(formatApiError(caught, "Could not load research definitions"));
      }
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 px-6 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <ScanSearch className="h-6 w-6 text-primary" aria-hidden />
          <h1 className="text-xl font-bold tracking-tight">Research</h1>
          <Button asChild size="sm" className="ml-auto">
            <a href="#/research/new">
              <Plus className="h-4 w-4" /> New research
            </a>
          </Button>
        </header>
        <p className="text-sm text-muted-foreground">
          State a question over an explicit source scope, review an editable plan, gather a local evidence dossier,
          resolve gaps and conflicts, then publish only through a reviewed draft.
        </p>
        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        )}
        {loading && <Skeleton className="h-40 rounded-lg" />}
        {!loading && items.length === 0 && !error && (
          <Card className="px-6 py-10 text-center text-sm text-muted-foreground">
            No research yet. Create a definition to start with a question and an explicit source scope.
          </Card>
        )}
        <ul className="space-y-2">
          {items.map((item) => {
            const state = definitionStateBadge(item);
            return (
              <li key={item.id}>
                <a
                  href={`#/research/${item.id}`}
                  className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-accent/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.output_kind === "memo" ? "Memo" : "Comparison table"} · rev {item.current_revision} ·{" "}
                      {item.source_count} source{item.source_count === 1 ? "" : "s"} · updated{" "}
                      {formatDate(item.updated_at)}
                    </p>
                  </div>
                  <Badge variant={state.tone}>{state.label}</Badge>
                </a>
              </li>
            );
          })}
        </ul>
        {nextCursor && (
          <Button
            variant="outline"
            size="sm"
            disabled={loadingMore}
            onClick={async () => {
              const requestId = ++requestRef.current;
              setLoadingMore(true);
              try {
                const page = await researchApi.list({ cursor: nextCursor });
                if (!mountedRef.current || requestId !== requestRef.current) return;
                setItems((current) => mergeCatalogContinuation(current, page.items));
                setNextCursor(page.next_cursor);
              } catch (caught: unknown) {
                if (mountedRef.current && requestId === requestRef.current) {
                  setError(formatApiError(caught, "Could not load more definitions"));
                }
              } finally {
                if (mountedRef.current && requestId === requestRef.current) setLoadingMore(false);
              }
            }}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ shared editor pieces

function useChatModels() {
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    modelsApi
      .list()
      .then((response) => {
        if (cancelled) return;
        setModels(response.available_models ?? response.models ?? []);
        setDefaultModel(response.account_default_model ?? response.default_model ?? null);
      })
      .catch(() => {
        /* the model select degrades to the stored/preferred value */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { models, defaultModel };
}

function ModelField({
  models,
  value,
  disabled,
  onChange,
}: {
  models: ChatModelOption[];
  value: string;
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  return (
    <div>
      <Label htmlFor="research-model" className="text-xs text-muted-foreground">
        Chat model
      </Label>
      <select
        id="research-model"
        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {value && !models.some((model) => model.id === value) && <option value={value}>{value}</option>}
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.display_name ?? model.id}
          </option>
        ))}
        {!models.some((model) => model.id === value) && !value && <option value="">Select a model</option>}
      </select>
    </div>
  );
}

function ConsentBanner() {
  return (
    <div
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      role="alert"
    >
      <p>
        Remote model-provider consent is required before research content may leave this machine. Remember:{" "}
        {EGRESS_PAYLOAD_CLASSES} can leave the machine under that provider's data policy.
      </p>
      <Button variant="outline" size="sm" className="mt-2" asChild>
        <a href="#/settings">
          <ExternalLink className="h-4 w-4" /> Open Settings to acknowledge
        </a>
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ new draft

function ResearchNewDraft() {
  const { models, defaultModel } = useChatModels();
  const [form, setForm] = useState<DraftForm>(() => ({ ...EMPTY_FORM }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);
  const prefilledRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  // Chat-to-research handoff: prefill the explicit selected scope + title once.
  useEffect(() => {
    if (prefilledRef.current) return;
    prefilledRef.current = true;
    const handoff = takeResearchHandoff();
    if (!handoff) return;
    setForm((current) => ({ ...current, sourceIds: handoff.source_ids, title: handoff.title }));
  }, []);

  useEffect(() => {
    if (!form.chatModel && defaultModel)
      setForm((current) => (current.chatModel ? current : { ...current, chatModel: defaultModel }));
  }, [defaultModel, form.chatModel]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 px-6 py-6">
        <header className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <a href="#/research">
              <ArrowLeft className="h-4 w-4" /> Research
            </a>
          </Button>
          <h1 className="text-xl font-bold tracking-tight">New research</h1>
        </header>
        <DefinitionFields
          form={form}
          models={models}
          busy={busy}
          availability={[]}
          onChange={(next) => setForm(next)}
        />
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            disabled={busy || !form.title.trim() || !form.question.trim() || !form.chatModel}
            onClick={async () => {
              if (busy) return;
              const requestId = ++requestRef.current;
              setBusy(true);
              setError(null);
              try {
                const created = await researchApi.create({
                  title: form.title.trim(),
                  question: form.question.trim(),
                  output_kind: form.outputKind,
                  source_ids: form.sourceIds,
                  library_ids: form.libraryIds,
                  chat_model: form.chatModel,
                  columns: form.outputKind === "comparison" ? form.columns : [],
                  plan: form.plan,
                });
                if (!mountedRef.current || requestId !== requestRef.current) return;
                window.location.hash = `#/research/${created.id}`;
              } catch (caught: unknown) {
                if (mountedRef.current && requestId === requestRef.current) {
                  setError(formatApiError(caught, "Could not create the research draft"));
                  setBusy(false);
                }
              }
            }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create draft
          </Button>
          <span className="text-xs text-muted-foreground">
            Creating stores a draft; nothing runs until you generate/confirm a plan and press Start.
          </span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ fields

function DefinitionFields({
  form,
  models,
  busy,
  availability,
  onChange,
}: {
  form: DraftForm;
  models: ChatModelOption[];
  busy: boolean;
  availability: ResearchDefinition["sources"];
  onChange: (form: DraftForm) => void;
}) {
  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <Label htmlFor="research-title" className="text-xs text-muted-foreground">
            Title
          </Label>
          <Input
            id="research-title"
            className="mt-1"
            value={form.title}
            maxLength={RESEARCH_TITLE_MAX_CHARS}
            disabled={busy}
            placeholder="What are you investigating?"
            onChange={(event) => onChange({ ...form, title: event.target.value })}
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Output</Label>
          <div className="mt-1.5 flex gap-2 text-sm">
            {(["memo", "comparison"] as const).map((kind) => (
              <label key={kind} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="research-output-kind"
                  checked={form.outputKind === kind}
                  disabled={busy}
                  onChange={() => onChange({ ...form, outputKind: kind })}
                />
                {kind}
              </label>
            ))}
          </div>
        </div>
      </div>
      <div>
        <Label htmlFor="research-question" className="text-xs text-muted-foreground">
          Question
        </Label>
        <Textarea
          id="research-question"
          className="mt-1 text-sm"
          rows={3}
          value={form.question}
          maxLength={RESEARCH_QUESTION_MAX_CHARS}
          disabled={busy}
          placeholder="The exact question the research run should answer from the selected sources"
          onChange={(event) => onChange({ ...form, question: event.target.value })}
        />
      </div>
      <div className="sm:max-w-sm">
        <ModelField
          models={models}
          value={form.chatModel}
          disabled={busy}
          onChange={(chatModel) => onChange({ ...form, chatModel })}
        />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Sources (explicit selection)</Label>
        <div className="mt-1">
          <ResearchScopePicker
            sourceIds={form.sourceIds}
            libraryIds={form.libraryIds}
            availability={availability}
            disabled={busy}
            onChange={(next) => onChange({ ...form, sourceIds: next.sourceIds, libraryIds: next.libraryIds })}
          />
        </div>
      </div>
      {form.outputKind === "comparison" && (
        <div>
          <Label className="text-xs text-muted-foreground">Comparison columns</Label>
          <div className="mt-1">
            <ColumnEditor
              columns={form.columns}
              disabled={busy}
              onChange={(columns) => onChange({ ...form, columns })}
            />
          </div>
        </div>
      )}
      <div>
        <Label className="text-xs text-muted-foreground">Plan (editable)</Label>
        <div className="mt-1">
          <PlanEditor plan={form.plan} disabled={busy} onChange={(plan) => onChange({ ...form, plan })} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ detail

function ResearchDetail({ definitionId }: { definitionId: string }) {
  const { models, defaultModel } = useChatModels();
  const [definition, setDefinition] = useState<ResearchDefinition | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<DraftForm>(EMPTY_FORM);
  const [dirty, setDirty] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [planNote, setPlanNote] = useState<string | null>(null);
  const [consentRequired, setConsentRequired] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ResearchRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<ResearchRunDetail | null>(null);
  const [runPollError, setRunPollError] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewConflict, setReviewConflict] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [rerunBusy, setRerunBusy] = useState(false);
  const [artifactBusy, setArtifactBusy] = useState(false);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [artifactResult, setArtifactResult] = useState<ResearchArtifactResult | null>(null);
  const [sourceLabels, setSourceLabels] = useState<Map<string, string>>(new Map());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const mountedRef = useRef(false);
  const definitionRequestRef = useRef(0);
  const definitionAbortRef = useRef<AbortController | null>(null);
  const formRef = useRef(form);
  formRef.current = form;
  const headRevisionRef = useRef<number>(0);
  const saveRequestRef = useRef(0);
  const planRequestRef = useRef(0);
  const startRequestRef = useRef(0);
  const reviewRequestRef = useRef(0);
  const reviewBusyRef = useRef(false);
  const runTargetRef = useRef<string | null>(null);
  const runDetailRequestRef = useRef(0);
  const deleteRequestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      definitionRequestRef.current += 1;
      definitionAbortRef.current?.abort();
      runTargetRef.current = null;
      runDetailRequestRef.current += 1;
      saveRequestRef.current += 1;
      reviewRequestRef.current += 1;
      reviewBusyRef.current = false;
      deleteRequestRef.current += 1;
    };
  }, []);

  const loadDefinition = useCallback(
    async (options: { resetForm?: boolean } = {}) => {
      const requestId = ++definitionRequestRef.current;
      definitionAbortRef.current?.abort();
      const abort = new AbortController();
      definitionAbortRef.current = abort;
      setLoadError(null);
      try {
        const [loaded, sourcePage] = await Promise.all([
          researchApi.get(definitionId, abort.signal),
          sourcesApi.list({ signal: abort.signal }).catch(() => null),
        ]);
        if (!mountedRef.current || requestId !== definitionRequestRef.current || abort.signal.aborted) return;
        setDefinition(loaded);
        headRevisionRef.current = loaded.current_revision;
        if (options.resetForm || !formRef.current.title) {
          setForm(formFromDefinition(loaded));
          setDirty(false);
        }
        setSaveConflict(false);
        setSaveError(null);
        setSelectedRunId((current) => current ?? loaded.active_run?.id ?? null);
        if (sourcePage) {
          setSourceLabels(new Map(sourcePage.items.map((source) => [source.id, source.display_name || source.name])));
        }
      } catch (caught: unknown) {
        if (mountedRef.current && requestId === definitionRequestRef.current && !abort.signal.aborted) {
          setLoadError(formatApiError(caught, "Could not load this research definition"));
        }
      }
    },
    [definitionId],
  );

  const loadRuns = useCallback(async () => {
    try {
      const page = await researchApi.listRuns(definitionId);
      if (!mountedRef.current || runTargetRef.current === "__gone") return;
      setRuns(page.items);
    } catch {
      // run history refresh is best-effort; the detail view surfaces errors.
    }
  }, [definitionId]);

  useEffect(() => {
    runTargetRef.current = null;
    void loadDefinition({ resetForm: true });
    void loadRuns();
    return () => {
      runTargetRef.current = "__gone";
    };
  }, [loadDefinition, loadRuns]);

  useEffect(() => {
    if (!form.chatModel && defaultModel && definition) {
      setForm((current) => (current.chatModel ? current : { ...current, chatModel: defaultModel }));
    }
  }, [defaultModel, definition, form.chatModel]);

  // -- exact-ID, visibility-aware run polling with failure backoff ------------
  useEffect(() => {
    if (!selectedRunId) return;
    const runId = selectedRunId;
    let cancelled = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;
    runTargetRef.current = runId;

    const delayFor = () =>
      document.hidden ? RUN_POLL_HIDDEN_MS : Math.min(RUN_POLL_MAX_MS, RUN_POLL_BASE_MS * 2 ** failures);
    const schedule = () => {
      timer = setTimeout(tick, delayFor());
    };
    const tick = async () => {
      if (cancelled || runTargetRef.current !== runId) return;
      if (document.hidden) {
        schedule();
        return;
      }
      abort?.abort();
      abort = new AbortController();
      const requestId = ++runDetailRequestRef.current;
      try {
        const detail = await researchApi.getRun(runId, abort.signal);
        if (cancelled || runTargetRef.current !== runId || requestId !== runDetailRequestRef.current) return;
        failures = 0;
        setRunPollError(null);
        setRunDetail(detail);
        if (isTerminalResearchRunStatus(detail.status)) return;
        schedule();
      } catch (caught: unknown) {
        if (cancelled || abort?.signal.aborted || runTargetRef.current !== runId) return;
        failures += 1;
        if (failures >= 6) setRunPollError(formatApiError(caught, "Could not reach the run; retrying more slowly"));
        schedule();
      }
    };
    const onVisible = () => schedule();
    window.addEventListener("visibilitychange", onVisible);
    void (async () => {
      // Fetch the detail immediately, then poll while non-terminal.
      const requestId = ++runDetailRequestRef.current;
      const initial = new AbortController();
      abort = initial;
      try {
        const detail = await researchApi.getRun(runId, initial.signal);
        if (cancelled || runTargetRef.current !== runId || requestId !== runDetailRequestRef.current) return;
        setRunDetail(detail);
        if (isTerminalResearchRunStatus(detail.status)) return;
      } catch (caught: unknown) {
        if (!cancelled && !initial.signal.aborted && runTargetRef.current === runId) {
          setRunPollError(formatApiError(caught, "Could not load the run"));
        }
      }
      schedule();
    })();
    return () => {
      cancelled = true;
      window.removeEventListener("visibilitychange", onVisible);
      if (timer) clearTimeout(timer);
      abort?.abort();
    };
  }, [selectedRunId]);

  const reloadRun = useCallback(() => {
    if (!selectedRunId) return;
    const runId = selectedRunId;
    const requestId = ++runDetailRequestRef.current;
    void researchApi
      .getRun(runId)
      .then((detail) => {
        if (mountedRef.current && runTargetRef.current === runId && requestId === runDetailRequestRef.current) {
          setReviewConflict(false);
          setRunDetail(detail);
        }
      })
      .catch(() => undefined);
  }, [selectedRunId]);

  const selectRun = (runId: string | null) => {
    // Re-clicking the already-selected row must be a no-op: the poll effect is
    // keyed on selectedRunId, so nulling the detail without an id change would
    // leave "Loading run…" with no in-flight request until another selection.
    if (runId !== null && runId === selectedRunId) return;
    runTargetRef.current = runId;
    runDetailRequestRef.current += 1;
    setRunDetail(null);
    setRunPollError(null);
    setReviewConflict(false);
    setReviewError(null);
    setArtifactResult(null);
    setArtifactError(null);
    setSelectedRunId(runId);
  };

  // -- CAS definition save ------------------------------------------------------
  const saveDefinition = async () => {
    if (!definition || saveBusy) return;
    const requestId = ++saveRequestRef.current;
    setSaveBusy(true);
    setSaveError(null);
    try {
      const updated = await researchApi.update(definitionId, {
        expected_revision: headRevisionRef.current,
        title: form.title.trim(),
        question: form.question.trim(),
        output_kind: form.outputKind,
        source_ids: form.sourceIds,
        library_ids: form.libraryIds,
        chat_model: form.chatModel,
        columns: form.outputKind === "comparison" ? form.columns : [],
        plan: form.plan,
      });
      if (!mountedRef.current || requestId !== saveRequestRef.current) return;
      setDefinition(updated);
      headRevisionRef.current = updated.current_revision;
      setDirty(false);
      setSaveConflict(false);
    } catch (caught: unknown) {
      if (!mountedRef.current || requestId !== saveRequestRef.current) return;
      if (isResearchErrorCode(caught, RESEARCH_REVISION_CONFLICT_CODE)) {
        setSaveConflict(true);
      } else {
        setSaveError(formatApiError(caught, "Could not save this revision"));
      }
    } finally {
      if (mountedRef.current && requestId === saveRequestRef.current) setSaveBusy(false);
    }
  };

  // -- bounded plan proposal (never starts execution) --------------------------
  const generatePlan = async () => {
    if (!definition || planBusy) return;
    const requestId = ++planRequestRef.current;
    setPlanBusy(true);
    setConsentRequired(false);
    setPlanNote(null);
    try {
      const proposal: ResearchPlanProposal = await researchApi.proposePlan(definitionId, headRevisionRef.current);
      if (!mountedRef.current || requestId !== planRequestRef.current) return;
      setForm((current) => ({
        ...current,
        plan: { steps: proposal.plan.steps.map((step) => ({ ...step, questions: [...step.questions] })) },
      }));
      setDirty(true);
      setPlanNote(
        proposal.fallback
          ? `Proposal returned the deterministic default plan (${proposal.error_code ?? "provider unavailable"}); nothing has started — edit and save it as a revision.`
          : `Proposal generated by ${proposal.model}; nothing has started — edit, then save it as a revision.`,
      );
    } catch (caught: unknown) {
      if (!mountedRef.current || requestId !== planRequestRef.current) return;
      if (isRemoteEgressConsentError(caught)) setConsentRequired(true);
      else if (isResearchErrorCode(caught, RESEARCH_REVISION_CONFLICT_CODE)) setSaveConflict(true);
      else setPlanNote(formatApiError(caught, "Could not generate a plan proposal"));
    } finally {
      if (mountedRef.current && requestId === planRequestRef.current) setPlanBusy(false);
    }
  };

  // -- start ------------------------------------------------------------------
  const conflicts = (definition?.sources ?? []).filter((entry) => entry.availability !== "ready");
  const startDisabledReason = !definition
    ? "Loading…"
    : dirty
      ? "Save this revision first"
      : form.sourceIds.length === 0
        ? "Select at least one source to start; an empty scope is a legal draft, not a run"
        : conflicts.length > 0
          ? `${conflicts.length} selected source${conflicts.length === 1 ? " is" : "s are"} not ready — revise the selection first`
          : null;

  const startRun = async (rerun?: { runId: string; selection: { row_source_ids: string[]; column_ids: string[] } }) => {
    if (!definition || startBusy || rerunBusy) return;
    if (!rerun && startDisabledReason) return;
    const requestId = ++startRequestRef.current;
    if (rerun) setRerunBusy(true);
    else setStartBusy(true);
    setStartError(null);
    setConsentRequired(false);
    try {
      const started = await researchApi.start(
        definitionId,
        rerun
          ? {
              expected_revision: headRevisionRef.current,
              definition_revision: definition.current_revision,
              rerun_of: rerun.runId,
              rerun_selection: {
                row_source_ids: rerun.selection.row_source_ids.length ? rerun.selection.row_source_ids : undefined,
                column_ids: rerun.selection.column_ids.length ? rerun.selection.column_ids : undefined,
              },
            }
          : { expected_revision: headRevisionRef.current },
      );
      if (!mountedRef.current || requestId !== startRequestRef.current) return;
      setRuns((current) => [started, ...current.filter((entry) => entry.id !== started.id)]);
      selectRun(started.id);
    } catch (caught: unknown) {
      if (!mountedRef.current || requestId !== startRequestRef.current) return;
      if (isRemoteEgressConsentError(caught)) setConsentRequired(true);
      else if (isResearchErrorCode(caught, RESEARCH_ACTIVE_RUN_CODE)) {
        const existing = researchActiveRunId(caught);
        setStartError(
          existing
            ? `This definition already has an active run (${existing.slice(0, 8)}…); it is selected below.`
            : "This definition already has an active run.",
        );
        if (existing) selectRun(existing);
      } else if (isResearchErrorCode(caught, RESEARCH_MODEL_UNAVAILABLE_CODE)) {
        setStartError(
          `The pinned model ${definition.chat_model} is not available on the provider. Adjust Settings or edit the definition.`,
        );
      } else if (isResearchErrorCode(caught, RESEARCH_INPUTS_NOT_READY_CODE)) {
        const ids = researchUnreadySourceIds(caught);
        setStartError(
          `Readiness conflict: ${ids.length ? ids.map((id) => sourceLabels.get(id) ?? `${id.slice(0, 8)}…`).join(", ") : "one or more selected sources"} are not ready. Revise the selection and save a new revision.`,
        );
        void loadDefinition();
      } else setStartError(formatApiError(caught, "Could not start the run"));
    } finally {
      if (mountedRef.current && requestId === startRequestRef.current) {
        setStartBusy(false);
        setRerunBusy(false);
      }
    }
  };

  // -- review CAS batch ---------------------------------------------------------
  const applyReview = async (ops: ResearchReviewOp[]): Promise<boolean> => {
    if (!runDetail || reviewBusyRef.current) return false;
    reviewBusyRef.current = true;
    setReviewBusy(true);
    setReviewError(null);
    const requestId = ++reviewRequestRef.current;
    try {
      await researchApi.review(runDetail.id, { expected_revision: runDetail.review_revision, ops });
      if (!mountedRef.current || requestId !== reviewRequestRef.current || runTargetRef.current !== runDetail.id) {
        return false;
      }
      setReviewConflict(false);
      // authoritative refresh of claims/steps/counts through the same target guard
      reloadRun();
      return true;
    } catch (caught: unknown) {
      if (!mountedRef.current || requestId !== reviewRequestRef.current) return false;
      if (isResearchErrorCode(caught, RESEARCH_REVISION_CONFLICT_CODE)) {
        setReviewConflict(true);
      } else {
        setReviewError(formatApiError(caught, "The review operation failed"));
      }
      return false;
    } finally {
      if (mountedRef.current && requestId === reviewRequestRef.current) {
        reviewBusyRef.current = false;
        setReviewBusy(false);
      }
    }
  };

  const cancelRun = async () => {
    if (!runDetail || cancelBusy) return;
    setCancelBusy(true);
    try {
      await researchApi.cancelRun(runDetail.id);
      reloadRun();
    } catch (caught: unknown) {
      if (mountedRef.current) setRunPollError(formatApiError(caught, "Could not request cancellation"));
    } finally {
      if (mountedRef.current) setCancelBusy(false);
    }
  };

  const createArtifact = async () => {
    if (!runDetail || artifactBusy) return;
    const runId = runDetail.id;
    setArtifactBusy(true);
    setArtifactError(null);
    try {
      const result = await researchApi.createArtifact(runId);
      if (!mountedRef.current || runTargetRef.current !== runId) return;
      setArtifactResult(result);
    } catch (caught: unknown) {
      if (mountedRef.current && runTargetRef.current === runId) {
        setArtifactError(formatApiError(caught, "Could not create the reviewed draft"));
      }
    } finally {
      if (mountedRef.current) setArtifactBusy(false);
    }
  };

  const removeDefinition = async () => {
    if (deleteBusy) return;
    const requestId = ++deleteRequestRef.current;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await researchApi.remove(definitionId);
      if (!mountedRef.current || requestId !== deleteRequestRef.current) return;
      window.location.hash = "#/research";
    } catch (caught: unknown) {
      if (mountedRef.current && requestId === deleteRequestRef.current) {
        setDeleteError(formatApiError(caught, "Could not delete this definition"));
        setDeleteBusy(false);
      }
    }
  };

  if (loadError && !definition) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-3 px-6 py-6">
          <p className="text-sm text-destructive" role="alert">
            {loadError}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void loadDefinition({ resetForm: true })}>
              Retry
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href="#/research">Back to Research</a>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!definition) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-6">
          <Skeleton className="h-64 rounded-lg" />
        </div>
      </div>
    );
  }

  const patchForm = (next: DraftForm) => {
    setForm(next);
    setDirty(true);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 px-6 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <a href="#/research">
              <ArrowLeft className="h-4 w-4" /> Research
            </a>
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-xl font-bold tracking-tight">{definition.title}</h1>
          {definition.active_run && (
            <Badge variant="pending">
              <CalendarClock className="mr-1 h-3 w-3" /> {runStatusLabel(definition.active_run.status)}
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </header>

        {consentRequired && <ConsentBanner />}

        <DefinitionFields
          form={form}
          models={models}
          busy={saveBusy}
          availability={definition.sources}
          onChange={patchForm}
        />

        {/* plan proposal + save + start */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={planBusy} onClick={() => void generatePlan()}>
            {planBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Generate plan
            proposal
          </Button>
          <Button
            size="sm"
            disabled={saveBusy || !form.title.trim() || !form.question.trim()}
            onClick={() => void saveDefinition()}
          >
            {saveBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save as revision {definition.current_revision + (dirty ? 1 : 0)}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={Boolean(startDisabledReason) || startBusy}
            title={startDisabledReason ?? undefined}
            onClick={() => void startRun()}
          >
            {startBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Start with {form.chatModel || "the selected model"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Proposal generation sends the question and selected source labels to the provider; it never starts
            execution. Start is a separate explicit action.
          </span>
        </div>
        {planNote && (
          <p className="text-xs text-muted-foreground" role="status">
            {planNote}
          </p>
        )}
        {saveConflict && (
          <div
            className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
            role="alert"
          >
            <span>
              The definition changed since this form loaded; your save was rejected. Reload the saved revision — your
              local edits will be discarded.
            </span>
            <Button variant="outline" size="sm" onClick={() => void loadDefinition({ resetForm: true })}>
              <RefreshCw className="h-3.5 w-3.5" /> Reload saved revision
            </Button>
          </div>
        )}
        {saveError && (
          <p className="text-xs text-destructive" role="alert">
            {saveError}
          </p>
        )}
        {startDisabledReason && !dirty && (
          <p className="text-xs text-warning" role="status">
            Start disabled: {startDisabledReason}.
          </p>
        )}
        {startError && (
          <p className="text-xs text-destructive" role="alert">
            {startError}
          </p>
        )}

        {/* run history */}
        <section aria-label="Run history" className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Runs</h2>
            <Button variant="ghost" size="sm" onClick={() => void loadRuns()}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
          <ul className="space-y-1.5">
            {runs.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => selectRun(entry.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm",
                    selectedRunId === entry.id ? "border-primary/50 bg-accent/50" : "hover:bg-accent/30",
                  )}
                >
                  <span className="font-medium">{formatDate(entry.created_at)}</span>
                  <Badge
                    variant={
                      entry.status === "completed"
                        ? "success"
                        : entry.status === "needs_review"
                          ? "pending"
                          : entry.status === "failed" || entry.status === "cancelled"
                            ? "destructive"
                            : "secondary"
                    }
                  >
                    {runStatusLabel(entry.status)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    rev {entry.definition_revision} · {entry.chat_model}
                    {entry.rerun_of ? " · rerun" : ""}
                  </span>
                </button>
              </li>
            ))}
            {runs.length === 0 && <li className="text-xs text-muted-foreground">No runs yet.</li>}
          </ul>
        </section>

        {/* selected run */}
        {selectedRunId && !runDetail && (
          <p className="text-sm text-muted-foreground" role="status">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading run {selectedRunId.slice(0, 8)}…
          </p>
        )}
        {runPollError && (
          <p className="text-xs text-warning" role="status">
            {runPollError}
          </p>
        )}
        {runDetail && (
          <>
            <RunPanel
              definition={definition}
              run={runDetail}
              reviewBusy={reviewBusy}
              reviewConflict={reviewConflict}
              reviewError={reviewError}
              onReview={applyReview}
              onReloadRun={reloadRun}
              onCancelRun={() => void cancelRun()}
              cancelBusy={cancelBusy}
              artifactSlot={
                <ArtifactCard
                  run={runDetail}
                  busy={artifactBusy}
                  error={artifactError}
                  result={
                    artifactResult
                      ? {
                          document_id: artifactResult.document_id,
                          document_revision: artifactResult.document_revision,
                          labels: artifactResult.projection.labels,
                          omitted: {
                            rows: artifactResult.projection.omitted.rows.length,
                            claims: artifactResult.projection.omitted.claims,
                            evidence: artifactResult.projection.omitted.evidence,
                          },
                        }
                      : null
                  }
                  onCreate={() => void createArtifact()}
                />
              }
            />
            {definition.output_kind === "comparison" && (
              <section aria-label="Comparison output" className="space-y-2">
                <h2 className="text-sm font-semibold">Comparison table</h2>
                <TablePanel
                  title={definition.title}
                  run={runDetail}
                  runHistory={runs}
                  sourceLabels={sourceLabels}
                  reviewBusy={reviewBusy}
                  rerunBusy={rerunBusy}
                  onReview={applyReview}
                  onRerun={(selection) => startRun({ runId: runDetail.id, selection })}
                />
              </section>
            )}
          </>
        )}

        {deleteOpen && (
          <ConfirmDialog
            title="Delete this research definition?"
            description="This cancels any active run and permanently removes the definition, its revisions, runs, evidence, and reviews. Captured output cannot be recovered."
            busy={deleteBusy}
            error={deleteError}
            onConfirm={() => void removeDefinition()}
            onCancel={() => {
              if (!deleteBusy) setDeleteOpen(false);
            }}
          />
        )}
      </div>
    </div>
  );
}
