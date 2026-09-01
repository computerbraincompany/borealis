import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signToken } from "../auth.js";
import { LATEST_SQLITE_SCHEMA_VERSION } from "../db/migrations.js";
import { installHttpBoundary } from "../httpErrors.js";
import { libraryRoutes } from "../routes/libraries.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ownerAuth = {
  authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}`,
};
const foreignAuth = {
  authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}`,
};

const apps: FastifyInstance[] = [];
let runtimeDirectory = "";

beforeEach(async () => {
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-libraries-"));
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

async function insertSource(id: string, accountId: string, name: string): Promise<void> {
  await storageRuntime().ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,status) VALUES (?,?,?,?,?,'ready')`,
    [id, accountId, name, "tabular", name]
  );
}

describe("library schema", () => {
  it("ships schema v5 with library tables", async () => {
    const version = await storageRuntime().ledger.get<{ user_version: unknown }>("PRAGMA user_version");
    expect(Number(version?.user_version)).toBe(LATEST_SQLITE_SCHEMA_VERSION);
    const tables = await storageRuntime().ledger.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('libraries','library_sources')"
    );
    expect(tables.map((table) => table.name).sort()).toEqual(["libraries", "library_sources"]);
  });
});

describe("library routes", () => {
  it("creates, renames, lists, and deletes libraries without touching sources", async () => {
    const app = await buildApp();
    const sourceId = randomUUID();
    await insertSource(sourceId, OWNER, "ledger.csv");

    const created = await app.inject({
      method: "POST",
      url: "/api/libraries",
      headers: ownerAuth,
      body: { name: "Finance data room" },
    });
    expect(created.statusCode).toBe(201);
    const library = created.json();
    expect(library).toMatchObject({ name: "Finance data room", id: expect.any(String) });

    const members = await app.inject({
      method: "PUT",
      url: `/api/libraries/${library.id}/sources`,
      headers: ownerAuth,
      body: { source_ids: [sourceId] },
    });
    expect(members.statusCode).toBe(200);

    const duplicateIds = await app.inject({
      method: "PUT",
      url: `/api/libraries/${library.id}/sources`,
      headers: ownerAuth,
      body: { source_ids: [sourceId, sourceId] },
    });
    expect(duplicateIds.statusCode).toBe(400);

    const detail = await app.inject({ method: "GET", url: `/api/libraries/${library.id}`, headers: ownerAuth });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      name: "Finance data room",
      members: [expect.objectContaining({ id: sourceId, name: "ledger.csv" })],
    });

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/libraries/${library.id}`,
      headers: ownerAuth,
      body: { name: "Diligence room" },
    });
    expect(renamed.json()).toMatchObject({ name: "Diligence room" });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/libraries",
      headers: ownerAuth,
      body: { name: "Diligence room" },
    });
    expect(duplicate.statusCode).toBe(409);

    const deleted = await app.inject({ method: "DELETE", url: `/api/libraries/${library.id}`, headers: ownerAuth });
    expect(deleted.statusCode).toBe(200);
    await expect(storageRuntime().sources.getSource(OWNER, sourceId)).resolves.toMatchObject({
      id: sourceId,
      status: "ready",
    });

    const list = await app.inject({ method: "GET", url: "/api/libraries", headers: ownerAuth });
    expect(list.json()).toEqual({ items: [], next_cursor: null });
  });

  it("replaces membership exactly and rejects foreign sources and libraries", async () => {
    const app = await buildApp();
    const first = randomUUID();
    const second = randomUUID();
    const foreignSource = randomUUID();
    await insertSource(first, OWNER, "a.csv");
    await insertSource(second, OWNER, "b.csv");
    await insertSource(foreignSource, FOREIGN, "foreign.csv");

    const created = await app.inject({
      method: "POST",
      url: "/api/libraries",
      headers: ownerAuth,
      body: { name: "Members" },
    });
    const libraryId = created.json().id as string;

    await app.inject({
      method: "PUT",
      url: `/api/libraries/${libraryId}/sources`,
      headers: ownerAuth,
      body: { source_ids: [first] },
    });
    const replaced = await app.inject({
      method: "PUT",
      url: `/api/libraries/${libraryId}/sources`,
      headers: ownerAuth,
      body: { source_ids: [second] },
    });
    expect(replaced.statusCode).toBe(200);

    const detail = await app.inject({ method: "GET", url: `/api/libraries/${libraryId}`, headers: ownerAuth });
    expect(detail.json().members.map((member: { id: string }) => member.id)).toEqual([second]);

    const foreignMember = await app.inject({
      method: "PUT",
      url: `/api/libraries/${libraryId}/sources`,
      headers: ownerAuth,
      body: { source_ids: [foreignSource] },
    });
    expect(foreignMember.statusCode).toBe(404);

    const foreignLibrary = await app.inject({
      method: "GET",
      url: `/api/libraries/${libraryId}`,
      headers: foreignAuth,
    });
    expect(foreignLibrary.statusCode).toBe(404);

    const foreignDelete = await app.inject({
      method: "DELETE",
      url: `/api/libraries/${libraryId}`,
      headers: foreignAuth,
    });
    expect(foreignDelete.statusCode).toBe(404);

    const oversize = await app.inject({
      method: "PUT",
      url: `/api/libraries/${libraryId}/sources`,
      headers: ownerAuth,
      body: { source_ids: Array.from({ length: 101 }, () => randomUUID()) },
    });
    expect(oversize.statusCode).toBe(400);
  });

  it("requires authentication and validates bodies", async () => {
    const app = await buildApp();

    const unauthenticated = await app.inject({ method: "GET", url: "/api/libraries" });
    expect(unauthenticated.statusCode).toBe(401);

    const blankName = await app.inject({
      method: "POST",
      url: "/api/libraries",
      headers: ownerAuth,
      body: { name: "  " },
    });
    expect(blankName.statusCode).toBe(400);

    // Fastify's shared AJV default strips unknown properties instead of rejecting them.
    const extraProperty = await app.inject({
      method: "POST",
      url: "/api/libraries",
      headers: ownerAuth,
      body: { name: "Valid", member_count: 5 },
    });
    expect(extraProperty.statusCode).toBe(201);
    expect(extraProperty.body).not.toContain("member_count");
  });
});
