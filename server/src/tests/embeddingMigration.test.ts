import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeJson } from "../db/codecs.js";
import { openSqliteLedger } from "../db/sqlite.js";
import {
  EmbeddingMigrationCoordinator,
  EmbeddingMigrationError,
  EmbeddingReindexRequiredError,
} from "../embeddingMigration.js";
import { IngestionExecutor, type IngestionDataOperations } from "../ingestionEngine.js";
import { createSettingsStore, type EffectiveLlmSettings, type SettingsStore } from "../settingsStore.js";
import { closeStorageRuntime, initializeStorageRuntime, type StorageRuntime } from "../storageRuntime.js";
import { retrieveWithVector } from "../vector/retrieve.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT = "22222222-2222-4222-8222-222222222222";

interface Harness {
  readonly root: string;
  readonly stateFile: string;
  readonly migrationRoot: string;
  readonly lanceDirectory: string;
  readonly sqlitePath: string;
  readonly settingsFile: string;
  readonly store: SettingsStore;
  readonly coordinator: EmbeddingMigrationCoordinator;
  runtime: StorageRuntime;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.map((harness) => harness.coordinator.close().catch(() => undefined)));
  await closeStorageRuntime();
  await Promise.all(harnesses.splice(0).map((harness) => fs.rm(harness.root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function createHarness(
  options: {
    readonly embed?: (
      settings: EffectiveLlmSettings,
      model: string
    ) => (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
    readonly audit?: (
      kind: "consent_acknowledged" | "remote_turn" | "remote_ingest",
      account: string,
      host?: string | null
    ) => Promise<void>;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly seed?: boolean;
  } = {}
): Promise<Harness> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-embedding-migration-")));
  const sqlitePath = path.join(root, "borealis.sqlite");
  const lanceDirectory = path.join(root, "lancedb");
  const settingsFile = path.join(root, "settings.json");
  const stateFile = path.join(root, "embedding-migration.json");
  const migrationRoot = path.join(root, ".lancedb-migrations");
  const store = createSettingsStore({ path: settingsFile, env: options.env ?? {} });
  await store.patch({ chatModel: "chat-model", embedModel: "old-embed", embeddingDimension: 3 });
  const runtime = await initializeStorageRuntime({
    sqlitePath,
    lanceDirectory,
    embeddingDimension: 3,
    embeddingModel: "old-embed",
  });
  const harness = {} as Harness;
  const coordinator = new EmbeddingMigrationCoordinator({
    stateFile,
    migrationRoot,
    liveLanceDirectory: lanceDirectory,
    settingsStore: store,
    ledger: () => harness.runtime.ledger,
    runtime: () => harness.runtime,
    openStartupLedger: async () => {
      const ledger = await openSqliteLedger({ path: sqlitePath });
      return { ledger, close: () => ledger.close() };
    },
    embedFactory:
      options.embed ??
      ((settings) => async (texts) => texts.map((_text, index) => unitVector(settings.embeddingDimension, index))),
    ...(options.audit ? { audit: options.audit } : {}),
  });
  Object.assign(harness, {
    root,
    stateFile,
    migrationRoot,
    lanceDirectory,
    sqlitePath,
    settingsFile,
    store,
    coordinator,
    runtime,
  });
  harnesses.push(harness);
  await seedAccount(harness.runtime, ACCOUNT, "owner@example.test");
  if (options.seed !== false) await seedReadySource(harness.runtime, ACCOUNT, "first passage", [1, 0, 0]);
  return harness;
}

describe("durable embedding migration coordinator", () => {
  it("does not strand the workspace behind migration state when ingestion is busy", async () => {
    const busy = await createHarness();
    const source = await busy.runtime.ledger.get<{ id: string }>("SELECT id FROM sources WHERE account_id=?", [
      ACCOUNT,
    ]);
    const now = new Date().toISOString();
    await busy.runtime.ledger.run(
      `INSERT INTO ingestion_jobs
         (source_id,account_id,generation,status,attempts,available_at,created_at,updated_at)
       VALUES (?,?,2,'pending',0,?,?,?)`,
      [source!.id, ACCOUNT, now, now, now]
    );
    await expect(busy.coordinator.start({ model: "new-embed", dimension: 5 })).rejects.toMatchObject({
      code: "INGESTION_BUSY",
    });
    await expect(busy.coordinator.status()).resolves.toMatchObject({ phase: "idle" });
    await expect(busy.coordinator.runSourceMutation(async () => "allowed")).resolves.toBe("allowed");
  });

  it("migrates an empty live index before persisting a new embedding identity", async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => unitVector(5, 0)));
    const embedFactory = vi.fn(() => embed);
    const harness = await createHarness({ seed: false, embed: embedFactory });

    await expect(
      harness.coordinator.patchSettings({ embedModel: "new-embed", embeddingDimension: 5 })
    ).rejects.toBeInstanceOf(EmbeddingReindexRequiredError);
    await expect(harness.store.read()).resolves.toMatchObject({
      settings: { embedModel: "old-embed", embeddingDimension: 3 },
    });
    expect(harness.runtime.vectors.dimension).toBe(3);

    await expect(harness.coordinator.start({ model: "new-embed", dimension: 5 })).resolves.toMatchObject({
      phase: "building",
      source_count: 0,
      chunk_count: 0,
    });
    await expect(waitForPhase(harness.coordinator, "ready_to_apply")).resolves.toMatchObject({
      source_count: 0,
      chunk_count: 0,
      indexed_count: 0,
      can_apply: true,
    });
    expect(embedFactory).toHaveBeenCalledOnce();
    expect(embed).not.toHaveBeenCalled();

    await harness.coordinator.requestApply();
    await closeStorageRuntime();
    await harness.coordinator.recoverBeforeStorageOpen();
    await expect(harness.store.read()).resolves.toMatchObject({
      settings: { embedModel: "new-embed", embeddingDimension: 5 },
    });
    harness.runtime = await initializeStorageRuntime({
      sqlitePath: harness.sqlitePath,
      lanceDirectory: harness.lanceDirectory,
      embeddingDimension: 5,
      embeddingModel: "new-embed",
    });
    await harness.coordinator.finalizeAfterStorageOpen();
    expect(harness.runtime.vectors.dimension).toBe(5);
    expect(await harness.runtime.vectors.countRows()).toBe(0);

    const sourceId = randomUUID();
    const artifact = path.join(harness.root, "post-migration.txt");
    await fs.writeFile(artifact, "post-migration passage");
    await harness.runtime.sources.createSource(ACCOUNT, {
      id: sourceId,
      name: "post_migration_source",
      kind: "document",
      displayName: "post-migration.txt",
      filePath: artifact,
      mime: "text/plain",
      status: "index",
    });
    await harness.runtime.ingestion.reserveJob(ACCOUNT, sourceId);
    const job = await harness.runtime.ingestion.claimNext("pending");
    expect(job?.leaseToken).toBeTruthy();
    const data: IngestionDataOperations = {
      registerDataset: vi.fn(async () => ({})),
      extractDataset: vi.fn(async () => ({})),
      extractPreparedDataset: vi.fn(async () => ({})),
      activateDatasetRefresh: vi.fn(async () => ({})),
      deactivateDatasetLocation: vi.fn(async () => undefined),
      cleanupDatasetCache: vi.fn(async () => undefined),
    };
    const executor = new IngestionExecutor({
      store: harness.runtime.ingestion,
      lifecycle: harness.runtime.vectorLifecycle,
      data,
      embeddingDimension: harness.runtime.vectors.dimension,
      createEmbeddingSession: async () => async (texts) => texts.map(() => unitVector(5, 0)),
      resolveArtifact: async () => artifact,
      isTabular: () => false,
      extractText: async () => "post-migration passage",
      chunkText: (text) => [text],
      datasetRegistration: () => ({}),
      datasetPreviewText: () => "preview",
    });
    await executor.ingest({
      accountId: ACCOUNT,
      sourceId,
      name: "post_migration_source",
      filePath: artifact,
      mime: "text/plain",
      kind: "document",
      displayName: "post-migration.txt",
      generation: job!.generation,
      leaseToken: job!.leaseToken!,
    });
    const passages = await retrieveWithVector(harness.runtime.ingestion, harness.runtime.vectors, {
      accountId: ACCOUNT,
      allowedSourceIds: [sourceId],
      vector: unitVector(5, 0),
      topK: 1,
    });
    expect(passages.map((passage) => passage.content)).toEqual(["post-migration passage"]);

    await closeStorageRuntime();
    harness.runtime = await initializeStorageRuntime({
      sqlitePath: harness.sqlitePath,
      lanceDirectory: harness.lanceDirectory,
      embeddingDimension: 5,
      embeddingModel: "new-embed",
    });
    expect(await harness.runtime.vectors.countRows()).toBe(1);
  });

  it("builds a no-text staging index while preserving the live pair and gating mutations", async () => {
    const harness = await createHarness();

    const started = await harness.coordinator.start({ model: "new-embed", dimension: 5 });
    expect(started).toMatchObject({
      phase: "building",
      source_count: 1,
      chunk_count: 1,
    });
    const ready = await waitForPhase(harness.coordinator, "ready_to_apply");
    expect(ready).toMatchObject({
      indexed_count: 1,
      can_apply: true,
      can_cancel: true,
      restart_required: false,
    });
    expect(harness.runtime.vectors.dimension).toBe(3);
    expect(await harness.runtime.vectors.countRows()).toBe(1);
    await expect(harness.store.read()).resolves.toMatchObject({
      settings: { embedModel: "old-embed", embeddingDimension: 3 },
    });
    await expect(harness.coordinator.runSourceMutation(async () => undefined)).rejects.toMatchObject({
      code: "SOURCE_MUTATION_BLOCKED",
    });
    await expect(harness.coordinator.patchSettings({ embedModel: "bypass" })).rejects.toBeInstanceOf(
      EmbeddingMigrationError
    );

    const storedState = JSON.parse(await fs.readFile(harness.stateFile, "utf8")) as { id: string };
    const manifestPath = path.join(harness.migrationRoot, storedState.id, "manifest.sqlite");
    const manifest = new Database(manifestPath, { readonly: true, fileMustExist: true });
    try {
      const columns = manifest.prepare("PRAGMA table_info(manifest_chunks)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain("content");
      expect(manifest.prepare("SELECT count(*) AS count FROM manifest_chunks").get()).toEqual({ count: 1 });
    } finally {
      manifest.close();
    }
    expect((await fs.stat(harness.stateFile)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(manifestPath)).mode & 0o777).toBe(0o600);

    await expect(harness.coordinator.cancel()).resolves.toMatchObject({ phase: "idle" });
    expect(await harness.runtime.vectors.countRows()).toBe(1);
    await expect(fs.stat(path.join(harness.migrationRoot, storedState.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects generic embedding changes with ready sources but permits unrelated settings while idle", async () => {
    const harness = await createHarness();

    await expect(harness.coordinator.patchSettings({ embedModel: "new-embed" })).rejects.toBeInstanceOf(
      EmbeddingReindexRequiredError
    );
    await expect(harness.coordinator.patchSettings({ embeddingDimension: 5 })).rejects.toBeInstanceOf(
      EmbeddingReindexRequiredError
    );
    await expect(harness.coordinator.patchSettings({ chatModel: "new-chat" })).resolves.toMatchObject({
      settings: { chatModel: "new-chat", embedModel: "old-embed", embeddingDimension: 3 },
    });
  });

  it("persists a bounded provider failure and resumes the same staging operation on retry", async () => {
    let fail = true;
    const embedFactory = vi.fn((settings: EffectiveLlmSettings) => async (texts: string[]) => {
      if (fail) throw new Error("provider detail must not persist");
      return texts.map((_text, index) => unitVector(settings.embeddingDimension, index));
    });
    const harness = await createHarness({ embed: embedFactory });

    await harness.coordinator.start({ model: "new-embed", dimension: 5 });
    await expect(waitForPhase(harness.coordinator, "failed")).resolves.toMatchObject({
      error_code: "EMBEDDING_UNAVAILABLE",
      can_retry: true,
    });
    expect(await fs.readFile(harness.stateFile, "utf8")).not.toContain("provider detail");

    fail = false;
    await expect(harness.coordinator.retry()).resolves.toMatchObject({ phase: "building" });
    await expect(waitForPhase(harness.coordinator, "ready_to_apply")).resolves.toMatchObject({ indexed_count: 1 });
    expect(embedFactory).toHaveBeenCalledTimes(2);
  });

  it("fails a populated staged build resume without either embedding-identity authority", async () => {
    const harness = await createHarness();
    await harness.coordinator.start({ model: "new-embed", dimension: 5 });
    await waitForPhase(harness.coordinator, "ready_to_apply");

    const state = JSON.parse(await fs.readFile(harness.stateFile, "utf8")) as Record<string, unknown> & {
      id: string;
    };
    const stagedIndex = path.join(harness.migrationRoot, state.id, "staged-index");
    const identityFiles = await removeEmbeddingIdentityAuthorities(stagedIndex);
    await fs.writeFile(
      harness.stateFile,
      `${JSON.stringify({
        ...state,
        phase: "failed",
        error_code: "EMBEDDING_UNAVAILABLE",
        updated_at: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 }
    );

    await expect(harness.coordinator.retry()).resolves.toMatchObject({ phase: "building" });
    await expect(waitForPhase(harness.coordinator, "failed")).resolves.toMatchObject({
      error_code: "EMBEDDING_UNAVAILABLE",
      indexed_count: 1,
    });
    for (const filename of identityFiles) {
      await expect(fs.lstat(filename)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await harness.runtime.vectors.countRows()).toBe(1);
  });

  it.each([
    ["float32 overflow", [1e100, 1, 0]],
    ["float32 underflow to an all-zero vector", [1e-100, 0, 0]],
    ["float32 norm underflow", [1e-23, 0, 0]],
    ["float32 norm overflow", [1e20, 0, 0]],
  ])("rejects %s before publishing migration vectors", async (_label, vector) => {
    const harness = await createHarness({
      embed: () => async (texts) => texts.map(() => vector),
    });

    await harness.coordinator.start({ model: "new-embed", dimension: 3 });
    await expect(waitForPhase(harness.coordinator, "failed")).resolves.toMatchObject({
      error_code: "EMBEDDING_INVALID",
      indexed_count: 0,
    });
  });

  it("fails the staged build if provider credentials drift outside the guarded settings path", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const embedFactory = vi.fn((settings: EffectiveLlmSettings) => async (texts: string[]) => {
      await waiting;
      return texts.map((_text, index) => unitVector(settings.embeddingDimension, index));
    });
    const harness = await createHarness({ embed: embedFactory });
    await harness.coordinator.start({ model: "new-embed", dimension: 5 });
    await vi.waitFor(() => expect(embedFactory).toHaveBeenCalledOnce());

    await harness.store.patch({ apiKey: "replacement-test-key" });
    release();

    await expect(waitForPhase(harness.coordinator, "failed")).resolves.toMatchObject({
      error_code: "PROVIDER_CHANGED",
    });
  });

  it("rejects a qualified start when provider identity changes before migration admission", async () => {
    const embedFactory = vi.fn(
      (settings: EffectiveLlmSettings) => async (texts: string[]) =>
        texts.map((_text, index) => unitVector(settings.embeddingDimension, index))
    );
    const harness = await createHarness({ embed: embedFactory });
    const baseline = await harness.store.read();
    const target = await harness.store.preview({ embedModel: "new-embed", embeddingDimension: 5 });
    let release!: () => void;
    const qualification = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starting = (async () => {
      await qualification;
      return harness.coordinator.start(
        { model: "new-embed", dimension: 5 },
        { baseline: baseline.settings, target: target.settings }
      );
    })();

    await harness.store.patch({ chatModel: "replacement-chat" });
    release();

    await expect(starting).rejects.toMatchObject({ code: "PROVIDER_CHANGED" });
    await expect(harness.coordinator.status()).resolves.toMatchObject({ phase: "idle" });
    expect(embedFactory).not.toHaveBeenCalled();
  });

  it("applies a different dimension only during restart and retires the backup after scoped retrieval", async () => {
    const harness = await createHarness();
    await harness.coordinator.start({ model: "new-embed", dimension: 5 });
    await waitForPhase(harness.coordinator, "ready_to_apply");

    await expect(harness.coordinator.requestApply()).resolves.toMatchObject({
      phase: "apply_pending",
      restart_required: true,
      can_cancel: false,
    });
    await expect(harness.coordinator.assertChatTurnAllowed()).rejects.toMatchObject({ code: "MIGRATION_ACTIVE" });
    expect(harness.runtime.vectors.dimension).toBe(3);
    await closeStorageRuntime();

    await harness.coordinator.recoverBeforeStorageOpen();
    await expect(harness.store.read()).resolves.toMatchObject({
      settings: { embedModel: "new-embed", embeddingDimension: 5 },
    });
    harness.runtime = await initializeStorageRuntime({
      sqlitePath: harness.sqlitePath,
      lanceDirectory: harness.lanceDirectory,
      embeddingDimension: 5,
      embeddingModel: "new-embed",
    });
    await harness.coordinator.finalizeAfterStorageOpen();

    await expect(harness.coordinator.status()).resolves.toMatchObject({ phase: "idle" });
    expect(harness.runtime.vectors.dimension).toBe(5);
    expect(await harness.runtime.vectors.countRows()).toBe(1);
    const source = await harness.runtime.ledger.get<{ id: string }>("SELECT id FROM sources WHERE account_id=?", [
      ACCOUNT,
    ]);
    const passages = await retrieveWithVector(harness.runtime.ingestion, harness.runtime.vectors, {
      accountId: ACCOUNT,
      allowedSourceIds: [source!.id],
      vector: unitVector(5, 0),
      topK: 1,
    });
    expect(passages).toHaveLength(1);
    expect(passages[0]?.content).toBe("first passage");
    await expect(fs.stat(harness.stateFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails startup apply closed when a populated staged index has neither identity authority", async () => {
    const harness = await createHarness();
    await harness.coordinator.start({ model: "new-embed", dimension: 5 });
    await waitForPhase(harness.coordinator, "ready_to_apply");
    await harness.coordinator.requestApply();
    await closeStorageRuntime();

    const state = JSON.parse(await fs.readFile(harness.stateFile, "utf8")) as { id: string };
    const stagedIndex = path.join(harness.migrationRoot, state.id, "staged-index");
    const identityFiles = await removeEmbeddingIdentityAuthorities(stagedIndex);

    await harness.coordinator.recoverBeforeStorageOpen();

    await expect(harness.coordinator.status()).resolves.toMatchObject({
      phase: "failed",
      error_code: "STARTUP_SWAP_FAILED",
    });
    await expect(harness.store.read()).resolves.toMatchObject({
      settings: { embedModel: "old-embed", embeddingDimension: 3 },
    });
    for (const filename of identityFiles) {
      await expect(fs.lstat(filename)).rejects.toMatchObject({ code: "ENOENT" });
    }
    harness.runtime = await initializeStorageRuntime({
      sqlitePath: harness.sqlitePath,
      lanceDirectory: harness.lanceDirectory,
      embeddingDimension: 3,
      embeddingModel: "old-embed",
    });
    expect(await harness.runtime.vectors.countRows()).toBe(1);
  });

  it("orders the whole chat admission transaction before an apply request", async () => {
    const harness = await createHarness();
    await harness.coordinator.start({ model: "new-embed", dimension: 5 });
    await waitForPhase(harness.coordinator, "ready_to_apply");
    let entered!: () => void;
    let release!: () => void;
    const admissionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const admissionRelease = new Promise<void>((resolve) => {
      release = resolve;
    });

    const admission = harness.coordinator.runChatTurnAdmission(async () => {
      entered();
      await admissionRelease;
      return "accepted";
    });
    await admissionEntered;
    let applySettled = false;
    const applying = harness.coordinator.requestApply().finally(() => {
      applySettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(applySettled).toBe(false);

    release();
    await expect(admission).resolves.toBe("accepted");
    await expect(applying).resolves.toMatchObject({ phase: "apply_pending" });
    await expect(harness.coordinator.runChatTurnAdmission(async () => "late")).rejects.toMatchObject({
      code: "MIGRATION_ACTIVE",
    });
  });

  it("restores the paired old index and settings when the installed index cannot open", async () => {
    const harness = await createHarness();
    await harness.coordinator.start({ model: "new-embed", dimension: 5 });
    await waitForPhase(harness.coordinator, "ready_to_apply");
    await harness.coordinator.requestApply();
    await closeStorageRuntime();

    await harness.coordinator.recoverBeforeStorageOpen();
    await expect(harness.coordinator.rollbackStartupFailure("STARTUP_OPEN_FAILED")).resolves.toBe(true);
    await expect(harness.store.read()).resolves.toMatchObject({
      settings: { embedModel: "old-embed", embeddingDimension: 3 },
    });
    harness.runtime = await initializeStorageRuntime({
      sqlitePath: harness.sqlitePath,
      lanceDirectory: harness.lanceDirectory,
      embeddingDimension: 3,
      embeddingModel: "old-embed",
    });
    expect(await harness.runtime.vectors.countRows()).toBe(1);
    await expect(harness.coordinator.status()).resolves.toMatchObject({
      phase: "failed",
      error_code: "STARTUP_OPEN_FAILED",
      can_retry: true,
    });
    await harness.coordinator.cancel();
  });

  it("rejects an idle same-dimension settings drift against the live index identity", async () => {
    const harness = await createHarness();
    await closeStorageRuntime();
    await harness.store.patch({ embedModel: "different-embed", embeddingDimension: 3 });

    await expect(
      initializeStorageRuntime({
        sqlitePath: harness.sqlitePath,
        lanceDirectory: harness.lanceDirectory,
        embeddingDimension: 3,
        embeddingModel: "different-embed",
      })
    ).rejects.toMatchObject({ name: "LanceVectorEmbeddingIdentityError" });
  });

  it("finishes rollback after a crash restored an old same-dimension index before settings", async () => {
    const harness = await createHarness();
    await harness.coordinator.start({ model: "new-embed", dimension: 3 });
    await waitForPhase(harness.coordinator, "ready_to_apply");
    await harness.coordinator.requestApply();
    await closeStorageRuntime();
    await harness.coordinator.recoverBeforeStorageOpen();

    const state = JSON.parse(await fs.readFile(harness.stateFile, "utf8")) as { id: string; phase: string };
    expect(state.phase).toBe("settings_updated");
    const migrationDirectory = path.join(harness.migrationRoot, state.id);
    await fs.rename(harness.lanceDirectory, path.join(migrationDirectory, "staged-index"));
    await fs.rename(path.join(migrationDirectory, "live-backup"), harness.lanceDirectory);

    await harness.coordinator.recoverBeforeStorageOpen();

    await expect(harness.coordinator.status()).resolves.toMatchObject({
      phase: "failed",
      error_code: "STARTUP_SWAP_FAILED",
    });
    await expect(harness.store.read()).resolves.toMatchObject({
      settings: { embedModel: "old-embed", embeddingDimension: 3 },
    });
    harness.runtime = await initializeStorageRuntime({
      sqlitePath: harness.sqlitePath,
      lanceDirectory: harness.lanceDirectory,
      embeddingDimension: 3,
      embeddingModel: "old-embed",
    });
    expect(await harness.runtime.vectors.countRows()).toBe(1);
  });

  it("recreates a never-published snapshot directory when retry is advertised", async () => {
    const harness = await createHarness();
    await harness.coordinator.start({ model: "new-embed", dimension: 5 });
    await harness.coordinator.close();
    const state = JSON.parse(await fs.readFile(harness.stateFile, "utf8")) as Record<string, unknown> & { id: string };
    await fs.rm(path.join(harness.migrationRoot, state.id), { recursive: true, force: false });
    await fs.writeFile(
      harness.stateFile,
      `${JSON.stringify({
        ...state,
        phase: "failed",
        snapshot_hash: null,
        source_count: 0,
        chunk_count: 0,
        indexed_count: 0,
        error_code: "SNAPSHOT_FAILED",
        updated_at: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 }
    );
    const recovery = createRecoveryCoordinator(harness, harness.store);

    await expect(recovery.retry()).resolves.toMatchObject({ phase: "building", can_retry: false });
    await expect(waitForPhase(recovery, "ready_to_apply")).resolves.toMatchObject({ indexed_count: 1 });
    await recovery.close();
  });

  it("recovers an unjournaled live-to-backup rename without exposing a mixed pair", async () => {
    const harness = await createHarness();
    await harness.coordinator.start({ model: "new-embed", dimension: 5 });
    await waitForPhase(harness.coordinator, "ready_to_apply");
    await harness.coordinator.requestApply();
    await closeStorageRuntime();
    const state = JSON.parse(await fs.readFile(harness.stateFile, "utf8")) as { id: string };
    const migrationDirectory = path.join(harness.migrationRoot, state.id);
    await fs.rename(harness.lanceDirectory, path.join(migrationDirectory, "live-backup"));

    await harness.coordinator.recoverBeforeStorageOpen();
    harness.runtime = await initializeStorageRuntime({
      sqlitePath: harness.sqlitePath,
      lanceDirectory: harness.lanceDirectory,
      embeddingDimension: 5,
      embeddingModel: "new-embed",
    });
    await harness.coordinator.finalizeAfterStorageOpen();
    expect(await harness.runtime.vectors.countRows()).toBe(1);
    await expect(harness.coordinator.status()).resolves.toMatchObject({ phase: "idle" });
  });

  it.each(["staged_installed", "settings_updated"] as const)(
    "rolls back a %s index when provider identity drifted after the settings write",
    async (phase) => {
      const harness = await createHarness();
      await installStagedIndex(harness, phase);
      await harness.store.patch({ embedModel: "new-embed", embeddingDimension: 5 });
      await harness.store.patch({ chatModel: "replacement-chat" });

      await harness.coordinator.recoverBeforeStorageOpen();

      await expect(harness.coordinator.status()).resolves.toMatchObject({
        phase: "failed",
        error_code: "STARTUP_SWAP_FAILED",
      });
      await expect(harness.store.read()).resolves.toMatchObject({
        settings: { chatModel: "replacement-chat", embedModel: "old-embed", embeddingDimension: 3 },
      });
      harness.runtime = await initializeStorageRuntime({
        sqlitePath: harness.sqlitePath,
        lanceDirectory: harness.lanceDirectory,
        embeddingDimension: 3,
        embeddingModel: "old-embed",
      });
      expect(await harness.runtime.vectors.countRows()).toBe(1);
    }
  );

  it("rolls back when an environment override only makes the installed target appear active", async () => {
    const harness = await createHarness();
    await installStagedIndex(harness);
    const environmentStore = createSettingsStore({
      path: harness.settingsFile,
      env: { LLM_EMBED_MODEL: "new-embed", EMBEDDING_DIM: "5" },
    });
    const recovery = createRecoveryCoordinator(harness, environmentStore);

    await recovery.recoverBeforeStorageOpen();

    await expect(recovery.status()).resolves.toMatchObject({
      phase: "failed",
      error_code: "STARTUP_SWAP_FAILED",
    });
    const persisted = createSettingsStore({ path: harness.settingsFile, env: {} });
    await expect(persisted.read()).resolves.toMatchObject({
      settings: { embedModel: "old-embed", embeddingDimension: 3 },
    });
    harness.runtime = await initializeStorageRuntime({
      sqlitePath: harness.sqlitePath,
      lanceDirectory: harness.lanceDirectory,
      embeddingDimension: 3,
      embeddingModel: "old-embed",
    });
    expect(await harness.runtime.vectors.countRows()).toBe(1);
    await recovery.close();
  });

  it("fails closed before provider work unless every affected account acknowledged remote ingestion", async () => {
    const embedFactory = vi.fn(
      (settings: EffectiveLlmSettings) => async (texts: string[]) =>
        texts.map((_text, index) => unitVector(settings.embeddingDimension, index))
    );
    const harness = await createHarness({ embed: embedFactory });
    await harness.store.patch({ llmBaseUrl: "https://provider.example.test" });
    await seedAccount(harness.runtime, OTHER_ACCOUNT, "other@example.test");
    await seedReadySource(harness.runtime, OTHER_ACCOUNT, "second passage", [0, 1, 0]);
    await harness.runtime.ledger.run("UPDATE users SET remote_egress_ack_at=? WHERE id=?", [
      new Date().toISOString(),
      ACCOUNT,
    ]);

    await expect(harness.coordinator.start({ model: "new-embed", dimension: 5 })).resolves.toMatchObject({
      phase: "failed",
      error_code: "REMOTE_EGRESS_CONSENT_REQUIRED",
    });
    expect(embedFactory).not.toHaveBeenCalled();
  });

  it("records one content-free remote-ingest audit per affected account", async () => {
    const audit = vi.fn(async () => undefined);
    const harness = await createHarness({ audit });
    await harness.store.patch({ llmBaseUrl: "https://provider.example.test" });
    await seedAccount(harness.runtime, OTHER_ACCOUNT, "other@example.test");
    await seedReadySource(harness.runtime, OTHER_ACCOUNT, "second passage", [0, 1, 0]);
    await harness.runtime.ledger.run("UPDATE users SET remote_egress_ack_at=?", [new Date().toISOString()]);

    await harness.coordinator.start({ model: "new-embed", dimension: 5 });
    await waitForPhase(harness.coordinator, "ready_to_apply");
    expect(audit.mock.calls).toEqual([
      ["remote_ingest", ACCOUNT, "provider.example.test"],
      ["remote_ingest", OTHER_ACCOUNT, "provider.example.test"],
    ]);
  });

  it("rejects a symlinked durable state file without following it", async () => {
    const harness = await createHarness();
    const outside = path.join(harness.root, "outside.json");
    await fs.writeFile(outside, "{}", { mode: 0o600 });
    await fs.symlink(outside, harness.stateFile);

    await expect(harness.coordinator.status()).rejects.toMatchObject({ code: "STATE_INVALID" });
  });
});

async function seedAccount(runtime: StorageRuntime, id: string, email: string): Promise<void> {
  await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, email, "hash"]);
}

async function seedReadySource(
  runtime: StorageRuntime,
  accountId: string,
  content: string,
  vector: readonly number[]
): Promise<{ sourceId: string; chunkId: string }> {
  const sourceId = randomUUID();
  const chunkId = randomUUID();
  await runtime.ledger.run(
    `INSERT INTO sources
       (id,account_id,name,kind,display_name,status,meta,ready_generation)
     VALUES (?,?,?,'document',?,'ready',?,1)`,
    [sourceId, accountId, `source_${sourceId}`, "Source.txt", encodeJson({})]
  );
  await runtime.ledger.run(
    `INSERT INTO chunks (id,account_id,source_id,generation,seq,source_name,content,meta)
     VALUES (?,?,?,?,0,?,?,?)`,
    [chunkId, accountId, sourceId, 1, "Source.txt", content, encodeJson({})]
  );
  await runtime.vectors.upsert([{ chunkId, accountId, sourceId, generation: 1, vector }]);
  return { sourceId, chunkId };
}

async function installStagedIndex(
  harness: Harness,
  phase: "staged_installed" | "settings_updated" = "staged_installed"
): Promise<void> {
  await harness.coordinator.start({ model: "new-embed", dimension: 5 });
  await waitForPhase(harness.coordinator, "ready_to_apply");
  await harness.coordinator.requestApply();
  await closeStorageRuntime();
  const state = JSON.parse(await fs.readFile(harness.stateFile, "utf8")) as Record<string, unknown> & {
    id: string;
  };
  const migrationDirectory = path.join(harness.migrationRoot, state.id);
  await fs.rename(harness.lanceDirectory, path.join(migrationDirectory, "live-backup"));
  await fs.rename(path.join(migrationDirectory, "staged-index"), harness.lanceDirectory);
  await fs.writeFile(
    harness.stateFile,
    `${JSON.stringify({ ...state, phase, updated_at: new Date().toISOString() })}\n`,
    { mode: 0o600 }
  );
  await fs.chmod(harness.stateFile, 0o600);
}

function createRecoveryCoordinator(harness: Harness, store: SettingsStore): EmbeddingMigrationCoordinator {
  return new EmbeddingMigrationCoordinator({
    stateFile: harness.stateFile,
    migrationRoot: harness.migrationRoot,
    liveLanceDirectory: harness.lanceDirectory,
    settingsStore: store,
    ledger: () => harness.runtime.ledger,
    runtime: () => harness.runtime,
    openStartupLedger: async () => {
      const ledger = await openSqliteLedger({ path: harness.sqlitePath });
      return { ledger, close: () => ledger.close() };
    },
    embedFactory: (settings) => async (texts) =>
      texts.map((_text, index) => unitVector(settings.embeddingDimension, index)),
  });
}

async function removeEmbeddingIdentityAuthorities(directory: string): Promise<readonly string[]> {
  const files = [
    path.join(directory, ".borealis-embedding-index.json"),
    path.join(directory, ".borealis-embedding-index-binding.json"),
  ];
  await Promise.all(files.map((filename) => fs.unlink(filename)));
  return files;
}

function unitVector(dimension: number, offset: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  vector[offset % dimension] = 1;
  return vector;
}

async function waitForPhase(
  coordinator: EmbeddingMigrationCoordinator,
  phase: "ready_to_apply" | "failed",
  timeoutMs = 5_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await coordinator.status();
    if (status.phase === phase) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`embedding migration did not reach ${phase}`);
}
