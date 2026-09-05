import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { encodeJson } from "../db/codecs.js";
import { openSqliteLedger } from "../db/sqlite.js";
import { EmbeddingMigrationCoordinator } from "../embeddingMigration.js";
import { createSettingsStore } from "../settingsStore.js";
import { closeStorageRuntime, initializeStorageRuntime, type StorageRuntime } from "../storageRuntime.js";
import { retrieveWithVector } from "../vector/retrieve.js";
import { createWorkspaceArchive, restoreWorkspaceArchive } from "../workspaceArchive.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PASSPHRASE = "archive migration test passphrase";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await closeStorageRuntime();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("portable workspace archives with external embedding migration staging", () => {
  it("restores the staged index canonically and completes the restart swap with retrieval", async () => {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-archive-migration-")));
    temporaryDirectories.push(parent);
    const workspace = path.join(parent, "source-workspace");
    const externalLance = path.join(parent, "operator-vectors");
    const externalMigrationRoot = path.join(parent, ".operator-vectors-migrations");
    const sqlitePath = path.join(workspace, "borealis.sqlite");
    const settingsPath = path.join(workspace, "settings.json");
    const statePath = path.join(workspace, "embedding-migration.json");
    await fs.mkdir(workspace);

    const sourceSettings = createSettingsStore({ path: settingsPath, env: {} });
    await sourceSettings.patch({ chatModel: "chat-model", embedModel: "old-embed", embeddingDimension: 3 });
    const sourceRuntime = await initializeStorageRuntime({
      sqlitePath,
      lanceDirectory: externalLance,
      embeddingDimension: 3,
      embeddingModel: "old-embed",
    });
    const sourceCoordinator = migrationCoordinator({
      statePath,
      migrationRoot: externalMigrationRoot,
      lanceDirectory: externalLance,
      settingsPath,
      runtime: () => sourceRuntime,
    });
    const sourceId = await seedReadySource(sourceRuntime);

    await sourceCoordinator.start({ model: "new-embed", dimension: 5 });
    await expect(waitForReady(sourceCoordinator)).resolves.toMatchObject({
      phase: "ready_to_apply",
      source_count: 1,
      chunk_count: 1,
      indexed_count: 1,
    });
    const migrationState = JSON.parse(await fs.readFile(statePath, "utf8")) as { id: string };
    await expect(fs.stat(path.join(externalMigrationRoot, migrationState.id, "staged-index"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });

    await sourceCoordinator.close();
    await closeStorageRuntime();

    const archive = path.join(parent, "workspace.borealis-workspace");
    const target = path.join(parent, "restored-workspace");
    await createWorkspaceArchive({
      workspaceDirectory: workspace,
      destination: archive,
      passphrase: PASSPHRASE,
      additions: [{ name: "lancedb", path: externalLance }],
    });
    await restoreWorkspaceArchive({
      archive,
      passphrase: PASSPHRASE,
      targetDirectory: target,
      embeddingDimension: 3,
    });

    const targetLance = path.join(target, "lancedb");
    const targetMigrationRoot = path.join(target, ".lancedb-migrations");
    await expect(fs.stat(targetLance)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(fs.stat(path.join(targetMigrationRoot, migrationState.id, "staged-index"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    expect(await fs.readdir(target)).not.toContain("relocated");

    // Removing every source path proves apply/recovery depends only on the
    // canonical restored tree, not on manifest-time absolute locations.
    await fs.rm(workspace, { recursive: true });
    await fs.rm(externalLance, { recursive: true });
    await fs.rm(externalMigrationRoot, { recursive: true });

    const targetSqlite = path.join(target, "borealis.sqlite");
    const targetSettings = path.join(target, "settings.json");
    let restoredRuntime = await initializeStorageRuntime({
      sqlitePath: targetSqlite,
      lanceDirectory: targetLance,
      embeddingDimension: 3,
      embeddingModel: "old-embed",
    });
    const restoredCoordinator = migrationCoordinator({
      statePath: path.join(target, "embedding-migration.json"),
      migrationRoot: targetMigrationRoot,
      lanceDirectory: targetLance,
      settingsPath: targetSettings,
      runtime: () => restoredRuntime,
    });
    try {
      await expect(restoredCoordinator.requestApply()).resolves.toMatchObject({
        phase: "apply_pending",
        restart_required: false,
      });
      await closeStorageRuntime();

      await restoredCoordinator.recoverBeforeStorageOpen();
      restoredRuntime = await initializeStorageRuntime({
        sqlitePath: targetSqlite,
        lanceDirectory: targetLance,
        embeddingDimension: 5,
        embeddingModel: "new-embed",
      });
      await restoredCoordinator.finalizeAfterStorageOpen();

      await expect(restoredCoordinator.status()).resolves.toMatchObject({ phase: "idle" });
      const passages = await retrieveWithVector(restoredRuntime.ingestion, restoredRuntime.vectors, {
        accountId: ACCOUNT_ID,
        allowedSourceIds: [sourceId],
        vector: unitVector(5),
        topK: 1,
      });
      expect(passages.map((passage) => passage.content)).toEqual(["portable migration passage"]);
      await expect(fs.stat(path.join(target, "embedding-migration.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(path.join(target, ".lancedb-migrations"))).resolves.toEqual([]);
    } finally {
      await restoredCoordinator.close();
    }
  });
});

function migrationCoordinator(options: {
  readonly statePath: string;
  readonly migrationRoot: string;
  readonly lanceDirectory: string;
  readonly settingsPath: string;
  readonly runtime: () => StorageRuntime;
}): EmbeddingMigrationCoordinator {
  const settings = createSettingsStore({ path: options.settingsPath, env: {} });
  const sqlitePath = path.join(path.dirname(options.settingsPath), "borealis.sqlite");
  return new EmbeddingMigrationCoordinator({
    stateFile: options.statePath,
    migrationRoot: options.migrationRoot,
    liveLanceDirectory: options.lanceDirectory,
    settingsStore: settings,
    ledger: () => options.runtime().ledger,
    runtime: options.runtime,
    openStartupLedger: async () => {
      const ledger = await openSqliteLedger({ path: sqlitePath });
      return { ledger, close: () => ledger.close() };
    },
    embedFactory: (effective) => async (texts) => texts.map(() => unitVector(effective.embeddingDimension)),
  });
}

async function seedReadySource(runtime: StorageRuntime): Promise<string> {
  const sourceId = randomUUID();
  const chunkId = randomUUID();
  await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    ACCOUNT_ID,
    "archive@example.test",
    "hash",
  ]);
  await runtime.ledger.run(
    `INSERT INTO sources
       (id,account_id,name,kind,display_name,status,meta,ready_generation)
     VALUES (?,?,?,'document',?,'ready',?,1)`,
    [sourceId, ACCOUNT_ID, `source_${sourceId}`, "Source.txt", encodeJson({})]
  );
  await runtime.ledger.run(
    `INSERT INTO chunks (id,account_id,source_id,generation,seq,source_name,content,meta)
     VALUES (?,?,?,?,0,?,?,?)`,
    [chunkId, ACCOUNT_ID, sourceId, 1, "Source.txt", "portable migration passage", encodeJson({})]
  );
  await runtime.vectors.upsert([{ chunkId, accountId: ACCOUNT_ID, sourceId, generation: 1, vector: unitVector(3) }]);
  return sourceId;
}

function unitVector(dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  vector[0] = 1;
  return vector;
}

async function waitForReady(coordinator: EmbeddingMigrationCoordinator, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await coordinator.status();
    if (status.phase === "ready_to_apply") return status;
    if (status.phase === "failed") throw new Error(`embedding migration failed: ${status.error_code ?? "unknown"}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("embedding migration did not become ready to apply");
}
