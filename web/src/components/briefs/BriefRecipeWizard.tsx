import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import {
  analysesApi,
  briefsApi,
  connectorsApi,
  formatApiError,
  knowledgeApi,
  sourcesApi,
  type Analysis,
  type AnalysisParameterDeclaration,
  type AnalysisParameterValue,
  type BriefCalendarSchedule,
  type BriefOccurrencePreview,
  type BriefRecipe,
  type BriefRecipeCreateBody,
  type AnalysisSummaryItem,
  type Connector,
  type KnowledgeConnection,
  type Source,
} from "@/lib/api";
import { mergeCatalogContinuation } from "@/lib/catalogMerge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Reviewed-brief recipe wizard (M16 slice 4). One form for create and CAS
 * edit: pick a saved analysis — selection loads the current definition
 * revision detail (loading skeleton; an in-dialog error with a retry
 * affordance gates create/save until it resolves, and a null-schema detail is
 * treated as a failed fetch rather than dereferenced) — and typed parameter
 * inputs, the membership mirror, and every submitted value derive only from
 * that revision, never from the catalog summary or a nullable run shape. Fill
 * typed parameter values validated against the bound revision's declarations,
 * keep report title + instruction within bounds, mirror the bound revision's
 * exact source membership (membership equality is a server rule — the picker
 * enforces it and mirrors the server error), bind per-source refreshes, and
 * choose a civil calendar schedule with the server-resolved next three run
 * times and the running-app caveat.
 */

const CALENDAR_CAVEAT = "The app/server must be running for schedules to fire — there is no OS scheduler.";
const MEMBERSHIP_NOTE =
  "Recipe membership must equal the bound analysis revision's selected source set. Changing membership requires an explicit saved-analysis revision, then editing this recipe.";
const REVISION_CONFLICT_MESSAGE =
  "This recipe changed since you opened it (someone else edited it, or it was auto-paused). Reload the recipe and edit again.";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const RUNNING_APP_CAVEAT = CALENDAR_CAVEAT;

interface BindingDraft {
  mode: "none" | "connector" | "knowledge";
  connectorId: string;
  connectionId: string;
}

function emptyBinding(): BindingDraft {
  return { mode: "none", connectorId: "", connectionId: "" };
}

function timeZoneChoices(): string[] {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const supported = (Intl as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf?.("timeZone");
  const choices = new Set<string>(["UTC"]);
  if (resolved) choices.add(resolved);
  for (const zone of supported ?? []) choices.add(zone);
  return [...choices];
}

/**
 * Wire shapes accepted by the brief create/patch routes. The server schemas in
 * `server/src/routes/briefs.ts` declare `weekday`, `day_of_month`,
 * `connector_id`, and `connection_id` as non-nullable, so an explicit JSON
 * `null` for an unused field is a masked `400 invalid request` (the defect
 * journey F asserted — the wizard's create could never succeed). Unused fields
 * are therefore omitted from the body instead of sent as null. The shared
 * response-DTO types in `@/lib/api` model those fields as required nullables,
 * so `toApiBody` is the single boundary that reconciles the request wire shape
 * with the response model.
 */
interface ScheduleWireBody {
  kind: BriefCalendarSchedule["kind"];
  hour: number;
  minute: number;
  time_zone: string;
  weekday?: number;
  day_of_month?: number;
}

interface RefreshBindingWireBody {
  source_id: string;
  kind: "connector" | "knowledge";
  connector_id?: string;
  connection_id?: string;
}

type RecipeCreateWireBody = Omit<BriefRecipeCreateBody, "schedule" | "refresh_bindings"> & {
  schedule: ScheduleWireBody;
  refresh_bindings: RefreshBindingWireBody[];
};

function toApiBody(wire: RecipeCreateWireBody): BriefRecipeCreateBody {
  // See the wire-shape note above: omitted keys satisfy the server schema while
  // the response DTO types require the null variant.
  return wire as unknown as BriefRecipeCreateBody;
}

function parseScheduleInput(input: {
  kind: BriefCalendarSchedule["kind"];
  weekdayDraft: string;
  dayDraft: string;
  hourDraft: string;
  minuteDraft: string;
  timeZone: string;
}): { schedule?: ScheduleWireBody; error?: string } {
  const hour = Number.parseInt(input.hourDraft, 10);
  const minute = Number.parseInt(input.minuteDraft, 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { error: "Hour must be between 0 and 23." };
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return { error: "Minute must be between 0 and 59." };
  const schedule: ScheduleWireBody = { kind: input.kind, hour, minute, time_zone: input.timeZone };
  if (input.kind === "weekly") {
    const weekday = Number.parseInt(input.weekdayDraft, 10);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { error: "Pick a weekday (Sunday–Saturday)." };
    schedule.weekday = weekday;
  }
  if (input.kind === "monthly") {
    const day = Number.parseInt(input.dayDraft, 10);
    if (!Number.isInteger(day) || day < 1 || day > 28) return { error: "Monthly day must be between 1 and 28." };
    schedule.day_of_month = day;
  }
  return { schedule };
}

function paramDraftValue(declaration: AnalysisParameterDeclaration): string {
  if (declaration.default === undefined || declaration.default === null) return "";
  return String(declaration.default);
}

function parseParamValue(
  declaration: AnalysisParameterDeclaration,
  draft: string,
): { value?: AnalysisParameterValue; error?: string } {
  if (draft === "") return {};
  if (declaration.type === "boolean") {
    if (draft !== "true" && draft !== "false") return { error: "Choose true or false." };
    return { value: draft === "true" };
  }
  if (declaration.type === "number" || declaration.type === "integer") {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) return { error: "Must be a finite number." };
    if (declaration.type === "integer" && !Number.isSafeInteger(parsed)) return { error: "Must be a whole number." };
    return { value: parsed };
  }
  if (declaration.type === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft)) return { error: "Use a YYYY-MM-DD date." };
    const parsed = new Date(`${draft}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== draft)
      return { error: "Use a real calendar date." };
    return { value: draft };
  }
  return { value: draft };
}

export function BriefRecipeWizard({
  recipe,
  handleConsentError,
  onClose,
  onSaved,
}: {
  /** Null for creation; the loaded recipe (detail revision) for a CAS edit. */
  recipe: BriefRecipe | null;
  handleConsentError: (error: unknown, retry: () => void) => boolean;
  onClose: () => void;
  onSaved: (saved: BriefRecipe) => void;
}) {
  const [name, setName] = useState(recipe?.name ?? "");
  const [analysisId, setAnalysisId] = useState(recipe?.analysis_id ?? "");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [reportTitle, setReportTitle] = useState(recipe?.report_title ?? "");
  const [reportInstruction, setReportInstruction] = useState(recipe?.report_instruction ?? "");
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({});
  const [paramErrors, setParamErrors] = useState<Record<string, string>>({});
  const [bindings, setBindings] = useState<Record<string, BindingDraft>>({});
  const [scheduleKind, setScheduleKind] = useState<BriefCalendarSchedule["kind"]>(recipe?.schedule.kind ?? "weekly");
  const [weekdayDraft, setWeekdayDraft] = useState(String(recipe?.schedule.weekday ?? 1));
  const [dayDraft, setDayDraft] = useState(String(recipe?.schedule.day_of_month ?? 1));
  const [hourDraft, setHourDraft] = useState(String(recipe?.schedule.hour ?? 9));
  const [minuteDraft, setMinuteDraft] = useState(String(recipe?.schedule.minute ?? 0).padStart(2, "0"));
  const [timeZone, setTimeZone] = useState(
    recipe?.schedule.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  );
  const [preview, setPreview] = useState<BriefOccurrencePreview[] | null>(null);
  const [previewFor, setPreviewFor] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const previewRequestRef = useRef(0);
  const scheduleKey = JSON.stringify([scheduleKind, weekdayDraft, dayDraft, hourDraft, minuteDraft, timeZone]);
  const previewCurrent = previewFor === scheduleKey && preview?.length === 3;
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [analyses, setAnalyses] = useState<AnalysisSummaryItem[]>([]);
  const [analysesNextCursor, setAnalysesNextCursor] = useState<string | null>(null);
  const [analysesLoadingMore, setAnalysesLoadingMore] = useState(false);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connections, setConnections] = useState<KnowledgeConnection[]>([]);
  const timeZones = useMemo(timeZoneChoices, []);

  const mountedRef = useRef(false);
  const detailRequestRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);
  const catalogRequestRef = useRef(0);
  const catalogAbortRef = useRef<AbortController | null>(null);
  const analysesPageOwnerRef = useRef<number | null>(null);
  const saveRequestRef = useRef(0);
  const saveAbortRef = useRef<AbortController | null>(null);

  const sourceNames = useMemo(() => new Map(sources.map((source) => [source.id, source.display_name])), [sources]);
  const boundSourceIds = analysis?.source_ids ?? recipe?.source_ids ?? [];

  const loadAnalysis = useCallback(
    async (id: string, requestId: number, signal: AbortSignal, seedValues?: Record<string, string>) => {
      setAnalysisLoading(true);
      setAnalysisError(null);
      try {
        // The detail DTO is the bound definition's CURRENT revision: its typed
        // parameter declarations and selected source set are the only schema
        // source for this wizard. Nullable runtime shapes on the analysis
        // surface (e.g. `active_run: null`) are never read for parameters.
        const detail = await analysesApi.get(id, signal);
        if (detailRequestRef.current !== requestId || signal.aborted || !mountedRef.current) return;
        // Fail closed on a null-schema response: dereferencing it is exactly
        // the journey-F crash signature ("Cannot read properties of null
        // (reading 'parameters')"). Treat it as a failed fetch so the in-
        // dialog error + retry path owns it instead of the render tree.
        if (!detail) throw new Error("analysis revision detail is unavailable");
        setAnalysis(detail);
        const draft: Record<string, string> = {};
        for (const declaration of detail.parameters) draft[declaration.name] = paramDraftValue(declaration);
        // An edit keeps the recipe's stored values where they exist; creation
        // and re-syncs fall back to the revision declaration defaults.
        setParamDraft(seedValues ? { ...draft, ...seedValues } : draft);
        setParamErrors({});
      } catch (failure: unknown) {
        if (detailRequestRef.current === requestId && !signal.aborted && mountedRef.current) {
          setAnalysisError(formatApiError(failure, "Could not load the saved analysis"));
        }
      } finally {
        if (detailRequestRef.current === requestId && !signal.aborted && mountedRef.current) setAnalysisLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    const abort = new AbortController();
    catalogAbortRef.current = abort;
    const requestId = ++catalogRequestRef.current;
    void Promise.allSettled([
      sourcesApi.list({ signal: abort.signal }),
      connectorsApi.list({ signal: abort.signal }),
      knowledgeApi.list({ signal: abort.signal }),
      analysesApi.list({ signal: abort.signal }),
    ]).then(([sourcesResult, connectorsResult, connectionsResult, analysesResult]) => {
      if (catalogRequestRef.current !== requestId || abort.signal.aborted || !mountedRef.current) return;
      if (sourcesResult.status === "fulfilled") setSources(sourcesResult.value.items);
      if (connectorsResult.status === "fulfilled") setConnectors(connectorsResult.value.items);
      if (connectionsResult.status === "fulfilled") setConnections(connectionsResult.value.items);
      if (analysesResult.status === "fulfilled") {
        setAnalyses(analysesResult.value.items);
        setAnalysesNextCursor(analysesResult.value.next_cursor);
      }
    });
    return () => {
      mountedRef.current = false;
      catalogRequestRef.current += 1;
      catalogAbortRef.current?.abort();
      analysesPageOwnerRef.current = null;
      detailRequestRef.current += 1;
      detailAbortRef.current?.abort();
      saveRequestRef.current += 1;
      saveAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const requestId = ++previewRequestRef.current;
    const abort = new AbortController();
    setPreview(null);
    setPreviewFor("");
    setPreviewError(null);
    const { schedule, error } = parseScheduleInput({
      kind: scheduleKind,
      weekdayDraft,
      dayDraft,
      hourDraft,
      minuteDraft,
      timeZone,
    });
    if (!schedule) {
      setPreviewError(error ?? "Check the schedule fields.");
      return () => {
        abort.abort();
      };
    }
    void (async () => {
      try {
        const result = await briefsApi.previewSchedule(schedule, abort.signal);
        if (abort.signal.aborted || requestId !== previewRequestRef.current || !mountedRef.current) return;
        if (result.next_occurrences.length !== 3) throw new Error("Schedule preview unavailable");
        setPreview(result.next_occurrences);
        setPreviewFor(scheduleKey);
      } catch (failure: unknown) {
        if (!abort.signal.aborted && requestId === previewRequestRef.current && mountedRef.current) {
          setPreviewError(formatApiError(failure, "Could not preview this schedule."));
        }
      }
    })();
    return () => {
      abort.abort();
    };
  }, [scheduleKey, scheduleKind, weekdayDraft, dayDraft, hourDraft, minuteDraft, timeZone, previewRetry]);

  const loadMoreAnalyses = async () => {
    if (!analysesNextCursor || analysesPageOwnerRef.current !== null) return;
    const requestId = ++catalogRequestRef.current;
    analysesPageOwnerRef.current = requestId;
    setAnalysesLoadingMore(true);
    const abort = new AbortController();
    try {
      const page = await analysesApi.list({ cursor: analysesNextCursor, signal: abort.signal });
      if (catalogRequestRef.current !== requestId || abort.signal.aborted || !mountedRef.current) return;
      setAnalyses((current) => mergeCatalogContinuation(current, page.items));
      setAnalysesNextCursor(page.next_cursor);
    } catch (failure: unknown) {
      if (catalogRequestRef.current === requestId && !abort.signal.aborted && mountedRef.current) {
        // Target pagination only happens inside the dialog; keep the message
        // visible there instead of hiding it behind the modal overlay.
        setDialogError(formatApiError(failure, "Could not load older saved analyses"));
      }
    } finally {
      if (analysesPageOwnerRef.current === requestId) {
        analysesPageOwnerRef.current = null;
        if (mountedRef.current) setAnalysesLoadingMore(false);
      }
    }
  };

  // Existing recipe: load the server detail (fresh CAS revision + the
  // server-resolved next-three preview) and the bound analysis revision.
  useEffect(() => {
    if (!recipe) return;
    const requestId = ++detailRequestRef.current;
    detailAbortRef.current?.abort();
    const abort = new AbortController();
    detailAbortRef.current = abort;
    const bindingsDraft: Record<string, BindingDraft> = {};
    for (const binding of recipe.refresh_bindings)
      bindingsDraft[binding.source_id] = {
        mode: binding.kind,
        connectorId: binding.connector_id ?? "",
        connectionId: binding.connection_id ?? "",
      };
    setBindings(bindingsDraft);
    const paramSeed: Record<string, string> = {};
    for (const binding of recipe.parameter_values)
      paramSeed[binding.name] = binding.value === null ? "" : String(binding.value);
    setParamDraft(paramSeed);
    const storedValues = Object.fromEntries(Object.entries(paramSeed).filter(([, value]) => value !== ""));
    void (async () => {
      try {
        const detail = await briefsApi.get(recipe.id, abort.signal);
        if (detailRequestRef.current !== requestId || abort.signal.aborted || !mountedRef.current) return;
        await loadAnalysis(detail.analysis_id, requestId, abort.signal, storedValues);
      } catch (failure: unknown) {
        if (detailRequestRef.current === requestId && !abort.signal.aborted && mountedRef.current) {
          setAnalysisError(formatApiError(failure, "Could not load the recipe detail"));
        }
      }
    })();
    // Seeding runs once per opened recipe identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe?.id, loadAnalysis]);

  const selectAnalysis = (id: string) => {
    const requestId = ++detailRequestRef.current;
    detailAbortRef.current?.abort();
    const abort = new AbortController();
    detailAbortRef.current = abort;
    setAnalysisId(id);
    setAnalysis(null);
    setBindings({});
    if (!id) {
      setAnalysisError(null);
      return;
    }
    void loadAnalysis(id, requestId, abort.signal);
  };

  const refreshMembership = () => {
    if (!analysisId) return;
    const requestId = ++detailRequestRef.current;
    detailAbortRef.current?.abort();
    const abort = new AbortController();
    detailAbortRef.current = abort;
    void loadAnalysis(analysisId, requestId, abort.signal);
  };

  const buildBody = (): { body?: RecipeCreateWireBody; error?: string } => {
    if (!previewCurrent) return { error: "Wait for the current schedule preview before saving." };
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 80) return { error: "Name must be 1–80 characters." };
    if (!reportTitle.trim()) return { error: "Report title is required (max 200 characters)." };
    if (reportInstruction.trim().length < 1 || reportInstruction.length > 8_000)
      return { error: "Draft instruction must be 1–8,000 characters." };
    if (!analysisId) return { error: "Choose a saved analysis." };
    if (!analysis) return { error: "The saved analysis is still loading." };
    if (boundSourceIds.length < 1)
      return { error: "The bound analysis revision selects no sources; edit the analysis first." };

    const values: Record<string, AnalysisParameterValue> = {};
    const errors: Record<string, string> = {};
    for (const declaration of analysis.parameters) {
      const parsed = parseParamValue(declaration, paramDraft[declaration.name] ?? "");
      if (parsed.error) {
        errors[declaration.name] = parsed.error;
        continue;
      }
      if (parsed.value !== undefined) values[declaration.name] = parsed.value;
      else if (declaration.required && declaration.default === undefined)
        errors[declaration.name] = "Required parameter value is missing.";
    }
    setParamErrors(errors);
    if (Object.keys(errors).length > 0) return { error: "Fix the highlighted parameter values." };

    const { schedule, error: scheduleError } = parseScheduleInput({
      kind: scheduleKind,
      weekdayDraft,
      dayDraft,
      hourDraft,
      minuteDraft,
      timeZone,
    });
    if (!schedule) return { error: scheduleError ?? "Invalid schedule." };

    // The server binding schema rejects explicit nulls: each kind carries only
    // its own id key, and the other key is omitted entirely.
    const refreshBindings: RefreshBindingWireBody[] = [];
    for (const sourceId of boundSourceIds) {
      const binding = bindings[sourceId] ?? emptyBinding();
      if (binding.mode === "none") continue;
      if (binding.mode === "connector") {
        if (!binding.connectorId) return { error: "Pick a connector for every connector-refresh source." };
        refreshBindings.push({ source_id: sourceId, kind: "connector", connector_id: binding.connectorId });
      } else {
        if (!binding.connectionId) return { error: "Pick a knowledge connection for every folder-refresh source." };
        refreshBindings.push({ source_id: sourceId, kind: "knowledge", connection_id: binding.connectionId });
      }
    }
    return {
      body: {
        name: trimmedName,
        analysis_id: analysisId,
        ...(Object.keys(values).length > 0 ? { parameter_values: values } : {}),
        report_title: reportTitle.trim(),
        report_instruction: reportInstruction,
        source_ids: [...boundSourceIds],
        refresh_bindings: refreshBindings,
        schedule,
      },
    };
  };

  const save = async () => {
    if (busy) return;
    const { body, error } = buildBody();
    if (!body) {
      if (error) setDialogError(error);
      return;
    }
    const requestId = ++saveRequestRef.current;
    saveAbortRef.current?.abort();
    const abort = new AbortController();
    saveAbortRef.current = abort;
    setBusy(true);
    setDialogError(null);
    try {
      const saved = recipe
        ? await briefsApi.update(recipe.id, { expected_revision: recipe.revision, ...toApiBody(body) }, abort.signal)
        : await briefsApi.create(toApiBody(body), abort.signal);
      if (saveRequestRef.current !== requestId || abort.signal.aborted || !mountedRef.current) return;
      saveAbortRef.current = null;
      onSaved(saved);
    } catch (failure: unknown) {
      if (saveRequestRef.current !== requestId || abort.signal.aborted || !mountedRef.current) return;
      const code = (failure as { data?: { code?: unknown } }).data?.code;
      if (code === "BRIEF_REVISION_CONFLICT") setDialogError(REVISION_CONFLICT_MESSAGE);
      else if (!handleConsentError(failure, () => void save()))
        // Membership/parameter drift and duplicate names keep the server's own
        // wording so the UI mirrors the exact contract violation.
        setDialogError(formatApiError(failure, "Could not save the brief"));
    } finally {
      if (saveRequestRef.current === requestId && !abort.signal.aborted && mountedRef.current) {
        saveAbortRef.current = null;
        setBusy(false);
      }
    }
  };

  const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm";

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{recipe ? `Edit “${recipe.name}”` : "New reviewed brief"}</DialogTitle>
          <DialogDescription>
            A brief reruns a saved analysis over its exact source set on a civil schedule and lands a report draft in
            the review inbox. Nothing publishes without your approval.
          </DialogDescription>
        </DialogHeader>
        {dialogError && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {dialogError}
          </p>
        )}
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            aria-label="Brief name"
            placeholder="Weekly finance brief"
            autoFocus
          />

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="brief-analysis-select">
              Saved analysis
            </label>
            <select
              id="brief-analysis-select"
              aria-label="Saved analysis"
              value={analysisId}
              onChange={(event) => selectAnalysis(event.target.value)}
              className={selectClass}
            >
              <option value="">Choose a saved analysis…</option>
              {analyses.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} (rev {item.current_revision})
                </option>
              ))}
            </select>
            {analysesNextCursor && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void loadMoreAnalyses()}
                disabled={analysesLoadingMore}
              >
                {analysesLoadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                Load older analyses
              </Button>
            )}
            {analysisLoading ? <Skeleton className="h-16 w-full" /> : null}
            {analysisError && !analysisLoading && (
              <div className="flex items-center gap-2">
                <p className="text-xs text-destructive" role="alert">
                  {analysisError}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Retry loading the saved analysis"
                  onClick={refreshMembership}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Retry
                </Button>
              </div>
            )}
            {analysis && !analysisLoading && (
              <div className="rounded-md border bg-secondary/30 px-3 py-2 text-xs">
                <p>
                  <span className="font-medium text-foreground">{analysis.title}</span> — pinned to definition revision{" "}
                  <span className="font-mono">{analysis.current_revision}</span>. The server binds the current revision
                  at save time; later analysis edits never retarget this recipe.
                </p>
                <p className="mt-1 text-muted-foreground">{MEMBERSHIP_NOTE}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {boundSourceIds.map((sourceId) => (
                    <span
                      key={sourceId}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]"
                    >
                      <input
                        type="checkbox"
                        checked
                        disabled
                        aria-label={`Source ${sourceNames.get(sourceId) ?? sourceId}`}
                        className="h-3 w-3"
                      />
                      {sourceNames.get(sourceId) ?? `source ${sourceId.slice(0, 8)}`}
                    </span>
                  ))}
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={refreshMembership} disabled={analysisLoading}>
                  <RefreshCw className="h-3.5 w-3.5" /> Refresh membership from the saved analysis
                </Button>
              </div>
            )}
          </div>

          {analysis && analysis.parameters.length > 0 && (
            <fieldset className="space-y-2 rounded-md border p-3">
              <legend className="px-1 text-xs font-medium text-muted-foreground">Parameter values</legend>
              {analysis.parameters.map((declaration) => (
                <label key={declaration.name} className="block space-y-1 text-sm">
                  <span className="text-xs">
                    {declaration.label ?? declaration.name}
                    {declaration.required ? " (required)" : ""}
                    {declaration.description ? ` — ${declaration.description}` : ""}
                  </span>
                  {declaration.type === "boolean" ? (
                    <select
                      aria-label={`Parameter ${declaration.name}`}
                      value={paramDraft[declaration.name] ?? ""}
                      onChange={(event) =>
                        setParamDraft((current) => ({ ...current, [declaration.name]: event.target.value }))
                      }
                      className={selectClass}
                    >
                      <option value="">(use default)</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <Input
                      type={
                        declaration.type === "date"
                          ? "date"
                          : declaration.type === "number" || declaration.type === "integer"
                            ? "number"
                            : "text"
                      }
                      step={declaration.type === "integer" ? 1 : declaration.type === "number" ? "any" : undefined}
                      aria-label={`Parameter ${declaration.name}`}
                      aria-invalid={Boolean(paramErrors[declaration.name])}
                      value={paramDraft[declaration.name] ?? ""}
                      onChange={(event) =>
                        setParamDraft((current) => ({ ...current, [declaration.name]: event.target.value }))
                      }
                    />
                  )}
                  {paramErrors[declaration.name] && (
                    <span className="text-xs text-destructive">{paramErrors[declaration.name]}</span>
                  )}
                </label>
              ))}
            </fieldset>
          )}

          <div className="space-y-1.5">
            <Input
              value={reportTitle}
              onChange={(event) => setReportTitle(event.target.value)}
              maxLength={200}
              aria-label="Report title"
              placeholder="Weekly finance brief"
            />
            <textarea
              value={reportInstruction}
              onChange={(event) => setReportInstruction(event.target.value)}
              maxLength={8_000}
              aria-label="Draft instruction"
              placeholder="What the draft should say each run (max 8,000 characters)."
              className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
            <p className="text-[11px] text-muted-foreground">{reportInstruction.length}/8,000</p>
          </div>

          {boundSourceIds.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Refresh bindings</p>
              {boundSourceIds.map((sourceId) => {
                const binding = bindings[sourceId] ?? emptyBinding();
                return (
                  <Card key={sourceId} className="space-y-1.5 p-2.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate font-medium">
                        {sourceNames.get(sourceId) ?? `source ${sourceId.slice(0, 8)}`}
                      </span>
                      <select
                        aria-label={`Refresh mode for ${sourceNames.get(sourceId) ?? sourceId}`}
                        value={binding.mode}
                        onChange={(event) =>
                          setBindings((current) => ({
                            ...current,
                            [sourceId]: { ...emptyBinding(), mode: event.target.value as BindingDraft["mode"] },
                          }))
                        }
                        className="h-8 rounded-md border bg-background px-2 text-xs"
                      >
                        <option value="none">uses imported version (static)</option>
                        <option value="connector">refresh via connector</option>
                        <option value="knowledge">refresh via knowledge folder</option>
                      </select>
                    </div>
                    {binding.mode === "connector" && (
                      <select
                        aria-label={`Connector for ${sourceNames.get(sourceId) ?? sourceId}`}
                        value={binding.connectorId}
                        onChange={(event) =>
                          setBindings((current) => ({
                            ...current,
                            [sourceId]: { ...binding, connectorId: event.target.value },
                          }))
                        }
                        className={selectClass}
                      >
                        <option value="">Choose a connector…</option>
                        {connectors.map((connector) => (
                          <option key={connector.id} value={connector.id}>
                            {connector.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {binding.mode === "knowledge" && (
                      <select
                        aria-label={`Knowledge connection for ${sourceNames.get(sourceId) ?? sourceId}`}
                        value={binding.connectionId}
                        onChange={(event) =>
                          setBindings((current) => ({
                            ...current,
                            [sourceId]: { ...binding, connectionId: event.target.value },
                          }))
                        }
                        className={selectClass}
                      >
                        <option value="">Choose a knowledge connection…</option>
                        {connections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {binding.mode === "none" && (
                      <p className="text-[11px] text-muted-foreground">
                        Static input — this brief will use the imported version, never a newer file.
                      </p>
                    )}
                  </Card>
                );
              })}
            </div>
          )}

          <div className="space-y-2 rounded-md border p-3">
            <p className="text-xs font-medium text-muted-foreground">Schedule (civil calendar, no cron)</p>
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Schedule kind"
                value={scheduleKind}
                onChange={(event) => setScheduleKind(event.target.value as BriefCalendarSchedule["kind"])}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
              {scheduleKind === "weekly" && (
                <select
                  aria-label="Weekday"
                  value={weekdayDraft}
                  onChange={(event) => setWeekdayDraft(event.target.value)}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  {WEEKDAYS.map((label, index) => (
                    <option key={label} value={index}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
              {scheduleKind === "monthly" && (
                <Input
                  type="number"
                  min={1}
                  max={28}
                  value={dayDraft}
                  onChange={(event) => setDayDraft(event.target.value)}
                  aria-label="Day of month (1-28)"
                  className="w-24"
                />
              )}
              <Input
                type="number"
                min={0}
                max={23}
                value={hourDraft}
                onChange={(event) => setHourDraft(event.target.value)}
                aria-label="Hour (0-23)"
                className="w-20"
              />
              <Input
                type="number"
                min={0}
                max={59}
                value={minuteDraft}
                onChange={(event) => setMinuteDraft(event.target.value)}
                aria-label="Minute (0-59)"
                className="w-20"
              />
              <select
                aria-label="Time zone"
                value={timeZone}
                onChange={(event) => setTimeZone(event.target.value)}
                className="h-9 flex-1 rounded-md border bg-background px-2 text-sm"
              >
                {timeZones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[11px] text-muted-foreground">{CALENDAR_CAVEAT}</p>
            <div aria-label="Next three run times">
              {previewCurrent && preview ? (
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {preview.map((occurrence) => (
                    <li key={occurrence.occurrence_key}>
                      <span className="text-foreground">{occurrence.civil.replace("T", " ")}</span> local ({timeZone})
                      {" · "}
                      <span className="font-mono">{occurrence.utc_at.replace("T", " ").replace(".000Z", "Z")}</span> UTC
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  {previewError ?? "Loading the server's next three run times…"}
                  {previewError && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setPreviewRetry((value) => value + 1)}
                    >
                      Retry schedule preview
                    </Button>
                  )}
                </p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={busy || !name.trim() || !analysisId || analysis === null || analysisLoading || !previewCurrent}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {recipe ? "Save changes" : "Create brief"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
