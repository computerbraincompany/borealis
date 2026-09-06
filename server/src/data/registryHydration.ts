/**
 * Bounded honest-ready signal for the startup rehydration of the DuckDB
 * dataset registry.
 *
 * After a backend restart the ledger already knows which tabular sources are
 * `ready`, but the DuckDB dataset registry inside the dataset worker starts
 * empty and is rebuilt asynchronously by `restoreDatasets()` behind the
 * server's ready line. Work admitted in that window — saved-analysis
 * execution and the chat `query_data` tool — would pin against an empty
 * registry and finalize a durable `stale-inputs` even though the inputs
 * exist: the user-visible wrong outcome reported by the journey-B E2E.
 * Admission surfaces await this signal so they either observe the hydrated
 * registry or, after a bounded wait, proceed with the existing honest
 * `stale-inputs` semantics — never a silent widening. `/api/health` folds the
 * same signal into its `data_service` operational prerequisite so the
 * readiness line is truthful during the window and self-healing afterwards.
 *
 * The state belongs to the single owned composition: the application-runtime
 * ownership lease and the workspace lock already forbid an overlap.
 * `beginDatasetRegistryRehydration` is idempotent while a window is open, and
 * `finishDatasetRegistryRehydration` is honest failed-open — a failed,
 * rejected, or never-completing restore still becomes ready, because the only
 * dishonest state is a restoration genuinely still in flight.
 */

/**
 * Fixed admission bound: an in-flight restoration may delay registry-dependent
 * execution by at most this long before callers proceed with current honest
 * semantics. Config-fixed and deliberately not environment-tunable.
 */
export const DATASET_REGISTRY_HYDRATION_WAIT_MS = 15_000;

export type DatasetRegistryHydrationOutcome = "ready" | "timeout";

interface PendingHydration {
  readonly promise: Promise<void>;
  readonly settle: () => void;
}

let pending: PendingHydration | undefined;

function abortError(): Error {
  const error = new Error("operation cancelled");
  error.name = "AbortError";
  return error;
}

/** Opens (or joins an already-open) rehydration window for this composition. */
export function beginDatasetRegistryRehydration(): void {
  if (pending) return;
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  pending = { promise, settle };
}

/**
 * Idempotently closes the current window and resolves every waiter. Honest
 * failed-open: completion, failure, and a never-scheduled restore all land on
 * ready, because post-window admission then evaluates genuinely absent inputs
 * with the existing stale-inputs semantics instead of pretending.
 */
export function finishDatasetRegistryRehydration(): void {
  const target = pending;
  if (!target) return;
  pending = undefined;
  target.settle();
}

/** Synchronous observation for the health surface: is a restoration in flight? */
export function datasetRegistryRehydrationPending(): boolean {
  return pending !== undefined;
}

/**
 * Awaits the in-flight rehydration window for at most `deadlineMs`. Returns
 * `"ready"` when no window is open or the window settles before the deadline,
 * and `"timeout"` when the deadline elapses first — that is the honest
 * stale-inputs path, never a failure or silent widening. Rejects with
 * `AbortError` only when the caller signal aborts, mirroring the data-service
 * RPC cancellation contract. Never holds a lock across the await.
 */
export function waitForDatasetRegistryHydration(
  deadlineMs: number = DATASET_REGISTRY_HYDRATION_WAIT_MS,
  signal?: AbortSignal
): Promise<DatasetRegistryHydrationOutcome> {
  const target = pending;
  if (!target) return Promise.resolve("ready");
  if (signal?.aborted) return Promise.reject(abortError());
  if (!(deadlineMs > 0)) return Promise.resolve("timeout");
  return new Promise<DatasetRegistryHydrationOutcome>((resolve, reject) => {
    let settled = false;
    // `finish` is only ever invoked from the callbacks and the deferred
    // resolution below, all of which run after the executor has returned, so
    // the later `onAbort`/`timer` bindings are initialized by then.
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const timer = setTimeout(() => finish(() => resolve("timeout")), deadlineMs);
    timer.unref();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    void target.promise.then(() => finish(() => resolve("ready")));
  });
}
