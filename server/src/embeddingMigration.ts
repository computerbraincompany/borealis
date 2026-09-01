import { createHash, randomUUID } from "node:crypto";
import { chmodSync, constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { config } from "./config.js";
import type { SqliteLedger, SqliteTransaction } from "./db/types.js";
import { openSqliteLedger } from "./db/sqlite.js";
import { endpointHost, isRemoteProvider } from "./egressPolicy.js";
import { recordEgressEvent } from "./egressAudit.js";
import { createEmbeddingExecutor } from "./llm.js";
import { normalizeEmbeddingVector } from "./embeddingVector.js";
import { resolveLlmModelId } from "./llmAliases.js";
import { runtimeSettingsStore } from "./runtimeSettings.js";
import type { EffectiveLlmSettings, LlmSettingsPatch, SettingsSnapshot, SettingsStore } from "./settingsStore.js";
import { storageRuntime, type StorageRuntime } from "./storageRuntime.js";
import { LanceVectorIndex, type LanceVectorRow } from "./vector/lance.js";
import { retrieveWithVector } from "./vector/retrieve.js";

const STATE_VERSION = 1 as const;
const MANIFEST_VERSION = 1;
const STATE_MAX_BYTES = 64 * 1024;
const SNAPSHOT_PAGE_SIZE = 256;
const EMBED_BATCH_SIZE = 16;
const MAX_MIGRATION_SOURCES = 100_000;
const MAX_MIGRATION_CHUNKS = 1_000_000;
const MIN_DISK_HEADROOM_BYTES = 128n * 1024n * 1024n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type EmbeddingMigrationPhase =
  | "snapshotting"
  | "building"
  | "ready_to_apply"
  | "apply_pending"
  | "cancelling"
  | "live_moved"
  | "staged_installed"
  | "settings_updated"
  | "complete"
  | "failed";

export type PublicEmbeddingMigrationPhase =
  "idle" | "snapshotting" | "building" | "ready_to_apply" | "apply_pending" | "failed";

export type EmbeddingMigrationErrorCode =
  | "MIGRATION_ACTIVE"
  | "TARGET_UNCHANGED"
  | "NO_READY_SOURCES"
  | "SOURCE_MUTATION_BLOCKED"
  | "INGESTION_BUSY"
  | "REMOTE_EGRESS_CONSENT_REQUIRED"
  | "ENVIRONMENT_MANAGED"
  | "PROVIDER_CHANGED"
  | "SNAPSHOT_FAILED"
  | "SNAPSHOT_DRIFT"
  | "MIGRATION_TOO_LARGE"
  | "INSUFFICIENT_DISK"
  | "EMBEDDING_UNAVAILABLE"
  | "EMBEDDING_INVALID"
  | "INDEX_VERIFY_FAILED"
  | "NOT_READY_TO_APPLY"
  | "CANNOT_CANCEL_AFTER_SWAP"
  | "NO_FAILED_MIGRATION"
  | "STATE_INVALID"
  | "STARTUP_SWAP_FAILED"
  | "STARTUP_OPEN_FAILED"
  | "STARTUP_SMOKE_FAILED";

interface StoredMigrationState {
  readonly version: typeof STATE_VERSION;
  readonly id: string;
  readonly phase: EmbeddingMigrationPhase;
  readonly target_model: string;
  readonly target_dimension: number;
  readonly old_model: string;
  readonly old_dimension: number;
  readonly provider_revision: string;
  readonly snapshot_hash: string | null;
  readonly source_count: number;
  readonly chunk_count: number;
  readonly indexed_count: number;
  readonly error_code: EmbeddingMigrationErrorCode | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface EmbeddingMigrationStatus {
  readonly phase: PublicEmbeddingMigrationPhase;
  readonly target_model: string | null;
  readonly target_dimension: number | null;
  readonly source_count: number;
  readonly chunk_count: number;
  readonly indexed_count: number;
  readonly error_code: EmbeddingMigrationErrorCode | null;
  readonly restart_required: boolean;
  readonly can_cancel: boolean;
  readonly can_retry: boolean;
  readonly can_apply: boolean;
}

export interface EmbeddingMigrationOperations {
  status(): Promise<EmbeddingMigrationStatus>;
  start(
    target: { model: string; dimension: number },
    qualification?: EmbeddingMigrationQualification
  ): Promise<EmbeddingMigrationStatus>;
  retry(): Promise<EmbeddingMigrationStatus>;
  cancel(): Promise<EmbeddingMigrationStatus>;
  requestApply(): Promise<EmbeddingMigrationStatus>;
}

export interface EmbeddingMigrationQualification {
  readonly baseline: EffectiveLlmSettings;
  readonly target: EffectiveLlmSettings;
}

export class EmbeddingMigrationError extends Error {
  constructor(
    readonly code: EmbeddingMigrationErrorCode,
    readonly statusCode = 409
  ) {
    super(publicMigrationError(code));
    this.name = "EmbeddingMigrationError";
  }
}

interface StartupLedgerHandle {
  readonly ledger: SqliteLedger;
  close(): Promise<void>;
}

export interface EmbeddingMigrationCoordinatorOptions {
  readonly stateFile: string;
  readonly migrationRoot: string;
  readonly liveLanceDirectory: string;
  readonly settingsStore: SettingsStore;
  readonly ledger: () => SqliteLedger;
  readonly runtime: () => StorageRuntime;
  readonly openStartupLedger: () => Promise<StartupLedgerHandle>;
  readonly embedFactory?: (
    settings: EffectiveLlmSettings,
    targetModel: string
  ) => (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
  readonly audit?: typeof recordEgressEvent;
  readonly now?: () => Date;
  readonly statfs?: typeof fs.statfs;
}

interface ManifestChunk {
  readonly ordinal: number;
  readonly chunkId: string;
  readonly accountId: string;
  readonly sourceId: string;
  readonly generation: number;
  readonly seq: number;
  readonly contentHash: string;
  readonly migrationId: string;
}

interface LiveChunk extends ManifestChunk {
  readonly content: string;
}

interface SnapshotSummary {
  readonly sourceCount: number;
  readonly chunkCount: number;
  readonly snapshotHash: string;
}

interface ManifestPaths {
  readonly directory: string;
  readonly manifest: string;
  readonly stagedIndex: string;
  readonly backupIndex: string;
  readonly failedIndex: string;
}

export class EmbeddingMigrationCoordinator implements EmbeddingMigrationOperations {
  readonly #stateFile: string;
  readonly #migrationRoot: string;
  readonly #liveLanceDirectory: string;
  readonly #settingsStore: SettingsStore;
  readonly #ledger: () => SqliteLedger;
  readonly #runtime: () => StorageRuntime;
  readonly #openStartupLedger: () => Promise<StartupLedgerHandle>;
  readonly #embedFactory: NonNullable<EmbeddingMigrationCoordinatorOptions["embedFactory"]>;
  readonly #audit: typeof recordEgressEvent;
  readonly #now: () => Date;
  readonly #statfs: typeof fs.statfs;
  #tail: Promise<void> = Promise.resolve();
  #build: Promise<void> | undefined;
  #buildAbort: AbortController | undefined;

  constructor(options: EmbeddingMigrationCoordinatorOptions) {
    this.#stateFile = path.resolve(options.stateFile);
    this.#migrationRoot = path.resolve(options.migrationRoot);
    this.#liveLanceDirectory = path.resolve(options.liveLanceDirectory);
    if (
      this.#migrationRoot === this.#liveLanceDirectory ||
      this.#migrationRoot.startsWith(`${this.#liveLanceDirectory}${path.sep}`)
    ) {
      throw new TypeError("embedding migration staging must be outside the live index");
    }
    this.#settingsStore = options.settingsStore;
    this.#ledger = options.ledger;
    this.#runtime = options.runtime;
    this.#openStartupLedger = options.openStartupLedger;
    this.#embedFactory = options.embedFactory ?? ((settings, model) => createEmbeddingExecutor(settings, model));
    this.#audit = options.audit ?? recordEgressEvent;
    this.#now = options.now ?? (() => new Date());
    this.#statfs = options.statfs ?? fs.statfs;
  }

  async status(): Promise<EmbeddingMigrationStatus> {
    return publicStatus(await this.#readState());
  }

  async start(
    target: { model: string; dimension: number },
    qualification?: EmbeddingMigrationQualification
  ): Promise<EmbeddingMigrationStatus> {
    return this.#exclusive(async () => {
      if (await this.#readState()) throw new EmbeddingMigrationError("MIGRATION_ACTIVE");
      const current = await this.#settingsStore.read();
      assertTarget(current, target);
      if (qualification) assertQualificationStillCurrent(current.settings, target, qualification);
      const id = randomUUID();
      const now = this.#now().toISOString();
      let state: StoredMigrationState = {
        version: STATE_VERSION,
        id,
        phase: "snapshotting",
        target_model: target.model.trim(),
        target_dimension: target.dimension,
        old_model: current.settings.embedModel,
        old_dimension: current.settings.embeddingDimension,
        provider_revision: providerRevision(current.settings, id),
        snapshot_hash: null,
        source_count: 0,
        chunk_count: 0,
        indexed_count: 0,
        error_code: null,
        created_at: now,
        updated_at: now,
      };
      await this.#writeState(state);
      try {
        const paths = await this.#createMigrationDirectory(id);
        const summary = await this.#captureSnapshot(this.#ledger(), paths, id);
        await this.#assertDiskBudget(paths, summary.chunkCount, target.dimension);
        await this.#assertRemoteAccountConsent(paths, current.settings);
        state = await this.#replaceState(state, {
          phase: "building",
          snapshot_hash: summary.snapshotHash,
          source_count: summary.sourceCount,
          chunk_count: summary.chunkCount,
          indexed_count: 0,
          error_code: null,
        });
        this.#launchBuild(state);
        return publicStatus(state);
      } catch (error) {
        if (error instanceof EmbeddingMigrationError && error.code === "INGESTION_BUSY") {
          const paths = await this.#ownedPaths(state.id, false);
          await removeExactDirectory(paths.directory);
          await this.#removeState();
          throw error;
        }
        const code = migrationCode(error, "SNAPSHOT_FAILED");
        state = await this.#replaceState(state, { phase: "failed", error_code: code });
        return publicStatus(state);
      }
    });
  }

  async retry(): Promise<EmbeddingMigrationStatus> {
    return this.#exclusive(async () => {
      const current = await this.#requiredState();
      if (current.phase !== "failed") throw new EmbeddingMigrationError("NO_FAILED_MIGRATION");
      const settings = await this.#settingsStore.read();
      this.#assertProviderAndOldIdentity(current, settings.settings);
      let next: StoredMigrationState;
      let paths = await this.#ownedPaths(current.id, false);
      if (
        !current.snapshot_hash ||
        current.error_code === "SNAPSHOT_DRIFT" ||
        current.error_code === "SNAPSHOT_FAILED"
      ) {
        if ((await pathKind(paths.directory)) === "missing") {
          paths = await this.#createMigrationDirectory(current.id);
        } else {
          paths = await this.#ownedPaths(current.id, true);
        }
        await removeExactDirectory(paths.stagedIndex);
        await fs.unlink(paths.manifest).catch(() => undefined);
        next = await this.#replaceState(current, {
          phase: "snapshotting",
          snapshot_hash: null,
          source_count: 0,
          chunk_count: 0,
          indexed_count: 0,
          error_code: null,
        });
        try {
          const summary = await this.#captureSnapshot(this.#ledger(), paths, current.id);
          await this.#assertDiskBudget(paths, summary.chunkCount, current.target_dimension);
          await this.#assertRemoteAccountConsent(paths, settings.settings);
          next = await this.#replaceState(next, {
            phase: "building",
            snapshot_hash: summary.snapshotHash,
            source_count: summary.sourceCount,
            chunk_count: summary.chunkCount,
            indexed_count: 0,
            error_code: null,
          });
        } catch (error) {
          next = await this.#replaceState(next, {
            phase: "failed",
            error_code: migrationCode(error, "SNAPSHOT_FAILED"),
          });
          return publicStatus(next);
        }
      } else if (current.error_code === "INDEX_VERIFY_FAILED") {
        paths = await this.#ownedPaths(current.id, true);
        await removeExactDirectory(paths.stagedIndex);
        next = await this.#replaceState(current, {
          phase: "building",
          indexed_count: 0,
          error_code: null,
        });
        await this.#assertDiskBudget(paths, current.chunk_count, current.target_dimension);
        await this.#assertRemoteAccountConsent(paths, settings.settings);
      } else {
        paths = await this.#ownedPaths(current.id, true);
        await this.#assertDiskBudget(paths, current.chunk_count - current.indexed_count, current.target_dimension);
        await this.#assertRemoteAccountConsent(paths, settings.settings);
        next = await this.#replaceState(current, { phase: "building", error_code: null });
      }
      this.#launchBuild(next);
      return publicStatus(next);
    });
  }

  async cancel(): Promise<EmbeddingMigrationStatus> {
    return this.#exclusive(async () => {
      let state = await this.#requiredState();
      if (["apply_pending", "live_moved", "staged_installed", "settings_updated"].includes(state.phase)) {
        throw new EmbeddingMigrationError("CANNOT_CANCEL_AFTER_SWAP");
      }
      this.#buildAbort?.abort(new DOMException("migration cancelled", "AbortError"));
      await this.#build?.catch(() => undefined);
      state = await this.#requiredState();
      if (["apply_pending", "live_moved", "staged_installed", "settings_updated"].includes(state.phase)) {
        throw new EmbeddingMigrationError("CANNOT_CANCEL_AFTER_SWAP");
      }
      state = await this.#replaceState(state, { phase: "cancelling", error_code: null });
      const paths = await this.#ownedPaths(state.id, false);
      await removeExactDirectory(paths.directory);
      await this.#removeState();
      return publicStatus(undefined);
    });
  }

  async requestApply(): Promise<EmbeddingMigrationStatus> {
    return this.#exclusive(async () => {
      const state = await this.#requiredState();
      if (state.phase !== "ready_to_apply") throw new EmbeddingMigrationError("NOT_READY_TO_APPLY");
      const settings = await this.#settingsStore.read();
      this.#assertProviderAndOldIdentity(state, settings.settings);
      await this.#assertSnapshotUnchanged(this.#ledger(), state);
      const next = await this.#replaceState(state, { phase: "apply_pending", error_code: null });
      return publicStatus(next);
    });
  }

  async runSourceMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.#exclusive(async () => {
      if (await this.#readState()) throw new EmbeddingMigrationError("SOURCE_MUTATION_BLOCKED");
      return operation();
    });
  }

  async assertSourceMutationAllowed(): Promise<void> {
    if (await this.#readState()) throw new EmbeddingMigrationError("SOURCE_MUTATION_BLOCKED");
  }

  async assertChatTurnAllowed(): Promise<void> {
    const state = await this.#readState();
    if (
      state &&
      ["apply_pending", "live_moved", "staged_installed", "settings_updated", "complete"].includes(state.phase)
    ) {
      throw new EmbeddingMigrationError("MIGRATION_ACTIVE");
    }
  }

  /** Keep migration apply admission ordered with the complete chat accept transaction. */
  async runChatTurnAdmission<T>(operation: () => Promise<T>): Promise<T> {
    return this.#exclusive(async () => {
      await this.assertChatTurnAllowed();
      return operation();
    });
  }

  async patchSettings(patch: LlmSettingsPatch): Promise<SettingsSnapshot> {
    return this.#exclusive(async () => {
      const before = await this.#settingsStore.read();
      const preview = await this.#settingsStore.preview(patch);
      const state = await this.#readState();
      if (state && providerOrEmbeddingIdentityChanged(before.settings, preview.settings)) {
        throw new EmbeddingMigrationError("MIGRATION_ACTIVE");
      }
      if (embeddingIdentityChanged(before.settings, preview.settings)) {
        throw new EmbeddingReindexRequiredError();
      }
      return this.#settingsStore.patch(patch);
    });
  }

  /** Journal and install a pending index before any live Lance handle opens. */
  async recoverBeforeStorageOpen(): Promise<void> {
    const state = await this.#readState();
    if (!state) return;
    if (state.phase === "cancelling") {
      const paths = await this.#ownedPaths(state.id, false);
      await removeExactDirectory(paths.directory);
      await this.#removeState();
      return;
    }
    if (!["apply_pending", "live_moved", "staged_installed", "settings_updated"].includes(state.phase)) {
      return;
    }
    const handle = await this.#openStartupLedger();
    try {
      await this.#recoverSwap(handle.ledger, state);
    } finally {
      await handle.close();
    }
  }

  /** Verify the installed pair through the normal scoped SQLite/Lance retrieval join. */
  async finalizeAfterStorageOpen(): Promise<void> {
    const state = await this.#readState();
    if (!state) return;
    if (state.phase === "snapshotting") {
      await this.#replaceState(state, { phase: "failed", error_code: "SNAPSHOT_FAILED" });
      return;
    }
    if (state.phase === "building") {
      if (!this.#build) this.#launchBuild(state);
      return;
    }
    if (state.phase !== "settings_updated" && state.phase !== "complete") return;
    const paths = await this.#ownedPaths(state.id, state.phase !== "complete");
    if (state.phase === "settings_updated") {
      try {
        await verifyIndexDirectory(paths.backupIndex, state.old_dimension, state.chunk_count, state.old_model);
      } catch {
        throw new EmbeddingMigrationError("STARTUP_SMOKE_FAILED", 500);
      }
      const runtime = this.#runtime();
      if (
        runtime.vectors.dimension !== state.target_dimension ||
        runtime.vectors.embeddingModel !== resolveLlmModelId(state.target_model) ||
        (await runtime.vectors.countRows()) !== state.chunk_count
      ) {
        throw new EmbeddingMigrationError("STARTUP_SMOKE_FAILED", 500);
      }
      if (state.chunk_count > 0) {
        const first = readManifestChunks(paths.manifest, 0, 1)[0];
        if (!first) throw new EmbeddingMigrationError("STARTUP_SMOKE_FAILED", 500);
        const probe = new Array<number>(state.target_dimension).fill(0);
        probe[0] = 1;
        const passages = await retrieveWithVector(runtime.ingestion, runtime.vectors, {
          accountId: first.accountId,
          allowedSourceIds: [first.sourceId],
          vector: probe,
          topK: 1,
        });
        if (!passages.length) throw new EmbeddingMigrationError("STARTUP_SMOKE_FAILED", 500);
      }
      await this.#replaceState(state, { phase: "complete", error_code: null });
    }
    await removeExactDirectory(paths.backupIndex);
    await removeExactDirectory(paths.directory);
    await this.#removeState();
  }

  /** Restore the old paired settings/index after a failed new-index open or smoke. */
  async rollbackStartupFailure(code: "STARTUP_OPEN_FAILED" | "STARTUP_SMOKE_FAILED"): Promise<boolean> {
    const state = await this.#readState();
    if (!state || !["live_moved", "staged_installed", "settings_updated"].includes(state.phase)) return false;
    await this.#rollbackSwap(state, code);
    return true;
  }

  async close(): Promise<void> {
    this.#buildAbort?.abort(new DOMException("migration coordinator closing", "AbortError"));
    await this.#build?.catch(() => undefined);
  }

  #launchBuild(state: StoredMigrationState): void {
    const controller = new AbortController();
    this.#buildAbort = controller;
    const build = this.#buildIndex(state, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.#build === build) this.#build = undefined;
        if (this.#buildAbort === controller) this.#buildAbort = undefined;
      });
    this.#build = build;
  }

  async #buildIndex(initial: StoredMigrationState, signal: AbortSignal): Promise<void> {
    let state = initial;
    let index: LanceVectorIndex | undefined;
    try {
      const paths = await this.#ownedPaths(state.id, true);
      assertManifestMatchesState(paths.manifest, state);
      const settingsSnapshot = await this.#settingsStore.read();
      this.#assertProviderAndOldIdentity(state, settingsSnapshot.settings);
      const targetSettings: EffectiveLlmSettings = {
        ...settingsSnapshot.settings,
        embedModel: state.target_model,
        embeddingDimension: state.target_dimension,
      };
      const embed = this.#embedFactory(targetSettings, state.target_model);
      await this.#recordRemoteAudits(paths, settingsSnapshot.settings);
      index = await LanceVectorIndex.open({
        directory: paths.stagedIndex,
        dimension: state.target_dimension,
        embeddingModel: state.target_model,
      });
      let cursor = state.indexed_count;
      while (cursor < state.chunk_count) {
        throwIfAborted(signal);
        const currentSettings = await this.#settingsStore.read();
        this.#assertProviderAndOldIdentity(state, currentSettings.settings);
        const manifestRows = readManifestChunks(paths.manifest, cursor, EMBED_BATCH_SIZE);
        if (!manifestRows.length) throw new EmbeddingMigrationError("SNAPSHOT_DRIFT");
        const liveRows = await loadLiveChunks(this.#ledger(), manifestRows);
        const providerVectors = await embed(
          liveRows.map((row) => row.content),
          signal
        );
        const vectors = normalizeMigrationVectors(providerVectors, liveRows.length, state.target_dimension);
        const lanceRows: LanceVectorRow[] = liveRows.map((row, indexValue) => ({
          chunkId: row.chunkId,
          accountId: row.accountId,
          sourceId: row.sourceId,
          generation: row.generation,
          vector: vectors[indexValue]!,
        }));
        await index.upsert(lanceRows);
        cursor = manifestRows[manifestRows.length - 1]!.ordinal;
        state = await this.#replaceState(state, { indexed_count: cursor });
      }
      const finalSettings = await this.#settingsStore.read();
      this.#assertProviderAndOldIdentity(state, finalSettings.settings);
      await this.#verifyStagedIndex(index, paths, state);
      await this.#assertSnapshotUnchanged(this.#ledger(), state);
      state = await this.#replaceState(state, { phase: "ready_to_apply", error_code: null });
    } catch (error) {
      if (signal.aborted) return;
      await this.#replaceState(state, {
        phase: "failed",
        error_code: migrationCode(
          error,
          error instanceof EmbeddingMigrationError ? error.code : "EMBEDDING_UNAVAILABLE"
        ),
      }).catch(() => undefined);
    } finally {
      await index?.close().catch(() => undefined);
    }
  }

  async #verifyStagedIndex(index: LanceVectorIndex, paths: ManifestPaths, state: StoredMigrationState): Promise<void> {
    assertManifestMatchesState(paths.manifest, state);
    if ((await index.countRows()) !== state.chunk_count) throw new EmbeddingMigrationError("INDEX_VERIFY_FAILED");
    let cursor = 0;
    while (cursor < state.chunk_count) {
      const rows = readManifestChunks(paths.manifest, cursor, SNAPSHOT_PAGE_SIZE);
      if (!rows.length) throw new EmbeddingMigrationError("INDEX_VERIFY_FAILED");
      const groups = groupManifestRows(rows);
      for (const group of groups.values()) {
        if (!(await index.hasAll(group.chunkIds, group.sourceId, group.generation))) {
          throw new EmbeddingMigrationError("INDEX_VERIFY_FAILED");
        }
      }
      cursor = rows[rows.length - 1]!.ordinal;
    }
  }

  async #captureSnapshot(ledger: SqliteLedger, paths: ManifestPaths, migrationId: string): Promise<SnapshotSummary> {
    const manifest = openManifest(paths.manifest, true);
    try {
      return await ledger.withImmediateTransaction((tx) => captureManifestSnapshot(tx, manifest, migrationId));
    } finally {
      manifest.close();
      await fs.chmod(paths.manifest, 0o600).catch(() => undefined);
    }
  }

  async #assertSnapshotUnchanged(ledger: SqliteLedger, state: StoredMigrationState): Promise<void> {
    const current = await ledger.withImmediateTransaction((tx) => hashLiveSnapshot(tx, state.id));
    if (
      current.snapshotHash !== state.snapshot_hash ||
      current.sourceCount !== state.source_count ||
      current.chunkCount !== state.chunk_count
    ) {
      throw new EmbeddingMigrationError("SNAPSHOT_DRIFT");
    }
  }

  async #assertDiskBudget(paths: ManifestPaths, remainingChunks: number, dimension: number): Promise<void> {
    const stat = await this.#statfs(paths.directory, { bigint: true });
    const available = stat.bavail * stat.bsize;
    const estimatedPerRow = BigInt(dimension) * 8n + 1_024n;
    const required = BigInt(Math.max(0, remainingChunks)) * estimatedPerRow + MIN_DISK_HEADROOM_BYTES;
    if (available < required) throw new EmbeddingMigrationError("INSUFFICIENT_DISK", 507);
  }

  async #assertRemoteAccountConsent(paths: ManifestPaths, settings: EffectiveLlmSettings): Promise<void> {
    if (!isRemoteProvider(settings.llmBaseUrl)) return;
    let cursor = "";
    for (;;) {
      const batch = readManifestAccounts(paths.manifest, cursor, SNAPSHOT_PAGE_SIZE);
      if (!batch.length) return;
      const placeholders = batch.map(() => "?").join(",");
      const rows = await this.#ledger().all<{ id: string; remote_egress_ack_at: string | null }>(
        `SELECT id,remote_egress_ack_at FROM users WHERE id IN (${placeholders})`,
        batch
      );
      const consented = new Set(rows.filter((row) => row.remote_egress_ack_at).map((row) => row.id));
      if (batch.some((accountId) => !consented.has(accountId))) {
        throw new EmbeddingMigrationError("REMOTE_EGRESS_CONSENT_REQUIRED", 403);
      }
      cursor = batch[batch.length - 1]!;
    }
  }

  async #recordRemoteAudits(paths: ManifestPaths, settings: EffectiveLlmSettings): Promise<void> {
    if (!isRemoteProvider(settings.llmBaseUrl)) return;
    const host = endpointHost(settings.llmBaseUrl);
    let cursor = "";
    for (;;) {
      const accounts = readManifestAccounts(paths.manifest, cursor, SNAPSHOT_PAGE_SIZE);
      if (!accounts.length) return;
      for (const accountId of accounts) {
        try {
          await this.#audit("remote_ingest", accountId, host);
        } catch {
          // Best effort and content-free.
        }
      }
      cursor = accounts[accounts.length - 1]!;
    }
  }

  async #recoverSwap(ledger: SqliteLedger, initial: StoredMigrationState): Promise<void> {
    let state = initial;
    const paths = await this.#ownedPaths(state.id, true);
    try {
      assertManifestMatchesState(paths.manifest, state);
      if (state.phase === "apply_pending") {
        const settings = await this.#settingsStore.read();
        this.#assertProviderAndOldIdentity(state, settings.settings);
        await this.#assertSnapshotUnchanged(ledger, state);
        const live = await pathKind(this.#liveLanceDirectory);
        const backup = await pathKind(paths.backupIndex);
        const staged = await pathKind(paths.stagedIndex);
        if (live === "missing" && backup === "directory" && staged === "directory") {
          await verifyIndexDirectory(paths.backupIndex, state.old_dimension, state.chunk_count, state.old_model);
          await verifyIndexDirectory(paths.stagedIndex, state.target_dimension, state.chunk_count, state.target_model);
          state = await this.#replaceState(state, { phase: "live_moved" });
        } else if (live === "directory" && backup === "directory" && staged === "missing") {
          await verifyIndexDirectory(paths.backupIndex, state.old_dimension, state.chunk_count, state.old_model);
          await verifyIndexDirectory(
            this.#liveLanceDirectory,
            state.target_dimension,
            state.chunk_count,
            state.target_model
          );
          state = await this.#replaceState(state, { phase: "staged_installed" });
        } else {
          if (live !== "directory" || backup !== "missing" || staged !== "directory") {
            throw new EmbeddingMigrationError("STARTUP_SWAP_FAILED", 500);
          }
          await verifyIndexDirectory(this.#liveLanceDirectory, state.old_dimension, state.chunk_count, state.old_model);
          await verifyIndexDirectory(paths.stagedIndex, state.target_dimension, state.chunk_count, state.target_model);
          await fs.rename(this.#liveLanceDirectory, paths.backupIndex);
          await syncDirectory(path.dirname(this.#liveLanceDirectory));
          state = await this.#replaceState(state, { phase: "live_moved" });
        }
      }
      if (state.phase === "live_moved") {
        const live = await pathKind(this.#liveLanceDirectory);
        const backup = await pathKind(paths.backupIndex);
        const staged = await pathKind(paths.stagedIndex);
        if (backup !== "directory") throw new EmbeddingMigrationError("STARTUP_SWAP_FAILED", 500);
        await verifyIndexDirectory(paths.backupIndex, state.old_dimension, state.chunk_count, state.old_model);
        if (live === "missing" && staged === "directory") {
          await verifyIndexDirectory(paths.stagedIndex, state.target_dimension, state.chunk_count, state.target_model);
          await fs.rename(paths.stagedIndex, this.#liveLanceDirectory);
          await syncDirectory(path.dirname(this.#liveLanceDirectory));
          await syncDirectory(paths.directory);
        } else if (!(live === "directory" && staged === "missing")) {
          throw new EmbeddingMigrationError("STARTUP_SWAP_FAILED", 500);
        } else {
          await verifyIndexDirectory(
            this.#liveLanceDirectory,
            state.target_dimension,
            state.chunk_count,
            state.target_model
          );
        }
        state = await this.#replaceState(state, { phase: "staged_installed" });
      }
      if (state.phase === "staged_installed") {
        await verifyIndexDirectory(
          this.#liveLanceDirectory,
          state.target_dimension,
          state.chunk_count,
          state.target_model
        );
        await verifyIndexDirectory(paths.backupIndex, state.old_dimension, state.chunk_count, state.old_model);
        const snapshot = await this.#settingsStore.read();
        this.#assertProviderRevision(state, snapshot.settings);
        if (embeddingIdentityManaged(snapshot)) throw new EmbeddingMigrationError("ENVIRONMENT_MANAGED");
        if (!targetIdentityMatches(state, snapshot.settings)) {
          this.#assertOldIdentity(state, snapshot.settings);
          await this.#settingsStore.patch({
            embedModel: state.target_model,
            embeddingDimension: state.target_dimension,
          });
        }
        await this.#replaceState(state, { phase: "settings_updated" });
        return;
      }
      if (state.phase === "settings_updated") {
        await verifyIndexDirectory(
          this.#liveLanceDirectory,
          state.target_dimension,
          state.chunk_count,
          state.target_model
        );
        await verifyIndexDirectory(paths.backupIndex, state.old_dimension, state.chunk_count, state.old_model);
        const snapshot = await this.#settingsStore.read();
        this.#assertProviderRevision(state, snapshot.settings);
        if (embeddingIdentityManaged(snapshot) || !targetIdentityMatches(state, snapshot.settings)) {
          throw new EmbeddingMigrationError("PROVIDER_CHANGED");
        }
      }
    } catch {
      await this.#rollbackSwap(state, "STARTUP_SWAP_FAILED");
    }
  }

  async #rollbackSwap(state: StoredMigrationState, code: EmbeddingMigrationErrorCode): Promise<void> {
    const paths = await this.#ownedPaths(state.id, true);
    const backup = await pathKind(paths.backupIndex);
    if (backup === "directory") {
      const live = await pathKind(this.#liveLanceDirectory);
      if (live === "directory") {
        const staged = await pathKind(paths.stagedIndex);
        const rollbackTarget = staged === "missing" ? paths.stagedIndex : paths.failedIndex;
        if (rollbackTarget === paths.failedIndex) await removeExactDirectory(paths.failedIndex);
        await fs.rename(this.#liveLanceDirectory, rollbackTarget);
        await syncDirectory(path.dirname(this.#liveLanceDirectory));
        await syncDirectory(paths.directory);
      } else if (live !== "missing") {
        throw new EmbeddingMigrationError("STARTUP_SWAP_FAILED", 500);
      }
      await fs.rename(paths.backupIndex, this.#liveLanceDirectory);
      await syncDirectory(path.dirname(this.#liveLanceDirectory));
      await syncDirectory(paths.directory);
    }
    await verifyIndexDirectory(this.#liveLanceDirectory, state.old_dimension, state.chunk_count, state.old_model);
    const settings = await this.#settingsStore.read();
    if (!embeddingIdentityManaged(settings) && targetIdentityMatches(state, settings.settings)) {
      await this.#settingsStore.patch({
        embedModel: state.old_model,
        embeddingDimension: state.old_dimension,
      });
    }
    await this.#replaceState(state, { phase: "failed", error_code: code });
  }

  #assertProviderAndOldIdentity(state: StoredMigrationState, settings: EffectiveLlmSettings): void {
    this.#assertProviderRevision(state, settings);
    this.#assertOldIdentity(state, settings);
  }

  #assertProviderRevision(state: StoredMigrationState, settings: EffectiveLlmSettings): void {
    if (providerRevision(settings, state.id) !== state.provider_revision) {
      throw new EmbeddingMigrationError("PROVIDER_CHANGED");
    }
  }

  #assertOldIdentity(state: StoredMigrationState, settings: EffectiveLlmSettings): void {
    if (settings.embedModel !== state.old_model || settings.embeddingDimension !== state.old_dimension) {
      throw new EmbeddingMigrationError("PROVIDER_CHANGED");
    }
  }

  async #createMigrationDirectory(id: string): Promise<ManifestPaths> {
    await fs.mkdir(this.#migrationRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(this.#migrationRoot, 0o700).catch(() => undefined);
    const root = await fs.realpath(this.#migrationRoot);
    if (root !== this.#migrationRoot) throw new EmbeddingMigrationError("STATE_INVALID", 500);
    const paths = this.#pathsForId(id);
    await fs.mkdir(paths.directory, { mode: 0o700 });
    const real = await fs.realpath(paths.directory);
    if (real !== paths.directory) throw new EmbeddingMigrationError("STATE_INVALID", 500);
    return paths;
  }

  async #ownedPaths(id: string, requireDirectory: boolean): Promise<ManifestPaths> {
    const paths = this.#pathsForId(id);
    const rootReal = await fs.realpath(this.#migrationRoot).catch((error: unknown) => {
      if (!requireDirectory && isNodeError(error) && error.code === "ENOENT") return this.#migrationRoot;
      throw error;
    });
    if (rootReal !== this.#migrationRoot) throw new EmbeddingMigrationError("STATE_INVALID", 500);
    const kind = await pathKind(paths.directory);
    if (requireDirectory && kind !== "directory") throw new EmbeddingMigrationError("STATE_INVALID", 500);
    if (kind === "directory" && (await fs.realpath(paths.directory)) !== paths.directory) {
      throw new EmbeddingMigrationError("STATE_INVALID", 500);
    }
    return paths;
  }

  #pathsForId(id: string): ManifestPaths {
    if (!UUID_PATTERN.test(id)) throw new EmbeddingMigrationError("STATE_INVALID", 500);
    const directory = path.join(this.#migrationRoot, id);
    if (path.dirname(directory) !== this.#migrationRoot) throw new EmbeddingMigrationError("STATE_INVALID", 500);
    return {
      directory,
      manifest: path.join(directory, "manifest.sqlite"),
      stagedIndex: path.join(directory, "staged-index"),
      backupIndex: path.join(directory, "live-backup"),
      failedIndex: path.join(directory, "failed-index"),
    };
  }

  async #requiredState(): Promise<StoredMigrationState> {
    const state = await this.#readState();
    if (!state) throw new EmbeddingMigrationError("NO_FAILED_MIGRATION", 404);
    return state;
  }

  async #readState(): Promise<StoredMigrationState | undefined> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(this.#stateFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > STATE_MAX_BYTES) throw new EmbeddingMigrationError("STATE_INVALID", 500);
      if ((stat.mode & 0o777) !== 0o600) await handle.chmod(0o600);
      const contents = await handle.readFile("utf8");
      return decodeState(JSON.parse(contents));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      if (error instanceof EmbeddingMigrationError) throw error;
      throw new EmbeddingMigrationError("STATE_INVALID", 500);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #replaceState(
    current: StoredMigrationState,
    patch: Partial<Omit<StoredMigrationState, "version" | "id" | "created_at">>
  ): Promise<StoredMigrationState> {
    const next = decodeState({ ...current, ...patch, updated_at: this.#now().toISOString() });
    await this.#writeState(next);
    return next;
  }

  async #writeState(state: StoredMigrationState): Promise<void> {
    await writePrivateJsonAtomically(this.#stateFile, decodeState(state));
  }

  async #removeState(): Promise<void> {
    await fs.unlink(this.#stateFile).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation, operation);
    this.#tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

export class EmbeddingReindexRequiredError extends Error {
  readonly code = "EMBEDDING_REINDEX_REQUIRED";

  constructor() {
    super("embedding reindex is required");
    this.name = "EmbeddingReindexRequiredError";
  }
}

let singleton: EmbeddingMigrationCoordinator | undefined;
let singletonIdentity: string | undefined;

export function embeddingMigrationCoordinator(): EmbeddingMigrationCoordinator {
  const paths = configuredMigrationPaths();
  const identity = `${paths.sqlitePath}\0${paths.lanceDirectory}`;
  if (singletonIdentity !== identity) {
    singleton = undefined;
    singletonIdentity = identity;
  }
  singleton ??= new EmbeddingMigrationCoordinator({
    stateFile: path.join(paths.storageDirectory, "embedding-migration.json"),
    migrationRoot: path.join(path.dirname(paths.lanceDirectory), `.${path.basename(paths.lanceDirectory)}-migrations`),
    liveLanceDirectory: paths.lanceDirectory,
    settingsStore: runtimeSettingsStore(),
    ledger: () => storageRuntime().ledger,
    runtime: storageRuntime,
    openStartupLedger: async () => {
      const ledger = await openSqliteLedger({ path: paths.sqlitePath });
      return { ledger, close: () => ledger.close() };
    },
  });
  return singleton;
}

export async function closeEmbeddingMigrationCoordinator(): Promise<void> {
  const current = singleton;
  singleton = undefined;
  singletonIdentity = undefined;
  await current?.close();
}

function configuredMigrationPaths(): {
  readonly storageDirectory: string;
  readonly sqlitePath: string;
  readonly lanceDirectory: string;
} {
  try {
    const runtime = storageRuntime();
    return {
      storageDirectory: path.dirname(runtime.sqlitePath),
      sqlitePath: runtime.sqlitePath,
      lanceDirectory: runtime.lanceDirectory,
    };
  } catch {
    // Startup constructs the coordinator before the paired runtime opens.
  }
  if (typeof config.sqlitePath === "string" && typeof config.lanceDir === "string") {
    return {
      storageDirectory:
        typeof config.storageDir === "string"
          ? path.resolve(config.storageDir)
          : path.dirname(path.resolve(config.sqlitePath)),
      sqlitePath: path.resolve(config.sqlitePath),
      lanceDirectory: path.resolve(config.lanceDir),
    };
  }
  throw new Error("embedding migration storage paths are unavailable");
}

function captureManifestSnapshot(
  tx: SqliteTransaction,
  manifest: Database.Database,
  migrationId: string
): SnapshotSummary {
  const busy = tx.get<{ busy: bigint }>(
    `SELECT EXISTS(
       SELECT 1 FROM sources WHERE status='index'
       UNION ALL SELECT 1 FROM ingestion_jobs WHERE status IN ('preparing','pending','running')
       UNION ALL SELECT 1 FROM pending_vector_ops
       UNION ALL SELECT 1 FROM pending_source_deletes
     ) AS busy`
  );
  if (Number(busy?.busy ?? 0) !== 0) throw new EmbeddingMigrationError("INGESTION_BUSY");

  const counts = tx.get<{ source_count: bigint; chunk_count: bigint }>(
    `SELECT
       (SELECT count(*) FROM sources WHERE status='ready' AND ready_generation IS NOT NULL) AS source_count,
       (SELECT count(*)
          FROM chunks c JOIN sources s
            ON s.id=c.source_id AND s.account_id=c.account_id AND s.ready_generation=c.generation
         WHERE s.status='ready') AS chunk_count`
  );
  const sourceCount = Number(counts?.source_count ?? 0);
  const chunkCount = Number(counts?.chunk_count ?? 0);
  if (sourceCount > MAX_MIGRATION_SOURCES || chunkCount > MAX_MIGRATION_CHUNKS) {
    throw new EmbeddingMigrationError("MIGRATION_TOO_LARGE", 413);
  }

  const hash = createHash("sha256");
  hashRecord(hash, ["migration", migrationId]);
  let sourceOrdinal = 0;
  let sourceCursor = "";
  let chunkOrdinal = 0;
  let chunkCursor = "";
  const insertSource = manifest.prepare(
    "INSERT INTO manifest_sources (ordinal,account_id,source_id,generation,chunk_count) VALUES (?,?,?,?,?)"
  );
  const insertChunk = manifest.prepare(
    `INSERT INTO manifest_chunks
       (ordinal,chunk_id,account_id,source_id,generation,seq,content_hash)
     VALUES (?,?,?,?,?,?,?)`
  );
  const insertAccount = manifest.prepare("INSERT OR IGNORE INTO manifest_accounts (account_id) VALUES (?)");
  manifest.exec("BEGIN IMMEDIATE");
  try {
    for (;;) {
      const rows = tx.all<{
        id: string;
        account_id: string;
        ready_generation: bigint;
        chunk_count: bigint;
      }>(
        `SELECT s.id,s.account_id,s.ready_generation,count(c.id) AS chunk_count
           FROM sources s
           LEFT JOIN chunks c
             ON c.source_id=s.id AND c.account_id=s.account_id AND c.generation=s.ready_generation
          WHERE s.status='ready' AND s.ready_generation IS NOT NULL AND s.id>?
          GROUP BY s.id,s.account_id,s.ready_generation
          ORDER BY s.id LIMIT ?`,
        [sourceCursor, SNAPSHOT_PAGE_SIZE]
      );
      if (!rows.length) break;
      for (const row of rows) {
        sourceOrdinal += 1;
        const generation = safeNonnegativeInteger(row.ready_generation);
        const rowChunkCount = safeNonnegativeInteger(row.chunk_count);
        insertSource.run(sourceOrdinal, row.account_id, row.id, generation, rowChunkCount);
        insertAccount.run(row.account_id);
        hashRecord(hash, ["source", row.account_id, row.id, generation, rowChunkCount]);
      }
      sourceCursor = rows[rows.length - 1]!.id;
    }

    for (;;) {
      const rows = tx.all<{
        id: string;
        account_id: string;
        source_id: string;
        generation: bigint;
        seq: bigint;
        content: string;
      }>(
        `SELECT c.id,c.account_id,c.source_id,c.generation,c.seq,c.content
           FROM chunks c
           JOIN sources s
             ON s.id=c.source_id AND s.account_id=c.account_id AND s.ready_generation=c.generation
          WHERE s.status='ready' AND c.id>?
          ORDER BY c.id LIMIT ?`,
        [chunkCursor, SNAPSHOT_PAGE_SIZE]
      );
      if (!rows.length) break;
      for (const row of rows) {
        chunkOrdinal += 1;
        const generation = safeNonnegativeInteger(row.generation);
        const seq = safeNonnegativeInteger(row.seq);
        const contentHash = hashContent(migrationId, row.content);
        insertChunk.run(chunkOrdinal, row.id, row.account_id, row.source_id, generation, seq, contentHash);
        hashRecord(hash, ["chunk", row.id, row.account_id, row.source_id, generation, seq, contentHash]);
      }
      chunkCursor = rows[rows.length - 1]!.id;
    }
    if (sourceOrdinal !== sourceCount || chunkOrdinal !== chunkCount) {
      throw new EmbeddingMigrationError("SNAPSHOT_FAILED");
    }
    const snapshotHash = hash.digest("hex");
    const insertMeta = manifest.prepare("INSERT INTO manifest_meta (key,value) VALUES (?,?)");
    insertMeta.run("version", String(MANIFEST_VERSION));
    insertMeta.run("migration_id", migrationId);
    insertMeta.run("snapshot_hash", snapshotHash);
    insertMeta.run("source_count", String(sourceCount));
    insertMeta.run("chunk_count", String(chunkCount));
    manifest.exec("COMMIT");
    return { sourceCount, chunkCount, snapshotHash };
  } catch (error) {
    if (manifest.inTransaction) manifest.exec("ROLLBACK");
    throw error;
  }
}

function hashLiveSnapshot(tx: SqliteTransaction, migrationId: string): SnapshotSummary {
  const hash = createHash("sha256");
  hashRecord(hash, ["migration", migrationId]);
  let sourceCount = 0;
  let chunkCount = 0;
  let sourceCursor = "";
  let chunkCursor = "";
  for (;;) {
    const rows = tx.all<{ id: string; account_id: string; ready_generation: bigint; chunk_count: bigint }>(
      `SELECT s.id,s.account_id,s.ready_generation,count(c.id) AS chunk_count
         FROM sources s
         LEFT JOIN chunks c
           ON c.source_id=s.id AND c.account_id=s.account_id AND c.generation=s.ready_generation
        WHERE s.status='ready' AND s.ready_generation IS NOT NULL AND s.id>?
        GROUP BY s.id,s.account_id,s.ready_generation
        ORDER BY s.id LIMIT ?`,
      [sourceCursor, SNAPSHOT_PAGE_SIZE]
    );
    if (!rows.length) break;
    for (const row of rows) {
      sourceCount += 1;
      hashRecord(hash, [
        "source",
        row.account_id,
        row.id,
        safeNonnegativeInteger(row.ready_generation),
        safeNonnegativeInteger(row.chunk_count),
      ]);
    }
    sourceCursor = rows[rows.length - 1]!.id;
  }
  for (;;) {
    const rows = tx.all<{
      id: string;
      account_id: string;
      source_id: string;
      generation: bigint;
      seq: bigint;
      content: string;
    }>(
      `SELECT c.id,c.account_id,c.source_id,c.generation,c.seq,c.content
         FROM chunks c
         JOIN sources s
           ON s.id=c.source_id AND s.account_id=c.account_id AND s.ready_generation=c.generation
        WHERE s.status='ready' AND c.id>?
        ORDER BY c.id LIMIT ?`,
      [chunkCursor, SNAPSHOT_PAGE_SIZE]
    );
    if (!rows.length) break;
    for (const row of rows) {
      chunkCount += 1;
      const generation = safeNonnegativeInteger(row.generation);
      const seq = safeNonnegativeInteger(row.seq);
      const contentHash = hashContent(migrationId, row.content);
      hashRecord(hash, ["chunk", row.id, row.account_id, row.source_id, generation, seq, contentHash]);
    }
    chunkCursor = rows[rows.length - 1]!.id;
  }
  return { sourceCount, chunkCount, snapshotHash: hash.digest("hex") };
}

async function loadLiveChunks(ledger: SqliteLedger, manifestRows: readonly ManifestChunk[]): Promise<LiveChunk[]> {
  if (!manifestRows.length || manifestRows.length > EMBED_BATCH_SIZE) {
    throw new EmbeddingMigrationError("SNAPSHOT_DRIFT");
  }
  const placeholders = manifestRows.map(() => "?").join(",");
  const rows = await ledger.all<{
    id: string;
    account_id: string;
    source_id: string;
    generation: bigint;
    seq: bigint;
    content: string;
  }>(
    `SELECT id,account_id,source_id,generation,seq,content FROM chunks WHERE id IN (${placeholders})`,
    manifestRows.map((row) => row.chunkId)
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return manifestRows.map((manifest) => {
    const row = byId.get(manifest.chunkId);
    if (
      !row ||
      row.account_id !== manifest.accountId ||
      row.source_id !== manifest.sourceId ||
      safeNonnegativeInteger(row.generation) !== manifest.generation ||
      safeNonnegativeInteger(row.seq) !== manifest.seq ||
      hashContent(manifest.migrationId, row.content) !== manifest.contentHash
    ) {
      throw new EmbeddingMigrationError("SNAPSHOT_DRIFT");
    }
    return { ...manifest, content: row.content };
  });
}

function readManifestChunks(filename: string, afterOrdinal: number, limit: number): ManifestChunk[] {
  const database = openManifest(filename, false);
  try {
    assertManifestMeta(database);
    const migrationId = manifestMeta(database, "migration_id");
    const rows = database
      .prepare(
        `SELECT ordinal,chunk_id,account_id,source_id,generation,seq,content_hash
           FROM manifest_chunks WHERE ordinal>? ORDER BY ordinal LIMIT ?`
      )
      .all(afterOrdinal, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const contentHash = requiredHash(row.content_hash);
      return {
        ordinal: positiveInteger(row.ordinal),
        chunkId: requiredString(row.chunk_id),
        accountId: requiredString(row.account_id),
        sourceId: requiredString(row.source_id),
        generation: safeNonnegativeInteger(row.generation),
        seq: safeNonnegativeInteger(row.seq),
        contentHash,
        migrationId,
      };
    });
  } finally {
    database.close();
  }
}

function readManifestAccounts(filename: string, afterAccountId: string, limit: number): string[] {
  const database = openManifest(filename, false);
  try {
    assertManifestMeta(database);
    return (
      database
        .prepare("SELECT account_id FROM manifest_accounts WHERE account_id>? ORDER BY account_id LIMIT ?")
        .all(afterAccountId, limit) as Array<{ account_id: unknown }>
    ).map((row) => requiredString(row.account_id));
  } finally {
    database.close();
  }
}

function openManifest(filename: string, create: boolean): Database.Database {
  if (create) assertManifestMissing(filename);
  else assertManifestFile(filename);
  const database = new Database(filename, create ? undefined : { readonly: true, fileMustExist: true });
  try {
    if (create) chmodSync(filename, 0o600);
    assertManifestFile(filename);
    database.pragma("trusted_schema = OFF");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    if (create) {
      database.pragma("journal_mode = DELETE");
      database.pragma("synchronous = FULL");
      database.exec(`
        CREATE TABLE manifest_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE manifest_accounts (account_id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE manifest_sources (
          ordinal INTEGER PRIMARY KEY,
          account_id TEXT NOT NULL,
          source_id TEXT NOT NULL UNIQUE,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0)
        ) STRICT;
        CREATE TABLE manifest_chunks (
          ordinal INTEGER PRIMARY KEY,
          chunk_id TEXT NOT NULL UNIQUE,
          account_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          seq INTEGER NOT NULL CHECK (seq >= 0),
          content_hash TEXT NOT NULL,
          FOREIGN KEY (source_id) REFERENCES manifest_sources(source_id)
        ) STRICT;
        CREATE INDEX manifest_chunks_source_idx ON manifest_chunks (source_id,generation,seq);
      `);
    }
    database.defaultSafeIntegers(true);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function assertManifestMissing(filename: string): void {
  try {
    lstatSync(filename);
    throw new EmbeddingMigrationError("STATE_INVALID", 500);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function assertManifestFile(filename: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(filename);
  } catch {
    throw new EmbeddingMigrationError("STATE_INVALID", 500);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(filename) !== path.resolve(filename)) {
    throw new EmbeddingMigrationError("STATE_INVALID", 500);
  }
}

function assertManifestMeta(database: Database.Database): void {
  const version = manifestMeta(database, "version");
  if (version !== String(MANIFEST_VERSION) || !UUID_PATTERN.test(manifestMeta(database, "migration_id"))) {
    throw new EmbeddingMigrationError("STATE_INVALID", 500);
  }
  requiredHash(manifestMeta(database, "snapshot_hash"));
}

function assertManifestMatchesState(filename: string, state: StoredMigrationState): void {
  const database = openManifest(filename, false);
  try {
    assertManifestMeta(database);
    if (
      manifestMeta(database, "migration_id") !== state.id ||
      manifestMeta(database, "snapshot_hash") !== state.snapshot_hash ||
      Number(manifestMeta(database, "source_count")) !== state.source_count ||
      Number(manifestMeta(database, "chunk_count")) !== state.chunk_count
    ) {
      throw new EmbeddingMigrationError("STATE_INVALID", 500);
    }
  } finally {
    database.close();
  }
}

function manifestMeta(database: Database.Database, key: string): string {
  const row = database.prepare("SELECT value FROM manifest_meta WHERE key=?").get(key) as
    { value?: unknown } | undefined;
  return requiredString(row?.value);
}

function groupManifestRows(
  rows: readonly ManifestChunk[]
): Map<string, { sourceId: string; generation: number; chunkIds: string[] }> {
  const groups = new Map<string, { sourceId: string; generation: number; chunkIds: string[] }>();
  for (const row of rows) {
    const key = `${row.sourceId}\0${row.generation}`;
    const group = groups.get(key) ?? { sourceId: row.sourceId, generation: row.generation, chunkIds: [] };
    group.chunkIds.push(row.chunkId);
    groups.set(key, group);
  }
  return groups;
}

function normalizeMigrationVectors(vectors: number[][], expectedCount: number, dimension: number): number[][] {
  if (vectors.length !== expectedCount) {
    throw new EmbeddingMigrationError("EMBEDDING_INVALID");
  }
  try {
    return vectors.map((vector) => normalizeEmbeddingVector(vector, dimension));
  } catch {
    throw new EmbeddingMigrationError("EMBEDDING_INVALID");
  }
}

function providerRevision(settings: EffectiveLlmSettings, migrationId: string): string {
  const hash = createHash("sha256");
  hashRecord(hash, ["provider", migrationId, settings.llmBaseUrl, settings.chatModel, settings.apiKey ?? ""]);
  return hash.digest("hex");
}

function embeddingIdentityChanged(left: EffectiveLlmSettings, right: EffectiveLlmSettings): boolean {
  return left.embedModel !== right.embedModel || left.embeddingDimension !== right.embeddingDimension;
}

function providerOrEmbeddingIdentityChanged(left: EffectiveLlmSettings, right: EffectiveLlmSettings): boolean {
  return providerIdentityChanged(left, right) || embeddingIdentityChanged(left, right);
}

function providerIdentityChanged(left: EffectiveLlmSettings, right: EffectiveLlmSettings): boolean {
  return left.llmBaseUrl !== right.llmBaseUrl || left.apiKey !== right.apiKey || left.chatModel !== right.chatModel;
}

function assertQualificationStillCurrent(
  current: EffectiveLlmSettings,
  target: { model: string; dimension: number },
  qualification: EmbeddingMigrationQualification
): void {
  if (
    providerOrEmbeddingIdentityChanged(current, qualification.baseline) ||
    providerIdentityChanged(qualification.baseline, qualification.target) ||
    qualification.target.embedModel !== target.model.trim() ||
    qualification.target.embeddingDimension !== target.dimension
  ) {
    throw new EmbeddingMigrationError("PROVIDER_CHANGED");
  }
}

function embeddingIdentityManaged(snapshot: SettingsSnapshot): boolean {
  return (
    snapshot.environmentOverrides.includes("default_embed_model") ||
    snapshot.environmentOverrides.includes("embedding_dimension")
  );
}

function assertTarget(snapshot: SettingsSnapshot, target: { model: string; dimension: number }): void {
  const model = typeof target.model === "string" ? target.model.trim() : "";
  if (!model || model.length > 256 || containsControlCharacter(model)) {
    throw new EmbeddingMigrationError("STATE_INVALID", 400);
  }
  if (!Number.isSafeInteger(target.dimension) || target.dimension < 1 || target.dimension > 16_384) {
    throw new EmbeddingMigrationError("STATE_INVALID", 400);
  }
  if (embeddingIdentityManaged(snapshot)) {
    throw new EmbeddingMigrationError("ENVIRONMENT_MANAGED");
  }
  if (snapshot.settings.embedModel === model && snapshot.settings.embeddingDimension === target.dimension) {
    throw new EmbeddingMigrationError("TARGET_UNCHANGED", 400);
  }
}

function targetIdentityMatches(state: StoredMigrationState, settings: EffectiveLlmSettings): boolean {
  return settings.embedModel === state.target_model && settings.embeddingDimension === state.target_dimension;
}

function publicStatus(state: StoredMigrationState | undefined): EmbeddingMigrationStatus {
  if (!state) {
    return {
      phase: "idle",
      target_model: null,
      target_dimension: null,
      source_count: 0,
      chunk_count: 0,
      indexed_count: 0,
      error_code: null,
      restart_required: false,
      can_cancel: false,
      can_retry: false,
      can_apply: false,
    };
  }
  let phase: PublicEmbeddingMigrationPhase;
  switch (state.phase) {
    case "cancelling":
      phase = "building";
      break;
    case "live_moved":
    case "staged_installed":
    case "settings_updated":
    case "complete":
      phase = "apply_pending";
      break;
    default:
      phase = state.phase;
  }
  return {
    phase,
    target_model: state.target_model,
    target_dimension: state.target_dimension,
    source_count: state.source_count,
    chunk_count: state.chunk_count,
    indexed_count: state.indexed_count,
    error_code: state.error_code,
    restart_required: phase === "apply_pending",
    can_cancel: ![
      "apply_pending",
      "cancelling",
      "live_moved",
      "staged_installed",
      "settings_updated",
      "complete",
    ].includes(state.phase),
    can_retry: state.phase === "failed",
    can_apply: state.phase === "ready_to_apply",
  };
}

function decodeState(input: unknown): StoredMigrationState {
  if (!isRecord(input)) throw new EmbeddingMigrationError("STATE_INVALID", 500);
  const allowed = new Set([
    "version",
    "id",
    "phase",
    "target_model",
    "target_dimension",
    "old_model",
    "old_dimension",
    "provider_revision",
    "snapshot_hash",
    "source_count",
    "chunk_count",
    "indexed_count",
    "error_code",
    "created_at",
    "updated_at",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)) || input.version !== STATE_VERSION) {
    throw new EmbeddingMigrationError("STATE_INVALID", 500);
  }
  const phases: EmbeddingMigrationPhase[] = [
    "snapshotting",
    "building",
    "ready_to_apply",
    "apply_pending",
    "cancelling",
    "live_moved",
    "staged_installed",
    "settings_updated",
    "complete",
    "failed",
  ];
  const errorCodes: EmbeddingMigrationErrorCode[] = [
    "MIGRATION_ACTIVE",
    "TARGET_UNCHANGED",
    "NO_READY_SOURCES",
    "SOURCE_MUTATION_BLOCKED",
    "INGESTION_BUSY",
    "REMOTE_EGRESS_CONSENT_REQUIRED",
    "ENVIRONMENT_MANAGED",
    "PROVIDER_CHANGED",
    "SNAPSHOT_FAILED",
    "SNAPSHOT_DRIFT",
    "MIGRATION_TOO_LARGE",
    "INSUFFICIENT_DISK",
    "EMBEDDING_UNAVAILABLE",
    "EMBEDDING_INVALID",
    "INDEX_VERIFY_FAILED",
    "NOT_READY_TO_APPLY",
    "CANNOT_CANCEL_AFTER_SWAP",
    "NO_FAILED_MIGRATION",
    "STATE_INVALID",
    "STARTUP_SWAP_FAILED",
    "STARTUP_OPEN_FAILED",
    "STARTUP_SMOKE_FAILED",
  ];
  if (
    typeof input.id !== "string" ||
    !UUID_PATTERN.test(input.id) ||
    typeof input.phase !== "string" ||
    !phases.includes(input.phase as EmbeddingMigrationPhase) ||
    typeof input.target_model !== "string" ||
    !input.target_model ||
    input.target_model.length > 256 ||
    typeof input.old_model !== "string" ||
    !input.old_model ||
    input.old_model.length > 256 ||
    !validDimension(input.target_dimension) ||
    !validDimension(input.old_dimension) ||
    typeof input.provider_revision !== "string" ||
    !HASH_PATTERN.test(input.provider_revision) ||
    (input.snapshot_hash !== null &&
      (typeof input.snapshot_hash !== "string" || !HASH_PATTERN.test(input.snapshot_hash))) ||
    !validCount(input.source_count, MAX_MIGRATION_SOURCES) ||
    !validCount(input.chunk_count, MAX_MIGRATION_CHUNKS) ||
    !validCount(input.indexed_count, MAX_MIGRATION_CHUNKS) ||
    Number(input.indexed_count) > Number(input.chunk_count) ||
    (input.error_code !== null &&
      (typeof input.error_code !== "string" ||
        !errorCodes.includes(input.error_code as EmbeddingMigrationErrorCode))) ||
    typeof input.created_at !== "string" ||
    !validIsoDate(input.created_at) ||
    typeof input.updated_at !== "string" ||
    !validIsoDate(input.updated_at)
  ) {
    throw new EmbeddingMigrationError("STATE_INVALID", 500);
  }
  return Object.freeze(input as unknown as StoredMigrationState);
}

async function writePrivateJsonAtomically(filename: string, value: unknown): Promise<void> {
  const directory = path.dirname(filename);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filename);
    await fs.chmod(filename, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // File fsync is authoritative where directory fsync is unavailable.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function verifyIndexDirectory(
  directory: string,
  dimension: number,
  count: number,
  embeddingModel: string,
  allowLegacyIdentityAdoption = false
): Promise<void> {
  if ((await pathKind(directory)) !== "directory") {
    throw new EmbeddingMigrationError("INDEX_VERIFY_FAILED");
  }
  const index = await LanceVectorIndex.open({
    directory,
    dimension,
    embeddingModel,
    allowLegacyIdentityAdoption,
    requireExistingTable: true,
  });
  try {
    if ((await index.countRows()) !== count) throw new EmbeddingMigrationError("INDEX_VERIFY_FAILED");
  } finally {
    await index.close();
  }
}

async function removeExactDirectory(directory: string): Promise<void> {
  const kind = await pathKind(directory);
  if (kind === "missing") return;
  if (kind !== "directory" || (await fs.realpath(directory)) !== directory) {
    throw new EmbeddingMigrationError("STATE_INVALID", 500);
  }
  await fs.rm(directory, { recursive: true, force: false });
}

async function pathKind(filename: string): Promise<"missing" | "directory" | "other"> {
  try {
    const stat = await fs.lstat(filename);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "other";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing";
    throw error;
  }
}

function hashRecord(hash: ReturnType<typeof createHash>, fields: readonly (string | number)[]): void {
  for (const field of fields) {
    const value = String(field);
    hash.update(String(Buffer.byteLength(value, "utf8")));
    hash.update(":");
    hash.update(value);
    hash.update(";");
  }
}

function hashContent(migrationId: string, content: string): string {
  return createHash("sha256").update(migrationId).update("\0").update(content).digest("hex");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
}

function migrationCode(error: unknown, fallback: EmbeddingMigrationErrorCode): EmbeddingMigrationErrorCode {
  return error instanceof EmbeddingMigrationError ? error.code : fallback;
}

function publicMigrationError(code: EmbeddingMigrationErrorCode): string {
  const messages: Record<EmbeddingMigrationErrorCode, string> = {
    MIGRATION_ACTIVE: "an embedding migration is already active",
    TARGET_UNCHANGED: "the target embedding identity is already configured",
    NO_READY_SOURCES: "no ready sources require embedding migration",
    SOURCE_MUTATION_BLOCKED: "source changes are paused during embedding migration",
    INGESTION_BUSY: "ingestion must finish before embedding migration starts",
    REMOTE_EGRESS_CONSENT_REQUIRED: "remote egress consent is required for every affected account",
    ENVIRONMENT_MANAGED: "embedding settings are managed by environment",
    PROVIDER_CHANGED: "model provider settings changed during embedding migration",
    SNAPSHOT_FAILED: "the embedding snapshot could not be created",
    SNAPSHOT_DRIFT: "the source snapshot changed during embedding migration",
    MIGRATION_TOO_LARGE: "the workspace exceeds the embedding migration limit",
    INSUFFICIENT_DISK: "insufficient disk space for embedding migration",
    EMBEDDING_UNAVAILABLE: "the embedding provider was unavailable",
    EMBEDDING_INVALID: "the embedding provider returned an invalid vector",
    INDEX_VERIFY_FAILED: "the staged embedding index could not be verified",
    NOT_READY_TO_APPLY: "the embedding migration is not ready to apply",
    CANNOT_CANCEL_AFTER_SWAP: "an applied embedding migration requires a reverse migration",
    NO_FAILED_MIGRATION: "there is no failed embedding migration to retry",
    STATE_INVALID: "embedding migration state is invalid",
    STARTUP_SWAP_FAILED: "the embedding index could not be installed safely",
    STARTUP_OPEN_FAILED: "the installed embedding index could not be opened",
    STARTUP_SMOKE_FAILED: "the installed embedding index failed verification",
  };
  return messages[code];
}

function safeNonnegativeInteger(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) < 0) throw new EmbeddingMigrationError("STATE_INVALID", 500);
  return Number(number);
}

function positiveInteger(value: unknown): number {
  const number = safeNonnegativeInteger(value);
  if (number < 1) throw new EmbeddingMigrationError("STATE_INVALID", 500);
  return number;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1_024 || value.includes("\0")) {
    throw new EmbeddingMigrationError("STATE_INVALID", 500);
  }
  return value;
}

function requiredHash(value: unknown): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new EmbeddingMigrationError("STATE_INVALID", 500);
  }
  return value;
}

function validDimension(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 16_384;
}

function validCount(value: unknown, maximum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function validIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
