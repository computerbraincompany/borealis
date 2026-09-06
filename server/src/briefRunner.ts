/**
 * Durable reviewed-brief execution (M16 stage 2).
 *
 * The runner is the single owned executor over the `brief_runs` stage machine:
 * claim (already durable in `briefRunStore`) → refresh → wait → analyze →
 * draft → `awaiting_review`, plus the step-8 notification rules.
 *
 * Honesty and recovery invariants:
 * - every stage transition is a short conditional CAS write carrying the
 *   current stage-attempt operation id; restart resumes the same run from its
 *   committed receipts (refresh receipts → source snapshot → baseline →
 *   analysis run id → comparison → draft references) and never creates a
 *   second result, draft, or notification;
 * - the analysis execution is keyed by an operation id derived from the run
 *   id, so M12 acceptance replays the original durable analysis run instead of
 *   double-executing;
 * - an interrupted draft whose references were never persisted cannot be
 *   proven complete: the run fails visibly and only a fresh explicit retry
 *   (a new run) may proceed;
 * - refresh/consent/busy prerequisites surface as visible skipped or blocked
 *   outcomes with a bounded content-free reason and never feed the
 *   five-consecutive-failure pause; only `failed` counts;
 * - the connector refresh path is the existing consent-gated `connector_sync`
 *   machinery over exact bound source ids; M14 inputs refresh through the
 *   shared `refreshAndWaitReady` service with the exact managed-item
 *   allowlist and the live expected connection revision; static inputs are
 *   labeled `uses imported version` in receipts and stay outside the
 *   published report chain like every draft;
 * - the analysis always runs against the run's own persisted generation
 *   snapshot through `runAnalysisService`'s expected-snapshot CAS — a
 *   superseded generation becomes a durable `stale-inputs`, never a silent
 *   switch to whatever is current;
 * - drafts carry labeled current/baseline previews with server-verified
 *   analysis provenance and truthful comparison/completeness labels inside
 *   M13's ceilings; the single narrative model call is consent-gated,
 *   audited, bounded, never reasons, and its output has citation-style
 *   markers stripped so the recipe can never manufacture citations;
 * - shutdown synchronously quiesces, interrupts in-flight waits through the
 *   execution signal, and drains: an interrupted run row stays in its
 *   committed stage for the next startup resume (cancellation requests
 *   finalize as `cancelled`, never silently);
 * - at most one brief executes per account and two globally; the tick claims
 *   due occurrences (batch ≤20) and dispatches detached executions so the
 *   interval never blocks existing scheduler work.
 */
import { createHash } from "node:crypto";

import {
  BRIEF_REFRESH_STAGE_DEADLINE_MS,
  BRIEF_REVIEW_DEADLINE_MS,
  BriefRunStateError,
  BRIEF_ACTIVE_STAGES,
  type BriefExecutionOutcome,
  type BriefRunStore,
  type BriefRunStage,
  type StoredBriefRun,
} from "./db/stores/briefRunStore.js";
import { BriefRecipeNotFoundError, type BriefRecipeStore, type BriefRefreshBinding } from "./db/stores/briefRecipeStore.js";
import type { SourceStore } from "./db/stores/sourceStore.js";
import { SourceStoreError } from "./db/stores/sourceStore.js";
import { SourceIngestionTransitionError } from "./db/stores/sourceIngestionTransitions.js";
import { AnalysisStore, AnalysisRevisionConflictError, type ExpectedSourceSnapshotEntry } from "./db/stores/analysisStore.js";
import type { StoredAnalysisResult, StoredAnalysisRun } from "./analysisTypes.js";
import { analysisSourceContentIdentity, TERMINAL_ANALYSIS_RUN_STATUSES } from "./analysisTypes.js";
import { compareAnalysisResults, type AnalysisComparison } from "./analysisCompare.js";
import {
  AnalysisServiceUnavailableError,
  runAnalysisService,
  type RunAnalysisServiceInput,
  type RunAnalysisServiceResult,
} from "./analysisRunner.js";
import { EmbeddingMigrationError } from "./embeddingMigration.js";
import { authorizeRemoteEgressOperation, RemoteEgressConsentRequiredError, type RemoteEgressTarget } from "./egressPolicy.js";
import { auditRemoteEgressTarget } from "./egressAudit.js";
import { syncConnector as syncConnectorRoute } from "./routes/connectors.js";
import { knowledgeRefreshService, type RefreshAndWaitReadyResult, type RefreshTarget } from "./knowledgeRefresh.js";
import type { KnowledgeStore } from "./db/stores/knowledgeStore.js";
import { storageRuntime } from "./storageRuntime.js";
import { createDocumentDraft } from "./documentService.js";
import {
  DOCUMENT_TABLE_CELL_MAX_CHARS,
  DOCUMENT_TABLE_COLUMNS_MAX,
  DOCUMENT_TABLE_ROWS_MAX,
  type DocumentTableAnalysis,
  type DocumentTreeInput,
} from "./documentTypes.js";
import { getRuntimeSettings } from "./runtimeSettings.js";
import { publicLlmModelId } from "./llmAliases.js";
import { streamingChat } from "./llm.js";
import type { ChatMessage } from "./llm.js";

const TICK_INTERVAL_MS = 60_000;
const CANCEL_POLL_INTERVAL_MS = 400;
const CLAIM_BATCH_LIMIT = 20;
const WAIT_POLL_INTERVAL_MS = 250;

export const BRIEF_MAX_CONCURRENT_GLOBAL = 2;
export const BRIEF_MAX_CONCURRENT_PER_ACCOUNT = 1;
export const BRIEF_NARRATIVE_MAX_CHARS = 1_600;
const BRIEF_NARRATIVE_MAX_OUTPUT_TOKENS = 400;
/** Total copied preview table cells across the draft (M16 preview bound; tighter than M13's per-table ceilings). */
export const BRIEF_PREVIEW_CELLS_MAX = 1_000;
const BRIEF_COMPARISON_SUMMARY_MAX_CHARS = 30_000;
const BRIEF_FAILURE_REASON_MAX = 500;
const BRIEF_COMPARISON_SAMPLES = 10;

export const BRIEF_STATIC_INPUT_LABEL = "uses imported version";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface BriefDraftRequest {
  readonly accountId: string;
  readonly title: string;
  readonly tree: DocumentTreeInput;
  readonly origin: { readonly runId: string; readonly analysisResultId: string | null };
}

export interface BriefNarrativeRequest {
  readonly accountId: string;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly signal: AbortSignal;
}

export interface BriefSourceState {
  readonly sourceStatus: "ready" | "index" | "error";
  readonly readyGeneration: number | null;
  readonly jobStatus: "preparing" | "pending" | "running" | "done" | "error" | null;
  readonly jobGeneration: number | null;
}

export interface BriefRunnerDependencies {
  readonly runs: BriefRunStore;
  readonly recipes: BriefRecipeStore;
  readonly sources: SourceStore;
  readonly analyses: AnalysisStore;
  readonly knowledge: KnowledgeStore;
  /** Consent-gated connector sync (the existing `connector_sync` executor seam). */
  readonly syncConnector?: (accountId: string, connectorId: string) => Promise<unknown>;
  /** Shared M14 refresh-and-wait service. */
  readonly refreshKnowledge?: (input: {
    readonly accountId: string;
    readonly connections: readonly RefreshTarget[];
    readonly signal: AbortSignal;
    readonly deadlineMs: number;
  }) => Promise<RefreshAndWaitReadyResult>;
  /** M12 execution service (the documented M16 hook with the expected-generation snapshot CAS). */
  readonly runAnalysis?: (input: RunAnalysisServiceInput) => Promise<RunAnalysisServiceResult>;
  /** Durable ingestion/source state probe for connector intended generations. */
  readonly sourceState?: (accountId: string, sourceId: string) => Promise<BriefSourceState | undefined>;
  /** Exactly one bounded narrative model call per run via the authorized runtime. */
  readonly generateNarrative?: (request: BriefNarrativeRequest) => Promise<string>;
  /** Chat model precedence: account default, else workspace default. */
  readonly resolveChatModel?: (accountId: string) => Promise<string>;
  /** Exact-target egress authorization (connector refresh + narrative gates). */
  readonly authorizeEgress?: (accountId: string) => Promise<RemoteEgressTarget>;
  readonly auditEgress?: (kind: "remote_ingest" | "remote_turn", accountId: string, target: RemoteEgressTarget) => void;
  readonly draft?: (request: BriefDraftRequest) => Promise<{ documentId: string; documentRevisionId: string }>;
  readonly tickIntervalMs?: number;
  readonly cancelPollIntervalMs?: number;
  readonly waitPollIntervalMs?: number;
  readonly claimBatchLimit?: number;
  readonly now?: () => Date;
  /**
   * Test-only crash seam: invoked synchronously after each named durable
   * commit boundary. Throwing here simulates a process crash with nothing
   * further persisted; the runner finalizes nothing and the row stays exactly
   * as committed for the next owner's restart resume. Never HTTP-exposed.
   */
  readonly debugCrashAt?: (boundary: BriefStageBoundary, run: StoredBriefRun) => void;
}

export type BriefStageBoundary =
  | "stage-refreshing"
  | "refresh-receipts"
  | "source-snapshot"
  | "stage-analyzing"
  | "baseline-selected"
  | "analysis-accepted"
  | "comparison-persisted"
  | "draft-references"
  | "outcome-accounted"
  | "awaiting-review";

// ---------------------------------------------------------------------------
// Internal control-flow errors (stable codes only; never content)
// ---------------------------------------------------------------------------

class SimulatedCrashSignal extends Error {
  constructor() {
    super("simulated process crash");
    this.name = "SimulatedCrashSignal";
  }
}

/** A terminal run decision with its bounded content-free visibility. */
class BriefTerminalDecision extends Error {
  constructor(
    readonly outcome: BriefExecutionOutcome | "cancelled",
    readonly failureCode: string | null,
    readonly failureReason: string | null
  ) {
    super(failureCode ?? "brief run terminated");
    this.name = "BriefTerminalDecision";
  }
}

function boundedReason(value: string): string {
  return value.slice(0, BRIEF_FAILURE_REASON_MAX);
}

/** Deterministic UUIDv4-shaped operation id derived from the durable run id. */
export function deriveBriefAnalysisOperationId(runId: string): string {
  const hex = createHash("sha256").update(`borealis-brief-analysis:${runId}`, "utf8").digest("hex");
  const digits = (start: number, length: number) => hex.slice(start, start + length);
  return `${digits(0, 8)}-${digits(8, 4)}-4${digits(13, 3)}-a${digits(17, 3)}-${digits(20, 12)}`.toLowerCase();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

// ---------------------------------------------------------------------------
// Bounded comparison summary (persisted ≤32 KiB; document carries the text)
// ---------------------------------------------------------------------------

interface BriefComparisonSummary {
  readonly kind: "compared";
  readonly baseline_run_id: string;
  readonly baseline_result_id: string;
  readonly current_result_id: string;
  readonly mode: AnalysisComparison["mode"];
  readonly key_columns: readonly string[];
  readonly reason_code: string | null;
  readonly reason_detail: string | null;
  readonly exhaustive: boolean;
  readonly added_total: number | null;
  readonly removed_total: number | null;
  readonly changed_total: number | null;
  readonly truncated: boolean;
  readonly changed_sample: ReadonlyArray<{
    readonly key: readonly (string | number | boolean | null)[];
    readonly changes: ReadonlyArray<{ readonly column: string; readonly delta: number | null }>;
  }>;
}

interface BriefComparisonUnavailable {
  readonly kind: "unavailable";
  readonly reason: "baseline-missing" | "baseline-result-deleted" | "current-result-deleted";
}

type BriefComparisonPayload = BriefComparisonSummary | BriefComparisonUnavailable;

function summarizeComparison(
  comparison: AnalysisComparison,
  baselineRunId: string
): BriefComparisonSummary {
  const summary: BriefComparisonSummary = {
    kind: "compared",
    baseline_run_id: baselineRunId,
    baseline_result_id: comparison.left_result_id,
    current_result_id: comparison.right_result_id,
    mode: comparison.mode,
    key_columns: comparison.key_columns,
    reason_code: comparison.reason_code,
    reason_detail: comparison.reason_detail,
    exhaustive: comparison.exhaustive,
    added_total: comparison.added_total ?? null,
    removed_total: comparison.removed_total ?? null,
    changed_total: comparison.changed_total ?? null,
    truncated: comparison.truncated === true,
    changed_sample: (comparison.changed ?? []).slice(0, BRIEF_COMPARISON_SAMPLES).map((change) => ({
      key: change.key,
      changes: change.changes.map((changeCell) => ({ column: changeCell.column, delta: changeCell.delta })),
    })),
  };
  if (JSON.stringify(summary).length > BRIEF_COMPARISON_SUMMARY_MAX_CHARS) {
    return { ...summary, changed_sample: [] };
  }
  return summary;
}

/** True only when the stored comparison deterministically proves row changes. */
function comparisonChangedSignal(summary: BriefComparisonPayload | null): boolean {
  if (!summary || summary.kind !== "compared") return false;
  if (summary.mode !== "keyed") return false;
  return (summary.changed_total ?? 0) > 0 || (summary.added_total ?? 0) > 0 || (summary.removed_total ?? 0) > 0;
}

/** Unsupported or incomplete comparisons are labeled, never proven no-change. */
function comparisonNeedsAttention(summary: BriefComparisonPayload | null): boolean {
  if (!summary) return false;
  if (summary.kind === "unavailable") return true;
  return summary.mode !== "keyed" || !summary.exhaustive || summary.truncated;
}

// ---------------------------------------------------------------------------
// Preview copying inside M13 ceilings
// ---------------------------------------------------------------------------

function clipCell(cell: string | number | boolean | null): string | number | boolean | null {
  if (typeof cell === "string" && cell.length > DOCUMENT_TABLE_CELL_MAX_CHARS) {
    return `${cell.slice(0, DOCUMENT_TABLE_CELL_MAX_CHARS - 1)}…`;
  }
  return cell;
}

interface BriefPreviewTable {
  readonly table: NonNullable<DocumentTreeInput["tables"]>[number];
  readonly notes: readonly string[];
  readonly cells: number;
}

/**
 * Copies one stored analysis result into a bounded labeled preview table with
 * its server-verified provenance envelope. Omitted rows/columns/values are
 * truthfully reported in `notes` — never silently dropped.
 */
export function buildBriefPreviewTable(
  result: StoredAnalysisResult,
  cellBudget: number,
  label: string
): BriefPreviewTable {
  const notes: string[] = [];
  let columns = result.columns.map((column) => column.name);
  const columnsOmitted = Math.max(0, columns.length - DOCUMENT_TABLE_COLUMNS_MAX);
  if (columnsOmitted > 0) {
    columns = columns.slice(0, DOCUMENT_TABLE_COLUMNS_MAX);
    notes.push(`${label}: ${columnsOmitted} additional column(s) omitted from this preview`);
  }
  const rowBudget = columns.length > 0 ? Math.floor(cellBudget / columns.length) : 0;
  const rowCap = Math.max(0, Math.min(DOCUMENT_TABLE_ROWS_MAX, rowBudget));
  let rows = result.rows.slice(0, rowCap);
  if (result.rows.length > rowCap) {
    notes.push(`${label}: preview shows first ${rows.length} of ${result.rows.length} stored rows (${columns.length} columns each)`);
  }
  const clipped = rows.map((row) => row.slice(0, columns.length).map((cell) => clipCell(cell)));
  if (!result.completeness.complete) {
    notes.push(
      `${label}: stored result is incomplete (${result.completeness.reasons.join(", ") || "incomplete"}); totals are not claimed`
    );
  }
  const analysis: DocumentTableAnalysis = {
    analysis_id: result.analysisId,
    analysis_revision: result.revision,
    result_id: result.id,
    parameters: result.parameterBindings.map((binding) => ({
      name: binding.name,
      type: binding.type,
      value: binding.value,
    })),
    source_generations: result.sourceProvenance.map((source) => ({
      source_id: source.sourceId,
      ready_generation: source.readyGeneration,
      content_identity: source.contentIdentity,
    })),
    columns: result.columns.slice(0, DOCUMENT_TABLE_COLUMNS_MAX).map((column) => ({ name: column.name, type: column.type })),
    completeness: { complete: result.completeness.complete, reasons: result.completeness.reasons },
    schema_fingerprint: result.schemaFingerprint,
  };
  return {
    table: { columns, rows: clipped, analysis },
    notes,
    cells: rows.length * Math.max(1, columns.length),
  };
}

// Strip citation-style markers: a recipe narrative may never mint citations.
export function stripBriefCitationMarkers(text: string): string {
  return text.replace(/\[\d{1,2}\]/g, "").slice(0, BRIEF_NARRATIVE_MAX_CHARS).trim();
}

// ---------------------------------------------------------------------------
// Production port defaults (module singletons; tests inject fakes)
// ---------------------------------------------------------------------------

const productionNarrative = async (request: BriefNarrativeRequest): Promise<string> => {
  // Ingestion-style consent recheck against the live exact target immediately
  // before the single bounded transport; a lost acknowledgment throws.
  const target = await authorizeRemoteEgressOperation(request.accountId);
  const completion = await streamingChat(
    [...request.messages],
    {
      accountId: request.accountId,
      model: request.model,
      maxTokens: BRIEF_NARRATIVE_MAX_OUTPUT_TOKENS,
      signal: request.signal,
    },
    () => undefined
  );
  void auditRemoteEgressTarget("remote_turn", request.accountId, target);
  return completion.choices[0]?.message?.content ?? "";
};

const productionResolveChatModel = async (accountId: string): Promise<string> => {
  try {
    const accountDefault = await storageRuntime().chats.getDefaultChatModel(accountId);
    if (accountDefault) return publicLlmModelId(accountDefault);
  } catch {
    // Missing account preference falls through to the workspace default.
  }
  const snapshot = await getRuntimeSettings();
  return publicLlmModelId(snapshot.settings.chatModel);
};

const productionDraft = async (
  request: BriefDraftRequest
): Promise<{ documentId: string; documentRevisionId: string }> => {
  const created = await createDocumentDraft({
    accountId: request.accountId,
    title: request.title,
    tree: request.tree,
    origin: { runId: request.origin.runId, analysisResultId: request.origin.analysisResultId },
  });
  return { documentId: created.document.id, documentRevisionId: created.revision.id };
};

const productionSourceState = async (accountId: string, sourceId: string): Promise<BriefSourceState | undefined> => {
  const state = await storageRuntime().knowledge.sourceIngestionState(accountId, sourceId);
  if (!state) return undefined;
  return {
    sourceStatus: state.sourceStatus,
    readyGeneration: state.readyGeneration,
    jobStatus: state.jobStatus,
    jobGeneration: state.jobGeneration,
  };
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface ActiveExecution {
  readonly runId: string;
  readonly accountId: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly settle: () => void;
  shutdownAborted: boolean;
  cancelObserved: boolean;
  deadlineObserved: boolean;
  pollTimer?: NodeJS.Timeout;
}

export function createBriefRunner(dependencies: BriefRunnerDependencies) {
  const runs = dependencies.runs;
  const recipes = dependencies.recipes;
  const sources = dependencies.sources;
  const analyses = dependencies.analyses;
  const knowledge = dependencies.knowledge;
  const syncConnector =
    dependencies.syncConnector ?? ((accountId, connectorId) => syncConnectorRoute(accountId, undefined, connectorId));
  const refreshKnowledge =
    dependencies.refreshKnowledge ??
    ((input) => knowledgeRefreshService().refreshAndWaitReady(input) as Promise<RefreshAndWaitReadyResult>);
  const runAnalysis = dependencies.runAnalysis ?? ((input) => runAnalysisService(input));
  const sourceState = dependencies.sourceState ?? productionSourceState;
  const generateNarrative = dependencies.generateNarrative ?? productionNarrative;
  const resolveChatModel = dependencies.resolveChatModel ?? productionResolveChatModel;
  const authorizeEgress = dependencies.authorizeEgress ?? ((accountId) => authorizeRemoteEgressOperation(accountId));
  const auditEgress =
    dependencies.auditEgress ??
    ((kind, accountId, target) => {
      void auditRemoteEgressTarget(kind, accountId, target);
    });
  const draft = dependencies.draft ?? productionDraft;
  const now = dependencies.now ?? (() => new Date());
  const tickIntervalMs = dependencies.tickIntervalMs ?? TICK_INTERVAL_MS;
  const cancelPollIntervalMs = dependencies.cancelPollIntervalMs ?? CANCEL_POLL_INTERVAL_MS;
  const waitPollIntervalMs = dependencies.waitPollIntervalMs ?? WAIT_POLL_INTERVAL_MS;
  const claimBatchLimit = dependencies.claimBatchLimit ?? CLAIM_BATCH_LIMIT;
  const debugCrashAt = dependencies.debugCrashAt;

  const active = new Map<string, ActiveExecution>();
  let quiescing = false;
  let timer: NodeJS.Timeout | undefined;
  let activeTick: { readonly done: Promise<void> } | undefined;
  let bootstrap: { readonly done: Promise<void> } | undefined;

  // The `armCrashAt` test seam names the boundary that must throw; the
  // optional `debugCrashAt` dependency is an observation hook only.
  let debugCrashBoundary: BriefStageBoundary | null = null;

  function crash(boundary: BriefStageBoundary, run: StoredBriefRun): void {
    if (debugCrashAt) debugCrashAt(boundary, run);
    if (debugCrashBoundary === boundary) throw new SimulatedCrashSignal();
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const timerHandle = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      timerHandle.unref?.();
      const onAbort = () => {
        clearTimeout(timerHandle);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function abortError(): Error {
    const error = new Error("operation cancelled");
    error.name = "AbortError";
    return error;
  }

  // -- Guarding -----------------------------------------------------------------

  /** Re-read the durable row and enforce cancellation/deadline at every boundary. */
  async function guard(execution: ActiveExecution, run: StoredBriefRun, phase: "refresh" | "total"): Promise<StoredBriefRun> {
    execution.controller.signal.throwIfAborted();
    const live = await runs.getRun(run.accountId, run.id);
    const nowMs = now().getTime();
    if (live.cancelRequested) {
      execution.cancelObserved = true;
      throw abortError();
    }
    if (Date.parse(live.deadlineAt) <= nowMs) {
      execution.deadlineObserved = true;
      throw abortError();
    }
    if (phase === "refresh" && live.refreshDeadlineAt !== null && Date.parse(live.refreshDeadlineAt) <= nowMs) {
      throw new BriefTerminalDecision("failed", "BRIEF_REFRESH_TIMEOUT", boundedReason("the input refresh stage exceeded its deadline"));
    }
    if (live.stage !== run.stage || live.stageOperationId !== run.stageOperationId) {
      // A newer attempt (or an out-of-process decision) owns the row; this
      // attempt must not write.
      throw new BriefRunStateError();
    }
    return live;
  }

  function remainingMs(deadlineAt: string | null): number {
    const total = Date.parse(deadlineAt ?? "") - now().getTime();
    return Math.max(1, Number.isFinite(total) ? total : 1);
  }

  // -- Stage helpers ------------------------------------------------------------

  async function beginStage(
    run: StoredBriefRun,
    toStage: BriefRunStage,
    expectedOp?: string | null
  ): Promise<StoredBriefRun> {
    const operationId = `brief-${toStage}-${randomOperationSuffix()}`;
    const updated = await runs.beginStage(run.accountId, run.id, {
      fromStage: run.stage,
      toStage,
      expectedStageOperationId: expectedOp ?? run.stageOperationId,
      stageOperationId: operationId,
    });
    return updated;
  }

  function randomOperationSuffix(): string {
    // A stable per-attempt operation identity; uniqueness matters only
    // against the run's own stage_operation_id CAS, not globally.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async function stageUpdate(
    run: StoredBriefRun,
    fields: Omit<Parameters<BriefRunStore["stageUpdate"]>[2], "stage" | "expectedStageOperationId">
  ): Promise<StoredBriefRun> {
    return runs.stageUpdate(run.accountId, run.id, {
      ...fields,
      stage: run.stage,
      expectedStageOperationId: run.stageOperationId,
    });
  }

  /** Durable terminal transition + outcome accounting + attention notification. */
  async function settleRun(
    run: StoredBriefRun,
    outcome: "failed" | "cancelled" | "skipped",
    failureCode: string | null,
    failureReason: string | null
  ): Promise<void> {
    try {
      await runs.finishRun(run.accountId, run.id, {
        fromStage: run.stage,
        outcome,
        expectedStageOperationId: run.stageOperationId,
        failureCode: outcome === "failed" ? (failureCode ?? "BRIEF_RUN_FAILED") : null,
        failureReason: outcome === "failed" ? boundedReason(failureReason ?? "the brief could not complete") : null,
      });
    } catch (error) {
      // A concurrent decision owns the row; never overwrite it.
      if (error instanceof BriefRunStateError) return;
      throw error;
    }
    const accounting: BriefExecutionOutcome = outcome === "failed" ? "failed" : "skipped";
    await runs.applyExecutionOutcome(run.accountId, run.id, accounting).catch(() => undefined);
    if (outcome === "failed") {
      await runs
        .recordNotification(
          run.accountId,
          run.id,
          "attention",
          boundedReason(`a brief run needs attention: ${failureCode ?? "BRIEF_RUN_FAILED"}`)
        )
        .catch(() => undefined);
    }
  }

  // -- Refresh stage ------------------------------------------------------------

  interface RefreshReceipt {
    readonly source_id: string;
    readonly kind: "connector" | "knowledge" | "static";
    readonly outcome: "promoted" | "unchanged" | "no-change";
    readonly generation: number;
    readonly label: string;
  }

  function classifyRefreshError(error: unknown): BriefTerminalDecision {
    if (error instanceof RemoteEgressConsentRequiredError) {
      return new BriefTerminalDecision("skipped", "BRIEF_EGRESS_CONSENT_REQUIRED", "remote egress consent is required");
    }
    if (error instanceof EmbeddingMigrationError && error.code === "SOURCE_MUTATION_BLOCKED") {
      return new BriefTerminalDecision(
        "skipped",
        "BRIEF_MIGRATION_BLOCKED",
        "source changes are paused during embedding migration"
      );
    }
    if (
      (error instanceof SourceIngestionTransitionError || error instanceof SourceStoreError) &&
      ["SOURCE_TRANSITION_CONNECTOR_SYNC_ACTIVE", "SOURCE_TRANSITION_SOURCE_IN_USE", "SOURCE_STORE_CONNECTOR_SYNC_ACTIVE", "SOURCE_STORE_SOURCE_IN_USE"].includes(
        error.code
      )
    ) {
      return new BriefTerminalDecision("blocked", "BRIEF_INPUT_BUSY", "a bound input was busy with another operation");
    }
    return new BriefTerminalDecision("failed", "BRIEF_REFRESH_FAILED", boundedReason("an input refresh could not complete"));
  }

  async function refreshPhase(execution: ActiveExecution, runValue: StoredBriefRun): Promise<readonly RefreshReceipt[]> {
    let run = runValue;
    const snapshot = run.recipeSnapshot;
    const receipts: RefreshReceipt[] = [];
    const records = await sources.getSourcesByIds(
      run.accountId,
      snapshot.source_ids
    );
    const byId = new Map(records.map((record) => [record.id, record]));
    let egressTarget: RemoteEgressTarget | null = null;

    // Static inputs: labeled "uses imported version", no refresh.
    const boundSourceIds = new Set(snapshot.refresh_bindings.map((binding) => binding.source_id));
    for (const sourceId of snapshot.source_ids) {
      run = await guard(execution, run, "refresh");
      if (boundSourceIds.has(sourceId)) continue;
      const record = byId.get(sourceId);
      if (!record || record.status !== "ready" || record.readyGeneration === null) {
        throw new BriefTerminalDecision(
          "failed",
          "BRIEF_INPUT_UNAVAILABLE",
          boundedReason("an input is missing or not ready")
        );
      }
      receipts.push({
        source_id: sourceId,
        kind: "static",
        outcome: "no-change",
        generation: record.readyGeneration,
        label: BRIEF_STATIC_INPUT_LABEL,
      });
    }

    // Connector inputs through the existing consent-gated connector_sync machinery.
    for (const binding of snapshot.refresh_bindings.filter((entry) => entry.kind === "connector")) {
      run = await guard(execution, run, "refresh");
      if (egressTarget === null) {
        egressTarget = await authorizeEgress(run.accountId);
        auditEgress("remote_ingest", run.accountId, egressTarget);
      }
      const record = byId.get(binding.source_id);
      if (!record || record.connectorId !== binding.connector_id) {
        throw new BriefTerminalDecision("failed", "BRIEF_INPUT_UNAVAILABLE", boundedReason("a bound connector input is missing"));
      }
      try {
        await syncConnector(run.accountId, binding.connector_id as string);
      } catch (error) {
        throw classifyRefreshError(error);
      }
      const state = await sourceState(run.accountId, binding.source_id);
      if (!state) {
        throw new BriefTerminalDecision("failed", "BRIEF_INPUT_UNAVAILABLE", boundedReason("a bound connector input vanished during refresh"));
      }
      if (state.jobStatus === "error") {
        throw new BriefTerminalDecision("failed", "BRIEF_REFRESH_FAILED", boundedReason("an input refresh failed"));
      }
      const intended = state.jobGeneration ?? state.readyGeneration;
      if (intended === null) {
        throw new BriefTerminalDecision("failed", "BRIEF_REFRESH_FAILED", boundedReason("the refreshed input generation is unknown"));
      }
      receipts.push({
        source_id: binding.source_id,
        kind: "connector",
        outcome: "promoted",
        generation: intended,
        label: "connector refresh",
      });
    }

    // Knowledge (M14 managed-folder) inputs via the shared refresh-and-wait
    // service with the exact managed-item allowlist and live connection revision.
    const knowledgeBindings = snapshot.refresh_bindings.filter((entry) => entry.kind === "knowledge");
    const byConnection = new Map<string, BriefRefreshBinding[]>();
    for (const binding of knowledgeBindings) {
      const list = byConnection.get(binding.connection_id as string) ?? [];
      list.push(binding);
      byConnection.set(binding.connection_id as string, list);
    }
    for (const [connectionId, bindings] of byConnection) {
      run = await guard(execution, run, "refresh");
      const connection = await knowledge.getConnection(run.accountId, connectionId);
      if (!connection) {
        throw new BriefTerminalDecision("failed", "BRIEF_INPUT_UNAVAILABLE", boundedReason("a bound knowledge connection is missing"));
      }
      const items = await listKnowledgeItems(run.accountId, connectionId);
      const managed = items.filter((item) => item.lifecycle !== "removed");
      const targetSources = new Set(bindings.map((binding) => binding.source_id));
      const allow = managed.filter((item) => targetSources.has(item.source_id));
      if (allow.length !== targetSources.size) {
        throw new BriefTerminalDecision("failed", "BRIEF_INPUT_UNAVAILABLE", boundedReason("a bound managed input is missing from its connection"));
      }
      let result: RefreshAndWaitReadyResult;
      try {
        result = await refreshKnowledge({
          accountId: run.accountId,
          connections: [
            {
              connection_id: connectionId,
              expected_connection_revision: connection.revision,
              item_ids: allow.map((item) => item.id),
            },
          ],
          signal: execution.controller.signal,
          deadlineMs: remainingMs(run.refreshDeadlineAt),
        });
      } catch (error) {
        throw classifyRefreshError(error);
      }
      const refresh = result.refreshes[0];
      const itemsBySource = new Map((refresh?.items ?? []).map((item) => [item.source_id, item]));
      for (const binding of bindings) {
        const item = itemsBySource.get(binding.source_id);
        if (!item || refresh.status === "rejected") {
          throw new BriefTerminalDecision(
            "failed",
            refresh?.error_code ?? "BRIEF_REFRESH_FAILED",
            boundedReason("a bound knowledge input refresh did not complete")
          );
        }
        if (item.outcome === "promoted" && item.generation !== null) {
          receipts.push({
            source_id: binding.source_id,
            kind: "knowledge",
            outcome: "promoted",
            generation: item.generation,
            label: "managed folder refresh",
          });
        } else if (item.outcome === "unchanged") {
          receipts.push({
            source_id: binding.source_id,
            kind: "knowledge",
            outcome: "unchanged",
            generation: item.generation as number,
            label: "verified unchanged",
          });
        } else if (item.outcome === "blocked") {
          throw new BriefTerminalDecision("blocked", "BRIEF_INPUT_BUSY", boundedReason("a bound knowledge input is in an active run"));
        } else if (item.outcome === "cancelled") {
          throw abortError();
        } else {
          throw new BriefTerminalDecision(
            "failed",
            item.error_code ?? "BRIEF_REFRESH_FAILED",
            boundedReason("a bound knowledge input refresh failed")
          );
        }
      }
    }

    // Receipts must cover every bound source exactly once each.
    const covered = new Set(receipts.map((receipt) => receipt.source_id));
    if (snapshot.source_ids.some((sourceId) => !covered.has(sourceId))) {
      throw new BriefTerminalDecision("failed", "BRIEF_REFRESH_FAILED", boundedReason("an input produced no refresh receipt"));
    }
    return receipts;
  }

  async function listKnowledgeItems(
    accountId: string,
    connectionId: string
  ): Promise<readonly { id: string; source_id: string; lifecycle: string }[]> {
    const items: Array<{ id: string; source_id: string; lifecycle: string }> = [];
    let after = null as { timestamp: string; id: string } | null;
    for (let guard = 0; guard < 4; guard += 1) {
      const page = await knowledge.listItems(accountId, connectionId, { limit: 500, after });
      items.push(...page.items.map((item) => ({ id: item.id, source_id: item.source_id, lifecycle: item.lifecycle })));
      if (!page.next) return items;
      after = page.next;
    }
    throw new BriefTerminalDecision("failed", "BRIEF_REFRESH_FAILED", boundedReason("the managed-item catalog exceeded its budget"));
  }

  // -- Wait stage ---------------------------------------------------------------

  async function waitPhase(execution: ActiveExecution, runValue: StoredBriefRun): Promise<readonly ExpectedSourceSnapshotEntry[]> {
    let run = runValue;
    const receipts = run.refreshReceipts as readonly RefreshReceipt[];
    for (;;) {
      run = await guard(execution, run, "refresh");
      const records = await sources.getSourcesByIds(
        run.accountId,
        receipts.map((receipt) => receipt.source_id)
      );
      const byId = new Map(records.map((record) => [record.id, record]));
      let allReady = true;
      const snapshot: ExpectedSourceSnapshotEntry[] = [];
      for (const receipt of receipts) {
        const record = byId.get(receipt.source_id);
        if (!record) {
          throw new BriefTerminalDecision("failed", "BRIEF_INPUT_UNAVAILABLE", boundedReason("a refreshed input vanished before analysis"));
        }
        if (record.status === "error") {
          throw new BriefTerminalDecision("failed", "BRIEF_REFRESH_FAILED", boundedReason("a refreshed input failed ingestion"));
        }
        const ready = record.readyGeneration;
        if (ready === null || ready < receipt.generation) {
          allReady = false;
          continue;
        }
        if (ready > receipt.generation) {
          // Superseded while waiting: honest stale-inputs, never a silent
          // switch to whatever became current.
          throw new BriefTerminalDecision(
            "failed",
            "BRIEF_STALE_INPUTS",
            boundedReason("a required input generation was superseded before the run snapshot")
          );
        }
        snapshot.push({
          sourceId: record.id,
          readyGeneration: ready,
          contentIdentity: analysisSourceContentIdentity({
            readyGeneration: ready,
            sizeBytes: record.sizeBytes,
            filePath: record.filePath,
          }),
        });
      }
      if (allReady) return snapshot.sort((left, right) => (left.sourceId < right.sourceId ? -1 : 1));
      await sleep(waitPollIntervalMs, execution.controller.signal);
    }
  }

  // -- Analyze stage ------------------------------------------------------------

  async function analyzePhase(execution: ActiveExecution, runValue: StoredBriefRun): Promise<StoredBriefRun> {
    let run = await guard(execution, runValue, "total");
    if (run.sourceSnapshot === null || run.refreshReceipts.length < 1) {
      throw new BriefRunStateError("analysis requires a committed source-generation snapshot");
    }
    const snapshotEntries = decodeSnapshotEntries(run.sourceSnapshot);

    // Baseline is selected and persisted BEFORE execution (M16 rule 5).
    if (run.analysisRunId === null) {
      const baseline = await runs.selectBaselineRun(run.accountId, run.recipeId, run.id, {
        analysisId: run.recipeSnapshot.analysis_id,
        analysisRevision: run.recipeSnapshot.analysis_revision,
        parameterValues: run.recipeSnapshot.parameter_values,
        sourceIds: run.recipeSnapshot.source_ids,
      });
      run = await stageUpdate(run, { baselineRunId: baseline?.id ?? null });
      crash("baseline-selected", run);
    }

    if (run.analysisRunId === null) {
      const values: Record<string, unknown> = {};
      for (const binding of run.recipeSnapshot.parameter_values) values[binding.name] = binding.value;
      let accepted: RunAnalysisServiceResult;
      try {
        accepted = await runAnalysis({
          accountId: run.accountId,
          analysisId: run.recipeSnapshot.analysis_id,
          values,
          operationId: deriveBriefAnalysisOperationId(run.id),
          expectedRevision: run.recipeSnapshot.analysis_revision,
          expectedSourceSnapshot: snapshotEntries,
          signal: execution.controller.signal,
          waitForCompletion: true,
        });
      } catch (error) {
        if (error instanceof AnalysisRevisionConflictError) {
          throw new BriefTerminalDecision(
            "failed",
            "BRIEF_ANALYSIS_REVISION_CONFLICT",
            boundedReason("the bound saved analysis definition changed; the recipe needs an explicit update")
          );
        }
        if (error instanceof AnalysisServiceUnavailableError) {
          throw new BriefTerminalDecision("failed", "BRIEF_ANALYSIS_UNAVAILABLE", boundedReason("the analysis executor is unavailable"));
        }
        throw error;
      }
      if (accepted.outcome === "stale-inputs") {
        throw new BriefTerminalDecision(
          "failed",
          "BRIEF_STALE_INPUTS",
          boundedReason("the run's input generations were superseded at analysis admission")
        );
      }
      const settled = await settleAnalysisRun(execution, run, accepted.run);
      const succeeded = settled.status === "succeeded";
      run = await stageUpdate(run, { analysisRunId: settled.id, analysisSucceeded: succeeded });
      crash("analysis-accepted", run);
      if (settled.status === "stale-inputs") {
        throw new BriefTerminalDecision("failed", "BRIEF_STALE_INPUTS", boundedReason("the saved analysis inputs were stale"));
      }
      if (settled.status === "cancelled") {
        throw abortError();
      }
      if (!succeeded) {
        throw new BriefTerminalDecision("failed", "BRIEF_ANALYSIS_FAILED", boundedReason("the saved analysis could not complete"));
      }
    }
    return run;
  }

  async function settleAnalysisRun(
    execution: ActiveExecution,
    run: StoredBriefRun,
    initial: StoredAnalysisRun
  ): Promise<StoredAnalysisRun> {
    let current = initial;
    for (;;) {
      if ((TERMINAL_ANALYSIS_RUN_STATUSES as readonly string[]).includes(current.status)) return current;
      await guard(execution, run, "total");
      await sleep(waitPollIntervalMs, execution.controller.signal);
      const live = await analyses.getAnalysisRun(run.accountId, run.recipeSnapshot.analysis_id, current.id);
      if (!live) {
        throw new BriefTerminalDecision("failed", "BRIEF_ANALYSIS_FAILED", boundedReason("the analysis run disappeared"));
      }
      current = live;
    }
  }

  async function fetchResultForRun(
    accountId: string,
    analysisId: string,
    runId: string
  ): Promise<StoredAnalysisResult | undefined> {
    let after = null as { timestamp: string; id: string } | null;
    for (let pageGuard = 0; pageGuard < 8; pageGuard += 1) {
      const page = await analyses.listAnalysisResults(accountId, analysisId, { limit: 50, after });
      const summary = page.items.find((item) => item.runId === runId);
      if (summary) return analyses.getAnalysisResult(accountId, analysisId, summary.id);
      if (!page.next) return undefined;
      after = page.next;
    }
    return undefined;
  }

  // -- Draft stage ---------------------------------------------------------------

  function freshnessSection(run: StoredBriefRun): string {
    const receipts = run.refreshReceipts as readonly RefreshReceipt[];
    const lines = receipts.map(
      (receipt) =>
        `- source ${receipt.source_id.slice(0, 8)}… · generation ${receipt.generation} · ${
          receipt.kind === "static" ? `static input — ${BRIEF_STATIC_INPUT_LABEL}` : receipt.label
        }${receipt.kind === "knowledge" && receipt.outcome === "unchanged" ? " (no change; ready generation retained)" : ""}`
    );
    const missed = run.coalescedCount > 1 ? ` · coalesced occurrences: ${run.coalescedCount}` : "";
    return lines.join("\n") + `\n\nSnapshot committed through the recipe's own refresh receipts${missed}.`;
  }

  function comparisonSection(summary: BriefComparisonPayload | null): string {
    if (summary === null) {
      return "First run of this comparison series — no baseline exists yet. Later runs compare against this result when its inputs change.";
    }
    if (summary.kind === "unavailable") {
      return "Comparison unavailable: the baseline result could not be read from the retained analysis ledger. This is a labeled gap, not a no-change claim.";
    }
    if (summary.mode !== "keyed") {
      const detail = summary.reason_detail ? ` (${summary.reason_detail})` : "";
      return `Comparison unsupported${detail}: the two stored results are shown side by side. An unsupported comparison is labeled and must never be read as proof of no change.`;
    }
    const totals = summary.exhaustive
      ? `${summary.added_total ?? 0} added, ${summary.removed_total ?? 0} removed, ${summary.changed_total ?? 0} changed`
      : `totals not claimed (stored results incomplete: ${summary.exhaustive ? "complete" : "incomplete"})`;
    const truncated = summary.truncated ? " Change lists are truncated; totals above bound the preview only." : "";
    const incomplete = summary.exhaustive ? "" : " This comparison is incomplete and is labeled as such.";
    const samples = summary.changed_sample
      .map((change) => `- ${JSON.stringify(change.key)}: ${change.changes.map((c) => `${c.column} Δ ${c.delta ?? "n/a"}`).join(", ")}`)
      .join("\n");
    return [
      `Keyed comparison against the previous successful run in this series (key: ${summary.key_columns.join(", ")}).`,
      `Rows: ${totals}.${truncated}${incomplete}`,
      samples ? `Sample changes:\n${samples}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  function provenanceSection(run: StoredBriefRun): string {
    const snap = run.recipeSnapshot;
    const params = snap.parameter_values.map((binding) => `${binding.name}=${JSON.stringify(binding.value)}`).join(", ");
    return [
      `Recipe revision ${snap.revision} (${snap.name}) · ${run.trigger} occurrence ${run.occurrenceKey}`,
      `Saved analysis ${snap.analysis_id} at definition revision ${snap.analysis_revision}`,
      `Parameter values: ${params || "none"}`,
      `Analysis run ${run.analysisRunId ?? "pending"} · baseline ${run.baselineRunId ?? "none (first run of this series)"}`,
    ].join("\n");
  }

  async function draftPhase(execution: ActiveExecution, runValue: StoredBriefRun): Promise<void> {
    let run = await guard(execution, runValue, "total");

    // Recovery: the draft and its references are already durable — the only
    // missing piece is the review CAS itself (at-most-one draft).
    if (run.documentId !== null && run.documentRevisionId !== null) {
      await accountSuccess(execution, run);
      run = await runs.markAwaitingReview(run.accountId, run.id, {
        expectedStageOperationId: run.stageOperationId,
        documentId: run.documentId,
        documentRevisionId: run.documentRevisionId,
      });
      crash("awaiting-review", run);
      return;
    }
    // The draft references are the commit point for this stage. An
    // interrupted draft whose references never persisted cannot be proven
    // complete: fail visibly; only a fresh explicit retry may proceed.
    if (run.analysisRunId === null || !run.analysisSucceeded) {
      throw new BriefRunStateError("drafting requires a committed successful analysis run");
    }

    const analysisId = run.recipeSnapshot.analysis_id;
    const currentResult = await fetchResultForRun(run.accountId, analysisId, run.analysisRunId);
    if (!currentResult) {
      throw new BriefTerminalDecision("failed", "BRIEF_ANALYSIS_FAILED", boundedReason("the completed analysis result is no longer retained"));
    }

    // Comparison over stored values only, with completeness/truncation flags.
    let summary = run.comparisonSummary as BriefComparisonPayload | null;
    if (summary === null) {
      if (run.baselineRunId === null) {
        summary = null;
      } else {
        const baseline = await runs.getRun(run.accountId, run.baselineRunId).catch(() => undefined);
        const baselineResult = baseline?.analysisRunId
          ? await fetchResultForRun(run.accountId, analysisId, baseline.analysisRunId)
          : undefined;
        if (baseline && baselineResult) {
          const analysis = await analyses.getAnalysis(run.accountId, analysisId);
          const comparisonKey = analysis?.revision.comparisonKey ?? null;
          const comparison = compareAnalysisResults(baselineResult, currentResult, comparisonKey);
          summary = summarizeComparison(comparison, baseline.id);
        } else {
          summary = { kind: "unavailable", reason: baseline ? "baseline-result-deleted" : "baseline-missing" };
        }
      }
      run = await stageUpdate(run, { comparisonSummary: summary });
      crash("comparison-persisted", run);
    }

    // One bounded narrative model call via the authorized runtime. The model
    // sees only labeled, already-stored values; it cannot widen scope.
    const model = await resolveChatModel(run.accountId);
    const digest = [
      `Brief report title: ${run.recipeSnapshot.report_title}`,
      `Instruction: ${run.recipeSnapshot.report_instruction}`,
      comparisonSection(summary),
      `Current preview first rows: ${renderPreviewDigest(currentResult)}`,
      await baselineDigestFor(run, analysisId),
    ].join("\n\n");
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are drafting a short, neutral executive summary for a recurring reviewed brief's review inbox. " +
          "Use only the numbers and labels provided. Never add citation markers or bracketed references, " +
          "never speculate beyond the given values, and do not expose internal reasoning.",
      },
      { role: "user", content: digest.slice(0, 30_000) },
    ];
    let narrative = "";
    try {
      narrative = stripBriefCitationMarkers(await generateNarrative({ accountId: run.accountId, model, messages, signal: execution.controller.signal }));
    } catch (error) {
      if (error instanceof RemoteEgressConsentRequiredError) {
        throw new BriefTerminalDecision("skipped", "BRIEF_EGRESS_CONSENT_REQUIRED", "remote egress consent is required");
      }
      if (isAbortError(error)) throw error;
      throw new BriefTerminalDecision("failed", "BRIEF_NARRATIVE_FAILED", boundedReason("the draft narrative could not be generated"));
    }

    // Build the draft tree inside M13 ceilings: labeled previews with
    // verified provenance, honest comparison/freshness labels, no citations.
    const currentPreview = buildBriefPreviewTable(currentResult, BRIEF_PREVIEW_CELLS_MAX, "Current result");
    const baseline = run.baselineRunId ? await runs.getRun(run.accountId, run.baselineRunId).catch(() => undefined) : undefined;
    const baselineResult = baseline?.analysisRunId
      ? await fetchResultForRun(run.accountId, analysisId, baseline.analysisRunId)
      : undefined;
    const baselinePreview = baselineResult
      ? buildBriefPreviewTable(baselineResult, Math.max(0, BRIEF_PREVIEW_CELLS_MAX - currentPreview.cells), "Baseline result")
      : null;

    const notes = [...currentPreview.notes, ...(baselinePreview?.notes ?? [])];
    const tree: DocumentTreeInput = {
      title: run.recipeSnapshot.report_title.slice(0, 200),
      subtitle:
        `Reviewed brief · ${run.recipeSnapshot.name} · recipe revision ${run.recipeSnapshot.revision} · ` +
        `${run.trigger} run for ${run.occurrenceKey}`.slice(0, 500),
      verified: true,
      sections: [
        {
          heading: "Summary",
          markdown: narrative || "(no narrative was generated for this run)",
        },
        { heading: "What changed", markdown: comparisonSection(summary) },
        {
          heading: "Baseline",
          markdown:
            run.baselineRunId === null
              ? "First run of this comparison series: no earlier successful compatible run exists. This run becomes the series baseline if it succeeds."
              : `Compared against run ${run.baselineRunId} (same recipe, same definition revision, parameters, and source set; differing refreshed generations are the intended comparison).`,
        },
        { heading: "Input freshness", markdown: freshnessSection(run) },
        { heading: "Provenance", markdown: provenanceSection(run) },
        ...(notes.length > 0 ? [{ heading: "Preview bounds", markdown: notes.map((note) => `- ${note}`).join("\n") }] : []),
      ],
      charts: [],
      tables: [currentPreview.table, ...(baselinePreview ? [baselinePreview.table] : [])],
      evidence: [],
    };

    let created;
    try {
      created = await draft({
        accountId: run.accountId,
        title: tree.title,
        tree,
        origin: { runId: run.id, analysisResultId: currentResult.id },
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new BriefTerminalDecision("failed", "BRIEF_DRAFT_REJECTED", boundedReason("the draft exceeded the report workbench bounds"));
    }
    run = await stageUpdate(run, { documentId: created.documentId, documentRevisionId: created.documentRevisionId });
    crash("draft-references", run);

    await accountSuccess(execution, run);
    run = await runs.markAwaitingReview(run.accountId, run.id, {
      expectedStageOperationId: run.stageOperationId,
      documentId: created.documentId,
      documentRevisionId: created.documentRevisionId,
    });
    crash("awaiting-review", run);
  }

  async function baselineDigestFor(run: StoredBriefRun, analysisId: string): Promise<string> {
    if (run.baselineRunId === null) return "Baseline: none — first run of this comparison series.";
    const baseline = await runs.getRun(run.accountId, run.baselineRunId).catch(() => undefined);
    const result = baseline?.analysisRunId ? await fetchResultForRun(run.accountId, analysisId, baseline.analysisRunId) : undefined;
    if (!result) return "Baseline: unavailable from the retained ledger (labeled gap, not a no-change claim).";
    return `Baseline preview first rows: ${renderPreviewDigest(result)}`;
  }

  function renderPreviewDigest(result: StoredAnalysisResult): string {
    const header = result.columns.map((column) => column.name).join(" | ");
    const rows = result.rows
      .slice(0, 5)
      .map((row) => row.map((cell) => (typeof cell === "string" ? clipCell(cell) : cell)).join(" | "));
    return [header, ...rows].join("\n");
  }

  /** Execution success accounting + step-8 notifications (deduplicated per run+kind). */
  async function accountSuccess(execution: ActiveExecution, run: StoredBriefRun): Promise<void> {
    await guard(execution, run, "total").catch((error) => {
      if (error instanceof BriefRunStateError) return;
      throw error;
    });
    await runs.applyExecutionOutcome(run.accountId, run.id, "succeeded");
    const summary = run.comparisonSummary as BriefComparisonPayload | null;
    if (run.baselineRunId === null) {
      await runs.recordNotification(run.accountId, run.id, "first_draft", "a first draft for this recipe is ready for review");
    } else if (comparisonNeedsAttention(summary)) {
      await runs.recordNotification(
        run.accountId,
        run.id,
        "attention",
        "a brief draft's comparison is unsupported or incomplete and is labeled, not a proven no-change"
      );
    } else if (comparisonChangedSignal(summary)) {
      await runs.recordNotification(run.accountId, run.id, "meaningful_change", "the newest brief results changed since the previous series baseline");
    }
    // A complete, supported no-change draft produces no repeated notification.
    crash("outcome-accounted", run);
  }

  // -- Execution ------------------------------------------------------------------

  async function pipeline(execution: ActiveExecution, initial: StoredBriefRun): Promise<void> {
    let run = initial;

    // A deleted/paused-away recipe stops scheduling; an already-claimed run
    // keeps its durable history either way.
    if (initial.stage === "queued" || initial.stage === "refreshing") {
      const recipe = await recipes.getRecipe(initial.accountId, initial.recipeId).catch(() => undefined);
      if (!recipe) {
        await settleRun(run, "cancelled", null, null);
        return;
      }
    }

    if (run.stage === "queued") {
      run = await beginStage(run, "refreshing");
      crash("stage-refreshing", run);
    }

    if (run.stage === "refreshing") {
      const receipts = await refreshPhase(execution, run);
      run = await stageUpdate(run, { refreshReceipts: receipts });
      crash("refresh-receipts", run);
      run = await beginStage(run, "waiting_ready");
    }

    if (run.stage === "waiting_ready") {
      if (run.sourceSnapshot === null) {
        if (run.refreshReceipts.length < 1) {
          const receipts = await refreshPhase(execution, run);
          run = await stageUpdate(run, { refreshReceipts: receipts });
          crash("refresh-receipts", run);
        }
        const snapshot = await waitPhase(execution, run);
        run = await stageUpdate(run, { sourceSnapshot: snapshot });
        crash("source-snapshot", run);
      }
      run = await beginStage(run, "analyzing");
      crash("stage-analyzing", run);
    }

    if (run.stage === "analyzing") {
      run = await analyzePhase(execution, run);
      run = await beginStage(run, "drafting");
    }

    if (run.stage === "drafting") {
      await draftPhase(execution, run);
      return;
    }

    // Terminal or under review: nothing for this executor to do (restart-safe).
    if (!(BRIEF_ACTIVE_STAGES as readonly string[]).includes(run.stage)) return;
    throw new BriefRunStateError(`brief stage ${run.stage} is not executable by this pipeline`);
  }

  async function finalizeError(execution: ActiveExecution, initial: StoredBriefRun, error: unknown): Promise<void> {
    if (error instanceof SimulatedCrashSignal) return; // The row stays exactly as committed.
    const live = await runs.getRun(initial.accountId, initial.id).catch(() => undefined);
    if (!live || !(BRIEF_ACTIVE_STAGES as readonly string[]).includes(live.stage)) return;

    if (error instanceof BriefTerminalDecision) {
      if (error.outcome === "cancelled") {
        await settleRun(live, "cancelled", null, null);
        return;
      }
      if (error.outcome === "failed") {
        await settleRun(live, "failed", error.failureCode, error.failureReason);
        return;
      }
      await settleRun(live, "skipped", error.failureCode, null);
      return;
    }
    if (error instanceof RemoteEgressConsentRequiredError) {
      await settleRun(live, "skipped", "BRIEF_EGRESS_CONSENT_REQUIRED", null);
      return;
    }
    if (isAbortError(error)) {
      if (execution.cancelObserved) {
        await settleRun(live, "cancelled", null, null);
        return;
      }
      if (execution.shutdownAborted && !execution.deadlineObserved) {
        // Shutdown interrupt: leave the committed stage durable for the next
        // startup resume — never a silent failure of work that can resume.
        return;
      }
      await settleRun(live, "failed", "BRIEF_DEADLINE_EXCEEDED", boundedReason("the brief exceeded its execution deadline"));
      return;
    }
    if (error instanceof BriefRunStateError || error instanceof BriefRecipeNotFoundError) return; // Ownership moved elsewhere.
    await settleRun(live, "failed", "BRIEF_RUN_FAILED", boundedReason("the brief could not complete"));
  }

  function registerCancelObserver(execution: ActiveExecution): void {
    execution.pollTimer = setInterval(() => {
      void runs
        .getRun(execution.accountId, execution.runId)
        .then((live) => {
          if (!(BRIEF_ACTIVE_STAGES as readonly string[]).includes(live.stage)) {
            if (!execution.controller.signal.aborted) execution.controller.abort();
            return;
          }
          if (live.cancelRequested) {
            execution.cancelObserved = true;
            if (!execution.controller.signal.aborted) execution.controller.abort();
            return;
          }
          if (Date.parse(live.deadlineAt) <= now().getTime()) {
            execution.deadlineObserved = true;
            if (!execution.controller.signal.aborted) execution.controller.abort();
          }
        })
        .catch(() => {
          // Transient store failure; the next poll or the terminal path settles.
        });
    }, cancelPollIntervalMs);
    execution.pollTimer.unref();
  }

  function accountActive(accountId: string): number {
    let count = 0;
    for (const execution of active.values()) if (execution.accountId === accountId) count += 1;
    return count;
  }

  async function executeRun(initial: StoredBriefRun): Promise<void> {
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const execution: ActiveExecution = {
      runId: initial.id,
      accountId: initial.accountId,
      controller: new AbortController(),
      done,
      settle,
      shutdownAborted: false,
      cancelObserved: false,
      deadlineObserved: false,
    };
    active.set(initial.id, execution);
    registerCancelObserver(execution);
    try {
      await pipeline(execution, initial);
    } catch (error) {
      await finalizeError(execution, initial, error).catch(() => undefined);
    } finally {
      if (execution.pollTimer) clearInterval(execution.pollTimer);
      if (active.get(initial.id) === execution) active.delete(initial.id);
      execution.settle();
    }
  }

  // -- Claim/dispatch loop -----------------------------------------------------

  async function dispatch(): Promise<void> {
    if (quiescing) return;
    let candidates: readonly StoredBriefRun[];
    try {
      candidates = await runs.recoverActiveRuns(claimBatchLimit);
    } catch {
      return;
    }
    for (const run of candidates) {
      if (quiescing) return;
      if (active.has(run.id)) continue;
      if (active.size >= BRIEF_MAX_CONCURRENT_GLOBAL) break;
      if (accountActive(run.accountId) >= BRIEF_MAX_CONCURRENT_PER_ACCOUNT) continue;
      void executeRun(run).catch(() => undefined);
    }
  }

  async function tickWork(): Promise<void> {
    try {
      await runs.claimDueRuns();
    } catch {
      // Claim failures are durable; the next tick retries.
    }
    await dispatch().catch(() => undefined);
  }

  function tick(): Promise<void> {
    if (quiescing) return Promise.resolve();
    if (activeTick) return activeTick.done;
    const handle: { done: Promise<void> } = { done: Promise.resolve() };
    activeTick = handle;
    handle.done = tickWork().finally(() => {
      if (activeTick === handle) activeTick = undefined;
    });
    return handle.done;
  }

  function start(): void {
    if (quiescing) return;
    if (bootstrap) return;
    const handle: { done: Promise<void> } = { done: Promise.resolve() };
    bootstrap = handle;
    handle.done = (async () => {
      await tickWork().catch(() => undefined);
      if (bootstrap === handle) bootstrap = undefined;
    })();
    void handle.done.catch(() => undefined);
    if (timer === undefined && !quiescing) {
      timer = setInterval(() => void tick(), tickIntervalMs);
      timer.unref();
    }
  }

  /**
   * Synchronous quiescence: the interval is cleared and active waits are
   * interrupted before the first await. The promise settles only after every
   * execution has either finalized its durable row (cancelled when requested)
   * or left it in its committed stage for the next startup resume.
   */
  function stop(): Promise<void> {
    quiescing = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    for (const execution of active.values()) {
      execution.shutdownAborted = true;
      if (!execution.controller.signal.aborted) execution.controller.abort();
    }
    const drains = [...active.values()].map((execution) => execution.done);
    const tickDrain = activeTick?.done ?? Promise.resolve();
    const bootstrapDrain = bootstrap?.done ?? Promise.resolve();
    return Promise.allSettled([tickDrain, bootstrapDrain, ...drains]).then(() => undefined);
  }

  /** Immediate one-shot dispatch pass (manual "Run now" wake; no-op when stopped). */
  function kick(): void {
    if (quiescing) return;
    void dispatch().catch(() => undefined);
  }

  /** Test seam: crash at the named boundary after its commit (never production). */
  function armCrashAt(boundary: BriefStageBoundary | null): void {
    debugCrashBoundary = boundary;
  }

  return {
    start,
    stop,
    tick,
    kick,
    armCrashAt,
    isRunning: () => !quiescing && (timer !== undefined || bootstrap !== undefined || active.size > 0),
    activeRunCount: () => active.size,
  };
}

export type BriefRunner = ReturnType<typeof createBriefRunner>;

/**
 * Composition-owned default runner, bound by `applicationRuntime` exactly like
 * the analysis/rewrite executors; `routes/briefs.ts` wakes it after a manual
 * durable acceptance.
 */
let defaultRunner: BriefRunner | undefined;

export function bindDefaultBriefRunner(runner: BriefRunner | undefined): void {
  defaultRunner = runner;
}

export function defaultBriefRunner(): BriefRunner | undefined {
  return defaultRunner;
}

function decodeSnapshotEntries(value: readonly unknown[]): readonly ExpectedSourceSnapshotEntry[] {
  return value.map((entry) => {
    const record = (typeof value === "object" && entry ? entry : {}) as Record<string, unknown>;
    return {
      sourceId: String(record.source_id ?? record.sourceId ?? ""),
      readyGeneration: Number(record.ready_generation ?? record.readyGeneration ?? 0),
      contentIdentity:
        record.content_identity === undefined || record.content_identity === null
          ? null
          : String(record.content_identity),
    };
  });
}

// Deadline constants are re-exported for docs/tests referencing the runner.
export const BRIEF_TOTAL_DEADLINE_MS = BRIEF_REVIEW_DEADLINE_MS;
export const BRIEF_REFRESH_BUDGET_MS = BRIEF_REFRESH_STAGE_DEADLINE_MS;
