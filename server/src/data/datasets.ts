import { Worker } from "node:worker_threads";

import { DataServiceError } from "./errors.js";

export type DatasetFormat = "csv" | "json";
export type DatasetKind = "path" | "url";
export type DatasetCell = null | boolean | number | string | DatasetCell[] | { [key: string]: DatasetCell };

export interface DatasetColumn {
  name: string;
  type: string;
}

export interface DatasetMetadata {
  name: string;
  location: string;
  safe_location: string;
  original_name: string;
  rows: number;
  columns: DatasetColumn[];
  preview: DatasetCell[][];
  preview_truncated: boolean;
  size_bytes: number;
  file_signature: string;
  kind?: DatasetKind;
  url?: string | null;
  format?: DatasetFormat | null;
  previous_location?: string | null;
}

export interface DatasetQueryResult {
  columns: string[];
  rows: DatasetCell[][];
  row_count: number;
  returned_row_count: number;
  columns_truncated: boolean;
  truncated: boolean;
}

export interface DatasetExtractResult extends DatasetQueryResult {
  total_row_count: number;
}

export interface DatasetCatalogResult {
  datasets: Array<{
    table: string;
    original_name: string;
    rows: number;
    columns: DatasetColumn[];
  }>;
  total: number;
  returned: number;
  omitted: number;
  truncated: boolean;
}

export interface DatasetListItem {
  table: string;
  original_name: string;
  rows: number;
  exists: boolean;
  location?: string;
  kind?: DatasetKind;
  format?: DatasetFormat | null;
}

export interface DatasetDescription {
  table: string;
  rows: number;
  profiled_rows: number;
  columns_truncated: boolean;
  truncated: boolean;
  columns: Array<{
    name: string;
    type: string;
    min?: DatasetCell;
    max?: DatasetCell;
    avg?: DatasetCell;
    distinct?: number;
    top_values?: Array<{ value: DatasetCell; count: number }>;
  }>;
}

type WorkerOperation =
  | "health"
  | "register"
  | "inspect"
  | "currentLocation"
  | "beginPreparation"
  | "endPreparation"
  | "activatePrepared"
  | "beginInactiveLocationCleanup"
  | "endInactiveLocationCleanup"
  | "query"
  | "describe"
  | "extract"
  | "extractCandidate"
  | "list"
  | "summaries"
  | "catalog"
  | "drop"
  | "deactivateIfLocation"
  | "debugState"
  | "configureForTests"
  | "shutdown";

interface WorkerRequest {
  type: "request";
  id: number;
  operation: WorkerOperation;
  payload: unknown;
}

interface WorkerCancel {
  type: "cancel";
  id: number;
}

interface WorkerResponse {
  type: "response";
  id: number;
  result?: unknown;
  error?: { status: number };
}

interface PendingRequest {
  operation: WorkerOperation;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();
let shuttingDown = false;

function abortError(): Error {
  const error = new Error("operation cancelled");
  error.name = "AbortError";
  return error;
}

function settlePending(id: number): PendingRequest | undefined {
  const request = pending.get(id);
  if (!request) return undefined;
  pending.delete(id);
  if (request.signal && request.onAbort) request.signal.removeEventListener("abort", request.onAbort);
  if (pending.size === 0) worker?.unref();
  return request;
}

function rejectAllPending(status: number): void {
  for (const [id, request] of pending) {
    settlePending(id)?.reject(new DataServiceError(status, request.operation));
  }
}

function workerUrl(): URL {
  return new URL(import.meta.url.endsWith(".ts") ? "./datasetsWorker.ts" : "./datasetsWorker.js", import.meta.url);
}

function getWorker(): Worker {
  if (worker) return worker;
  const url = workerUrl();
  const created = new Worker(url, {
    // Source execution (tsx/vitest) needs a loader. Compiled production JS does
    // not, and deliberately has no runtime dependency on tsx.
    execArgv: url.pathname.endsWith(".ts") ? ["--import", "tsx"] : [],
  });
  created.unref();
  worker = created;
  shuttingDown = false;

  created.on("message", (message: WorkerResponse) => {
    if (!message || message.type !== "response" || !Number.isSafeInteger(message.id)) return;
    const request = settlePending(message.id);
    if (!request) return;
    if (message.error) request.reject(new DataServiceError(message.error.status, request.operation));
    else request.resolve(message.result);
  });
  created.on("error", () => {
    if (worker !== created) return;
    worker = undefined;
    rejectAllPending(503);
  });
  created.on("exit", (code) => {
    if (worker !== created) return;
    worker = undefined;
    if (!shuttingDown && code !== 0) rejectAllPending(503);
    else if (pending.size) rejectAllPending(503);
  });
  return created;
}

function rpc<T>(operation: WorkerOperation, payload: unknown, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  const target = getWorker();
  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    const request: PendingRequest = {
      operation,
      resolve: resolve as (value: unknown) => void,
      reject,
      signal,
    };
    if (signal) {
      request.onAbort = () => {
        const active = settlePending(id);
        if (!active) return;
        target.postMessage({ type: "cancel", id } satisfies WorkerCancel);
        active.reject(abortError());
      };
      signal.addEventListener("abort", request.onAbort, { once: true });
    }
    pending.set(id, request);
    target.ref();
    target.postMessage({ type: "request", id, operation, payload } satisfies WorkerRequest);
  });
}

async function beginReservation(
  beginOperation: "beginPreparation" | "beginInactiveLocationCleanup",
  endOperation: "endPreparation" | "endInactiveLocationCleanup",
  payload: { accountId: string; name: string; location: string },
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw abortError();

  try {
    // Reservation acquisition is intentionally allowed to reach a definitive
    // worker response. If cancellation wins while this short RPC is in flight,
    // release exactly the count acquired by this request before surfacing the
    // normal AbortError. Ordinary cancellable RPC semantics would discard a
    // late success and leave an unowned reservation in the worker forever.
    await rpc<void>(beginOperation, payload);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  }

  if (!signal?.aborted) return;
  try {
    await rpc<void>(endOperation, payload);
  } catch {
    // A failed worker has already discarded its in-memory reservations. The
    // caller-facing cancellation contract remains AbortError either way.
  }
  throw abortError();
}

export function datasetHealth(signal?: AbortSignal): Promise<boolean> {
  return rpc("health", {}, signal);
}

export function registerDataset(
  input: {
    accountId: string;
    name: string;
    location: string;
    kind: DatasetKind;
    originalName: string;
    url?: string | null;
    expectedFormat?: DatasetFormat | null;
  },
  signal?: AbortSignal
): Promise<DatasetMetadata> {
  return rpc("register", input, signal);
}

export function inspectDataset(
  input: {
    name: string;
    location: string;
    originalName: string;
    expectedFormat?: DatasetFormat | null;
  },
  signal?: AbortSignal
): Promise<DatasetMetadata> {
  return rpc("inspect", input, signal);
}

export function currentDatasetLocation(accountId: string, name: string, signal?: AbortSignal): Promise<string | null> {
  return rpc("currentLocation", { accountId, name }, signal);
}

export function beginDatasetPreparation(
  accountId: string,
  name: string,
  location: string,
  signal?: AbortSignal
): Promise<void> {
  return beginReservation("beginPreparation", "endPreparation", { accountId, name, location }, signal);
}

export function endDatasetPreparation(
  accountId: string,
  name: string,
  location: string,
  signal?: AbortSignal
): Promise<void> {
  return rpc("endPreparation", { accountId, name, location }, signal);
}

export function activatePreparedDataset(
  input: {
    accountId: string;
    name: string;
    location: string;
    originalName: string;
    url: string;
    expectedFormat: DatasetFormat;
    expectedPreviousLocation: string | null;
  },
  signal?: AbortSignal
): Promise<DatasetMetadata> {
  return rpc("activatePrepared", input, signal);
}

export function beginInactiveLocationCleanup(
  accountId: string,
  name: string,
  location: string,
  signal?: AbortSignal
): Promise<void> {
  return beginReservation(
    "beginInactiveLocationCleanup",
    "endInactiveLocationCleanup",
    { accountId, name, location },
    signal
  );
}

export function endInactiveLocationCleanup(
  accountId: string,
  name: string,
  location: string,
  signal?: AbortSignal
): Promise<void> {
  return rpc("endInactiveLocationCleanup", { accountId, name, location }, signal);
}

export function queryDataset(
  accountId: string,
  sql: string,
  allowedTables: readonly string[],
  signal?: AbortSignal
): Promise<DatasetQueryResult> {
  return rpc("query", { accountId, sql, allowedTables: [...allowedTables] }, signal);
}

export function describeDataset(
  accountId: string,
  table: string,
  allowedTables: readonly string[],
  signal?: AbortSignal
): Promise<DatasetDescription> {
  return rpc("describe", { accountId, table, allowedTables: [...allowedTables] }, signal);
}

export function extractDataset(
  accountId: string,
  table: string,
  allowedTables: readonly string[],
  maxRows = 500,
  signal?: AbortSignal
): Promise<DatasetExtractResult> {
  return rpc("extract", { accountId, table, allowedTables: [...allowedTables], maxRows }, signal);
}

export function extractDatasetCandidate(
  name: string,
  location: string,
  expectedFormat: DatasetFormat,
  maxRows = 500,
  signal?: AbortSignal
): Promise<DatasetExtractResult> {
  return rpc("extractCandidate", { name, location, expectedFormat, maxRows }, signal);
}

export function listDatasets(accountId: string, summary = false, signal?: AbortSignal): Promise<DatasetListItem[]> {
  return rpc("list", { accountId, summary }, signal);
}

/**
 * Return compact metadata only for the bounded table-name set supplied by the
 * caller. Names that are not registered datasets are intentionally omitted so
 * mixed document/tabular source pages remain fail-soft.
 */
export function listDatasetSummaries(
  accountId: string,
  tableNames: readonly string[],
  signal?: AbortSignal
): Promise<DatasetListItem[]> {
  return rpc("summaries", { accountId, tableNames: [...tableNames] }, signal);
}

export function catalogDatasets(
  accountId: string,
  allowedTables: readonly string[],
  signal?: AbortSignal
): Promise<DatasetCatalogResult> {
  return rpc("catalog", { accountId, allowedTables: [...allowedTables] }, signal);
}

export function dropDataset(accountId: string, name: string, signal?: AbortSignal): Promise<void> {
  return rpc("drop", { accountId, name }, signal);
}

export function deactivateDatasetIfLocation(
  accountId: string,
  name: string,
  location: string,
  signal?: AbortSignal
): Promise<boolean> {
  return rpc("deactivateIfLocation", { accountId, name, location }, signal);
}

export interface DatasetWorkerDebugState {
  scopes: Array<{ accountId: string; tables: string[] }>;
  pendingPreparations: number;
  pendingActivations: number;
  cleanupReservations: number;
  activeQueryPreflightTestDelays: number;
  activeQueryNativePrepares: number;
  openCatalogs: number;
}

/** Test-only observability for lifecycle and LRU assertions. */
export function __datasetWorkerDebugState(): Promise<DatasetWorkerDebugState> {
  return rpc("debugState", {});
}

/** Test-only query controls; rejected by the worker outside NODE_ENV=test. */
export function __configureDatasetWorkerForTests(input: {
  queryTimeoutMs?: number;
  queryPreflightDelay?: { phase: "scope_load" | "scope_install"; delayMs: number } | null;
  queryNativePrepareUnionCount?: number | null;
}): Promise<void> {
  return rpc("configureForTests", input);
}

/** Close all DuckDB catalogs and terminate the lazy worker. */
export async function shutdownDatasetWorker(): Promise<void> {
  const target = worker;
  if (!target) return;
  shuttingDown = true;
  try {
    await rpc("shutdown", {});
  } catch {
    // The process is terminated below even if graceful close failed.
  }
  if (worker === target) worker = undefined;
  await target.terminate();
  rejectAllPending(503);
}

/** @deprecated Kept for existing worker lifecycle tests. */
export const __shutdownDatasetWorker = shutdownDatasetWorker;
