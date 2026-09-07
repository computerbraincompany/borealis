import { randomUUID } from "node:crypto";

import {
  KnowledgeConnectionConfigError,
  KnowledgePreviewExpiredError,
  KnowledgePreviewNotFoundError,
  KnowledgePreviewSelectionError,
  KnowledgePreviewStaleError,
  KnowledgeStore,
  MAX_MANAGED_ITEMS_PER_CONNECTION,
  MAX_PREVIEW_SCAN_BYTES,
  MAX_PREVIEW_SCAN_DEPTH,
  MAX_PREVIEW_SCAN_ENTRIES,
  MAX_PREVIEW_SCAN_VISITED,
  validateKnowledgeScanBounds,
  type AppliedPreview,
  type CompletePreviewInput,
  type KnowledgeConnectionKind,
  type KnowledgeConnectionRecord,
  type KnowledgeItemRecord,
  type KnowledgePreviewEntryRecord,
  type KnowledgePreviewRecord,
  type KnowledgeRefreshItemRecord,
  type KnowledgeRefreshRecord,
  type KnowledgeRefreshStatus,
  type KnowledgeScanBounds,
  type PreviewScanEntryInput,
  type PreviewSelection,
} from "./db/stores/knowledgeStore.js";
import { SourceIngestionTransitionError } from "./db/stores/sourceIngestionTransitions.js";
import { connectionSecretStore } from "./connections/service.js";
import {
  ConnectionCustodyUnavailableError,
  type ConnectionSecrets,
  type ConnectionSecretStore,
} from "./connections/secrets.js";
import { storageRuntime } from "./storageRuntime.js";

/**
 * Shared `refreshAndWaitReady` service for living knowledge libraries (M14).
 *
 * The service is the single composition point that meets the knowledge
 * ledger, the shared connection secret custody (the v17 MCP secret store —
 * never a second mechanism), and one injected transport adapter per
 * connection kind. Folder scanning and WebDAV fetching are stage-2
 * implementations of `KnowledgeTransportAdapter`; everything durable here is
 * SQLite state that survives restart, so recovery retries only incomplete
 * items and adopts an already-reserved generation through the store's CAS
 * instead of queueing a duplicate.
 *
 * Honesty invariants:
 * - `fully_ready` is true only when every requested item ended `unchanged`
 *   or `promoted`; partial success never becomes a fully ready snapshot.
 * - The result carries the exact promoted `(source_id, generation)` pairs.
 * - A connection whose upstream is missing/failed reports explicit per-item
 *   outcomes; it never rewrites managed identity or deletes content.
 * - Nothing here reads or writes chats: a refresh cannot widen or shrink a
 *   chat's source selection.
 */

export const KNOWLEDGE_REFRESH_POLL_INTERVAL_MS = 250;
export const DEFAULT_KNOWLEDGE_REFRESH_DEADLINE_MS = 10 * 60 * 1000;
export const MAX_KNOWLEDGE_ITEM_ATTEMPTS = 5;

export const DEFAULT_KNOWLEDGE_SCAN_BOUNDS: KnowledgeScanBounds = Object.freeze({
  maxEntries: MAX_PREVIEW_SCAN_ENTRIES,
  maxDepth: MAX_PREVIEW_SCAN_DEPTH,
  maxVisited: MAX_PREVIEW_SCAN_VISITED,
  maxAggregateBytes: MAX_PREVIEW_SCAN_BYTES,
});

export class KnowledgeTransportUnavailableError extends Error {
  readonly code = "KNOWLEDGE_TRANSPORT_UNAVAILABLE";
  readonly statusCode = 503;

  constructor(kind: string) {
    super(`no knowledge transport adapter is configured for ${kind}`);
    this.name = "KnowledgeTransportUnavailableError";
  }
}

/** Bounded transport failure evidence; codes are stable identifiers only. */
export class KnowledgeScanFailureError extends Error {
  readonly code: string;
  readonly statusCode = 502;

  constructor(code: string, message = "the knowledge upstream scan failed") {
    super(message);
    this.name = "KnowledgeScanFailureError";
    this.code = code.slice(0, 64);
  }
}

export const KNOWLEDGE_SCAN_SKIP_REASONS = ["hidden", "symlink", "excluded", "depth", "limit"] as const;
export type KnowledgeScanSkipReason = (typeof KNOWLEDGE_SCAN_SKIP_REASONS)[number];

export interface KnowledgeScanFileEntry {
  readonly relative_path: string;
  readonly content_hash: string;
  readonly size_bytes: number;
  readonly mtime_hint?: string | null;
  readonly etag_hint?: string | null;
}

export interface KnowledgeScanUnsupportedEntry {
  readonly relative_path: string;
  readonly size_bytes?: number | null;
}

export interface KnowledgeScanSkipEntry {
  readonly relative_path: string;
  readonly reason: KnowledgeScanSkipReason;
}

export interface KnowledgeScanOutcome {
  /** Supported files within every bound; the hash is computed upstream bytes. */
  readonly files: readonly KnowledgeScanFileEntry[];
  readonly unsupported: readonly KnowledgeScanUnsupportedEntry[];
  readonly skipped: readonly KnowledgeScanSkipEntry[];
  readonly visited_entries: number;
  readonly directories: number;
  readonly aggregate_bytes: number;
}

export type KnowledgeInspection =
  | {
      readonly state: "present";
      readonly content_hash: string;
      readonly size_bytes: number;
      readonly mtime_hint?: string | null;
      readonly etag_hint?: string | null;
    }
  | { readonly state: "missing" }
  | { readonly state: "unauthorized" };

export interface KnowledgeStageRequest {
  readonly relative_path: string;
  /** Stable managed source when replacing content in place; null for new. */
  readonly source_id: string | null;
  /**
   * Preallocated source UUID for a `new`/`duplicate` selection. The preview
   * commit binds this exact id, so transports stage directly into the
   * ordinary `uploads/<account>/<source>` directory of the source that will
   * own the bytes — the same account/source-scoped storage layout every
   * browser upload uses. Absent for refresh-driven staging, where the
   * managed `source_id` already owns the bytes.
   */
  readonly proposed_source_id?: string | null;
  /** Current durable source path so the adapter can stage beside it. */
  readonly source_file_path: string | null;
}

export interface KnowledgeStagedEntry {
  readonly file_path: string;
  readonly content_hash: string;
  readonly size_bytes: number;
  readonly mime: string;
  readonly kind: "document" | "tabular";
}

export interface KnowledgeTransportContext {
  readonly accountId: string;
  readonly connection: KnowledgeConnectionRecord;
  /** Transport-only credential material; never serialized into a DTO. */
  readonly secrets: ConnectionSecrets | undefined;
}

/**
 * The per-connection transport seam. The stage-2 folder and WebDAV adapters
 * implement this; `DeterministicKnowledgeAdapter` (tests) provides the
 * in-process deterministic fake. Implementations must enforce the scan
 * bounds and throw `KnowledgeScanFailureError` for actionable upstream
 * states (for example `KNOWLEDGE_UPSTREAM_UNAUTHORIZED` or
 * `KNOWLEDGE_SCAN_LIMIT`); they must never call back into ingestion.
 */
export interface KnowledgeTransportAdapter {
  readonly kind: KnowledgeConnectionKind;
  scan(
    context: KnowledgeTransportContext,
    bounds: KnowledgeScanBounds,
    managed: readonly KnowledgeItemRecord[],
    signal: AbortSignal
  ): Promise<KnowledgeScanOutcome>;
  inspect(
    context: KnowledgeTransportContext,
    request: { readonly relative_path: string; readonly source_id: string; readonly source_file_path: string | null },
    signal: AbortSignal
  ): Promise<KnowledgeInspection>;
  stage(
    context: KnowledgeTransportContext,
    request: KnowledgeStageRequest,
    signal: AbortSignal
  ): Promise<KnowledgeStagedEntry>;
}

/**
 * Classifies one scan against the managed-item snapshot. Identity is the
 * path: an unmanaged path is `new` (a repeat of another new path's hash is
 * `duplicate`), a managed path with an equal hash is `unchanged`, a
 * different hash is `changed`, and a managed path absent from the scan is
 * `missing`. Equal content on different paths never merges identities.
 */
export function classifyKnowledgeScan(
  managed: readonly KnowledgeItemRecord[],
  scan: KnowledgeScanOutcome
): CompletePreviewInput {
  const managedByPath = new Map(managed.map((item) => [item.relative_path, item]));
  const seenHashes = new Set<string>();
  const entries: PreviewScanEntryInput[] = [];
  for (const file of scan.files) {
    const existing = managedByPath.get(file.relative_path);
    let classification: PreviewScanEntryInput["classification"];
    if (!existing || existing.lifecycle === "removed") {
      classification = seenHashes.has(file.content_hash) ? "duplicate" : "new";
    } else {
      classification = existing.content_hash === file.content_hash ? "unchanged" : "changed";
    }
    if (!existing || existing.lifecycle === "removed") seenHashes.add(file.content_hash);
    entries.push({
      relative_path: file.relative_path,
      classification,
      content_hash: file.content_hash,
      size_bytes: file.size_bytes,
      // A `new` scan of a path whose identity is retained-but-removed still
      // names the original source: the commit reactivates that identity, and
      // transports stage into the upload directory that source already owns.
      existing_source_id: existing?.source_id ?? null,
      mtime_hint: file.mtime_hint ?? null,
      etag_hint: file.etag_hint ?? null,
    });
  }
  const scannedPaths = new Set(entries.map((entry) => entry.relative_path));
  for (const item of managed) {
    if (item.lifecycle === "removed" || scannedPaths.has(item.relative_path)) continue;
    entries.push({
      relative_path: item.relative_path,
      classification: "missing",
      content_hash: null,
      size_bytes: item.size_bytes,
      existing_source_id: item.source_id,
      mtime_hint: null,
      etag_hint: null,
    });
  }
  for (const unsupported of scan.unsupported) {
    entries.push({
      relative_path: unsupported.relative_path,
      classification: "unsupported",
      content_hash: null,
      size_bytes: unsupported.size_bytes ?? null,
      existing_source_id: managedByPath.get(unsupported.relative_path)?.source_id ?? null,
      mtime_hint: null,
      etag_hint: null,
    });
  }
  return {
    entries,
    visited_entries: scan.visited_entries,
    directories: scan.directories,
    aggregate_bytes: scan.aggregate_bytes,
    // The scan's skip report (hidden/symlink/excluded/depth/limit) is
    // persisted as a durable count on the preview row so the preview surface
    // never silently drops entries the scan deliberately skipped.
    skipped_count: scan.skipped.length,
  };
}

export interface RefreshTarget {
  readonly connection_id: string;
  readonly expected_connection_revision: number;
  /** Exact managed-item allowlist; omit to refresh all non-removed items. */
  readonly item_ids?: readonly string[];
}

export interface RefreshAndWaitReadyInput {
  readonly accountId: string;
  readonly connections: readonly RefreshTarget[];
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

export type KnowledgeRefreshItemOutcome =
  "promoted" | "unchanged" | "missing" | "failed" | "blocked" | "cancelled" | "pending";

export interface RefreshItemResult {
  readonly item_id: string;
  readonly source_id: string;
  readonly relative_path: string;
  readonly outcome: KnowledgeRefreshItemOutcome;
  readonly generation: number | null;
  readonly error_code: string | null;
}

export interface RefreshPromotedPair {
  readonly connection_id: string;
  readonly item_id: string;
  readonly source_id: string;
  readonly generation: number;
}

export interface RefreshConnectionResult {
  readonly connection_id: string;
  readonly refresh_id: string | null;
  readonly status: KnowledgeRefreshStatus | "rejected";
  readonly error_code: string | null;
  readonly items: readonly RefreshItemResult[];
}

export interface RefreshAndWaitReadyResult {
  /** True only when every item ended unchanged or promoted. */
  readonly fully_ready: boolean;
  readonly promoted: readonly RefreshPromotedPair[];
  readonly refreshes: readonly RefreshConnectionResult[];
}

export interface KnowledgeRefreshPorts {
  /** Resolves the knowledge ledger; defaults to the active storage runtime. */
  readonly store?: () => KnowledgeStore;
  /** Shared connection credential custody; defaults to the MCP-era store. */
  readonly secrets?: () => ConnectionSecretStore;
  /** Transport adapter registry; stage 2 registers folder/webdav adapters. */
  readonly adapter?: (kind: KnowledgeConnectionKind) => KnowledgeTransportAdapter | undefined;
  /** Durable re-ingestion reservation via normal ingestion admission. */
  readonly reingest?: (accountId: string, sourceId: string) => Promise<{ generation: number }>;
  readonly pollIntervalMs?: number;
  readonly now?: () => Date;
}

interface ExecutionContext {
  readonly accountId: string;
  readonly connection: KnowledgeConnectionRecord;
  readonly adapter: KnowledgeTransportAdapter;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}

const defaultReingest = async (accountId: string, sourceId: string): Promise<{ generation: number }> => {
  const reserved = await storageRuntime().sourceIngestion.reserveSourceReingest(accountId, sourceId);
  return { generation: reserved.generation };
};

function scanErrorCode(error: unknown): string {
  if (error instanceof KnowledgeScanFailureError) return error.code;
  if (error instanceof ConnectionCustodyUnavailableError) return "CONNECTION_CUSTODY_UNAVAILABLE";
  if (error instanceof KnowledgeConnectionConfigError) return "KNOWLEDGE_CONNECTION_CONFIG_INVALID";
  if (error instanceof Error && error.name === "AbortError") return "KNOWLEDGE_SCAN_CANCELLED";
  return "KNOWLEDGE_SCAN_FAILED";
}

const neverSignal = new AbortController().signal;

export class KnowledgeRefreshService {
  constructor(private readonly ports: KnowledgeRefreshPorts = {}) {}

  private get store(): KnowledgeStore {
    return this.ports.store ? this.ports.store() : storageRuntime().knowledge;
  }

  private get secrets(): ConnectionSecretStore {
    return this.ports.secrets ? this.ports.secrets() : connectionSecretStore();
  }

  private adapterFor(kind: KnowledgeConnectionKind): KnowledgeTransportAdapter {
    const adapter = this.ports.adapter ? this.ports.adapter(kind) : defaultKnowledgeTransportAdapter(kind);
    if (!adapter) throw new KnowledgeTransportUnavailableError(kind);
    return adapter;
  }

  private get pollIntervalMs(): number {
    const value = this.ports.pollIntervalMs ?? KNOWLEDGE_REFRESH_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("pollIntervalMs is invalid");
    return value;
  }

  private async transportContext(
    accountId: string,
    connection: KnowledgeConnectionRecord
  ): Promise<KnowledgeTransportContext> {
    let secrets: KnowledgeTransportContext["secrets"];
    if (connection.kind === "webdav") {
      const read = await this.secrets.read(accountId, connection.id);
      if (read.state === "unavailable") throw new ConnectionCustodyUnavailableError();
      if (read.state === "absent") {
        throw new KnowledgeScanFailureError(
          "KNOWLEDGE_CREDENTIALS_MISSING",
          "the connection has no stored credentials"
        );
      }
      secrets = read.secrets;
    } else {
      secrets = undefined;
    }
    return Object.freeze({ accountId, connection, secrets });
  }

  private async managedItems(accountId: string, connectionId: string): Promise<readonly KnowledgeItemRecord[]> {
    const items: KnowledgeItemRecord[] = [];
    let after = null as { timestamp: string; id: string } | null;
    for (let guard = 0; guard < 4; guard += 1) {
      const page = await this.store.listItems(accountId, connectionId, {
        limit: MAX_MANAGED_ITEMS_PER_CONNECTION,
        after,
      });
      items.push(...page.items);
      if (!page.next) return items;
      after = page.next;
    }
    throw new RangeError("managed item catalog exceeded its budget");
  }

  /**
   * Registers the durable pending preview row and detaches the bounded
   * upstream scan onto a detached run promise. The route surface returns the
   * pending preview id immediately; the caller polls
   * `getPreview`/`GET /api/knowledge-previews/:id` for `complete`/`failed`.
   * A scan that fails (over bounds, unauthorized, or timed out) records a
   * durable failed preview and never activates anything.
   */
  async beginPreview(
    accountId: string,
    connectionId: string,
    bounds: KnowledgeScanBounds = DEFAULT_KNOWLEDGE_SCAN_BOUNDS,
    options: { signal?: AbortSignal } = {}
  ): Promise<{
    preview: KnowledgePreviewRecord;
    run: Promise<{ preview: KnowledgePreviewRecord; entries: readonly KnowledgePreviewEntryRecord[] }>;
  }> {
    const signal = options.signal ?? neverSignal;
    const connection = await this.store.requireConnection(accountId, connectionId);
    const adapter = this.adapterFor(connection.kind);
    const validated = validateKnowledgeScanBounds(bounds);
    // Early failures (foreign connection, missing adapter, insert error) throw
    // before any preview row exists.
    const preview = await this.store.createPreview(accountId, connectionId, validated);
    const run = (async () => {
      const managed = await this.managedItems(accountId, connectionId);
      try {
        signal.throwIfAborted();
        const context = await this.transportContext(accountId, connection);
        const scan = await adapter.scan(context, validated, managed, signal);
        signal.throwIfAborted();
        const completed = await this.store.completePreview(accountId, preview.id, classifyKnowledgeScan(managed, scan));
        await this.store.recordConnectionStatus(accountId, connectionId, "ready", null);
        return completed;
      } catch (error) {
        const code = scanErrorCode(error);
        await this.store.failPreview(accountId, preview.id, code).catch(() => undefined);
        const status =
          code === "KNOWLEDGE_UPSTREAM_UNAUTHORIZED" || code === "KNOWLEDGE_CREDENTIALS_MISSING"
            ? "disconnected"
            : "error";
        await this.store.recordConnectionStatus(accountId, connectionId, status, code).catch(() => undefined);
        throw error;
      }
    })();
    // The detached run must never surface as an unhandled rejection while the
    // route polls the pending row; an awaiting caller (createPreview) still
    // observes the original rejection through its own `await run`.
    run.catch(() => undefined);
    return Object.freeze({ preview, run });
  }

  /**
   * Runs one bounded upstream scan and persists the classified diff as a
   * preview, awaiting the detached run. A scan that fails records a durable
   * failed preview and never activates anything.
   */
  async createPreview(
    accountId: string,
    connectionId: string,
    bounds: KnowledgeScanBounds = DEFAULT_KNOWLEDGE_SCAN_BOUNDS,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ preview: KnowledgePreviewRecord; entries: readonly KnowledgePreviewEntryRecord[] }> {
    const { run } = await this.beginPreview(accountId, connectionId, bounds, options);
    return run;
  }

  /**
   * Stages the current upstream bytes for each selected entry and commits
   * them against the exact preview revision. If upstream content moved
   * between preview and commit, the staged hash no longer matches the scan
   * and the whole commit refuses (stale preview, 409) — never a silent
   * substitution. Registration lands in one durable active refresh.
   */
  async applyPreview(
    accountId: string,
    previewId: string,
    input: { expected_revision: number; selections: readonly { entry_id: string; selection_token: string }[] },
    options: { signal?: AbortSignal } = {}
  ): Promise<AppliedPreview> {
    const signal = options.signal ?? neverSignal;
    const preview = await this.store.getPreview(accountId, previewId);
    if (!preview) throw new KnowledgePreviewNotFoundError();
    // Report an expired scan before any transport staging so a caller never
    // pays for downloads on a manifest that can no longer commit.
    if (preview.status === "expired") throw new KnowledgePreviewExpiredError();
    if (preview.status !== "complete") {
      throw new KnowledgePreviewStaleError("only a complete preview can be applied");
    }
    const connection = await this.store.requireConnection(accountId, preview.connection_id);
    const adapter = this.adapterFor(connection.kind);
    const context = await this.transportContext(accountId, connection);
    const entries = await this.store.listPreviewEntries(accountId, preview.id);
    const byId = new Map(entries.map((entry) => [entry.entry_id, entry]));
    const selections: PreviewSelection[] = [];
    for (const selection of input.selections) {
      signal.throwIfAborted();
      const entry = byId.get(selection.entry_id);
      if (!entry || entry.preview_id !== preview.id) {
        throw new KnowledgePreviewStaleError("a selected entry is not part of this preview");
      }
      if (
        entry.classification !== "new" &&
        entry.classification !== "changed" &&
        entry.classification !== "duplicate"
      ) {
        throw new KnowledgePreviewSelectionError(`${entry.classification} entries are not selectable`);
      }
      let sourceFilePath: string | null = null;
      if (entry.classification === "changed" && entry.existing_source_id) {
        sourceFilePath = (await this.store.sourceIngestionState(accountId, entry.existing_source_id))?.filePath ?? null;
      }
      // A `new`/`duplicate` path gets its source UUID allocated here so the
      // transport can stage into the ordinary account/source upload directory
      // the commit will then bind, rather than a foreign staging path.
      const proposedSourceId = entry.classification === "changed" ? null : (entry.existing_source_id ?? randomUUID());
      const staged = await adapter.stage(
        context,
        {
          relative_path: entry.relative_path,
          source_id: entry.classification === "changed" ? entry.existing_source_id : null,
          proposed_source_id: proposedSourceId,
          source_file_path: sourceFilePath,
        },
        signal
      );
      if (staged.content_hash !== entry.content_hash) {
        throw new KnowledgePreviewStaleError("the upstream content changed between preview and commit");
      }
      selections.push(
        Object.freeze({
          entry_id: entry.entry_id,
          selection_token: selection.selection_token,
          staged,
          proposed_source_id: proposedSourceId,
        })
      );
    }
    return this.store.applyPreview(accountId, preview.id, { expected_revision: input.expected_revision, selections });
  }

  /**
   * The shared refresh-and-wait service. Commits durable per-item work,
   * drives it through the transport and normal ingestion admission, and
   * waits for ready generations — or returns honest partial outcomes when
   * the caller's signal or deadline cuts the work short.
   */
  async refreshAndWaitReady(input: RefreshAndWaitReadyInput): Promise<RefreshAndWaitReadyResult> {
    const deadlineMs = input.deadlineMs ?? DEFAULT_KNOWLEDGE_REFRESH_DEADLINE_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new RangeError("deadlineMs is invalid");
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(input.signal?.reason);
    if (input.signal) {
      if (input.signal.aborted) abortFromCaller();
      else input.signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    const deadlineAt = Date.now() + deadlineMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("knowledge refresh deadline exceeded"));
    }, deadlineMs);
    timer.unref?.();
    const refreshes: RefreshConnectionResult[] = [];
    try {
      for (const target of input.connections) {
        const result = await this.refreshOne(input.accountId, target, controller.signal, deadlineAt, () => timedOut);
        refreshes.push(result);
      }
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortFromCaller);
    }
    const promoted = refreshes
      .flatMap((refresh) =>
        refresh.items.flatMap((item) =>
          item.outcome === "promoted" && item.generation !== null
            ? [
                Object.freeze({
                  connection_id: refresh.connection_id,
                  item_id: item.item_id,
                  source_id: item.source_id,
                  generation: item.generation,
                }),
              ]
            : []
        )
      )
      .map((pair) => Object.freeze(pair));
    const fullyReady =
      refreshes.length > 0 &&
      refreshes.every(
        (refresh) =>
          refresh.status === "completed" &&
          refresh.items.every((item) => item.outcome === "unchanged" || item.outcome === "promoted")
      );
    return Object.freeze({
      fully_ready: fullyReady,
      promoted: Object.freeze(promoted),
      refreshes: Object.freeze(refreshes.map((refresh) => Object.freeze(refresh))),
    });
  }

  /**
   * Restart recovery: every durable active refresh retries only its
   * incomplete items. Committed work is never reserved twice — an
   * already-queued generation is adopted through the store's CAS.
   */
  async recoverInterrupted(
    accountId: string,
    options: { signal?: AbortSignal; deadlineMs?: number } = {}
  ): Promise<RefreshAndWaitReadyResult> {
    const deadlineMs = options.deadlineMs ?? DEFAULT_KNOWLEDGE_REFRESH_DEADLINE_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new RangeError("deadlineMs is invalid");
    const signal = options.signal ?? neverSignal;
    const deadlineAt = Date.now() + deadlineMs;
    const interrupted = await this.store.listInterruptedRefreshes(accountId);
    const refreshes: RefreshConnectionResult[] = [];
    for (const refresh of interrupted) {
      const connection = await this.store.getConnection(accountId, refresh.connection_id);
      const result = await this.runExistingRefresh(
        accountId,
        refresh,
        connection,
        signal,
        deadlineAt,
        () => Date.now() >= deadlineAt
      );
      refreshes.push(result);
    }
    const promoted = refreshes
      .flatMap((refresh) =>
        refresh.items.flatMap((item) =>
          item.outcome === "promoted" && item.generation !== null
            ? [
                Object.freeze({
                  connection_id: refresh.connection_id,
                  item_id: item.item_id,
                  source_id: item.source_id,
                  generation: item.generation,
                }),
              ]
            : []
        )
      )
      .map((pair) => Object.freeze(pair));
    return Object.freeze({
      fully_ready: false,
      promoted: Object.freeze(promoted),
      refreshes: Object.freeze(refreshes.map((refresh) => Object.freeze(refresh))),
    });
  }

  /** Explicit durable cancellation request for a running refresh. */
  async requestCancellation(accountId: string, refreshId: string): Promise<boolean> {
    return this.store.requestRefreshCancellation(accountId, refreshId);
  }

  private async refreshOne(
    accountId: string,
    target: RefreshTarget,
    signal: AbortSignal,
    deadlineAt: number,
    isTimedOut: () => boolean
  ): Promise<RefreshConnectionResult> {
    let connection: KnowledgeConnectionRecord | undefined;
    try {
      connection = await this.store.requireConnection(accountId, target.connection_id);
    } catch {
      return Object.freeze({
        connection_id: target.connection_id,
        refresh_id: null,
        status: "rejected",
        error_code: "KNOWLEDGE_CONNECTION_NOT_FOUND",
        items: Object.freeze([]),
      });
    }
    let adapter: KnowledgeTransportAdapter;
    try {
      adapter = this.adapterFor(connection.kind);
    } catch (error) {
      return Object.freeze({
        connection_id: target.connection_id,
        refresh_id: null,
        status: "rejected",
        error_code:
          error instanceof KnowledgeTransportUnavailableError ? error.code : "KNOWLEDGE_TRANSPORT_UNAVAILABLE",
        items: Object.freeze([]),
      });
    }
    try {
      // One active refresh per connection: if a prior apply or refresh left
      // durable work in flight, coalesce onto it and drive it to completion
      // rather than starting a competing reservation (the spec's coalescing
      // rule). The allowlist governs a fresh begin; adopted work is already
      // committed with its concrete item set.
      const active = await this.store.getActiveRefresh(accountId, target.connection_id);
      const begun = active
        ? { refresh: active, items: await this.store.listRefreshItems(accountId, active.id) }
        : await this.store.beginRefresh(accountId, {
            connection_id: target.connection_id,
            expected_connection_revision: target.expected_connection_revision,
            item_ids: target.item_ids,
            requested_by: "manual",
          });
      return await this.executeRefresh(accountId, begun.refresh, adapter, connection, signal, deadlineAt, isTimedOut);
    } catch (error) {
      const rawCode = error instanceof Error ? (error as unknown as { code?: unknown }).code : undefined;
      const code = typeof rawCode === "string" ? rawCode.slice(0, 64) : "KNOWLEDGE_REFRESH_FAILED";
      return Object.freeze({
        connection_id: target.connection_id,
        refresh_id: null,
        status: "rejected",
        error_code: code,
        items: Object.freeze([]),
      });
    }
  }

  private async runExistingRefresh(
    accountId: string,
    refresh: KnowledgeRefreshRecord,
    connection: KnowledgeConnectionRecord | undefined,
    signal: AbortSignal,
    deadlineAt: number,
    isTimedOut: () => boolean
  ): Promise<RefreshConnectionResult> {
    if (!connection) {
      return Object.freeze({
        connection_id: refresh.connection_id,
        refresh_id: refresh.id,
        status: "rejected",
        error_code: "KNOWLEDGE_CONNECTION_NOT_FOUND",
        items: Object.freeze([]),
      });
    }
    let adapter: KnowledgeTransportAdapter;
    try {
      adapter = this.adapterFor(connection.kind);
    } catch (error) {
      // Durable work stays durable: recovery without its transport makes no
      // upstream call and reports the actionable gap instead of finishing.
      return Object.freeze({
        connection_id: refresh.connection_id,
        refresh_id: refresh.id,
        status: "rejected",
        error_code:
          error instanceof KnowledgeTransportUnavailableError ? error.code : "KNOWLEDGE_TRANSPORT_UNAVAILABLE",
        items: Object.freeze(await this.snapshotOutcomes(accountId, refresh.id)),
      });
    }
    return this.executeRefresh(accountId, refresh, adapter, connection, signal, deadlineAt, isTimedOut);
  }

  private async executeRefresh(
    accountId: string,
    refresh: KnowledgeRefreshRecord,
    adapter: KnowledgeTransportAdapter,
    connection: KnowledgeConnectionRecord,
    signal: AbortSignal,
    deadlineAt: number,
    isTimedOut: () => boolean
  ): Promise<RefreshConnectionResult> {
    const context: ExecutionContext = { accountId, connection, adapter, signal, deadlineAt };
    let lastErrorCode: string | null = null;
    let authIssue = false;
    let timeoutExit = false;
    const finishCancelled = async () => {
      for (const item of await this.store.listRefreshItems(accountId, refresh.id)) {
        if (item.status === "pending" || item.status === "staged") {
          await this.store.resolveRefreshItem(accountId, refresh.id, item.item_id, {
            status: "cancelled",
            error_code: "KNOWLEDGE_REFRESH_CANCELLED",
          });
        }
      }
      await this.store.finishRefresh(accountId, refresh.id, "cancelled", null).catch(() => undefined);
    };
    for (;;) {
      const current = await this.store.requireRefresh(accountId, refresh.id);
      if (current.status !== "active") break;
      if (current.cancel_requested) {
        await finishCancelled();
        break;
      }
      if (signal.aborted) {
        if (isTimedOut()) {
          // A caller deadline is an honest failure for the caller, not a
          // user cancellation: the durable refresh stays `active` and every
          // committed item stays committed so restart recovery resumes them
          // without re-reserving generations.
          timeoutExit = true;
          lastErrorCode = "KNOWLEDGE_REFRESH_TIMEOUT";
        } else {
          await finishCancelled();
        }
        break;
      }
      const items = await this.store.listRefreshItems(accountId, refresh.id);
      const incomplete = items.filter(
        (item) => item.status === "pending" || item.status === "staged" || item.status === "committed"
      );
      if (incomplete.length === 0) break;
      for (const item of incomplete) {
        try {
          const outcome = await this.stepItem(context, item);
          if (outcome.authIssue) authIssue = true;
          if (outcome.errorCode) lastErrorCode = outcome.errorCode;
        } catch (error) {
          // Transport cancellation must reach the loop's durable finalizer.
          // That branch distinguishes a resumable deadline from caller abort;
          // letting an aborted socket reject here would leave an active row.
          if (!signal.aborted) throw error;
          break;
        }
      }
      const afterStep = await this.store.listRefreshItems(accountId, refresh.id);
      const stillIncomplete = afterStep.some(
        (item) => item.status === "pending" || item.status === "staged" || item.status === "committed"
      );
      if (!stillIncomplete) continue;
      if (signal.aborted) continue;
      if (Date.now() >= deadlineAt || isTimedOut()) {
        timeoutExit = true;
        lastErrorCode = "KNOWLEDGE_REFRESH_TIMEOUT";
        break;
      }
      await sleep(this.pollIntervalMs, signal);
    }
    let finalRefresh = await this.store.requireRefresh(accountId, refresh.id);
    const finalItems = [...(await this.store.listRefreshItems(accountId, refresh.id))];
    if (!timeoutExit && finalRefresh.status === "active") {
      const derived = deriveStatus(finalItems);
      try {
        finalRefresh =
          (await this.store.finishRefresh(
            accountId,
            refresh.id,
            derived as Exclude<KnowledgeRefreshStatus, "active">,
            lastErrorCode
          )) ?? finalRefresh;
      } catch {
        // A concurrent finalizer owns the transition; its record is truth.
        finalRefresh = await this.store.requireRefresh(accountId, refresh.id);
      }
    }
    const status: KnowledgeRefreshStatus = timeoutExit ? "failed" : finalRefresh.status;
    const errorCode = timeoutExit ? "KNOWLEDGE_REFRESH_TIMEOUT" : finalRefresh.error_code;
    if (status === "completed") {
      await this.store.recordConnectionStatus(accountId, connection.id, "ready", null).catch(() => undefined);
    } else if (authIssue) {
      await this.store
        .recordConnectionStatus(accountId, connection.id, "disconnected", "KNOWLEDGE_UPSTREAM_UNAUTHORIZED")
        .catch(() => undefined);
    } else if (status === "failed" || status === "partial") {
      await this.store.recordConnectionStatus(accountId, connection.id, "error", errorCode).catch(() => undefined);
    }
    return Object.freeze({
      connection_id: connection.id,
      refresh_id: refresh.id,
      status,
      error_code: errorCode,
      items: Object.freeze(finalItems.map((item) => Object.freeze(toItemResult(item)))),
    });
  }

  /** One bounded advance attempt for a single incomplete refresh item. */
  private async stepItem(
    context: ExecutionContext,
    item: KnowledgeRefreshItemRecord
  ): Promise<{ errorCode: string | null; authIssue: boolean }> {
    const { accountId, adapter, signal } = context;
    if (item.status === "committed") {
      const state = await this.store.sourceIngestionState(accountId, item.source_id);
      if (!state) {
        await this.store.resolveRefreshItem(accountId, item.refresh_id, item.item_id, {
          status: "failed",
          error_code: "KNOWLEDGE_SOURCE_MISSING",
        });
        return { errorCode: "KNOWLEDGE_SOURCE_MISSING", authIssue: false };
      }
      if (state.jobStatus === "error") {
        await this.store.resolveRefreshItem(accountId, item.refresh_id, item.item_id, {
          status: "failed",
          error_code: "KNOWLEDGE_INGESTION_FAILED",
        });
        return { errorCode: "KNOWLEDGE_INGESTION_FAILED", authIssue: false };
      }
      if (
        state.readyGeneration !== null &&
        item.expected_generation !== null &&
        state.readyGeneration >= item.expected_generation
      ) {
        const promoted = await this.store.readyRefreshItem(accountId, {
          refresh_id: item.refresh_id,
          item_id: item.item_id,
          size_bytes: item.candidate_size_bytes,
        });
        void promoted;
      }
      return { errorCode: null, authIssue: false };
    }
    if (item.attempts >= MAX_KNOWLEDGE_ITEM_ATTEMPTS) {
      await this.store.resolveRefreshItem(accountId, item.refresh_id, item.item_id, {
        status: "failed",
        error_code: "KNOWLEDGE_ITEM_ATTEMPTS_EXHAUSTED",
      });
      return { errorCode: "KNOWLEDGE_ITEM_ATTEMPTS_EXHAUSTED", authIssue: false };
    }
    if (!(await this.store.markRefreshItemAttempted(accountId, item.refresh_id, item.item_id))) {
      return { errorCode: null, authIssue: false };
    }
    const stagedPath = item.candidate_path;
    const stagedSize = item.candidate_size_bytes;
    const targetHash = item.target_hash;
    if (item.status === "pending" && stagedPath === null) {
      const state = await this.store.sourceIngestionState(accountId, item.source_id);
      const transport = await this.transportContext(accountId, context.connection);
      const upstream = await adapter.inspect(
        transport,
        {
          relative_path: item.relative_path,
          source_id: item.source_id,
          source_file_path: state?.filePath ?? null,
        },
        signal
      );
      if (upstream.state === "unauthorized") {
        await this.store.resolveRefreshItem(accountId, item.refresh_id, item.item_id, {
          status: "failed",
          error_code: "KNOWLEDGE_UPSTREAM_UNAUTHORIZED",
        });
        return { errorCode: "KNOWLEDGE_UPSTREAM_UNAUTHORIZED", authIssue: true };
      }
      if (upstream.state === "missing") {
        await this.store.resolveRefreshItem(accountId, item.refresh_id, item.item_id, { status: "missing" });
        return { errorCode: null, authIssue: false };
      }
      const managed = await this.store.getItem(accountId, item.item_id);
      if (!managed) {
        await this.store.resolveRefreshItem(accountId, item.refresh_id, item.item_id, {
          status: "failed",
          error_code: "KNOWLEDGE_ITEM_MISSING",
        });
        return { errorCode: "KNOWLEDGE_ITEM_MISSING", authIssue: false };
      }
      if (managed.content_hash === upstream.content_hash) {
        // `unchanged` requires that the current ready generation already
        // indexes this exact content. An apply that swapped bytes advances the
        // intended `content_hash` but leaves `ingested_hash` at the old
        // content, so it must reserve a generation (via adopt, since the
        // staged bytes are already at the source's file path).
        if (state && state.readyGeneration !== null && managed.ingested_hash === upstream.content_hash) {
          await this.store.resolveRefreshItem(accountId, item.refresh_id, item.item_id, {
            status: "unchanged",
            size_bytes: upstream.size_bytes,
            mtime_hint: upstream.mtime_hint ?? null,
            etag_hint: upstream.etag_hint ?? null,
          });
          return { errorCode: null, authIssue: false };
        }
        const adopted = await this.store.adoptStagedSourceItem(accountId, item.refresh_id, item.item_id);
        if (!adopted) return { errorCode: null, authIssue: false };
        return this.enqueueGeneration(context, item);
      }
      const staged = await adapter.stage(
        transport,
        {
          relative_path: item.relative_path,
          source_id: item.source_id,
          source_file_path: state?.filePath ?? null,
        },
        signal
      );
      if (staged.content_hash !== upstream.content_hash) {
        await this.store.resolveRefreshItem(accountId, item.refresh_id, item.item_id, {
          status: "failed",
          error_code: "KNOWLEDGE_STAGED_HASH_MISMATCH",
        });
        return { errorCode: "KNOWLEDGE_STAGED_HASH_MISMATCH", authIssue: false };
      }
      const stagedItem = await this.store.stageRefreshItem(accountId, {
        refresh_id: item.refresh_id,
        item_id: item.item_id,
        candidate_path: staged.file_path,
        candidate_size_bytes: staged.size_bytes,
        target_hash: staged.content_hash,
        mime: staged.mime,
      });
      if (!stagedItem) return { errorCode: null, authIssue: false };
      return this.enqueueGeneration(context, item);
    }
    // Pending-with-candidate (registered by preview apply): adopt the durable
    // swap, then reserve/wait for one generation.
    if (item.status === "pending") {
      if (stagedPath === null || targetHash === null) return { errorCode: null, authIssue: false };
      const swapped = await this.store.stageRefreshItem(accountId, {
        refresh_id: item.refresh_id,
        item_id: item.item_id,
        candidate_path: stagedPath,
        candidate_size_bytes: stagedSize ?? 0,
        target_hash: targetHash,
      });
      if (!swapped) return { errorCode: null, authIssue: false };
    }
    return this.enqueueGeneration(context, item);
  }

  /**
   * Reserves exactly one generation per committed item. A generation
   * already ahead of the snapshot is adopted without a new reservation —
   * this is the restart dedupe: recovery of an item whose reservation
   * committed before the crash never re-reserves (generation CAS).
   */
  private async enqueueGeneration(
    context: ExecutionContext,
    item: KnowledgeRefreshItemRecord
  ): Promise<{ errorCode: string | null; authIssue: boolean }> {
    const { accountId } = context;
    const state = await this.store.sourceIngestionState(accountId, item.source_id);
    if (!state) {
      await this.store.resolveRefreshItem(accountId, item.refresh_id, item.item_id, {
        status: "failed",
        error_code: "KNOWLEDGE_SOURCE_MISSING",
      });
      return { errorCode: "KNOWLEDGE_SOURCE_MISSING", authIssue: false };
    }
    const currentReady = item.current_ready_generation;
    // Adoption is limited to reservations that are in flight or already
    // promoted: a terminal error job must be superseded by a fresh
    // reservation. This is the restart dedupe — recovery of an item whose
    // reservation committed (or was promoted) before the crash never
    // reserves a second generation; it adopts the existing one through the
    // ready CAS instead.
    const inFlight = state.jobStatus === "preparing" || state.jobStatus === "pending" || state.jobStatus === "running";
    const alreadyReserved =
      state.jobGeneration !== null &&
      (inFlight || state.jobStatus === "done") &&
      (currentReady === null || state.jobGeneration > currentReady);
    if (alreadyReserved) {
      await this.store.commitRefreshItem(accountId, item.refresh_id, item.item_id, state.jobGeneration!);
      return { errorCode: null, authIssue: false };
    }
    const reingest = this.ports.reingest ?? defaultReingest;
    try {
      const reserved = await reingest(accountId, item.source_id);
      await this.store.commitRefreshItem(accountId, item.refresh_id, item.item_id, reserved.generation);
      return { errorCode: null, authIssue: false };
    } catch (error) {
      if (error instanceof SourceIngestionTransitionError && error.code === "SOURCE_TRANSITION_SOURCE_IN_USE") {
        await this.store.resolveRefreshItem(accountId, item.refresh_id, item.item_id, {
          status: "blocked",
          error_code: "KNOWLEDGE_SOURCE_IN_ACTIVE_RUN",
        });
        return { errorCode: "KNOWLEDGE_SOURCE_IN_ACTIVE_RUN", authIssue: false };
      }
      // Transient reservation failure: the item remains pending and the
      // attempt counter bounds the retries.
      return { errorCode: null, authIssue: false };
    }
  }

  private async snapshotOutcomes(accountId: string, refreshId: string): Promise<readonly RefreshItemResult[]> {
    const items = await this.store.listRefreshItems(accountId, refreshId);
    return items.map((item) => Object.freeze(toItemResult(item)));
  }
}

function toItemResult(item: KnowledgeRefreshItemRecord): RefreshItemResult {
  let outcome: KnowledgeRefreshItemOutcome;
  let generation: number | null = null;
  switch (item.status) {
    case "ready":
      outcome = "promoted";
      generation = item.promoted_generation;
      break;
    case "unchanged":
      outcome = "unchanged";
      generation = item.current_ready_generation;
      break;
    case "missing":
      outcome = "missing";
      break;
    case "failed":
      outcome = "failed";
      break;
    case "blocked":
      outcome = "blocked";
      break;
    case "cancelled":
      outcome = "cancelled";
      break;
    default:
      outcome = "pending";
  }
  return {
    item_id: item.item_id,
    source_id: item.source_id,
    relative_path: item.relative_path,
    outcome,
    generation,
    error_code: item.error_code,
  };
}

function deriveStatus(items: readonly KnowledgeRefreshItemRecord[]): KnowledgeRefreshStatus {
  const ready = items.filter((item) => item.status === "ready").length;
  const unchanged = items.filter((item) => item.status === "unchanged").length;
  const failed = items.filter((item) => item.status === "failed" || item.status === "blocked").length;
  const missing = items.filter((item) => item.status === "missing").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const open = items.filter(
    (item) => item.status === "pending" || item.status === "staged" || item.status === "committed"
  ).length;
  const succeeded = ready + unchanged;
  if (open > 0) return succeeded > 0 ? "partial" : "failed";
  if (failed === 0 && missing === 0 && cancelled === 0) return "completed";
  if (succeeded > 0) return "partial";
  return cancelled > 0 && failed === 0 && missing === 0 ? "cancelled" : "failed";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Process-wide transport adapter registry. Stage-2 composition (folder and
 * WebDAV transports) registers its concrete adapters here so the default
 * service resolves them without every caller threading ports; a service
 * constructed with an explicit `adapter` port (tests) never consults the
 * registry. Registration replaces the adapter for one kind and is the only
 * mutation surface.
 */
const adapterRegistry = new Map<KnowledgeConnectionKind, KnowledgeTransportAdapter>();

export function registerKnowledgeTransportAdapter(adapter: KnowledgeTransportAdapter): void {
  adapterRegistry.set(adapter.kind, adapter);
}

export function clearKnowledgeTransportAdapters(): void {
  adapterRegistry.clear();
}

export function defaultKnowledgeTransportAdapter(kind: KnowledgeConnectionKind): KnowledgeTransportAdapter | undefined {
  return adapterRegistry.get(kind);
}

let configured: KnowledgeRefreshPorts = {};
let active: KnowledgeRefreshService | undefined;

/** Composition seam for tests and stage-2 transport/platform wiring. */
export function configureKnowledgeRefresh(ports: KnowledgeRefreshPorts = {}): void {
  configured = ports;
  active = undefined;
}

export function knowledgeRefreshService(): KnowledgeRefreshService {
  active ??= new KnowledgeRefreshService(configured);
  return active;
}

export function closeKnowledgeRefreshService(): void {
  active = undefined;
  configured = {};
}
