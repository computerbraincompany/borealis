import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../config.js";
import { KnowledgeStore, type KnowledgeScanBounds } from "../db/stores/knowledgeStore.js";
import type { SqliteLedger } from "../db/types.js";
import { KnowledgeRefreshService } from "../knowledgeRefresh.js";
import {
  DesktopFolderKnowledgeAdapter,
  desktopFolderKnowledgeAdapter,
  isExcludedDirectoryName,
} from "../knowledge/folder.js";
import { makeIngestionSimulator, promoteGeneration } from "./knowledgeTransportFixture.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";
import { ensureUploadResourceDirectory } from "../knowledge/uploadStaging.js";

/**
 * The `desktop_folder` transport runs against real temporary directories:
 * scan bounds (visited/entry/depth/aggregate), hidden and symlink exclusion,
 * excluded directories, content-hash classification (rename = missing+new,
 * mtime is never identity), and staged copies into the ordinary account/source
 * upload directory feeding normal ingestion admission. An over-limit scan
 * fails the whole preview without partial activation.
 */

const resources: { root: string; uploads: string; ledger?: TempSqliteLedger }[] = [];
const originalUploadDir = config.uploadDir;

let uploadRoot = "";

beforeEach(async () => {
  uploadRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-folder-uploads-")));
  config.uploadDir = uploadRoot;
});

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.ledger?.cleanup();
    await fs.rm(resource.root, { recursive: true, force: true });
  }
  config.uploadDir = originalUploadDir;
  if (uploadRoot) await fs.rm(uploadRoot, { recursive: true, force: true }).catch(() => {});
});

async function newRoot(files: Record<string, string> = {}, symlinks: Record<string, string> = {}): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-folder-")));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  for (const [relative, target] of Object.entries(symlinks)) {
    const link = path.join(root, relative);
    // Symlink targets must exist only as final components; do not mkdir
    // through a symlinked segment.
    const parent = path.dirname(link);
    if (parent !== root) await fs.mkdir(parent, { recursive: true }).catch(() => {});
    await fs.symlink(path.isAbsolute(target) ? target : path.join(root, target), link).catch(() => {});
  }
  resources.push({ root, uploads: uploadRoot });
  return root;
}

async function seedUser(ledger: SqliteLedger): Promise<{ account: string; libraryId: string }> {
  const account = randomUUID();
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [account, `${account}@e.test`, "h"]);
  const libraryId = randomUUID();
  await ledger.run("INSERT INTO libraries (id,account_id,name) VALUES (?,?,?)", [
    libraryId,
    account,
    `Lib ${account.slice(0, 6)}`,
  ]);
  return { account, libraryId };
}

async function harness(root: string, options: { autoPromote?: boolean } = {}) {
  const ledgerResource = await createTempSqliteLedger();
  resources.push({ root, uploads: uploadRoot, ledger: ledgerResource });
  const ledger = ledgerResource.ledger;
  const { account, libraryId } = await seedUser(ledger);
  const store = new KnowledgeStore(ledger);
  const ingestion = { calls: 0, generations: [] as number[], autoPromote: options.autoPromote ?? true };
  const adapter = new DesktopFolderKnowledgeAdapter();
  const service = new KnowledgeRefreshService({
    store: () => store,
    adapter: (kind) => (kind === "desktop_folder" ? adapter : undefined),
    reingest: makeIngestionSimulator(ledger, ingestion),
    secrets: () => ({
      read: async () => ({ state: "absent" as const }),
      put: async () => undefined,
      remove: async () => undefined,
    }),
    pollIntervalMs: 10,
  });
  const connection = await store.createConnection(account, {
    name: "Folder",
    kind: "desktop_folder",
    config: { root_path: root, display_label: path.basename(root) },
    library_id: libraryId,
  });
  return { ledger, store, service, account, libraryId, connection, ingestion };
}

const bounds: KnowledgeScanBounds = {
  maxEntries: 100,
  maxDepth: 10,
  maxVisited: 1_000,
  maxAggregateBytes: 64 * 1024 * 1024,
};

async function scan(root: string, override: Partial<KnowledgeScanBounds> = {}) {
  const context = {
    accountId: randomUUID(),
    connection: {
      id: randomUUID(),
      name: "n",
      kind: "desktop_folder" as const,
      library_id: null,
      revision: 1,
      watch_enabled: false,
      credential_configured: false,
      status: "ready" as const,
      status_code: null,
      config: { kind: "desktop_folder" as const, root_path: root, display_label: "n" },
      created_at: "2026-09-06T00:00:00.000Z",
      updated_at: "2026-09-06T00:00:00.000Z",
    },
    secrets: undefined,
  };
  return desktopFolderKnowledgeAdapter.scan(context, { ...bounds, ...override }, [], new AbortController().signal);
}

describe("desktop_folder transport", () => {
  it("excludes hidden dirs, symlinks, and excluded directories while reporting them as skips", async () => {
    const root = await newRoot(
      { "readme.md": "# hi", "notes/deep.md": "deep", "data.csv": "a,b", ".hidden/secret.md": "secret" },
      { "link.md": "readme.md" }
    );
    // Create excluded directories.
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git/config"), "git", "utf8");
    await fs.mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules/pkg/index.md"), "noise", "utf8");

    const outcome = await scan(root);
    expect(outcome.files.map((file) => file.relative_path).sort()).toEqual(["data.csv", "notes/deep.md", "readme.md"]);
    for (const file of outcome.files) expect(file.content_hash).toMatch(/^[0-9a-f]{64}$/);

    const skippedByPath = new Map(outcome.skipped.map((skip) => [skip.relative_path, skip.reason]));
    expect(skippedByPath.get("link.md")).toBe("symlink");
    expect(skippedByPath.get(".hidden")).toBe("hidden");
    expect(skippedByPath.get(".git")).toBe("hidden");
    expect(skippedByPath.get("node_modules")).toBe("excluded");
    expect(isExcludedDirectoryName("node_modules")).toBe(true);
    expect(isExcludedDirectoryName("Borealis")).toBe(true);
  });

  it("honors depth and visited bounds and fails the scan over each", async () => {
    const deep = await newRoot({ "a/b/c/d/deep.md": "x", "top.md": "y" });
    const shallow = await scan(deep, { maxDepth: 0 });
    expect(shallow.files.map((file) => file.relative_path)).toEqual(["top.md"]);
    expect(shallow.skipped.find((skip) => skip.relative_path === "a")).toMatchObject({ reason: "depth" });

    await expect(scan(deep, { maxVisited: 1 })).rejects.toMatchObject({ code: "KNOWLEDGE_SCAN_LIMIT" });
    await expect(scan(deep, { maxAggregateBytes: 1 })).rejects.toMatchObject({ code: "KNOWLEDGE_SCAN_LIMIT" });
    const many = await newRoot({ "a.md": "1", "b.md": "2", "c.md": "3" });
    await expect(scan(many, { maxEntries: 2 })).rejects.toMatchObject({ code: "KNOWLEDGE_SCAN_LIMIT" });
  });

  it("reports a missing/renamed upstream and stages staged copies under the account/source upload directory", async () => {
    const root = await newRoot({ "alpha.md": "first" });
    const h = await harness(root);

    const preview = await h.service.createPreview(h.account, h.connection.id, bounds);
    expect(preview.entries.find((entry) => entry.relative_path === "alpha.md")?.classification).toBe("new");
    const applied = await h.service.applyPreview(h.account, preview.preview.id, {
      expected_revision: preview.preview.revision,
      selections: preview.entries
        .filter((entry) => entry.classification === "new")
        .map((entry) => ({ entry_id: entry.entry_id, selection_token: entry.selection_token })),
    });
    const sourceId = applied.items[0]!.source_id;

    // The staged file lives in the ordinary upload directory for the source.
    const expectedDir = path.join(uploadRoot, h.account, sourceId);
    const source = await h.ledger.get<{ file_path: string; status: string }>(
      "SELECT file_path,status FROM sources WHERE id=? AND account_id=?",
      [sourceId, h.account]
    );
    expect(source?.file_path.startsWith(expectedDir)).toBe(true);
    expect(await fs.readFile(source!.file_path, "utf8")).toBe("first");
    // Normal ingestion admission reserves one generation and promotes it.
    const promoted = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    expect(promoted.fully_ready).toBe(true);
    expect(await h.store.sourceIngestionState(h.account, sourceId)).toMatchObject({
      readyGeneration: 1,
      jobStatus: "done",
    });
    expect(h.ingestion.generations).toEqual([1]);

    // Rename the upstream file: identity is path, so the old path goes missing
    // and the new path is new (never identity-by-content).
    await fs.rename(path.join(root, "alpha.md"), path.join(root, "moved.md"));
    const second = await h.service.createPreview(h.account, h.connection.id, bounds);
    const byPath = new Map(second.entries.map((entry) => [entry.relative_path, entry.classification]));
    expect(byPath.get("alpha.md")).toBe("missing");
    expect(byPath.get("moved.md")).toBe("new");
  });

  it("detects changed bytes by hash, reuses the source id, and reserves a new generation", async () => {
    const root = await newRoot({ "live.md": "v1" });
    const h = await harness(root);
    const importOne = async (): Promise<void> => {
      const preview = await h.service.createPreview(h.account, h.connection.id, bounds);
      await h.service.applyPreview(h.account, preview.preview.id, {
        expected_revision: preview.preview.revision,
        selections: preview.entries
          .filter((entry) => ["new", "changed", "duplicate"].includes(entry.classification))
          .map((entry) => ({ entry_id: entry.entry_id, selection_token: entry.selection_token })),
      });
      await h.service.refreshAndWaitReady({
        accountId: h.account,
        connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
      });
    };
    await importOne();
    const sourceId = (await h.store.listItems(h.account, h.connection.id, { limit: 100, after: null })).items[0]!
      .source_id;

    // Touch mtime but leave bytes identical: unchanged, no new reservation.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.utimes(path.join(root, "live.md"), new Date(), new Date());
    const unchangedRefresh = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    expect(unchangedRefresh.refreshes[0]?.items[0]?.outcome).toBe("unchanged");
    expect(h.ingestion.generations).toEqual([1]);

    // Now change bytes: changed -> a new generation for the SAME source.
    await fs.writeFile(path.join(root, "live.md"), "v2 bytes", "utf8");
    const changed = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    expect(changed.refreshes[0]?.items[0]).toMatchObject({ outcome: "promoted", source_id: sourceId, generation: 2 });
    expect(h.ingestion.generations).toEqual([1, 2]);
    const sourceCount = await h.ledger.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM sources WHERE account_id=?", [
      h.account,
    ]);
    expect(sourceCount?.n).toBe(1n);
    const source = await h.ledger.get<{ status: string; ready_generation: bigint }>(
      "SELECT status,ready_generation FROM sources WHERE id=?",
      [sourceId]
    );
    expect(source).toMatchObject({ status: "ready", ready_generation: 2n });
  });

  it("fails an over-limit preview atomically: no items, no active refresh", async () => {
    const root = await newRoot({ "a.md": "1", "b.md": "2", "c.md": "3" });
    const h = await harness(root);
    await expect(
      h.service.createPreview(h.account, h.connection.id, { ...bounds, maxEntries: 2 })
    ).rejects.toMatchObject({ code: "KNOWLEDGE_SCAN_LIMIT" });
    await expect(h.store.listItems(h.account, h.connection.id, { limit: 100, after: null })).resolves.toMatchObject({
      items: [],
    });
    await expect(h.store.getActiveRefresh(h.account, h.connection.id)).resolves.toBeUndefined();
    const previews = await h.store.listPreviews(h.account, h.connection.id, { limit: 10, after: null });
    expect(previews.items[0]?.status).toBe("failed");
    expect(previews.items[0]?.error_code).toBe("KNOWLEDGE_SCAN_LIMIT");
  });

  it("retains missing upstream content and its ready generation", async () => {
    const root = await newRoot({ "keep.md": "keep" });
    const h = await harness(root);
    const preview = await h.service.createPreview(h.account, h.connection.id, bounds);
    const applied = await h.service.applyPreview(h.account, preview.preview.id, {
      expected_revision: preview.preview.revision,
      selections: preview.entries.map((entry) => ({
        entry_id: entry.entry_id,
        selection_token: entry.selection_token,
      })),
    });
    await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    await fs.rm(path.join(root, "keep.md"));
    const result = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    expect(result.refreshes[0]?.items[0]?.outcome).toBe("missing");
    const item = await h.store.getItem(h.account, applied.items[0]!.item_id);
    expect(item).toMatchObject({ lifecycle: "missing_upstream", stale: true });
    const source = await h.store.sourceIngestionState(h.account, applied.items[0]!.source_id);
    expect(source?.readyGeneration).toBe(1);
  });
});

describe("upload staging", () => {
  it("creates an exact UUID-scoped directory and rejects identity/symlink drift", async () => {
    const accountId = randomUUID();
    const sourceId = randomUUID();
    const directory = await ensureUploadResourceDirectory(accountId, sourceId);
    expect(directory).toBe(path.join(await fs.realpath(uploadRoot), accountId, sourceId));
    await expect(ensureUploadResourceDirectory("not-a-uuid", sourceId)).rejects.toThrow();
    // A symlinked source directory fails closed.
    const otherId = randomUUID();
    await fs.mkdir(path.join(uploadRoot, accountId), { recursive: true });
    await fs.symlink(directory, path.join(uploadRoot, accountId, otherId)).catch(() => {});
    await expect(ensureUploadResourceDirectory(accountId, otherId)).rejects.toThrow();
  });
});

describe("folder transport recovery integration", () => {
  it("adopts the staged generation after restart without double reservation", async () => {
    const root = await newRoot({ "durable.md": "bytes" });
    const ledgerResource = await createTempSqliteLedger();
    resources.push({ root, uploads: uploadRoot, ledger: ledgerResource });
    const ledger = ledgerResource.ledger;
    const { account, libraryId } = await seedUser(ledger);
    const store = new KnowledgeStore(ledger);
    const adapter = new DesktopFolderKnowledgeAdapter();
    const first = { calls: 0, generations: [] as number[], autoPromote: false };
    const absentSecrets = {
      read: async () => ({ state: "absent" as const }),
      put: async () => undefined,
      remove: async () => undefined,
    };
    const service = new KnowledgeRefreshService({
      store: () => store,
      adapter: () => adapter,
      reingest: makeIngestionSimulator(ledger, first),
      secrets: () => absentSecrets,
      pollIntervalMs: 10,
    });
    const connection = await store.createConnection(account, {
      name: "Durable",
      kind: "desktop_folder",
      config: { root_path: root, display_label: "d" },
      library_id: libraryId,
    });
    const preview = await service.createPreview(account, connection.id, bounds);
    const applied = await service.applyPreview(account, preview.preview.id, {
      expected_revision: preview.preview.revision,
      selections: preview.entries.map((entry) => ({
        entry_id: entry.entry_id,
        selection_token: entry.selection_token,
      })),
    });
    const timedOut = await service.refreshAndWaitReady({
      accountId: account,
      connections: [{ connection_id: connection.id, expected_connection_revision: connection.revision }],
      deadlineMs: 60,
    });
    expect(timedOut.refreshes[0]?.status).toBe("failed");
    expect(first.calls).toBe(1);

    // Simulated restart with a non-promoting recovery pass adopts the reserved
    // generation; then the durable worker promotion finishes the promoted pair.
    const second = { calls: 0, generations: [] as number[], autoPromote: false };
    const recovery = new KnowledgeRefreshService({
      store: () => store,
      adapter: () => new DesktopFolderKnowledgeAdapter(),
      reingest: makeIngestionSimulator(ledger, second),
      secrets: () => absentSecrets,
      pollIntervalMs: 10,
    });
    const firstPass = await recovery.recoverInterrupted(account, { deadlineMs: 40 });
    expect(firstPass.refreshes[0]?.items[0]?.outcome).toBe("pending");
    expect(second.calls).toBe(0);
    await promoteGeneration(ledger, applied.items[0]!.source_id, 1);
    const finished = await recovery.recoverInterrupted(account);
    expect(finished.promoted[0]).toMatchObject({ source_id: applied.items[0]!.source_id, generation: 1 });
    expect(second.calls).toBe(0);
  });
});
