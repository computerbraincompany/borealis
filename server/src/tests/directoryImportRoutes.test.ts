import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signToken } from "../auth.js";
import { encodeJson } from "../db/codecs.js";
import { installHttpBoundary } from "../httpErrors.js";
import { libraryRoutes } from "../routes/libraries.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { DIRECTORY_IMPORT_META_KEY, libraryMembershipRevision } from "../db/stores/directoryImportStore.js";

/**
 * `POST /api/libraries/:id/directory-imports` (browser copied-directory
 * import): operation-UUID idempotence, exact-library-revision CAS, owned/ready
 * source validation, connector/traversal/over-limit refusal, and proof that it
 * creates no refreshable folder connection.
 */

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}` };
const foreignAuth = { authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}` };

const apps: FastifyInstance[] = [];
let runtimeDirectory = "";

beforeEach(async () => {
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-dir-import-"));
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
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await closeStorageRuntime();
  if (runtimeDirectory) await fs.rm(runtimeDirectory, { recursive: true, force: true });
  runtimeDirectory = "";
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(libraryRoutes);
  await app.ready();
  return app;
}

async function createLibrary(name: string): Promise<{ id: string; revision: number }> {
  const app = await buildApp();
  const created = await app.inject({ method: "POST", url: "/api/libraries", headers: ownerAuth, body: { name } });
  const id = created.json().id as string;
  const detail = await app.inject({ method: "GET", url: `/api/libraries/${id}`, headers: ownerAuth });
  return { id, revision: detail.json().revision as number };
}

async function insertSource(
  accountId: string,
  options: { status?: string; connector?: string | null; sizeBytes?: number; id?: string } = {}
): Promise<string> {
  const id = options.id ?? randomUUID();
  await storageRuntime().ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,mime,size_bytes,status,connector,meta)
     VALUES (?,?,?,'document',?,?,?,?,?,?,?)`,
    [
      id,
      accountId,
      `src-${id.slice(0, 6)}.md`,
      `src-${id.slice(0, 6)}.md`,
      `/uploads/${accountId}/${id}/file.md`,
      "text/markdown",
      options.sizeBytes ?? 12,
      options.status ?? "ready",
      options.connector ?? null,
      encodeJson({}),
    ]
  );
  return id;
}

function manifest(
  items: Array<{ source_id: string; relative_path: string }>,
  operationId = randomUUID(),
  revision = 0
) {
  return { operation_id: operationId, expected_revision: revision, items };
}

describe("directory-imports route", () => {
  it("commits an owned ready manifest, becoming members with a provenance stamp", async () => {
    const app = await buildApp();
    const library = await createLibrary("Import room");
    const a = await insertSource(OWNER);
    const b = await insertSource(OWNER);
    const operationId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/directory-imports`,
      headers: ownerAuth,
      body: {
        operation_id: operationId,
        expected_revision: library.revision,
        items: [
          { source_id: a, relative_path: "a.md" },
          { source_id: b, relative_path: "notes/b.md" },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ added: 2, idempotent: false, library_id: library.id });

    const detail = await app.inject({ method: "GET", url: `/api/libraries/${library.id}`, headers: ownerAuth });
    const members = detail.json().members as Array<{ id: string; meta: Record<string, unknown> }>;
    expect(members.map((m) => m.id).sort()).toEqual([a, b].sort());
    const stamped = members.find((m) => m.id === a)!;
    expect(stamped.meta[DIRECTORY_IMPORT_META_KEY]).toMatchObject({ operation_id: operationId, relative_path: "a.md" });
    // No refreshable folder connection is created by an import.
    const connections = await storageRuntime().ledger.get<{ n: bigint }>(
      "SELECT COUNT(*) AS n FROM knowledge_connections"
    );
    expect(connections?.n).toBe(0n);
  });

  it("retries idempotently under the same operation UUID", async () => {
    const app = await buildApp();
    const library = await createLibrary("Retry room");
    const a = await insertSource(OWNER);
    const operationId = randomUUID();
    const body = {
      operation_id: operationId,
      expected_revision: library.revision,
      items: [{ source_id: a, relative_path: "a.md" }],
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/directory-imports`,
      headers: ownerAuth,
      body,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ added: 1 });
    const retry = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/directory-imports`,
      headers: ownerAuth,
      body,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ added: 0, idempotent: true });
    const memberCount = await storageRuntime().ledger.get<{ n: bigint }>(
      "SELECT COUNT(*) AS n FROM library_sources WHERE library_id=?",
      [library.id]
    );
    expect(memberCount?.n).toBe(1n);
  });

  it("rejects a stale library revision with 409", async () => {
    const app = await buildApp();
    const library = await createLibrary("CAS room");
    const a = await insertSource(OWNER);
    const b = await insertSource(OWNER);
    const firstCommit = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/directory-imports`,
      headers: ownerAuth,
      body: manifest([{ source_id: a, relative_path: "a.md" }], randomUUID(), library.revision),
    });
    expect(firstCommit.statusCode).toBe(200);
    // A second, different operation using the now-stale original revision fails.
    const stale = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/directory-imports`,
      headers: ownerAuth,
      body: manifest([{ source_id: b, relative_path: "b.md" }], randomUUID(), library.revision),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "LIBRARY_REVISION_CONFLICT" });
  });

  it("rejects foreign, unready, and connector sources; and traversal/over-limit manifests", async () => {
    const app = await buildApp();
    const library = await createLibrary("Reject room");
    const foreign = await insertSource(FOREIGN);
    const notReady = await insertSource(OWNER, { status: "index" });
    const connectorId = randomUUID();
    await storageRuntime().ledger.run(
      "INSERT INTO connectors (id,account_id,name,type,target_table) VALUES (?,?,?,'url_csv',?)",
      [connectorId, OWNER, `conn-${connectorId.slice(0, 6)}`, `tbl_${connectorId.slice(0, 6).replace(/-/g, "_")}`]
    );
    const connector = await insertSource(OWNER, { connector: connectorId });
    const libraryRevision = library.revision;

    const foreignRes = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/directory-imports`,
      headers: ownerAuth,
      body: manifest([{ source_id: foreign, relative_path: "x.md" }], randomUUID(), libraryRevision),
    });
    expect(foreignRes.statusCode).toBe(404);
    expect(foreignRes.json()).toMatchObject({ code: "SOURCE_NOT_FOUND" });

    const notReadyRes = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/directory-imports`,
      headers: ownerAuth,
      body: manifest([{ source_id: notReady, relative_path: "x.md" }], randomUUID(), libraryRevision),
    });
    expect(notReadyRes.statusCode).toBe(409);
    expect(notReadyRes.json()).toMatchObject({ code: "DIRECTORY_IMPORT_SOURCE_NOT_READY" });

    const connectorRes = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/directory-imports`,
      headers: ownerAuth,
      body: manifest([{ source_id: connector, relative_path: "x.md" }], randomUUID(), libraryRevision),
    });
    expect(connectorRes.statusCode).toBe(400);
    expect(connectorRes.json()).toMatchObject({ code: "DIRECTORY_IMPORT_SOURCE_CONNECTOR" });

    const traversal = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/directory-imports`,
      headers: ownerAuth,
      body: manifest(
        [{ source_id: await insertSource(OWNER), relative_path: "../escape.md" }],
        randomUUID(),
        libraryRevision
      ),
    });
    expect(traversal.statusCode).toBe(400);

    const oversized = await insertSource(OWNER, { sizeBytes: 60 * 1024 * 1024 });
    const oversized2 = await insertSource(OWNER, { sizeBytes: 60 * 1024 * 1024 });
    const tooBig = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/directory-imports`,
      headers: ownerAuth,
      body: manifest(
        [
          { source_id: oversized, relative_path: "one.md" },
          { source_id: oversized2, relative_path: "two.md" },
        ],
        randomUUID(),
        libraryRevision
      ),
    });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json()).toMatchObject({ code: "DIRECTORY_IMPORT_SIZE_EXCEEDED" });
  });

  it("rejects a manifest of more than 100 items and a foreign library", async () => {
    const app = await buildApp();
    const library = await createLibrary("Capacity room");
    const items = Array.from({ length: 101 }, () => ({
      source_id: randomUUID(),
      relative_path: `f-${randomUUID().slice(0, 6)}.md`,
    }));
    const tooMany = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/directory-imports`,
      headers: ownerAuth,
      body: manifest(items, randomUUID(), library.revision),
    });
    expect(tooMany.statusCode).toBe(400);

    const foreignLibrary = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/directory-imports`,
      headers: foreignAuth,
      body: manifest([{ source_id: await insertSource(OWNER), relative_path: "a.md" }], randomUUID(), library.revision),
    });
    expect(foreignLibrary.statusCode).toBe(404);
  });

  it("the detail revision reflects membership and drives a valid second commit", async () => {
    const app = await buildApp();
    const library = await createLibrary("Revision room");
    expect(library.revision).toBe(libraryMembershipRevision(library.id, []));
    const a = await insertSource(OWNER);
    const committed = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/directory-imports`,
      headers: ownerAuth,
      body: manifest([{ source_id: a, relative_path: "a.md" }], randomUUID(), library.revision),
    });
    const nextRevision = committed.json().revision as number;
    expect(nextRevision).toBe(libraryMembershipRevision(library.id, [a]));
    const b = await insertSource(OWNER);
    const second = await app.inject({
      method: "POST",
      url: `/api/libraries/${library.id}/directory-imports`,
      headers: ownerAuth,
      body: manifest([{ source_id: b, relative_path: "b.md" }], randomUUID(), nextRevision),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ added: 1 });
  });
});
