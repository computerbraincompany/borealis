/**
 * Durable saved-analysis execution (M12 stage 2).
 *
 * The runner is the single executor over `analysis_runs`:
 * - startup resume recovers interrupted dispatched runs through the store's
 *   durable contract (running → failed with a retry code, cancelling →
 *   cancelled) and then claims undispatched `queued` runs; it never republishes
 *   or reruns interrupted work automatically;
 * - execution re-verifies readiness and the frozen generation/content identity
 *   snapshot at the admission/lease boundary and runs the frozen SQL through
 *   `dataService.queryAnalysis` — typed positional binding plus exact-location
 *   leases in the DuckDB worker, so a concurrent connector refresh can neither
 *   substitute bytes nor delete files the run is using;
 * - any drift fails the durable run as `stale-inputs` — never a silent rerun
 *   against latest;
 * - exactly one result transaction per success, enforced under the stage-1
 *   persisted ceilings BEFORE persistence, with truthful truncation flags;
 * - cancellation is the DELETE-side durable flag observed at safe points: the
 *   statement is interrupted through the caller signal and the store's
 *   cancellation-wins rule finalizes the run;
 * - shutdown quiesces synchronously, interrupts active statements, and drains
 *   so no run row is orphaned (running → failed / cancelling → cancelled).
 */
import { randomUUID } from "node:crypto";

import {
  ANALYSIS_RESULT_CELLS_MAX,
  ANALYSIS_RESULT_COLUMNS_MAX,
  ANALYSIS_RESULT_PAYLOAD_MAX_BYTES,
  ANALYSIS_RESULT_ROWS_MAX,
  ANALYSIS_RESULT_STRING_CELL_MAX_CHARS,
  analysisSourceContentIdentity,
  AnalysisValidationError,
  TERMINAL_ANALYSIS_RUN_STATUSES,
  type AnalysisResultInput,
  type StoredAnalysisRun,
} from "./analysisTypes.js";
import { dataService, DataServiceError } from "./dataService.js";
import type { DatasetQueryResult } from "./data/datasets.js";
import { DATASET_REGISTRY_HYDRATION_WAIT_MS, waitForDatasetRegistryHydration } from "./data/registryHydration.js";
import {
  AnalysisNotFoundError,
  AnalysisQuotaError,
  AnalysisRunNotFoundError,
  AnalysisRunStateError,
  AnalysisStore,
  type ExpectedSourceSnapshotEntry,
} from "./db/stores/analysisStore.js";
import type { SourceRecord, SourceStore } from "./db/stores/sourceStore.js";

const CANCEL_POLL_INTERVAL_MS = 400;
const CLAIM_INTERVAL_MS = 30_000;
const CLAIM_BATCH_LIMIT = 50;

export interface AnalysisRunnerDependencies {
  readonly store: AnalysisStore;
  readonly sources: SourceStore;
  readonly cancelPollIntervalMs?: number;
  readonly claimIntervalMs?: number;
  readonly claimBatchLimit?: number;
  /**
   * Bound on the startup registry-rehydration honesty wait. Production uses
   * the config-fixed ceiling; composition tests may shorten it to drive the
   * deadline-exceeded path. Never an environment value.
   */
  readonly registryHydrationDeadlineMs?: number;
}

export interface RunAnalysisServiceInput {
  readonly accountId: string;
  readonly analysisId: string;
  /** Typed values keyed by declared parameter name; resolved positionally by the store. */
  readonly values?: Readonly<Record<string, unknown>>;
  /** Client operation UUID; a retried acceptance replays the original run. */
  readonly operationId?: string | null;
  /** Optimistic guard against a concurrent definition edit. */
  readonly expectedRevision?: number | null;
  /**
   * Optional generation/content snapshot CAS compared at this admission
   * boundary (M16 supplies the snapshot from its completed refresh phase).
   * Any mismatch records a durable `stale-inputs` run — never a silent latest.
   */
  readonly expectedSourceSnapshot?: readonly ExpectedSourceSnapshotEntry[] | null;
  readonly schemaFingerprint?: string | null;
  /** Caller signal; aborting requests durable cancellation of the accepted run. */
  readonly signal?: AbortSignal;
  /** Await the local executor settlement instead of returning at acceptance (202) semantics. */
  readonly waitForCompletion?: boolean;
}

export interface RunAnalysisServiceResult {
  readonly run: StoredAnalysisRun;
  readonly outcome: "queued" | "replayed" | "stale-inputs";
}

class StaleInputsSignal extends Error {
  constructor() {
    super("saved analysis inputs are stale");
    this.name = "StaleInputsSignal";
  }
}

/** The owning analysis/run vanished mid-execution; nothing may be finalized. */
class RunOwnershipLost extends Error {
  constructor() {
    super("analysis run ownership lost");
    this.name = "RunOwnershipLost";
  }
}

class BoundedExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string
  ) {
    super(code);
    this.name = "BoundedExecutionError";
  }
}

/** Query statuses that mean the pinned/accepted inputs could not be coherently acquired. */
const STALE_QUERY_STATUSES = new Set([404, 409]);

/**
 * Clips the worker result down to the persisted-result ceilings — 64 columns,
 * 500 rows, 20,000 cells, 2,000 characters per string cell, and 1 MiB UTF-8
 * serialized payload, whichever binds first — and preserves explicit
 * truncation information truthfully. The worker's own bounded-completeness
 * flags are merged; the worker's `row_count` is a returned-row count, never a
 * claimed exact total, so `sourceRowTotal` stays null.
 */
export function boundResultForPersistence(result: DatasetQueryResult): AnalysisResultInput {
  const reasons = new Set<string>();
  let truncated = result.truncated === true || result.columns_truncated === true;
  if (result.columns_truncated) reasons.add("columns-truncated");

  let columns = [...result.columns];
  if (columns.length > ANALYSIS_RESULT_COLUMNS_MAX) {
    columns = columns.slice(0, ANALYSIS_RESULT_COLUMNS_MAX);
    reasons.add("columns-truncated");
    truncated = true;
  }

  let rows = result.rows.map((row) => [...row]);
  if (rows.length > ANALYSIS_RESULT_ROWS_MAX) {
    rows = rows.slice(0, ANALYSIS_RESULT_ROWS_MAX);
    reasons.add("rows-truncated");
    truncated = true;
  }
  const cellRowCap = columns.length > 0 ? Math.floor(ANALYSIS_RESULT_CELLS_MAX / columns.length) : 0;
  if (rows.length > cellRowCap) {
    rows = rows.slice(0, cellRowCap);
    reasons.add("cells-truncated");
    truncated = true;
  }

  let valuesTruncated = false;
  rows = rows.map((row) =>
    row.map((cell) => {
      if (typeof cell === "string" && cell.length > ANALYSIS_RESULT_STRING_CELL_MAX_CHARS) {
        valuesTruncated = true;
        return `${cell.slice(0, ANALYSIS_RESULT_STRING_CELL_MAX_CHARS - 1)}…`;
      }
      return cell;
    })
  );
  if (valuesTruncated) {
    reasons.add("values-truncated");
    truncated = true;
  }

  let payloadTruncated = false;
  while (rows.length > 0 && Buffer.byteLength(JSON.stringify(rows), "utf8") > ANALYSIS_RESULT_PAYLOAD_MAX_BYTES) {
    rows.pop();
    payloadTruncated = true;
  }
  if (payloadTruncated) {
    reasons.add("payload-truncated");
    truncated = true;
  }

  return {
    columns,
    rows,
    sourceRowTotal: null,
    truncated,
    reasons: [...reasons],
  };
}

interface ActiveExecution {
  readonly runId: string;
  readonly accountId: string;
  readonly analysisId: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly settle: () => void;
  shutdownAborted: boolean;
  cancelObserved: boolean;
  cancelTimer?: NodeJS.Timeout;
}

function isTerminalStatus(status: string): boolean {
  return (TERMINAL_ANALYSIS_RUN_STATUSES as readonly string[]).includes(status);
}

function abortError(): Error {
  const error = new Error("operation cancelled");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function classifyQueryError(error: unknown): unknown {
  if (error instanceof DataServiceError) {
    if (STALE_QUERY_STATUSES.has(error.status)) return new StaleInputsSignal();
    if (error.status === 504) {
      return new BoundedExecutionError("ANALYSIS_QUERY_TIMEOUT", "the saved analysis query exceeded its deadline");
    }
    if (error.status === 400 || error.status === 413 || error.status === 422) {
      return new BoundedExecutionError("ANALYSIS_QUERY_REJECTED", "the saved analysis query was rejected");
    }
    return new BoundedExecutionError("ANALYSIS_QUERY_FAILED", "the saved analysis query could not complete");
  }
  return error;
}

export function createAnalysisRunner(dependencies: AnalysisRunnerDependencies) {
  const store = dependencies.store;
  const sources = dependencies.sources;
  const cancelPollIntervalMs = dependencies.cancelPollIntervalMs ?? CANCEL_POLL_INTERVAL_MS;
  const claimIntervalMs = dependencies.claimIntervalMs ?? CLAIM_INTERVAL_MS;
  const claimBatchLimit = dependencies.claimBatchLimit ?? CLAIM_BATCH_LIMIT;
  const registryHydrationDeadlineMs = dependencies.registryHydrationDeadlineMs ?? DATASET_REGISTRY_HYDRATION_WAIT_MS;

  const active = new Map<string, ActiveExecution>();
  let quiescing = false;
  let claimTimer: NodeJS.Timeout | undefined;
  let activeBootstrap: { readonly done: Promise<void> } | undefined;

  // -- Execution --------------------------------------------------------------

  function registerCancelObserver(execution: ActiveExecution): void {
    execution.cancelTimer = setInterval(() => {
      void store
        .getAnalysisRunCancelState(execution.accountId, execution.analysisId, execution.runId)
        .then((state) => {
          if (state === null || isTerminalStatus(state.status) || state.cancelRequested) {
            if (state?.cancelRequested) execution.cancelObserved = true;
            if (!execution.controller.signal.aborted) execution.controller.abort();
          }
        })
        .catch(() => {
          // Transient store failure; the next poll or the terminal path settles.
        });
    }, cancelPollIntervalMs);
    execution.cancelTimer.unref();
  }

  async function loadVerifiedSourceScope(run: StoredAnalysisRun): Promise<{
    allowedTables: string[];
    pinnedInputs: Array<{ name: string; location: string }>;
  }> {
    const ids = run.sources.map((source) => source.sourceId);
    const records = ids.length > 0 ? await sources.getSourcesByIds(run.accountId, ids) : [];
    const byId = new Map<string, SourceRecord>(records.map((record) => [record.id, record]));
    const allowedTables: string[] = [];
    const pinnedInputs: Array<{ name: string; location: string }> = [];
    for (const frozen of run.sources) {
      const record = byId.get(frozen.sourceId);
      if (!record || record.kind !== "tabular" || record.status !== "ready" || record.readyGeneration === null) {
        throw new StaleInputsSignal();
      }
      if (record.readyGeneration !== frozen.readyGeneration) throw new StaleInputsSignal();
      const identity = analysisSourceContentIdentity({
        readyGeneration: record.readyGeneration,
        sizeBytes: record.sizeBytes,
        filePath: record.filePath,
      });
      if (identity !== frozen.contentIdentity) throw new StaleInputsSignal();
      if (typeof record.filePath !== "string" || record.filePath.length < 1) throw new StaleInputsSignal();
      allowedTables.push(record.name);
      pinnedInputs.push({ name: record.name, location: record.filePath });
    }
    return { allowedTables, pinnedInputs };
  }

  async function runPipeline(execution: ActiveExecution, run: StoredAnalysisRun): Promise<void> {
    if (run.sources.length > 0) {
      // Startup-window honesty (journey-B defect): after a restart the ledger
      // already reports ready tabular sources while the DuckDB dataset
      // registry is still being rebuilt behind the server's ready line. Await
      // that rehydration — bounded — BEFORE evaluating readiness and the
      // frozen identity snapshot, so a run accepted inside the window executes
      // against its real pinned inputs instead of finalizing a false durable
      // `stale-inputs`. Deadline exceedance proceeds with the existing honest
      // stale-inputs semantics; nothing widens. This await sits between store
      // calls and holds no SQLite transaction; cancellation/shutdown aborts of
      // the execution interrupt the wait through the normal abort path.
      await waitForDatasetRegistryHydration(registryHydrationDeadlineMs, execution.controller.signal);
    }
    const sql = await store.getAnalysisRevisionSql(run.accountId, run.analysisId, run.revision);
    if (sql === null) throw new RunOwnershipLost();
    const scope = await loadVerifiedSourceScope(run);
    const parameters = run.parameterBindings.map((binding) => ({
      type: binding.type,
      value: binding.value,
    }));
    const result = await dataService
      .queryAnalysis(
        run.accountId,
        sql,
        scope.allowedTables,
        parameters,
        scope.pinnedInputs,
        execution.controller.signal
      )
      .catch((error: unknown) => {
        throw classifyQueryError(error);
      });
    const bounded = boundResultForPersistence(result);
    try {
      await store.publishAnalysisRunResult(run.accountId, run.analysisId, run.id, {
        id: randomUUID(),
        ...bounded,
      });
    } catch (error) {
      if (error instanceof AnalysisQuotaError) {
        throw new BoundedExecutionError(
          "ANALYSIS_RESULT_QUOTA_EXCEEDED",
          "the analysis reached its retained result limit"
        );
      }
      if (error instanceof AnalysisValidationError) {
        throw new BoundedExecutionError(
          "ANALYSIS_RESULT_REJECTED",
          "the query produced values that cannot be persisted"
        );
      }
      if (error instanceof AnalysisRunNotFoundError || error instanceof AnalysisNotFoundError) {
        throw new RunOwnershipLost();
      }
      throw error;
    }
  }

  async function finalizeFailure(execution: ActiveExecution, error: unknown): Promise<void> {
    const { accountId, analysisId, runId } = execution;
    try {
      if (error instanceof RunOwnershipLost) return;
      if (error instanceof StaleInputsSignal) {
        await store.markAnalysisRunStaleInputs(accountId, analysisId, runId);
        return;
      }
      if (isAbortError(error) || execution.shutdownAborted) {
        // The store's cancellation-wins rule finalizes a cancelling run as
        // cancelled; a plain interrupted run becomes failed with a retry code.
        await store.finishAnalysisRun(accountId, analysisId, runId, "failed", "SERVER_RESTARTED");
        return;
      }
      if (error instanceof BoundedExecutionError) {
        await store.finishAnalysisRun(accountId, analysisId, runId, "failed", error.code, error.reason);
        return;
      }
      if (error instanceof AnalysisRunStateError) return;
      await store.finishAnalysisRun(accountId, analysisId, runId, "failed", "ANALYSIS_EXECUTION_FAILED");
    } catch {
      // The durable row is owned by its next recovery/repair path.
    }
  }

  async function executeClaimed(run: StoredAnalysisRun): Promise<void> {
    if (quiescing || active.has(run.analysisId)) return;
    // The slot is reserved synchronously so a concurrent claim loop or a
    // service dispatch can never enter the same run twice across an await.
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const execution: ActiveExecution = {
      runId: run.id,
      accountId: run.accountId,
      analysisId: run.analysisId,
      controller: new AbortController(),
      done,
      settle,
      shutdownAborted: false,
      cancelObserved: false,
    };
    active.set(run.analysisId, execution);
    registerCancelObserver(execution);
    try {
      let live: StoredAnalysisRun;
      try {
        live = await store.markAnalysisRunRunning(run.accountId, run.analysisId, run.id);
      } catch (error) {
        if (
          error instanceof AnalysisRunStateError ||
          error instanceof AnalysisRunNotFoundError ||
          error instanceof AnalysisNotFoundError ||
          isAbortError(error)
        ) {
          return;
        }
        return;
      }
      if (live.status !== "running") return; // A durable cancellation request won.
      try {
        await runPipeline(execution, live);
      } catch (error) {
        await finalizeFailure(execution, error);
      }
    } finally {
      if (execution.cancelTimer) clearInterval(execution.cancelTimer);
      if (active.get(run.analysisId) === execution) active.delete(run.analysisId);
      execution.settle();
    }
  }

  // -- Durable claim loop -------------------------------------------------------

  async function claimQueued(): Promise<void> {
    if (quiescing) return;
    let claims: readonly StoredAnalysisRun[];
    try {
      claims = await store.listQueuedAnalysisRuns(claimBatchLimit);
    } catch {
      return;
    }
    for (const claim of claims) {
      if (quiescing) return; // The durable queued row survives for the next resume.
      if (active.has(claim.analysisId)) continue;
      await executeClaimed(claim);
    }
  }

  /**
   * Startup/registration resume: interrupted dispatched runs become durable
   * terminal records (failed with a retry code; cancelling → cancelled) via
   * the store's recovery — never republished, never rerun — and then undispatched
   * `queued` runs are claimed once and executed.
   */
  function start(): void {
    if (quiescing) return;
    if (activeBootstrap) return;
    const handle: { done: Promise<void> } = { done: Promise.resolve() };
    activeBootstrap = handle;
    handle.done = (async () => {
      try {
        await store.recoverInterruptedAnalysisRuns();
      } catch {
        // Repair is durable; a later start retries.
      }
      await claimQueued().catch(() => undefined);
      if (activeBootstrap === handle) activeBootstrap = undefined;
    })();
    void handle.done.catch(() => undefined);
    if (claimTimer === undefined && !quiescing) {
      claimTimer = setInterval(() => void claimQueued().catch(() => undefined), claimIntervalMs);
      claimTimer.unref();
    }
  }

  /**
   * Synchronous quiescence: no claim loop continues and active statements are
   * interrupted before the first await. The returned promise settles only
   * after every bootstrap/claim/execution has finalized its durable row — a
   * shutdown-interrupted run becomes failed (or cancelled when cancellation
   * was requested), never an orphaned `running`.
   */
  function stop(): Promise<void> {
    quiescing = true;
    if (claimTimer) clearInterval(claimTimer);
    claimTimer = undefined;
    for (const execution of active.values()) {
      execution.shutdownAborted = true;
      if (!execution.controller.signal.aborted) execution.controller.abort();
    }
    const drains = [...active.values()].map((execution) => execution.done);
    const bootstrap = activeBootstrap?.done ?? Promise.resolve();
    return Promise.allSettled([bootstrap, ...drains]).then(() => undefined);
  }

  // -- Internal service surface (M13/M16 compose this) --------------------------

  async function runAnalysisService(input: RunAnalysisServiceInput): Promise<RunAnalysisServiceResult> {
    if (input.signal?.aborted) throw abortError();
    const accepted = await store.acceptAnalysisRun(input.accountId, input.analysisId, {
      operationId: input.operationId ?? null,
      expectedRevision: input.expectedRevision ?? null,
      values: input.values,
      expectedSourceSnapshot: input.expectedSourceSnapshot ?? null,
      schemaFingerprint: input.schemaFingerprint ?? null,
    });
    if (accepted.outcome !== "queued") return accepted;

    let dispatched: Promise<void> = Promise.resolve();
    if (!quiescing && !active.has(accepted.run.analysisId)) {
      dispatched = executeClaimed(accepted.run).catch(() => undefined);
    }
    if (input.signal) {
      const onAbort = () => {
        void store
          .requestAnalysisRunCancel(accepted.run.accountId, accepted.run.analysisId, accepted.run.id)
          .catch(() => undefined);
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      dispatched = dispatched.finally(() => input.signal?.removeEventListener("abort", onAbort));
    }
    if (input.waitForCompletion) await dispatched;
    return accepted;
  }

  return {
    start,
    stop,
    runAnalysisService,
    isRunning: () => !quiescing && (claimTimer !== undefined || activeBootstrap !== undefined || active.size > 0),
    activeRunCount: () => active.size,
  };
}

export type AnalysisRunner = ReturnType<typeof createAnalysisRunner>;

/**
 * The composition-owned default runner. `applicationRuntime` binds the single
 * owned executor at startup and clears it when its ownership is released;
 * `runAnalysisService` (M13/M16 and later routes) composes through it. The
 * runner's durable store makes a missing executor harmless: accepted `queued`
 * runs survive and are claimed by the next startup resume.
 */
let defaultRunner: AnalysisRunner | undefined;

export class AnalysisServiceUnavailableError extends Error {
  readonly code = "ANALYSIS_SERVICE_UNAVAILABLE";

  constructor() {
    super("the analysis execution service is not registered");
    this.name = "AnalysisServiceUnavailableError";
  }
}

export function bindDefaultAnalysisRunner(runner: AnalysisRunner | undefined): void {
  defaultRunner = runner;
}

export function defaultAnalysisRunner(): AnalysisRunner | undefined {
  return defaultRunner;
}

/**
 * Server-internal execution service (M12 stage 2). Accepts the owner, analysis
 * id, typed parameter values, an optional expected source-generation/content
 * snapshot CAS, and a caller signal; dispatches through the registered runner
 * when one is live. The durable run row is the contract — acceptance is
 * operation-idempotent, quota fails before execution, and every unavailable or
 * drifted input surface becomes an explicit durable `stale-inputs` outcome.
 */
export async function runAnalysisService(input: RunAnalysisServiceInput): Promise<RunAnalysisServiceResult> {
  const runner = defaultRunner;
  if (!runner) throw new AnalysisServiceUnavailableError();
  return runner.runAnalysisService(input);
}
