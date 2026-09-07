import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signToken } from "../auth.js";
import { closeConnectionService, configureConnectionService } from "../connections/service.js";
import {
  ConnectionCustodyUnavailableError,
  type ConnectionSecretRead,
  type ConnectionSecretStore,
} from "../connections/secrets.js";
import { DesktopFolderGrantUnavailableError, desktopFolderGrants } from "../knowledge/grants.js";
import { WEBDAV_APPLICATION_PASSWORD_ENV_KEY } from "../knowledge/webdav.js";
import {
  KnowledgeScanFailureError,
  closeKnowledgeRefreshService,
  configureKnowledgeRefresh,
  type KnowledgeTransportAdapter,
} from "../knowledgeRefresh.js";
import { KnowledgeWatchPump } from "../knowledgeWatch.js";
import { knowledgeRoutes } from "../routes/knowledge.js";
import { installHttpBoundary } from "../httpErrors.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { DeterministicKnowledgeAdapter, makeIngestionSimulator } from "./knowledgeTransportFixture.js";

/**
 * Route-matrix tests for the M14 stage-4 living-library HTTP surface:
 * grant-bound folder creation (expiry, wrong account, consume-once), WebDAV
 * write-only password custody with redaction scans, revision CAS 409s on
 * connection edits and preview apply, stale/expired/foreign preview apply
 * refusals, durable refresh cancellation idempotence, delete-with-active-
 * refresh behavior, and source/library retention after connection deletion.
 */

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}` };
const foreignAuth = { authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}` };

const apps: FastifyInstance[] = [];
let runtimeDirectory = "";
let stagingDirectory = "";
let grantRoot = "";
let custody = new Map<string, Record<string, string>>();
let custodyFails = false;
let folderAdapter: DeterministicKnowledgeAdapter;
let webdavAdapter: DeterministicKnowledgeAdapter;
let ingestion: { calls: number; generations: number[]; autoPromote: boolean };

const secretStore: ConnectionSecretStore = {
  async put(accountId, connectionId, secrets): Promise<void> {
    if (custodyFails) throw new ConnectionCustodyUnavailableError();
    custody.set(`${accountId}|${connectionId}`, { ...(secrets.env ?? {}) });
  },
  async read(accountId, connectionId): Promise<ConnectionSecretRead> {
    const record = custody.get(`${accountId}|${connectionId}`);
    if (!record) return { state: "absent" };
    return { state: "available", secrets: { headers: {}, env: record } };
  },
  async remove(accountId, connectionId): Promise<void> {
    custody.delete(`${accountId}|${connectionId}`);
  },
};

beforeEach(async () => {
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-knowledge-routes-"));
  stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-knowledge-stage-"));
  grantRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-grant-dir-")));
  custody = new Map();
  custodyFails = false;
  const runtime = await initializeStorageRuntime({
    sqlitePath: path.join(runtimeDirectory, "ledger.sqlite"),
    lanceDirectory: path.join(runtimeDirectory, "lancedb"),
    embeddingDimension: 3,
  });
  for (const [id, email] of [
    [OWNER, "owner@example.test"],
    [FOREIGN, "foreign@example.test"],
  ] as const) {
    await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, email, "hash"]);
  }
  folderAdapter = new DeterministicKnowledgeAdapter("desktop_folder", stagingDirectory);
  webdavAdapter = new DeterministicKnowledgeAdapter("webdav", stagingDirectory);
  ingestion = { calls: 0, generations: [], autoPromote: true };
  configureKnowledgeRefresh({
    store: () => storageRuntime().knowledge,
    adapter: (kind) =>
      (({ desktop_folder: folderAdapter, webdav: webdavAdapter }) as Record<string, KnowledgeTransportAdapter>)[kind],
    reingest: makeIngestionSimulator(runtime.ledger, ingestion),
    secrets: () => secretStore,
    pollIntervalMs: 5,
  });
  configureConnectionService({ secrets: () => secretStore });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
  closeKnowledgeRefreshService();
  closeConnectionService();
  desktopFolderGrants.clearForTesting();
  await closeStorageRuntime();
  if (runtimeDirectory) await fs.rm(runtimeDirectory, { recursive: true, force: true });
  if (stagingDirectory) await fs.rm(stagingDirectory, { recursive: true, force: true });
  if (grantRoot) await fs.rm(grantRoot, { recursive: true, force: true });
});

async function buildApp(desktop = false): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(knowledgeRoutes, { desktop });
  await app.ready();
  return app;
}

async function createLibrary(name: string, owner: string = OWNER): Promise<string> {
  const id = randomUUID();
  await storageRuntime().ledger.run("INSERT INTO libraries (id,account_id,name) VALUES (?,?,?)", [id, owner, name]);
  return id;
}

function newGrantId(): string {
  return randomBytes(32).toString("hex");
}

async function registerGrant(grantId = newGrantId(), ttlMs?: number): Promise<string> {
  const ok = await desktopFolderGrants.register({
    grantId,
    rootPath: grantRoot,
    displayLabel: "Research notes",
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  if (!ok) throw new DesktopFolderGrantUnavailableError("fixture: grant registration rejected");
  return grantId;
}

async function createFolderConnection(
  app: FastifyInstance,
  options: { name?: string; libraryId?: string; watch?: boolean; auth?: Record<string, string>; owner?: string } = {}
): Promise<{ id: string; revision: number; libraryId: string }> {
  const auth = options.auth ?? ownerAuth;
  const libraryId =
    options.libraryId ?? (await createLibrary(`lib-${randomUUID().slice(0, 8)}`, options.owner ?? OWNER));
  const grantId = await registerGrant();
  const created = await app.inject({
    method: "POST",
    url: "/api/knowledge-connections",
    headers: auth,
    body: {
      name: options.name ?? `folder-${randomUUID().slice(0, 8)}`,
      kind: "desktop_folder",
      library_id: libraryId,
      grant_id: grantId,
      ...(options.watch === undefined ? {} : { watch_enabled: options.watch }),
    },
  });
  expect(created.statusCode).toBe(201);
  return { id: created.json().id as string, revision: created.json().revision as number, libraryId };
}

async function createWebdavConnection(
  app: FastifyInstance,
  options: { name?: string; password?: string } = {}
): Promise<{ id: string; revision: number; libraryId: string; password: string }> {
  const password = options.password ?? `pw-${randomUUID()}`;
  const libraryId = await createLibrary(`lib-${randomUUID().slice(0, 8)}`);
  const created = await app.inject({
    method: "POST",
    url: "/api/knowledge-connections",
    headers: ownerAuth,
    body: {
      name: options.name ?? `dav-${randomUUID().slice(0, 8)}`,
      kind: "webdav",
      library_id: libraryId,
      config: { url: "https://dav.example.test/collections/team", username: "ada", password },
    },
  });
  expect(created.statusCode).toBe(201);
  return { id: created.json().id as string, revision: created.json().revision as number, libraryId, password };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitPreview(
  app: FastifyInstance,
  previewId: string,
  wanted: readonly string[],
  auth = ownerAuth
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const res = await app.inject({ method: "GET", url: `/api/knowledge-previews/${previewId}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const status = (res.json().preview as { status: string }).status;
    if (wanted.includes(status)) return res.json() as Record<string, unknown>;
    await sleep(5);
  }
  throw new Error(`preview ${previewId} never reached ${wanted.join("|")}`);
}

async function waitRefresh(
  app: FastifyInstance,
  refreshId: string,
  wanted: readonly string[],
  auth = ownerAuth
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2_400; attempt += 1) {
    const res = await app.inject({ method: "GET", url: `/api/knowledge-refreshes/${refreshId}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const status = (res.json().refresh as { status: string }).status;
    if (wanted.includes(status)) return res.json() as Record<string, unknown>;
    await sleep(5);
  }
  throw new Error(`refresh ${refreshId} never reached ${wanted.join("|")}`);
}

/** Deep redaction scan: banned material may appear nowhere in a payload. */
function expectRedacted(payload: unknown, banned: readonly string[]): void {
  const text = JSON.stringify(payload);
  for (const secret of banned) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toContain("root_path");
  expect(text).not.toContain("candidate_path");
}

interface PreviewDone {
  preview: { id: string; revision: number; status: string };
  entries: {
    entry_id: string;
    selection_token: string;
    classification: string;
    relative_path: string;
    existing_source_id: string | null;
  }[];
}

async function startPreview(app: FastifyInstance, connectionId: string): Promise<string> {
  const started = await app.inject({
    method: "POST",
    url: `/api/knowledge-connections/${connectionId}/previews`,
    headers: ownerAuth,
  });
  expect(started.statusCode).toBe(202);
  expect((started.json().preview as { status: string }).status).toBe("pending");
  const previewId = (started.json().preview as { id: string }).id;
  expect(started.json().run_id).toBe(previewId);
  return previewId;
}

async function completePreview(app: FastifyInstance, connectionId: string): Promise<PreviewDone> {
  const previewId = await startPreview(app, connectionId);
  return (await waitPreview(app, previewId, ["complete"])) as unknown as PreviewDone;
}

async function applyEntries(app: FastifyInstance, done: PreviewDone, entries?: PreviewDone["entries"]) {
  const selections = (entries ?? done.entries)
    .filter((entry) => ["new", "changed", "duplicate"].includes(entry.classification))
    .map((entry) => ({ entry_id: entry.entry_id, selection_token: entry.selection_token }));
  return app.inject({
    method: "POST",
    url: `/api/knowledge-previews/${done.preview.id}/apply`,
    headers: ownerAuth,
    body: { expected_revision: done.preview.revision, selections },
  });
}

/** Preview → select every selectable entry → apply (does not await refresh). */
async function importAll(
  app: FastifyInstance,
  connectionId: string
): Promise<{
  refreshId: string;
  items: { entry_id: string; item_id: string; source_id: string; relative_path: string; action: string }[];
}> {
  const done = await completePreview(app, connectionId);
  const applied = await applyEntries(app, done);
  expect(applied.statusCode).toBe(200);
  return {
    refreshId: applied.json().refresh_id as string,
    items: applied.json().items as {
      entry_id: string;
      item_id: string;
      source_id: string;
      relative_path: string;
      action: string;
    }[],
  };
}

describe("POST /api/knowledge-connections — desktop folder grants", () => {
  it("creates only from a consumed grant and never exposes the root path", async () => {
    const app = await buildApp();
    const libraryId = await createLibrary("Notes");
    const grantId = await registerGrant();
    const created = await app.inject({
      method: "POST",
      url: "/api/knowledge-connections",
      headers: ownerAuth,
      body: { name: "Research", kind: "desktop_folder", library_id: libraryId, grant_id: grantId },
    });
    expect(created.statusCode).toBe(201);
    expectRedacted(created.json(), [grantRoot, grantId]);
    expect(created.json().label).toBe("Research notes");
    expect(created.json().watch_enabled).toBe(false);

    // Consume-once: the same grant cannot create a second connection.
    const replay = await app.inject({
      method: "POST",
      url: "/api/knowledge-connections",
      headers: ownerAuth,
      body: { name: "Replay", kind: "desktop_folder", library_id: libraryId, grant_id: grantId },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().code).toBe("DESKTOP_FOLDER_GRANT_INVALID");
  });

  it("refuses missing grants, path-carrying bodies, and expired grants", async () => {
    const app = await buildApp();
    const libraryId = await createLibrary("Notes");
    const missing = await app.inject({
      method: "POST",
      url: "/api/knowledge-connections",
      headers: ownerAuth,
      body: { name: "NoGrant", kind: "desktop_folder", library_id: libraryId },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("DESKTOP_FOLDER_GRANT_INVALID");

    const pathBody = await app.inject({
      method: "POST",
      url: "/api/knowledge-connections",
      headers: ownerAuth,
      body: {
        name: "Sneak",
        kind: "desktop_folder",
        library_id: libraryId,
        grant_id: "f".repeat(64),
        config: { url: "http://127.0.0.1:9/dav", username: "ada", password: "pw" },
      },
    });
    expect(pathBody.statusCode).toBe(400);

    const expired = await registerGrant(newGrantId(), 1);
    await sleep(10);
    const expiredRes = await app.inject({
      method: "POST",
      url: "/api/knowledge-connections",
      headers: ownerAuth,
      body: { name: "Expired", kind: "desktop_folder", library_id: libraryId, grant_id: expired },
    });
    expect(expiredRes.statusCode).toBe(400);
    expect(expiredRes.json().code).toBe("DESKTOP_FOLDER_GRANT_INVALID");
  });

  it("binds the grant to the consuming account so a second account cannot reuse it", async () => {
    const app = await buildApp();
    const ownerLibrary = await createLibrary("Mine");
    const foreignLibrary = await createLibrary("Theirs", FOREIGN);
    const grantId = await registerGrant();
    const mine = await app.inject({
      method: "POST",
      url: "/api/knowledge-connections",
      headers: ownerAuth,
      body: { name: "Mine", kind: "desktop_folder", library_id: ownerLibrary, grant_id: grantId },
    });
    expect(mine.statusCode).toBe(201);
    const stolen = await app.inject({
      method: "POST",
      url: "/api/knowledge-connections",
      headers: foreignAuth,
      body: { name: "Stolen", kind: "desktop_folder", library_id: foreignLibrary, grant_id: grantId },
    });
    expect(stolen.statusCode).toBe(400);
    expect(stolen.json().code).toBe("DESKTOP_FOLDER_GRANT_INVALID");
  });
});

describe("WebDAV connections — write-only password custody", () => {
  it("stores the password only in custody and never returns it anywhere", async () => {
    const app = await buildApp();
    const created = await createWebdavConnection(app, { password: "sup3r-secretpw" });
    expect(custody.get(`${OWNER}|${created.id}`)?.[WEBDAV_APPLICATION_PASSWORD_ENV_KEY]).toBe("sup3r-secretpw");

    const list = await app.inject({ method: "GET", url: "/api/knowledge-connections", headers: ownerAuth });
    expect(list.statusCode).toBe(200);
    expectRedacted(list.json(), ["sup3r-secretpw"]);
    expect((list.json().items as { credential_configured: boolean }[])[0].credential_configured).toBe(true);

    const rotated = await app.inject({
      method: "PATCH",
      url: `/api/knowledge-connections/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: created.revision, credentials: { password: "rotated-pw" } },
    });
    expect(rotated.statusCode).toBe(200);
    expectRedacted(rotated.json(), ["rotated-pw", "sup3r-secretpw"]);
    expect(custody.get(`${OWNER}|${created.id}`)?.[WEBDAV_APPLICATION_PASSWORD_ENV_KEY]).toBe("rotated-pw");

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/knowledge-connections/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: rotated.json().revision, credentials: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().credential_configured).toBe(false);
    expect(custody.size).toBe(0);
  });

  it("compensates: a connection whose password cannot reach custody does not exist", async () => {
    const app = await buildApp();
    custodyFails = true;
    const libraryId = await createLibrary("Notes");
    const failed = await app.inject({
      method: "POST",
      url: "/api/knowledge-connections",
      headers: ownerAuth,
      body: {
        name: "Half",
        kind: "webdav",
        library_id: libraryId,
        config: { url: "https://dav.example.test/c", username: "ada", password: "pw" },
      },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().code).toBe("CONNECTION_CUSTODY_UNAVAILABLE");
    const list = await app.inject({ method: "GET", url: "/api/knowledge-connections", headers: ownerAuth });
    expect(list.json().items).toHaveLength(0);
  });

  it("refuses credential replacement on folder connections and watch on webdav", async () => {
    const app = await buildApp();
    const folder = await createFolderConnection(app);
    const wrongKind = await app.inject({
      method: "PATCH",
      url: `/api/knowledge-connections/${folder.id}`,
      headers: ownerAuth,
      body: { expected_revision: folder.revision, credentials: { password: "pw" } },
    });
    expect(wrongKind.statusCode).toBe(400);
    const webdav = await createWebdavConnection(app);
    const watch = await app.inject({
      method: "PATCH",
      url: `/api/knowledge-connections/${webdav.id}`,
      headers: ownerAuth,
      body: { expected_revision: webdav.revision, watch_enabled: true },
    });
    expect(watch.statusCode).toBe(400);
    expect(watch.json().code).toBe("KNOWLEDGE_CONNECTION_CONFIG_INVALID");
    // The refused watch edit changed nothing.
    const list = await app.inject({ method: "GET", url: "/api/knowledge-connections", headers: ownerAuth });
    const row = (list.json().items as { id: string; watch_enabled: boolean }[]).find((item) => item.id === webdav.id);
    expect(row?.watch_enabled).toBe(false);
  });
});

describe("GET /api/knowledge-connections — catalog", () => {
  it("defaults to 25 rows with a bound cursor and rejects over-limit", async () => {
    const app = await buildApp();
    for (let index = 0; index < 26; index += 1) await createFolderConnection(app, { name: `note-${index}` });
    const first = await app.inject({ method: "GET", url: "/api/knowledge-connections", headers: ownerAuth });
    expect(first.json().items).toHaveLength(25);
    expect(typeof first.json().next_cursor).toBe("string");
    const next = await app.inject({
      method: "GET",
      url: `/api/knowledge-connections?cursor=${first.json().next_cursor}`,
      headers: ownerAuth,
    });
    expect(next.json().items).toHaveLength(1);
    const overLimit = await app.inject({
      method: "GET",
      url: "/api/knowledge-connections?limit=200",
      headers: ownerAuth,
    });
    expect(overLimit.statusCode).toBe(400);
    const foreign = await app.inject({ method: "GET", url: "/api/knowledge-connections", headers: foreignAuth });
    expect(foreign.json().items).toHaveLength(0);
  });
});

describe("PATCH /api/knowledge-connections/:id — version-checked edits", () => {
  it("stale revisions conflict and name edits advance the lineage", async () => {
    const app = await buildApp();
    const folder = await createFolderConnection(app, { name: "Original" });
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/knowledge-connections/${folder.id}`,
      headers: ownerAuth,
      body: { expected_revision: folder.revision + 5, name: "Too late" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("KNOWLEDGE_CONNECTION_REVISION_CONFLICT");
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/knowledge-connections/${folder.id}`,
      headers: ownerAuth,
      body: { expected_revision: folder.revision, name: "Renamed" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().revision).toBe(folder.revision + 1);
    const watch = await app.inject({
      method: "PATCH",
      url: `/api/knowledge-connections/${folder.id}`,
      headers: ownerAuth,
      body: { expected_revision: renamed.json().revision, watch_enabled: true },
    });
    expect(watch.statusCode).toBe(200);
    expect(watch.json().watch_enabled).toBe(true);
    // A watch-only toggle does not rewrite the revision lineage.
    expect(watch.json().revision).toBe(renamed.json().revision);
    const taken = await app.inject({
      method: "PATCH",
      url: `/api/knowledge-connections/${folder.id}`,
      headers: ownerAuth,
      body: { expected_revision: watch.json().revision, name: "Original" },
    });
    // "Original" was freed by the rename, so this succeeds; a true duplicate
    // conflicts instead.
    expect(taken.statusCode).toBe(200);
    const duplicate = await createFolderConnection(app, { name: "Sibling" });
    const conflict = await app.inject({
      method: "PATCH",
      url: `/api/knowledge-connections/${duplicate.id}`,
      headers: ownerAuth,
      body: { expected_revision: duplicate.revision, name: "Original" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("KNOWLEDGE_CONNECTION_NAME_TAKEN");
  });

  it("foreign connections are 404", async () => {
    const app = await buildApp();
    const folder = await createFolderConnection(app);
    const foreign = await app.inject({
      method: "PATCH",
      url: `/api/knowledge-connections/${folder.id}`,
      headers: foreignAuth,
      body: { expected_revision: 1, name: "Not mine" },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe("KNOWLEDGE_CONNECTION_NOT_FOUND");
  });
});

describe("previews — durable bounded scan, selection tokens, and CAS apply", () => {
  it("runs the scan in the background and reports classifications, counts, and skips", async () => {
    const app = await buildApp();
    const folder = await createFolderConnection(app);
    folderAdapter.put("notes/a.md", "alpha");
    folderAdapter.put("notes/b.md", "beta");
    folderAdapter.skipped = [{ relative_path: "notes/.secret.md", reason: "hidden" }];
    const done = await completePreview(app, folder.id);
    expect(done.preview.status).toBe("complete");
    expect((done as unknown as { preview: { skipped_count: number } }).preview.skipped_count).toBe(1);
    expect(done.entries.map((entry) => entry.relative_path)).toEqual(["notes/a.md", "notes/b.md"]);
    for (const entry of done.entries) {
      expect(entry.classification).toBe("new");
      expect(entry.selection_token).toMatch(/^[0-9a-f]{64}$/);
    }
    const read = await app.inject({
      method: "GET",
      url: `/api/knowledge-previews/${done.preview.id}`,
      headers: ownerAuth,
    });
    expectRedacted(read.json(), [grantRoot]);
  });

  it("apply commits selected entries, binds library membership, and promotes generations", async () => {
    const app = await buildApp();
    const folder = await createFolderConnection(app);
    folderAdapter.put("a.md", "alpha");
    folderAdapter.put("dup.md", "alpha");
    const imported = await importAll(app, folder.id);
    expect(imported.items).toHaveLength(2);
    await waitRefresh(app, imported.refreshId, ["completed", "partial"]);
    const members = await storageRuntime().libraries.listMembers(OWNER, folder.libraryId);
    expect(members.map((member) => member.id).sort()).toEqual(imported.items.map((item) => item.source_id).sort());
    for (const item of imported.items) {
      const source = await storageRuntime().ledger.get<{ status: string; ready_generation: number }>(
        "SELECT status,ready_generation FROM sources WHERE id=?",
        [item.source_id]
      );
      expect(source?.status).toBe("ready");
      expect(source?.ready_generation).toBeGreaterThanOrEqual(1);
    }
    // The modified-source-reuse path: a changed file applies under the same
    // source id (never a second source for a same-path replacement).
    folderAdapter.put("a.md", "alpha v2");
    const done = await completePreview(app, folder.id);
    const changed = done.entries.find((entry) => entry.classification === "changed");
    expect(changed?.relative_path).toBe("a.md");
    const originalId = imported.items.find((item) => item.relative_path === "a.md")!.source_id;
    expect(changed?.existing_source_id).toBe(originalId);
    const applied2 = await applyEntries(
      app,
      done,
      done.entries.filter((entry) => entry.classification === "changed")
    );
    expect(applied2.statusCode).toBe(200);
    expect((applied2.json().items as { source_id: string }[])[0].source_id).toBe(originalId);
    await waitRefresh(app, applied2.json().refresh_id as string, ["completed", "partial"]);
  });

  it("stale revisions, wrong tokens, re-applies, foreign entries, and expiry are refused", async () => {
    const app = await buildApp();
    const folder = await createFolderConnection(app);
    folderAdapter.put("a.md", "alpha");
    const previewId = await startPreview(app, folder.id);
    const done = (await waitPreview(app, previewId, ["complete"])) as unknown as PreviewDone;
    const entry = done.entries[0]!;

    const wrongRevision = await app.inject({
      method: "POST",
      url: `/api/knowledge-previews/${previewId}/apply`,
      headers: ownerAuth,
      body: { expected_revision: done.preview.revision + 3, selections: [entry] },
    });
    expect(wrongRevision.statusCode).toBe(409);
    expect(wrongRevision.json().code).toBe("KNOWLEDGE_PREVIEW_STALE");

    const wrongToken = await app.inject({
      method: "POST",
      url: `/api/knowledge-previews/${previewId}/apply`,
      headers: ownerAuth,
      body: {
        expected_revision: done.preview.revision,
        selections: [{ entry_id: entry.entry_id, selection_token: "0".repeat(64) }],
      },
    });
    expect(wrongToken.statusCode).toBe(409);
    expect(wrongToken.json().code).toBe("KNOWLEDGE_PREVIEW_STALE");

    // A foreign account's preview entry is "not part of this preview".
    const foreignLibrary = await createLibrary("F2", FOREIGN);
    const foreign = await createFolderConnection(app, {
      name: "foreign-conn",
      libraryId: foreignLibrary,
      auth: foreignAuth,
      owner: FOREIGN,
    });
    const foreignDone = (await waitPreview(
      app,
      await startPreviewForeign(app, foreign.id),
      ["complete"],
      foreignAuth
    )) as unknown as PreviewDone;
    const foreignEntry = foreignDone.entries[0] ?? entry;
    const foreignSelection = await app.inject({
      method: "POST",
      url: `/api/knowledge-previews/${previewId}/apply`,
      headers: ownerAuth,
      body: {
        expected_revision: done.preview.revision,
        selections: [{ entry_id: foreignEntry.entry_id, selection_token: foreignEntry.selection_token }],
      },
    });
    expect(foreignSelection.statusCode).toBe(409);
    expect(foreignSelection.json().code).toBe("KNOWLEDGE_PREVIEW_STALE");

    const applied = await applyEntries(app, done);
    expect(applied.statusCode).toBe(200);
    const reapplied = await app.inject({
      method: "POST",
      url: `/api/knowledge-previews/${previewId}/apply`,
      headers: ownerAuth,
      body: {
        expected_revision: done.preview.revision,
        selections: [{ entry_id: entry.entry_id, selection_token: entry.selection_token }],
      },
    });
    expect(reapplied.statusCode).toBe(409);

    // An expired complete preview is 410, and expiry lands lazily on read.
    const pendingId = await startPreview(app, folder.id);
    await waitPreview(app, pendingId, ["complete", "failed", "expired"]);
    await storageRuntime().ledger.run(
      "UPDATE knowledge_previews SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
      [pendingId]
    );
    const expiredApply = await app.inject({
      method: "POST",
      url: `/api/knowledge-previews/${pendingId}/apply`,
      headers: ownerAuth,
      body: { expected_revision: 1, selections: [{ entry_id: randomUUID(), selection_token: "0".repeat(64) }] },
    });
    expect(expiredApply.statusCode).toBe(410);
    expect(expiredApply.json().code).toBe("KNOWLEDGE_PREVIEW_EXPIRED");
    const lazyRead = await app.inject({
      method: "GET",
      url: `/api/knowledge-previews/${pendingId}`,
      headers: ownerAuth,
    });
    expect((lazyRead.json().preview as { status: string }).status).toBe("expired");

    const foreignRead = await app.inject({
      method: "GET",
      url: `/api/knowledge-previews/${previewId}`,
      headers: foreignAuth,
    });
    expect(foreignRead.statusCode).toBe(404);
  });

  it("returns actionable HTTP 403 if source read permission is lost after preview, before apply", async () => {
    const app = await buildApp();
    const folder = await createFolderConnection(app);
    folderAdapter.put("readme.md", "fixture bytes");
    const done = await completePreview(app, folder.id);
    folderAdapter.stage = async () => {
      throw new KnowledgeScanFailureError("KNOWLEDGE_FILE_UNREADABLE", "private fixture path must stay private");
    };
    const applied = await applyEntries(app, done);
    expect(applied.statusCode).toBe(403);
    expect(applied.json()).toEqual({
      code: "KNOWLEDGE_FILE_UNREADABLE",
      error: "restore read access to the folder and its files, then retry",
    });
    expect(ingestion.calls).toBe(0);
    expect(await storageRuntime().knowledge.getActiveRefresh(OWNER, folder.id)).toBeUndefined();
    expect((await storageRuntime().knowledge.listItems(OWNER, folder.id, { limit: 100, after: null })).items).toEqual(
      []
    );
  });

  it("returns a content-free durable permission failure for an unreadable folder preview", async () => {
    const app = await buildApp();
    const folder = await createFolderConnection(app);
    folderAdapter.scan = async () => {
      throw new KnowledgeScanFailureError("KNOWLEDGE_FILE_UNREADABLE", "private fixture path must stay private");
    };
    const previewId = await startPreview(app, folder.id);
    const done = await waitPreview(app, previewId, ["failed"]);
    expect(done.preview).toMatchObject({ status: "failed", error_code: "KNOWLEDGE_FILE_UNREADABLE" });
    expect(done.entries).toEqual([]);
    expect(JSON.stringify(done)).not.toContain("private fixture path");
    const listed = await app.inject({ method: "GET", url: "/api/knowledge-connections", headers: ownerAuth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toContainEqual(
      expect.objectContaining({ id: folder.id, status: "error", status_code: "KNOWLEDGE_FILE_UNREADABLE" })
    );
    expect(ingestion.calls).toBe(0);
  });

  it("records an actionable disconnected state when the webdav password is gone", async () => {
    const app = await buildApp();
    const webdav = await createWebdavConnection(app);
    custody.delete(`${OWNER}|${webdav.id}`);
    const previewId = await startPreview(app, webdav.id);
    const done = await waitPreview(app, previewId, ["failed"]);
    expect((done.preview as unknown as { error_code: string }).error_code).toBe("KNOWLEDGE_CREDENTIALS_MISSING");
    const list = await app.inject({ method: "GET", url: "/api/knowledge-connections", headers: ownerAuth });
    const row = (list.json().items as { id: string; status: string; status_code: string | null }[]).find(
      (item) => item.id === webdav.id
    );
    expect(row?.status).toBe("disconnected");
    expect(row?.status_code).toBe("KNOWLEDGE_CREDENTIALS_MISSING");
  });
});

async function startPreviewForeign(app: FastifyInstance, connectionId: string): Promise<string> {
  const started = await app.inject({
    method: "POST",
    url: `/api/knowledge-connections/${connectionId}/previews`,
    headers: foreignAuth,
  });
  expect(started.statusCode).toBe(202);
  return (started.json().preview as { id: string }).id;
}

describe("refreshes — history, single active, cancellation idempotence", () => {
  it("supports the full lifecycle with durable cancellation", async () => {
    const app = await buildApp();
    ingestion.autoPromote = false;
    const folder = await createFolderConnection(app);
    folderAdapter.put("a.md", "alpha");
    const imported = await importAll(app, folder.id); // refresh active (never promoted)

    const history = await app.inject({
      method: "GET",
      url: `/api/knowledge-connections/${folder.id}/refreshes`,
      headers: ownerAuth,
    });
    expect(history.statusCode).toBe(200);
    expect((history.json().items as unknown[]).length).toBe(1);

    const second = await app.inject({
      method: "POST",
      url: `/api/knowledge-connections/${folder.id}/refreshes`,
      headers: ownerAuth,
      body: {},
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("KNOWLEDGE_REFRESH_ACTIVE");

    const cancel = await app.inject({
      method: "DELETE",
      url: `/api/knowledge-refreshes/${imported.refreshId}`,
      headers: ownerAuth,
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().cancel_requested).toBe(true);
    const settled = await waitRefresh(app, imported.refreshId, ["cancelled"]);
    expect((settled.refresh as { status: string }).status).toBe("cancelled");

    // Idempotent cancellation: the settled refresh reports its state, not an
    // error, and a repeat request changes nothing.
    const again = await app.inject({
      method: "DELETE",
      url: `/api/knowledge-refreshes/${imported.refreshId}`,
      headers: ownerAuth,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe("cancelled");

    const missing = await app.inject({
      method: "GET",
      url: `/api/knowledge-refreshes/${randomUUID()}`,
      headers: ownerAuth,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("KNOWLEDGE_REFRESH_NOT_FOUND");
    const foreignRead = await app.inject({
      method: "GET",
      url: `/api/knowledge-refreshes/${imported.refreshId}`,
      headers: foreignAuth,
    });
    expect(foreignRead.statusCode).toBe(404);

    // With the active refresh gone, a new manual refresh can begin and the
    // previously reserved generation is adopted without a second reservation.
    await storageRuntime().ledger.run("DELETE FROM ingestion_jobs");
    ingestion.autoPromote = true;
    const next = await app.inject({
      method: "POST",
      url: `/api/knowledge-connections/${folder.id}/refreshes`,
      headers: ownerAuth,
      body: {},
    });
    expect(next.statusCode).toBe(202);
    const done = await waitRefresh(app, (next.json().refresh as { id: string }).id, ["completed", "partial"]);
    expect((done.refresh as { requested_by: string }).requested_by).toBe("manual");
    expect((done.counts as Record<string, number>).ready + (done.counts as Record<string, number>).unchanged).toBe(1);
  });

  it("delete with an active refresh cancels work and retains sources and library", async () => {
    const app = await buildApp();
    const folder = await createFolderConnection(app);
    folderAdapter.put("a.md", "alpha");
    const imported = await importAll(app, folder.id);
    await waitRefresh(app, imported.refreshId, ["completed", "partial"]);
    const sourceIds = imported.items.map((item) => item.source_id);
    for (const id of sourceIds) {
      const row = await storageRuntime().ledger.get<{ status: string }>("SELECT status FROM sources WHERE id=?", [id]);
      expect(row?.status).toBe("ready");
    }
    // A new upstream change leaves the next refresh active (no promotion).
    folderAdapter.put("a.md", "alpha v2");
    const done = await completePreview(app, folder.id);
    const changedEntry = done.entries.find((entry) => entry.classification === "changed")!;
    ingestion.autoPromote = false;
    const applied2 = await applyEntries(app, done, [changedEntry]);
    const activeId = applied2.json().refresh_id as string;
    const statusBefore = await app.inject({
      method: "GET",
      url: `/api/knowledge-refreshes/${activeId}`,
      headers: ownerAuth,
    });
    expect((statusBefore.json().refresh as { status: string }).status).toBe("active");

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/knowledge-connections/${folder.id}`,
      headers: ownerAuth,
    });
    expect(removed.statusCode).toBe(200);

    // Retention: sources and library membership survive; mappings, the
    // durable refresh row, the secret, and any watch flag are gone.
    for (const id of sourceIds) {
      const row = await storageRuntime().ledger.get<{ id: string }>("SELECT id FROM sources WHERE id=?", [id]);
      expect(row).toBeTruthy();
      const member = await storageRuntime().ledger.get(
        "SELECT 1 FROM library_sources WHERE source_id=? AND library_id=?",
        [id, folder.libraryId]
      );
      expect(member).toBeTruthy();
    }
    const itemRows = await storageRuntime().ledger.get<{ n: number | bigint }>(
      "SELECT COUNT(*) AS n FROM knowledge_items WHERE connection_id=?",
      [folder.id]
    );
    expect(Number(itemRows?.n)).toBe(0);
    const goneRefresh = await app.inject({
      method: "GET",
      url: `/api/knowledge-refreshes/${activeId}`,
      headers: ownerAuth,
    });
    expect(goneRefresh.statusCode).toBe(404);
    const connectionGone = await app.inject({
      method: "DELETE",
      url: `/api/knowledge-connections/${folder.id}`,
      headers: ownerAuth,
    });
    expect(connectionGone.statusCode).toBe(404);
    expect(await storageRuntime().knowledge.listWatchEnabledConnections()).toEqual([]);
  });
});

describe("watch persistence and status passthrough", () => {
  it("pauses permission-denied watch runs until a successful manual retry", async () => {
    const captured: { pump?: KnowledgeWatchPump } = {};
    const start = KnowledgeWatchPump.prototype.start;
    vi.spyOn(KnowledgeWatchPump.prototype, "start").mockImplementation(function (this: KnowledgeWatchPump) {
      captured.pump = this;
      start.call(this);
    });
    const app = await buildApp(true);
    const folder = await createFolderConnection(app, { watch: true });
    folderAdapter.put("readme.md", "ready bytes");
    const imported = await importAll(app, folder.id);
    await waitRefresh(app, imported.refreshId, ["completed"]);
    const inspect = folderAdapter.inspect.bind(folderAdapter);
    let deniedCalls = 0;
    folderAdapter.inspect = async () => {
      deniedCalls += 1;
      throw new KnowledgeScanFailureError("KNOWLEDGE_FILE_UNREADABLE", "permission denied");
    };
    expect(captured.pump).toBeDefined();
    await captured.pump!.reconcile();
    expect(deniedCalls).toBe(1);
    expect(await storageRuntime().knowledge.getConnection(OWNER, folder.id)).toMatchObject({
      watch_enabled: true,
      status: "error",
      status_code: "KNOWLEDGE_FILE_UNREADABLE",
    });
    expect(await storageRuntime().knowledge.getActiveRefresh(OWNER, folder.id)).toBeUndefined();
    const before = await storageRuntime().ledger.all(
      "SELECT id FROM knowledge_refreshes WHERE connection_id=? ORDER BY id",
      [folder.id]
    );
    await captured.pump!.reconcile();
    expect(deniedCalls).toBe(1);
    expect(
      await storageRuntime().ledger.all("SELECT id FROM knowledge_refreshes WHERE connection_id=? ORDER BY id", [
        folder.id,
      ])
    ).toEqual(before);
    folderAdapter.inspect = inspect;
    const retry = await app.inject({
      method: "POST",
      url: `/api/knowledge-connections/${folder.id}/refreshes`,
      headers: ownerAuth,
      body: { expected_connection_revision: folder.revision },
    });
    expect(retry.statusCode).toBe(202);
    await waitRefresh(app, retry.json().refresh.id, ["completed"]);
    expect(await storageRuntime().knowledge.getConnection(OWNER, folder.id)).toMatchObject({
      watch_enabled: true,
      status: "ready",
      status_code: null,
    });
    const callsBeforeResume = folderAdapter.inspectCount;
    await captured.pump!.reconcile();
    expect(folderAdapter.inspectCount).toBe(callsBeforeResume + 1);
  });

  it("persists watch on folder connections and lists them for the desktop pump", async () => {
    const app = await buildApp(true);
    const folder = await createFolderConnection(app, { watch: true });
    const watchRows = await storageRuntime().knowledge.listWatchEnabledConnections();
    expect(watchRows).toContainEqual({ accountId: OWNER, connectionId: folder.id });
    const toggled = await app.inject({
      method: "PATCH",
      url: `/api/knowledge-connections/${folder.id}`,
      headers: ownerAuth,
      body: { expected_revision: folder.revision, watch_enabled: false },
    });
    expect(toggled.statusCode).toBe(200);
    expect(await storageRuntime().knowledge.listWatchEnabledConnections()).toEqual([]);
  });

  it("status codes pass through unchanged, including restore-reconnect evidence", async () => {
    const app = await buildApp();
    const folder = await createFolderConnection(app);
    await storageRuntime().knowledge.recordConnectionStatus(
      OWNER,
      folder.id,
      "disconnected",
      "CONNECTION_RESTORE_RECONNECT_REQUIRED"
    );
    const list = await app.inject({ method: "GET", url: "/api/knowledge-connections", headers: ownerAuth });
    const row = (list.json().items as { id: string; status: string; status_code: string | null }[]).find(
      (item) => item.id === folder.id
    );
    expect(row?.status).toBe("disconnected");
    expect(row?.status_code).toBe("CONNECTION_RESTORE_RECONNECT_REQUIRED");
  });
});

describe("request boundary", () => {
  it("unauthenticated oversized bodies never reach the parser", async () => {
    const app = await buildApp();
    const huge = JSON.stringify({ name: "x".repeat(400_000), kind: "webdav", library_id: randomUUID() });
    const anon = await app.inject({
      method: "POST",
      url: "/api/knowledge-connections",
      headers: { "content-type": "application/json" },
      payload: huge,
    });
    expect(anon.statusCode).toBe(401);
    const authed = await app.inject({
      method: "POST",
      url: "/api/knowledge-connections",
      headers: { ...ownerAuth, "content-type": "application/json" },
      payload: huge,
    });
    expect(authed.statusCode).toBe(413);
  });
});

describe("knowledge route shutdown drains", () => {
  it.each(["preview", "refresh"] as const)("waits for an aborted %s and its durable finalizer", async (kind) => {
    const app = await buildApp();
    const connection = await createWebdavConnection(app);
    webdavAdapter.put("shutdown.md", "last successfully imported content");
    const imported = await importAll(app, connection.id);
    await waitRefresh(app, imported.refreshId, ["completed"]);
    const sourceId = imported.items[0]!.source_id;
    const priorSource = await storageRuntime().ledger.get("SELECT * FROM sources WHERE id=?", [sourceId]);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let aborted = false;
    const holdTransport = async (signal: AbortSignal): Promise<never> => {
      entered();
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          aborted = true;
          resolve();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      // Socket/file cleanup may finish asynchronously after abort is observed.
      await cleanupGate;
      throw new DOMException("transport stopped", "AbortError");
    };
    if (kind === "preview") webdavAdapter.scan = async (_context, _bounds, _managed, signal) => holdTransport(signal);
    else webdavAdapter.inspect = async (_context, _request, signal) => holdTransport(signal);
    const response = await app.inject({
      method: "POST",
      url: `/api/knowledge-connections/${connection.id}/${kind === "preview" ? "previews" : "refreshes"}`,
      headers: ownerAuth,
      ...(kind === "refresh" ? { body: {} } : {}),
    });
    expect(response.statusCode).toBe(202);
    await started;
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(aborted).toBe(true);
      expect(closed).toBe(false);
    } finally {
      release();
      await closing;
    }
    const store = storageRuntime().knowledge;
    if (kind === "preview") {
      const preview = await store.getPreview(OWNER, response.json().preview.id);
      expect(preview?.status).toBe("failed");
      expect(preview?.error_code).toBe("KNOWLEDGE_SCAN_CANCELLED");
    } else {
      const refreshId = response.json().refresh.id as string;
      expect((await store.requireRefresh(OWNER, refreshId)).status).toBe("cancelled");
      const items = await store.listRefreshItems(OWNER, refreshId);
      expect(items).toHaveLength(1);
      expect(items[0]?.status).toBe("cancelled");
      expect(items[0]?.error_code).toBe("KNOWLEDGE_REFRESH_CANCELLED");
      expect(await store.getActiveRefresh(OWNER, connection.id)).toBeUndefined();
    }
    expect(await storageRuntime().ledger.get("SELECT * FROM sources WHERE id=?", [sourceId])).toEqual(priorSource);
  });
});
