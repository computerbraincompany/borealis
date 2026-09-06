import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteIngestionStore } from "../db/stores/ingestionStore.js";
import { openSqliteLedger } from "../db/sqlite.js";
import type { SqliteLedger } from "../db/types.js";
import { encodeJson } from "../db/codecs.js";
import { buildFtsLiteralQuery, searchCapturedScope, searchLibraryScope } from "../sourceSearch.js";
import type { LanceVectorIndex, LanceVectorSearchHit, LanceVectorSearchInput } from "../vector/lance.js";

/**
 * Search-core tests run against the real SQLite ledger (and therefore the
 * real schema v24 FTS triggers and promotion/cleanup transactions). The
 * vector side is a deterministic cosine fake honoring the same scoped
 * prefilter contract as LanceDB: account + explicit source allowlist +
 * exact captured generations.
 */

interface Resource {
  directory: string;
  ledger: SqliteLedger;
  store: SqliteIngestionStore;
}

const resources: Resource[] = [];

async function newResource(): Promise<Resource> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-source-search-"));
  const ledger = await openSqliteLedger({ path: path.join(directory, "ledger.sqlite") });
  const store = new SqliteIngestionStore(ledger);
  const entry: Resource = { directory, ledger, store };
  resources.push(entry);
  return entry;
}

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ directory, ledger }) => {
      await ledger.close();
      await fs.rm(directory, { recursive: true, force: true });
    })
  );
});

async function insertUser(ledger: SqliteLedger): Promise<string> {
  const id = randomUUID();
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, `${id}@example.test`, "hash"]);
  return id;
}

async function insertSource(ledger: SqliteLedger, accountId: string, displayName: string, kind = "document") {
  const id = randomUUID();
  await ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,mime,size_bytes,status,meta)
     VALUES (?,?,?,?,?,'/uploads/x','text/markdown',10,'index',?)`,
    [id, accountId, `source-${id.slice(0, 8)}`, kind, displayName, encodeJson({})]
  );
  return id;
}

/** Reserve, lease, stage, and promote one generation of chunks. */
async function ingest(
  resource: Resource,
  accountId: string,
  sourceId: string,
  chunks: readonly Readonly<{ content: string; meta?: Record<string, unknown> }>[]
): Promise<number> {
  const generation = await resource.store.reserveJob(accountId, sourceId);
  const job = await resource.store.claimNext("pending");
  if (!job?.leaseToken) throw new Error("lease unavailable");
  await resource.store.stageChunks({
    accountId,
    sourceId,
    generation,
    leaseToken: job.leaseToken,
    sourceName: "doc",
    chunks: chunks.map((chunk) => ({ content: chunk.content, meta: chunk.meta ?? {} })),
  });
  await resource.store.promoteGeneration({
    accountId,
    sourceId,
    generation,
    leaseToken: job.leaseToken,
    sizeBytes: 10,
    verifyVectors: async () => true,
  });
  return generation;
}

interface FakeVectorRow {
  chunkId: string;
  accountId: string;
  sourceId: string;
  generation: number;
  vector: number[];
}

function fakeVectors(rows: FakeVectorRow[], searchLog: LanceVectorSearchInput[]) {
  const vectors = {
    async search(input: LanceVectorSearchInput): Promise<LanceVectorSearchHit[]> {
      searchLog.push(input);
      const allowGenerations = new Map(
        (input.sourceGenerations ?? input.sourceIds.map((sourceId) => ({ sourceId, generation: -1 }))).map((scope) => [
          scope.sourceId,
          scope.generation,
        ])
      );
      return rows
        .filter((row) => row.accountId === input.accountId && allowGenerations.has(row.sourceId))
        .filter(
          (row) => (input.sourceGenerations?.length ?? 0) === 0 || allowGenerations.get(row.sourceId) === row.generation
        )
        .map((row) => {
          const dot = row.vector.reduce((sum, value, index) => sum + value * (input.vector[index] ?? 0), 0);
          const norm = Math.sqrt(row.vector.reduce((sum, value) => sum + value * value, 0)) || 1;
          return { hit: { chunkId: row.chunkId, distance: 1 - dot / norm } as LanceVectorSearchHit, score: dot / norm };
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, input.limit)
        .map((entry) => entry.hit);
    },
  };
  return vectors as unknown as LanceVectorIndex;
}

describe("literal FTS5 query grammar", () => {
  it("compiles user text into quoted phrases with doubled quotes", () => {
    expect(buildFtsLiteralQuery('alpha  beta "gamma')).toEqual({
      ftsQuery: '"alpha" "beta" """gamma"',
      truncated: false,
    });
    expect(buildFtsLiteralQuery("   ")).toEqual({ ftsQuery: null, truncated: false });
    // A trailing `*` is stripped: FTS5 would apply prefix semantics even
    // inside a quoted phrase, so it must never reach the engine.
    expect(buildFtsLiteralQuery("**lead trail** x**y")).toEqual({
      ftsQuery: '"lead" "trail" "x**y"',
      truncated: false,
    });
    expect(buildFtsLiteralQuery("*** ****")).toEqual({ ftsQuery: null, truncated: false });
    const many = Array.from({ length: 70 }, (_, index) => `t${index}`).join(" ");
    const compiled = buildFtsLiteralQuery(many);
    expect(compiled.truncated).toBe(true);
    expect(compiled.ftsQuery!.split(" ")).toHaveLength(64);
  });
});

describe("keyword search", () => {
  it("returns ranked hits with locators for the account's captured scope only", async () => {
    const resource = await newResource();
    const mine = await insertUser(resource.ledger);
    const theirs = await insertUser(resource.ledger);
    const source = await insertSource(resource.ledger, mine, "Supplier terms.pdf");
    const foreignSource = await insertSource(resource.ledger, theirs, "Foreign.pdf");
    const locator = { kind: "pdf_page", page: 3, ocr: false, char_start: 12, char_len: 40 };
    await ingest(resource, mine, source, [
      { content: "the quarterly renewal escalates pricing", meta: { loc: [locator] } },
      { content: "the annual termination window closes quietly", meta: {} },
    ]);
    await ingest(resource, theirs, foreignSource, [{ content: "the quarterly renewal is a foreign secret" }]);

    const result = await searchCapturedScope(
      {
        accountId: mine,
        scopes: [{ sourceId: source, generation: 1 }],
        query: "quarterly renewal",
        mode: "keyword",
      },
      { store: () => resource.store }
    );
    expect(result.mode).toBe("keyword");
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    expect(hit).toMatchObject({
      source_id: source,
      generation: 1,
      label: "Supplier terms.pdf",
      excerpt: "the quarterly renewal escalates pricing",
      rank: 1,
    });
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.locators).toEqual([locator]);
    expect(result.scope).toEqual([{ source_id: source, generation: 1, status: "ready" }]);
    expect(result.returned_char_count).toBe(hit.excerpt.length);
  });

  it("treats FTS operators as literal tokens", async () => {
    const resource = await newResource();
    const account = await insertUser(resource.ledger);
    const source = await insertSource(resource.ledger, account, "grammar.md");
    await ingest(resource, account, source, [
      { content: "alpha AND delta", meta: {} },
      { content: "alpha delta plain", meta: {} },
    ]);
    const scopes = [{ sourceId: source, generation: 1 }];
    const ports = { store: () => resource.store };

    const literalAnd = await searchCapturedScope(
      { accountId: account, scopes, query: "alpha AND delta", mode: "keyword" },
      ports
    );
    // The user's `AND` must match the literal token, not the operator:
    // only the chunk that literally contains "and" qualifies.
    expect(literalAnd.hits.map((hit) => hit.excerpt)).toEqual(["alpha AND delta"]);

    const quotedAnd = await searchCapturedScope(
      { accountId: account, scopes, query: '"AND" alpha delta', mode: "keyword" },
      ports
    );
    expect(quotedAnd.hits.map((hit) => hit.excerpt)).toEqual(["alpha AND delta"]);

    const orLiteral = await searchCapturedScope(
      { accountId: account, scopes, query: "alpha OR delta", mode: "keyword" },
      ports
    );
    // `OR` is required as a literal token; no chunk holds the token `or`,
    // so the page is empty instead of a boolean union.
    expect(orLiteral.hits).toEqual([]);

    // The stripped star must not gain prefix power: `alpha*` matches only the
    // exact token `alpha`, never the `alphabet` token by prefix expansion.
    await ingest(resource, account, source, [
      { content: "alpha AND delta", meta: {} },
      { content: "alpha delta plain", meta: {} },
      { content: "alphabet soup recipe", meta: {} },
    ]);
    const star = await searchCapturedScope(
      { accountId: account, scopes: [{ sourceId: source, generation: 2 }], query: "alpha*", mode: "keyword" },
      ports
    );
    expect(star.hits.map((hit) => hit.excerpt).sort()).toEqual(["alpha AND delta", "alpha delta plain"]);

    const parens = await searchCapturedScope(
      { accountId: account, scopes, query: "NEAR(alpha delta)", mode: "keyword" },
      ports
    );
    expect(parens.hits).toEqual([]);
  });

  it("honors hit, excerpt, and total-character budgets", async () => {
    const resource = await newResource();
    const account = await insertUser(resource.ledger);
    const source = await insertSource(resource.ledger, account, "many.md");
    const big = "sharedtoken ".padEnd(2_100, "x");
    const chunks = Array.from({ length: 51 }, () => ({ content: big, meta: {} }));
    await ingest(resource, account, source, chunks);
    const result = await searchCapturedScope(
      { accountId: account, scopes: [{ sourceId: source, generation: 1 }], query: "sharedtoken", mode: "keyword" },
      { store: () => resource.store }
    );
    expect(result.hits.length).toBeLessThanOrEqual(50);
    for (const hit of result.hits) expect(hit.excerpt.length).toBeLessThanOrEqual(2_000);
    expect(result.returned_char_count).toBeLessThanOrEqual(100_000);
  });

  it("reports honest truncation for over-budget token counts", async () => {
    const resource = await newResource();
    const account = await insertUser(resource.ledger);
    const source = await insertSource(resource.ledger, account, "long.md");
    await ingest(resource, account, source, [{ content: "needle token here", meta: {} }]);
    const query = `${Array.from({ length: 64 }, (_, index) => `junk${index}`).join(" ")} needle`;
    const result = await searchCapturedScope(
      { accountId: account, scopes: [{ sourceId: source, generation: 1 }], query, mode: "keyword" },
      { store: () => resource.store }
    );
    expect(result.query_truncated).toBe(true);
    // The truncated question dropped `needle`, so nothing matches honestly.
    expect(result.hits).toEqual([]);
  });
});

describe("scope honesty", () => {
  it("keeps staged generations invisible until promotion", async () => {
    const resource = await newResource();
    const account = await insertUser(resource.ledger);
    const source = await insertSource(resource.ledger, account, "flip.md");
    await ingest(resource, account, source, [{ content: "promoted alpha text", meta: {} }]);
    const generation = await resource.store.reserveJob(account, source);
    const job = await resource.store.claimNext("pending");
    await resource.store.stageChunks({
      accountId: account,
      sourceId: source,
      generation,
      leaseToken: job!.leaseToken!,
      sourceName: "doc",
      chunks: [{ content: "staged beta text never visible", meta: {} }],
    });
    const result = await searchCapturedScope(
      { accountId: account, scopes: [{ sourceId: source, generation: 1 }], query: "beta", mode: "keyword" },
      { store: () => resource.store }
    );
    expect(result.hits).toEqual([]);
    const alpha = await searchCapturedScope(
      { accountId: account, scopes: [{ sourceId: source, generation: 1 }], query: "alpha", mode: "keyword" },
      { store: () => resource.store }
    );
    expect(alpha.hits).toHaveLength(1);
  });

  it("returns source_changed for superseded pairs and never newer-generation text", async () => {
    const resource = await newResource();
    const account = await insertUser(resource.ledger);
    const source = await insertSource(resource.ledger, account, "refresh.md");
    await ingest(resource, account, source, [{ content: "alpha generation one", meta: {} }]);
    const captured = {
      accountId: account,
      scopes: [{ sourceId: source, generation: 1 }],
      query: "alpha",
      mode: "keyword" as const,
    };
    const ports = { store: () => resource.store };
    expect((await searchCapturedScope(captured, ports)).hits).toHaveLength(1);

    // A refresh promotes generation two mid-flight.
    await ingest(resource, account, source, [{ content: "alpha generation two", meta: {} }]);

    const stale = await searchCapturedScope(captured, ports);
    expect(stale.scope).toEqual([{ source_id: source, generation: 1, status: "source_changed" }]);
    expect(stale.hits).toEqual([]);

    const fresh = await searchCapturedScope(
      { accountId: account, scopes: [{ sourceId: source, generation: 2 }], query: "alpha", mode: "keyword" },
      ports
    );
    expect(fresh.hits.map((hit) => hit.excerpt)).toEqual(["alpha generation two"]);

    // Library-style acceptance captures the CURRENT ready set, so it lands
    // on generation two and never leaks generation one.
    const library = await searchLibraryScope(
      { accountId: account, sourceIds: [source], query: "alpha", mode: "keyword" },
      ports
    );
    expect(library.scope).toEqual([{ source_id: source, generation: 2, status: "ready" }]);
    expect(library.hits.map((hit) => hit.excerpt)).toEqual(["alpha generation two"]);
  });

  it("reports unavailable for not-ready sources and never embeds for an empty scope", async () => {
    const resource = await newResource();
    const account = await insertUser(resource.ledger);
    const pending = await insertSource(resource.ledger, account, "pending.md");
    const embed = vi.fn(async () => [[1, 0, 0]]);
    const searchLog: LanceVectorSearchInput[] = [];
    const result = await searchLibraryScope(
      { accountId: account, sourceIds: [pending], query: "anything", mode: "semantic" },
      { store: () => resource.store, vectors: () => fakeVectors([], searchLog), embedQuery: embed }
    );
    expect(result.scope).toEqual([{ source_id: pending, generation: null, status: "unavailable" }]);
    expect(result.hits).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(searchLog).toEqual([]);
  });

  it("cannot search another account's captured pairs", async () => {
    const resource = await newResource();
    const owner = await insertUser(resource.ledger);
    const intruder = await insertUser(resource.ledger);
    const source = await insertSource(resource.ledger, owner, "private.md");
    await ingest(resource, owner, source, [{ content: "private alpha material", meta: {} }]);
    const result = await searchCapturedScope(
      { accountId: intruder, scopes: [{ sourceId: source, generation: 1 }], query: "alpha", mode: "keyword" },
      { store: () => resource.store }
    );
    expect(result.scope).toEqual([{ source_id: source, generation: 1, status: "source_changed" }]);
    expect(result.hits).toEqual([]);
  });

  it("rejects invalid queries and oversized scopes before any search work", async () => {
    const resource = await newResource();
    const account = await insertUser(resource.ledger);
    await expect(
      searchCapturedScope(
        { accountId: account, scopes: [], query: "  ", mode: "keyword" },
        { store: () => resource.store }
      )
    ).rejects.toMatchObject({ code: "SEARCH_QUERY_INVALID" });
    await expect(
      searchCapturedScope(
        { accountId: account, scopes: [], query: "a".repeat(1_001), mode: "keyword" },
        { store: () => resource.store }
      )
    ).rejects.toMatchObject({ code: "SEARCH_QUERY_TOO_LONG" });
    const scopes = Array.from({ length: 101 }, () => ({ sourceId: randomUUID(), generation: 1 }));
    await expect(
      searchCapturedScope(
        { accountId: account, scopes, query: "token", mode: "keyword" },
        { store: () => resource.store }
      )
    ).rejects.toMatchObject({ code: "SEARCH_SCOPE_TOO_BROAD" });
  });
});

describe("semantic search", () => {
  it("embeds once through the authorized boundary and keeps captured generations", async () => {
    const resource = await newResource();
    const account = await insertUser(resource.ledger);
    const source = await insertSource(resource.ledger, account, "semantics.pdf");
    const locator = { kind: "text_span", char_start: 0, char_len: 10 };
    await ingest(resource, account, source, [
      { content: "semantic chunk alpha", meta: { loc: [locator] } },
      { content: "semantic chunk beta", meta: {} },
    ]);
    const searchLog: LanceVectorSearchInput[] = [];
    const embed = vi.fn(async (texts: string[]) => {
      expect(texts).toEqual(["alpha question"]);
      return [[1, 0, 0]];
    });
    const vectors = fakeVectors(
      [{ chunkId: "missing-chunk", accountId: account, sourceId: source, generation: 1, vector: [1, 0, 0] }],
      searchLog
    );
    // The vector fake returns a chunk id that does not join SQLite text
    // (e.g. a pruned chunk): the fail-closed join must drop it.
    const noJoin = await searchCapturedScope(
      { accountId: account, scopes: [{ sourceId: source, generation: 1 }], query: "alpha question", mode: "semantic" },
      { store: () => resource.store, vectors: () => vectors, embedQuery: embed }
    );
    expect(noJoin.hits).toEqual([]);

    const chunks = await resource.store.loadSearchChunks({
      accountId: account,
      scopes: [{ sourceId: source, generation: 1 }],
      chunkIds: [],
    });
    expect(chunks.size).toBe(0);

    const realChunks = await resource.ledger.all<{ id: string }>(
      "SELECT id FROM chunks WHERE source_id=? ORDER BY seq",
      [source]
    );
    const rows: FakeVectorRow[] = realChunks.map((row, index) => ({
      chunkId: row.id,
      accountId: account,
      sourceId: source,
      generation: 1,
      vector: index === 0 ? [1, 0, 0] : [0, 1, 0],
    }));
    const result = await searchCapturedScope(
      { accountId: account, scopes: [{ sourceId: source, generation: 1 }], query: "alpha question", mode: "semantic" },
      { store: () => resource.store, vectors: () => fakeVectors(rows, searchLog), embedQuery: embed }
    );
    expect(embed).toHaveBeenCalledTimes(2);
    expect(searchLog).toHaveLength(2);
    // KNN returns both stored vectors; cosine similarity ranks alpha first
    // and the beta chunk honestly at zero similarity.
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]).toMatchObject({
      excerpt: "semantic chunk alpha",
      label: "semantics.pdf",
      rank: 1,
      locators: [locator],
    });
    expect(result.hits[0]!.score).toBeCloseTo(1, 5);
    expect(result.hits[1]!.excerpt).toBe("semantic chunk beta");
    expect(result.hits[1]!.score).toBeCloseTo(0, 5);
    // The vector search itself received the exact captured pairs, never a
    // bare account-wide scan.
    const last = searchLog[searchLog.length - 1]!;
    expect(last.sourceGenerations).toEqual([{ sourceId: source, generation: 1 }]);
  });

  it("keyword mode makes no model request at all", async () => {
    const resource = await newResource();
    const account = await insertUser(resource.ledger);
    const source = await insertSource(resource.ledger, account, "local.md");
    await ingest(resource, account, source, [{ content: "purely local token", meta: {} }]);
    const embed = vi.fn(async () => [[1, 0, 0]]);
    const searchLog: LanceVectorSearchInput[] = [];
    const result = await searchCapturedScope(
      { accountId: account, scopes: [{ sourceId: source, generation: 1 }], query: "local", mode: "keyword" },
      { store: () => resource.store, vectors: () => fakeVectors([], searchLog), embedQuery: embed }
    );
    expect(result.hits).toHaveLength(1);
    expect(embed).not.toHaveBeenCalled();
    expect(searchLog).toEqual([]);
  });
});

describe("FTS follows the two-store transactions", () => {
  it("keeps FTS rows in lockstep with promotion, cleanup, and rollback", async () => {
    const resource = await newResource();
    const account = await insertUser(resource.ledger);
    const source = await insertSource(resource.ledger, account, "tx.md");
    await ingest(resource, account, source, [{ content: "transaction marker one", meta: {} }]);
    const countFts = async () =>
      (await resource.ledger.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM chunks_fts"))?.n ?? 0n;
    expect(await countFts()).toBe(1n);

    // Generation two replaces generation one inside one transaction.
    await ingest(resource, account, source, [{ content: "transaction marker two", meta: {} }]);
    expect(await countFts()).toBe(1n);
    const stale = await resource.store.keywordSearchChunks({
      accountId: account,
      scopes: [{ sourceId: source, generation: 1 }],
      ftsQuery: '"transaction"',
      limit: 50,
    });
    expect(stale).toEqual([]);

    // A failed generation deletes only staging; ready chunks and FTS survive.
    const failedGeneration = await resource.store.reserveJob(account, source);
    const failedJob = await resource.store.claimNext("pending");
    await resource.store.stageChunks({
      accountId: account,
      sourceId: source,
      generation: failedGeneration,
      leaseToken: failedJob!.leaseToken!,
      sourceName: "doc",
      chunks: [{ content: "never promoted text", meta: {} }],
    });
    await resource.store.failGeneration({
      accountId: account,
      sourceId: source,
      generation: failedGeneration,
      leaseToken: failedJob!.leaseToken ?? undefined,
      errorCode: "INGEST_FAILED",
    });
    expect(await countFts()).toBe(1n);

    // A rolled-back transaction rolls back its FTS mirror too.
    await expect(
      resource.ledger.withImmediateTransaction((tx) => {
        tx.run(
          `INSERT INTO chunks (id,account_id,source_id,generation,seq,source_name,content,meta)
           VALUES ('rollback-chunk',?,?,3,99,'tx','rolled back marker','{}')`,
          [account, source]
        );
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    expect(await countFts()).toBe(1n);

    // Source deletion cascades chunks and the FTS shadow together.
    await resource.ledger.run("DELETE FROM sources WHERE id=? AND account_id=?", [source, account]);
    expect(await countFts()).toBe(0n);
  });
});
