import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signToken } from "../auth.js";
import { embed } from "../llm.js";
import { installHttpBoundary } from "../httpErrors.js";
import { closeRuntimeSettings, initializeRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";
import { sourceRoutes } from "../routes/sources.js";
import { sourceSearchRoutes } from "../routes/sourceSearch.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { libraryRoutes } from "../routes/libraries.js";
import { encodeJson } from "../db/codecs.js";

vi.mock("../llm.js", () => ({
  embed: vi.fn(async (): Promise<number[][]> => [[1, 0, 0]]),
}));

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}` };
const foreignAuth = { authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}` };

const apps: FastifyInstance[] = [];
let runtimeDirectory = "";

beforeEach(async () => {
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-source-search-routes-"));
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
  await initializeRuntimeSettings({
    settingsFile: path.join(runtimeDirectory, "settings.json"),
    env: {},
  });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await closeStorageRuntime();
  await closeRuntimeSettings();
  vi.mocked(embed).mockClear();
  if (runtimeDirectory) await fs.rm(runtimeDirectory, { recursive: true, force: true });
  runtimeDirectory = "";
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(libraryRoutes);
  await app.register(sourceRoutes);
  await app.register(sourceSearchRoutes);
  await app.ready();
  return app;
}

async function createSource(
  accountId: string,
  displayName: string,
  chunks: readonly Readonly<{ content: string; meta?: Record<string, unknown> }>[],
  kind: "document" | "tabular" = "document"
): Promise<{ sourceId: string; generation: number; chunkIds: string[] }> {
  const runtime = storageRuntime();
  const sourceId = randomUUID();
  await runtime.ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,mime,size_bytes,status,meta)
     VALUES (?,?,?,?,?,'/uploads/x','text/markdown',10,'index',?)`,
    [sourceId, accountId, `source-${sourceId.slice(0, 8)}`, kind, displayName, encodeJson({})]
  );
  const generation = await runtime.ingestion.reserveJob(accountId, sourceId);
  const job = await runtime.ingestion.claimNext("pending");
  await runtime.ingestion.stageChunks({
    accountId,
    sourceId,
    generation,
    leaseToken: job!.leaseToken!,
    sourceName: displayName,
    chunks: chunks.map((chunk) => ({ content: chunk.content, meta: chunk.meta ?? {} })),
  });
  const chunkIds = (
    await runtime.ledger.all<{ chunk_id: string }>(
      "SELECT chunk_id FROM ingestion_chunk_staging WHERE source_id=? AND generation=? ORDER BY seq",
      [sourceId, generation]
    )
  ).map((row) => row.chunk_id);
  await runtime.ingestion.promoteGeneration({
    accountId,
    sourceId,
    generation,
    leaseToken: job!.leaseToken!,
    sizeBytes: 10,
    verifyVectors: async () => true,
  });
  return { sourceId, generation, chunkIds };
}

async function createLibraryWith(accountId: string, name: string, memberIds: readonly string[]): Promise<string> {
  const runtime = storageRuntime();
  const id = randomUUID();
  await runtime.ledger.run("INSERT INTO libraries (id,account_id,name) VALUES (?,?,?)", [id, accountId, name]);
  for (const sourceId of memberIds) {
    await runtime.ledger.run("INSERT INTO library_sources (library_id,source_id,account_id) VALUES (?,?,?)", [
      id,
      sourceId,
      accountId,
    ]);
  }
  return id;
}

describe("POST /api/libraries/:id/search", () => {
  it("requires authentication and an owned library", async () => {
    const app = await buildApp();
    const unauthed = await app.inject({ method: "POST", url: "/api/libraries/x/search", body: { query: "a" } });
    expect(unauthed.statusCode).toBe(401);
    const missing = await app.inject({
      method: "POST",
      url: `/api/libraries/${randomUUID()}/search`,
      headers: ownerAuth,
      body: { query: "a" },
    });
    expect(missing.statusCode).toBe(404);
    const libraryId = await createLibraryWith(OWNER, "Mine", []);
    const foreign = await app.inject({
      method: "POST",
      url: `/api/libraries/${libraryId}/search`,
      headers: foreignAuth,
      body: { query: "a" },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("validates the query, mode, and filter grammar", async () => {
    const app = await buildApp();
    const libraryId = await createLibraryWith(OWNER, "Grammar", []);
    const url = `/api/libraries/${libraryId}/search`;
    expect((await app.inject({ method: "POST", url, headers: ownerAuth, body: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: ownerAuth, body: { query: "   " } })).statusCode).toBe(
      400
    );
    expect(
      (await app.inject({ method: "POST", url, headers: ownerAuth, body: { query: "a".repeat(1_001) } })).statusCode
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url, headers: ownerAuth, body: { query: "a", mode: "vector" } })).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: ownerAuth,
          body: { query: "a", source_ids: ["not-a-uuid"] },
        })
      ).statusCode
    ).toBe(400);
    // Oversized bodies are refused at the parser boundary, after auth.
    const huge = await app.inject({
      method: "POST",
      url,
      headers: { ...ownerAuth, "content-type": "application/json" },
      payload: JSON.stringify({ query: "a", pad: "x".repeat(64 * 1024) }),
    });
    expect(huge.statusCode).toBe(413);
    const hugeUnauthed = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ query: "a", pad: "x".repeat(64 * 1024) }),
    });
    expect(hugeUnauthed.statusCode).toBe(401);
  });

  it("searches only library members and reports ignored foreign filters", async () => {
    const app = await buildApp();
    const inLibrary = await createSource(OWNER, "in-library.md", [
      { content: "library shared token text", meta: { loc: [{ kind: "text_span", char_start: 0, char_len: 10 }] } },
    ]);
    const outside = await createSource(OWNER, "outside.md", [{ content: "library shared token elsewhere" }]);
    const libraryId = await createLibraryWith(OWNER, "Search room", [inLibrary.sourceId]);

    const response = await app.inject({
      method: "POST",
      url: `/api/libraries/${libraryId}/search`,
      headers: ownerAuth,
      body: { query: "library shared token" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mode).toBe("keyword");
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]).toMatchObject({
      source_id: inLibrary.sourceId,
      generation: inLibrary.generation,
      label: "in-library.md",
      rank: 1,
      locators: [{ kind: "text_span", char_start: 0, char_len: 10 }],
    });
    expect(body.captured_scope).toEqual([
      { source_id: inLibrary.sourceId, generation: inLibrary.generation, status: "ready" },
    ]);

    const filtered = await app.inject({
      method: "POST",
      url: `/api/libraries/${libraryId}/search`,
      headers: ownerAuth,
      body: { query: "library shared token", source_ids: [outside.sourceId] },
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().hits).toEqual([]);
    expect(filtered.json().ignored_source_ids).toEqual([outside.sourceId]);
    // Selected-empty never widens to the whole library or account.
    expect(filtered.json().captured_scope).toEqual([]);
  });

  it("filters by source kind", async () => {
    const app = await buildApp();
    const doc = await createSource(OWNER, "doc.md", [{ content: "kind shared token document" }]);
    const sheet = await createSource(
      OWNER,
      "sheet.csv",
      [
        {
          content: "Columns: a Rows: 1 kind shared token tabular",
          meta: { loc: [{ kind: "tabular_rows", sheet: "sheet", row_start: 1, row_end: 1 }] },
        },
      ],
      "tabular"
    );
    const libraryId = await createLibraryWith(OWNER, "Kinds", [doc.sourceId, sheet.sourceId]);
    const tabularOnly = await app.inject({
      method: "POST",
      url: `/api/libraries/${libraryId}/search`,
      headers: ownerAuth,
      body: { query: "kind shared token", kind: "tabular" },
    });
    expect(tabularOnly.json().hits.map((hit: { source_id: string }) => hit.source_id)).toEqual([sheet.sourceId]);
    expect(tabularOnly.json().hits[0].locators[0]).toMatchObject({
      kind: "tabular_rows",
      sheet: "sheet",
      row_start: 1,
    });
    const docOnly = await app.inject({
      method: "POST",
      url: `/api/libraries/${libraryId}/search`,
      headers: ownerAuth,
      body: { query: "kind shared token", kind: "document" },
    });
    expect(docOnly.json().hits.map((hit: { source_id: string }) => hit.source_id)).toEqual([doc.sourceId]);
  });

  it("makes semantic mode consent-gated and embedding-backed", async () => {
    const app = await buildApp();
    const seeded = await createSource(OWNER, "vec.md", [{ content: "semantic route token" }]);
    const libraryId = await createLibraryWith(OWNER, "Vectors", [seeded.sourceId]);
    await storageRuntime().vectors.upsert([
      {
        chunkId: seeded.chunkIds[0]!,
        accountId: OWNER,
        sourceId: seeded.sourceId,
        generation: seeded.generation,
        vector: [1, 0, 0],
      },
    ]);
    const url = `/api/libraries/${libraryId}/search`;

    // Loopback default provider: no consent gate, one embed through the
    // authorized boundary.
    const ok = await app.inject({
      method: "POST",
      url,
      headers: ownerAuth,
      body: { query: "semantic route question", mode: "semantic" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().mode).toBe("semantic");
    expect(ok.json().hits[0]).toMatchObject({ excerpt: "semantic route token", rank: 1 });
    expect(vi.mocked(embed)).toHaveBeenCalledTimes(1);

    // A remote provider without acknowledgment gates BEFORE any embed call.
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider.example" });
    vi.mocked(embed).mockClear();
    const gated = await app.inject({
      method: "POST",
      url,
      headers: ownerAuth,
      body: { query: "semantic route question", mode: "semantic" },
    });
    expect(gated.statusCode).toBe(403);
    expect(gated.json().code).toBe("REMOTE_EGRESS_CONSENT_REQUIRED");
    expect(vi.mocked(embed)).not.toHaveBeenCalled();

    // Keyword mode is never gated: it makes no model request at all.
    const keyword = await app.inject({
      method: "POST",
      url,
      headers: ownerAuth,
      body: { query: "semantic route token" },
    });
    expect(keyword.statusCode).toBe(200);
    expect(keyword.json().hits).toHaveLength(1);

    // Acknowledging the exact origin unblocks semantic mode.
    await storageRuntime().ledger.run(
      "UPDATE users SET remote_egress_ack_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),remote_egress_ack_origin=? WHERE id=?",
      ["https://api.provider.example", OWNER]
    );
    const unblocked = await app.inject({
      method: "POST",
      url,
      headers: ownerAuth,
      body: { query: "semantic route question", mode: "semantic" },
    });
    expect(unblocked.statusCode).toBe(200);
    expect(unblocked.json().hits[0].excerpt).toBe("semantic route token");
  });
});

describe("passage routes", () => {
  it("returns the owned current chunk with locators and bounded neighbors", async () => {
    const app = await buildApp();
    const locator = { kind: "pdf_page", page: 2, ocr: false, char_start: 4, char_len: 8 };
    const seeded = await createSource(OWNER, "pages.pdf", [
      { content: "page one neighbor text", meta: {} },
      { content: "page two middle marker", meta: { loc: [locator] } },
      { content: "page three trailing neighbor", meta: {} },
    ]);
    const middleChunkId = seeded.chunkIds[1]!;
    const response = await app.inject({
      method: "GET",
      url: `/api/sources/${seeded.sourceId}/passages/${middleChunkId}`,
      headers: ownerAuth,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.source).toMatchObject({ id: seeded.sourceId, label: "pages.pdf", ready_generation: seeded.generation });
    expect(body.chunk).toMatchObject({
      chunk_id: middleChunkId,
      generation: seeded.generation,
      seq: 1,
      content: "page two middle marker",
      locators: [locator],
    });
    expect(body.neighbors.before.content).toBe("page one neighbor text");
    expect(body.neighbors.after.content).toBe("page three trailing neighbor");

    const context = await app.inject({
      method: "GET",
      url: `/api/sources/${seeded.sourceId}/passages/${middleChunkId}/neighboring-context?context_chars=6`,
      headers: ownerAuth,
    });
    expect(context.statusCode).toBe(200);
    expect(context.json().neighbors.before.content).toBe("page o");
    expect(context.json().neighbors.after.content).toBe("page t");
    expect(context.json().context_chars).toBe(6);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/sources/${seeded.sourceId}/passages/${middleChunkId}/neighboring-context?context_chars=99999`,
          headers: ownerAuth,
        })
      ).statusCode
    ).toBe(400);
  });

  it("answers 410 for pruned or superseded chunks and 404 outside ownership", async () => {
    const app = await buildApp();
    const seeded = await createSource(OWNER, "refresh.md", [{ content: "generation one passage" }]);
    const staleChunkId = seeded.chunkIds[0]!;

    // Unknown chunk under an owned source: honest unavailable passage.
    const unknownChunk = await app.inject({
      method: "GET",
      url: `/api/sources/${seeded.sourceId}/passages/${randomUUID()}`,
      headers: ownerAuth,
    });
    expect(unknownChunk.statusCode).toBe(410);
    expect(unknownChunk.json().code).toBe("PASSAGE_UNAVAILABLE");

    // Refresh: the chunk id disappears with the promoted generation two.
    const runtime = storageRuntime();
    const generation = await runtime.ingestion.reserveJob(OWNER, seeded.sourceId);
    const job = await runtime.ingestion.claimNext("pending");
    await runtime.ingestion.stageChunks({
      accountId: OWNER,
      sourceId: seeded.sourceId,
      generation,
      leaseToken: job!.leaseToken!,
      sourceName: "refresh.md",
      chunks: [{ content: "generation two passage", meta: {} }],
    });
    await runtime.ingestion.promoteGeneration({
      accountId: OWNER,
      sourceId: seeded.sourceId,
      generation,
      leaseToken: job!.leaseToken!,
      sizeBytes: 10,
      verifyVectors: async () => true,
    });
    const stale = await app.inject({
      method: "GET",
      url: `/api/sources/${seeded.sourceId}/passages/${staleChunkId}`,
      headers: ownerAuth,
    });
    expect(stale.statusCode).toBe(410);
    expect(stale.json().code).toBe("PASSAGE_UNAVAILABLE");

    const foreignSource = await createSource(FOREIGN, "theirs.md", [{ content: "foreign passage" }]);
    const foreign = await app.inject({
      method: "GET",
      url: `/api/sources/${foreignSource.sourceId}/passages/${foreignSource.chunkIds[0]}`,
      headers: ownerAuth,
    });
    expect(foreign.statusCode).toBe(404);
    const unauthed = await app.inject({
      method: "GET",
      url: `/api/sources/${seeded.sourceId}/passages/${staleChunkId}`,
    });
    expect(unauthed.statusCode).toBe(401);
  });
});
