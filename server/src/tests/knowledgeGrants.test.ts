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
  DesktopFolderGrantRegistry,
  DesktopFolderGrantUnavailableError,
  acceptDesktopGrantMessage,
  parseDesktopGrantMessage,
} from "../knowledge/grants.js";
import { DesktopFolderKnowledgeAdapter, createDesktopFolderConnection } from "../knowledge/folder.js";
import { makeIngestionSimulator } from "./knowledgeTransportFixture.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

/**
 * Desktop folder-selection grant semantics: consume-once, ten-minute expiry,
 * account binding, canonical (non-symlink) directory proof, hostile protocol
 * refusal, and the backend flow that consumes a grant to create a
 * `desktop_folder` connection whose scan then runs end to end.
 */

const originalUploadDir = config.uploadDir;
let uploadRoot = "";
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  uploadRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-grant-uploads-")));
  config.uploadDir = uploadRoot;
});

afterEach(async () => {
  config.uploadDir = originalUploadDir;
  await fs.rm(uploadRoot, { recursive: true, force: true }).catch(() => {});
  while (cleanups.length) await cleanups.pop()!();
});

function grantId(): string {
  return randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "").slice(0, 32);
}

async function newFolder(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-grant-root-")));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  const cleanup = cleanups.push.bind(cleanups);
  cleanup(async () => fs.rm(root, { recursive: true, force: true }));
  return root;
}

describe("desktop folder grant registry", () => {
  it("registers only canonical directories and refuses hostile handoffs", async () => {
    const root = await newFolder();
    const registry = new DesktopFolderGrantRegistry();
    await expect(registry.register({ grantId: grantId(), rootPath: root, displayLabel: "Notes" })).resolves.toBe(true);

    // Not a 64-hex id, a relative path, or a missing directory all fail closed.
    await expect(registry.register({ grantId: "zz", rootPath: root, displayLabel: "n" })).resolves.toBe(false);
    await expect(registry.register({ grantId: grantId(), rootPath: "relative/path", displayLabel: "n" })).resolves.toBe(
      false
    );
    await expect(
      registry.register({ grantId: grantId(), rootPath: path.join(root, "missing"), displayLabel: "n" })
    ).resolves.toBe(false);

    // A symlinked path is rejected (realpath must equal the given path).
    const link = path.join(path.dirname(root), `${path.basename(root)}-link`);
    await fs.symlink(root, link).catch(() => {});
    await expect(registry.register({ grantId: grantId(), rootPath: link, displayLabel: "n" })).resolves.toBe(false);
    await fs.rm(link, { force: true });
  });

  it("consumes once, binds the account, and expires", async () => {
    const root = await newFolder({ "a.md": "a" });
    let clock = 1_000;
    const registry = new DesktopFolderGrantRegistry(() => clock);
    const id = grantId();
    await registry.register({ grantId: id, rootPath: root, displayLabel: "Notes" });

    const account = randomUUID();
    const first = await registry.consume(account, id);
    expect(first.root_path).toBe(root);
    await expect(registry.consume(account, id)).rejects.toBeInstanceOf(DesktopFolderGrantUnavailableError);
    await expect(registry.consume(randomUUID(), id)).rejects.toBeInstanceOf(DesktopFolderGrantUnavailableError);

    // Expiry: a fresh grant is dead once its TTL window passes.
    const id2 = grantId();
    await registry.register({ grantId: id2, rootPath: root, displayLabel: "Notes" });
    clock += 10 * 60 * 1000 + 1;
    await expect(registry.consume(account, id2)).rejects.toBeInstanceOf(DesktopFolderGrantUnavailableError);
    expect(registry.pendingCount).toBe(0);

    // Non-UUID account or malformed id throws the same actionable error.
    await expect(registry.consume("not-a-uuid", grantId())).rejects.toBeInstanceOf(DesktopFolderGrantUnavailableError);
  });

  it("parses and accepts only the exact protocol handoff", async () => {
    const root = await newFolder({ "b.md": "b" });
    const id = grantId();
    const valid = { type: "folder-grant", grant_id: id, root_path: root, display_label: "Notes" };
    expect(parseDesktopGrantMessage(valid)).toMatchObject({ grantId: id });
    expect(parseDesktopGrantMessage({ ...valid, extra: "x" })).toBeNull();
    expect(parseDesktopGrantMessage({ ...valid, grant_id: "short" })).toBeNull();
    expect(parseDesktopGrantMessage({ type: "shutdown" })).toBeNull();

    const registry = new DesktopFolderGrantRegistry();
    await expect(acceptDesktopGrantMessage(valid, registry)).resolves.toBe(true);
    expect(registry.pendingCount).toBe(1);
    await expect(acceptDesktopGrantMessage({ ...valid, grant_id: "short" }, registry)).resolves.toBe(false);
  });
});

describe("backend grant consumption end to end", () => {
  async function seedLedger(): Promise<{
    ledger: SqliteLedger;
    cleanup(): Promise<void>;
    account: string;
    libraryId: string;
  }> {
    const resource: TempSqliteLedger = await createTempSqliteLedger();
    cleanups.push(resource.cleanup);
    const account = randomUUID();
    await resource.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
      account,
      `${account}@e.test`,
      "h",
    ]);
    const libraryId = randomUUID();
    await resource.ledger.run("INSERT INTO libraries (id,account_id,name) VALUES (?,?,?)", [
      libraryId,
      account,
      `Lib-${account.slice(0, 6)}`,
    ]);
    return { ledger: resource.ledger, cleanup: async () => undefined, account, libraryId };
  }

  const bounds: KnowledgeScanBounds = {
    maxEntries: 100,
    maxDepth: 10,
    maxVisited: 1_000,
    maxAggregateBytes: 64 * 1024 * 1024,
  };

  it("consumes a grant to create the connection, runs the scan, and rejects reuse", async () => {
    const root = await newFolder({ "doc.md": "grant content" });
    const { ledger, account, libraryId } = await seedLedger();
    const store = new KnowledgeStore(ledger);
    const registry = new DesktopFolderGrantRegistry();

    // The main→backend handoff is accepted and registered by the same code
    // path the desktop host invokes.
    const id = grantId();
    await expect(
      acceptDesktopGrantMessage(
        { type: "folder-grant", grant_id: id, root_path: root, display_label: "Docs" },
        registry
      )
    ).resolves.toBe(true);

    const { grant, connection } = await createDesktopFolderConnection(store, {
      accountId: account,
      grantId: id,
      name: "Docs",
      libraryId,
      registry,
    });
    expect(grant.root_path).toBe(root);
    const created = connection as { config: { root_path: string } };
    expect(created.config.root_path).toBe(root);

    // The connection scans against the granted root and imports via the
    // ordinary ingestion admission.
    const ingestion = { calls: 0, generations: [] as number[], autoPromote: true };
    const service = new KnowledgeRefreshService({
      store: () => store,
      adapter: (kind) => (kind === "desktop_folder" ? new DesktopFolderKnowledgeAdapter() : undefined),
      reingest: makeIngestionSimulator(ledger, ingestion),
      secrets: () => ({
        read: async () => ({ state: "absent" as const }),
        put: async () => undefined,
        remove: async () => undefined,
      }),
      pollIntervalMs: 10,
    });
    const preview = await service.createPreview(account, (connection as { id: string }).id, bounds);
    expect(preview.entries[0]).toMatchObject({ relative_path: "doc.md", classification: "new" });
    const applied = await service.applyPreview(account, preview.preview.id, {
      expected_revision: preview.preview.revision,
      selections: preview.entries.map((entry) => ({
        entry_id: entry.entry_id,
        selection_token: entry.selection_token,
      })),
    });
    await service.refreshAndWaitReady({
      accountId: account,
      connections: [
        {
          connection_id: (connection as { id: string }).id,
          expected_connection_revision: (connection as { revision: number }).revision,
        },
      ],
    });
    expect(ingestion.generations).toEqual([1]);
    const staged = await store.sourceIngestionState(account, applied.items[0]!.source_id);
    expect(staged?.filePath?.startsWith(path.join(uploadRoot, account, applied.items[0]!.source_id))).toBe(true);

    // The grant is spent: a second connection attempt fails and creates none.
    await expect(
      createDesktopFolderConnection(store, { accountId: account, grantId: id, name: "Docs 2", libraryId, registry })
    ).rejects.toBeInstanceOf(DesktopFolderGrantUnavailableError);
    const connections = await ledger.get<{ n: bigint }>(
      "SELECT COUNT(*) AS n FROM knowledge_connections WHERE account_id=?",
      [account]
    );
    expect(connections?.n).toBe(1n);
  });

  it("a desktop_folder connection can only be created from a consumed grant", async () => {
    const { ledger, account, libraryId } = await seedLedger();
    const store = new KnowledgeStore(ledger);
    const registry = new DesktopFolderGrantRegistry();
    await expect(
      createDesktopFolderConnection(store, {
        accountId: account,
        grantId: grantId(),
        name: "Nope",
        libraryId,
        registry,
      })
    ).rejects.toBeInstanceOf(DesktopFolderGrantUnavailableError);
    const count = await ledger.get<{ n: bigint }>(
      "SELECT COUNT(*) AS n FROM knowledge_connections WHERE account_id=?",
      [account]
    );
    expect(count?.n).toBe(0n);
  });
});
