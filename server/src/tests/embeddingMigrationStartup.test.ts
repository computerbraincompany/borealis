import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const CHUNK_ID = "33333333-3333-4333-8333-333333333333";

describe("production embedding-migration startup composition", () => {
  it("applies an apply-pending index through real initDb and reopens the scoped pair", async () => {
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-migration-startup-")));
    const sqlitePath = path.join(workspace, "borealis.sqlite");
    const lanceDirectory = path.join(workspace, "lancedb");
    const settingsFile = path.join(workspace, "settings.json");
    const migrationState = path.join(workspace, "embedding-migration.json");
    const migrationRoot = path.join(workspace, ".lancedb-migrations");

    vi.resetModules();
    vi.stubEnv("BOREALIS_DESKTOP", "1");
    vi.stubEnv("BOREALIS_DATA_DIR", workspace);
    vi.stubEnv("SQLITE_PATH", sqlitePath);
    vi.stubEnv("LANCEDB_DIR", lanceDirectory);
    vi.stubEnv("SETTINGS_FILE", settingsFile);
    vi.stubEnv("UPLOAD_DIR", path.join(workspace, "uploads"));
    vi.stubEnv("REPORT_DIR", path.join(workspace, "reports"));
    vi.stubEnv("CONTAINED_DIR", path.join(workspace, "models"));
    vi.stubEnv("JWT_SECRET_FILE", path.join(workspace, "jwt.secret"));
    vi.stubEnv("LLM_EMBED_MODEL", undefined);
    vi.stubEnv("LITELLM_EMBED_MODEL", undefined);
    vi.stubEnv("EMBEDDING_DIM", undefined);

    const runtimeSettings = await import("../runtimeSettings.js");
    const storage = await import("../storageRuntime.js");
    const migration = await import("../embeddingMigration.js");
    const { openSqliteLedger } = await import("../db/sqlite.js");
    const { initDb } = await import("../db.js");
    const { retrieveWithVector } = await import("../vector/retrieve.js");

    let preparing: InstanceType<typeof migration.EmbeddingMigrationCoordinator> | undefined;
    try {
      await runtimeSettings.initializeRuntimeSettings();
      const settings = runtimeSettings.runtimeSettingsStore();
      await settings.patch({ chatModel: "chat-model", embedModel: "old-embed", embeddingDimension: 3 });

      let activeRuntime = await storage.initializeStorageRuntime({
        sqlitePath,
        lanceDirectory,
        embeddingDimension: 3,
        embeddingModel: "old-embed",
      });
      await activeRuntime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
        ACCOUNT_ID,
        "owner@example.test",
        "hash",
      ]);
      await activeRuntime.ledger.run(
        `INSERT INTO sources
           (id,account_id,name,kind,display_name,status,meta,ready_generation)
         VALUES (?,?,?,'document',?,'ready',?,1)`,
        [SOURCE_ID, ACCOUNT_ID, "startup_source", "Startup source", "{}"]
      );
      await activeRuntime.ledger.run(
        `INSERT INTO chunks (id,account_id,source_id,generation,seq,source_name,content,meta)
         VALUES (?,?,?,?,0,?,?,?)`,
        [CHUNK_ID, ACCOUNT_ID, SOURCE_ID, 1, "Startup source", "deterministic startup passage", "{}"]
      );
      await activeRuntime.vectors.upsert([
        {
          chunkId: CHUNK_ID,
          accountId: ACCOUNT_ID,
          sourceId: SOURCE_ID,
          generation: 1,
          vector: unitVector(3),
        },
      ]);

      preparing = new migration.EmbeddingMigrationCoordinator({
        stateFile: migrationState,
        migrationRoot,
        liveLanceDirectory: lanceDirectory,
        settingsStore: settings,
        ledger: () => activeRuntime.ledger,
        runtime: () => activeRuntime,
        openStartupLedger: async () => {
          const ledger = await openSqliteLedger({ path: sqlitePath });
          return { ledger, close: () => ledger.close() };
        },
        embedFactory: (effective) => async (texts) => texts.map(() => unitVector(effective.embeddingDimension)),
      });

      await preparing.start({ model: "new-embed", dimension: 5 });
      await expect(waitForReady(preparing)).resolves.toMatchObject({
        phase: "ready_to_apply",
        chunk_count: 1,
        indexed_count: 1,
      });
      await expect(preparing.requestApply()).resolves.toMatchObject({
        phase: "apply_pending",
        restart_required: true,
      });
      await preparing.close();
      preparing = undefined;
      await storage.closeStorageRuntime();

      // This is the production startup boundary: initDb owns migration
      // recovery, configured store opening, post-open retrieval smoke, and
      // rollback routing. The test deliberately does not call those phases.
      await initDb();
      activeRuntime = storage.storageRuntime();

      await expect(settings.read()).resolves.toMatchObject({
        settings: { embedModel: "new-embed", embeddingDimension: 5 },
      });
      expect(activeRuntime.vectors.dimension).toBe(5);
      expect(activeRuntime.vectors.embeddingModel).toBe("new-embed");
      expect(await activeRuntime.vectors.countRows()).toBe(1);
      await expect(
        retrieveWithVector(activeRuntime.ingestion, activeRuntime.vectors, {
          accountId: ACCOUNT_ID,
          allowedSourceIds: [SOURCE_ID],
          vector: unitVector(5),
          topK: 1,
        })
      ).resolves.toMatchObject([
        {
          chunk_id: CHUNK_ID,
          source_id: SOURCE_ID,
          content: "deterministic startup passage",
        },
      ]);

      const marker = JSON.parse(
        await fs.readFile(path.join(lanceDirectory, ".borealis-embedding-index.json"), "utf8")
      ) as { resolved_model?: unknown; dimension?: unknown };
      expect(marker).toMatchObject({ resolved_model: "new-embed", dimension: 5 });
      await expect(fs.stat(migrationState)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(migrationRoot)).resolves.toEqual([]);
    } finally {
      await preparing?.close().catch(() => undefined);
      await migration.closeEmbeddingMigrationCoordinator().catch(() => undefined);
      await storage.closeStorageRuntime().catch(() => undefined);
      runtimeSettings.closeRuntimeSettings();
      vi.unstubAllEnvs();
      vi.resetModules();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

function unitVector(dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  vector[0] = 1;
  return vector;
}

async function waitForReady(
  coordinator: { status(): Promise<{ phase: string; error_code: string | null }> },
  timeoutMs = 5_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await coordinator.status();
    if (status.phase === "ready_to_apply") return status;
    if (status.phase === "failed") throw new Error(`migration failed: ${status.error_code ?? "unknown"}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("migration did not become ready to apply");
}
