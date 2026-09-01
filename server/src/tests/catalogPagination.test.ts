import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { signToken } from "../auth.js";
import {
  CatalogCursorError,
  DEFAULT_CATALOG_PAGE_LIMIT,
  decodeCatalogCursor,
  encodeCatalogCursor,
  MAX_CATALOG_CURSOR_CHARS,
  MAX_CATALOG_PAGE_LIMIT,
  parseCatalogPageQuery,
  type CatalogEndpoint,
} from "../catalogPagination.js";
import { createSourceStore } from "../db/stores/sourceStore.js";
import { installHttpBoundary } from "../httpErrors.js";
import { sourceRoutes } from "../routes/sources.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SAME_TIME = "2026-08-30T12:00:00.000Z";
const POSITION = { timestamp: SAME_TIME, id: "00000000-0000-4000-8000-000000000004" } as const;
const ENDPOINTS: CatalogEndpoint[] = [
  "sources",
  "connectors",
  "chats",
  "reports",
  "shared_reports",
  "agents",
  "libraries",
  "automations",
];

const resources: TempSqliteLedger[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
});

function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("catalog cursor codec", () => {
  it("defaults to 50, accepts at most 100, and rejects invalid limits", () => {
    expect(parseCatalogPageQuery("sources", {})).toEqual({ limit: DEFAULT_CATALOG_PAGE_LIMIT, after: null });
    expect(parseCatalogPageQuery("sources", { limit: MAX_CATALOG_PAGE_LIMIT })).toEqual({
      limit: MAX_CATALOG_PAGE_LIMIT,
      after: null,
    });
    for (const limit of [0, 101, 1.5, "50"]) {
      expect(() => parseCatalogPageQuery("sources", { limit })).toThrow(CatalogCursorError);
    }
  });

  it("round-trips only the requested endpoint and deterministic tuple", () => {
    for (const endpoint of ENDPOINTS) {
      const cursor = encodeCatalogCursor(endpoint, POSITION);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(cursor.length).toBeLessThanOrEqual(MAX_CATALOG_CURSOR_CHARS);
      expect(decodeCatalogCursor(endpoint, cursor)).toEqual(POSITION);
    }

    const sourceCursor = encodeCatalogCursor("sources", POSITION);
    expect(() => decodeCatalogCursor("connectors", sourceCursor)).toThrow(CatalogCursorError);
  });

  it.each([
    ["empty", ""],
    ["non-base64url", "not+a+cursor"],
    ["oversized", "a".repeat(MAX_CATALOG_CURSOR_CHARS + 1)],
    ["invalid JSON", Buffer.from("not json", "utf8").toString("base64url")],
    ["wrong version", rawCursor({ v: 2, e: "sources", t: POSITION.timestamp, i: POSITION.id })],
    ["extra field", rawCursor({ v: 1, e: "sources", t: POSITION.timestamp, i: POSITION.id, account: OWNER })],
    ["invalid timestamp", rawCursor({ v: 1, e: "sources", t: "yesterday", i: POSITION.id })],
    ["invalid id", rawCursor({ v: 1, e: "sources", t: POSITION.timestamp, i: "source-4" })],
    [
      "noncanonical id",
      rawCursor({ v: 1, e: "sources", t: POSITION.timestamp, i: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }),
    ],
  ])("rejects %s cursors", (_label, cursor) => {
    expect(() => decodeCatalogCursor("sources", cursor)).toThrow(CatalogCursorError);
  });
});

describe("catalog keyset traversal", () => {
  it("survives equal timestamps, cursor-row deletion, newer inserts, and foreign rows", async () => {
    const resource = await createTempSqliteLedger();
    resources.push(resource);
    await resource.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
      OWNER,
      "owner@example.test",
      "hash",
    ]);
    await resource.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
      FOREIGN,
      "foreign@example.test",
      "hash",
    ]);
    const ids = [1, 2, 3, 4, 5].map((suffix) => `00000000-0000-4000-8000-00000000000${suffix}`);
    for (const id of ids) {
      await insertSource(resource, OWNER, id, SAME_TIME);
    }
    await insertSource(resource, FOREIGN, "ffffffff-ffff-4fff-8fff-ffffffffffff", SAME_TIME);
    const store = createSourceStore(resource.ledger);

    const first = await store.listSources(OWNER, { limit: 2, after: null });
    expect(first.items.map((source) => source.id)).toEqual([ids[4], ids[3]]);
    expect(first.next).toEqual({ timestamp: SAME_TIME, id: ids[3] });

    await resource.ledger.run("DELETE FROM sources WHERE account_id=? AND id=?", [OWNER, ids[3]]);
    await insertSource(resource, OWNER, "99999999-9999-4999-8999-999999999999", "2026-08-31T12:00:00.000Z");

    const second = await store.listSources(OWNER, { limit: 2, after: first.next! });
    expect(second.items.map((source) => source.id)).toEqual([ids[2], ids[1]]);
    const third = await store.listSources(OWNER, { limit: 2, after: second.next! });
    expect(third.items.map((source) => source.id)).toEqual([ids[0]]);
    expect(third.next).toBeNull();
    expect([...first.items, ...second.items, ...third.items].map((source) => source.accountId)).toEqual([
      OWNER,
      OWNER,
      OWNER,
      OWNER,
      OWNER,
    ]);
  });
});

describe("catalog cursor HTTP boundary", () => {
  it("returns 400 for malformed and cross-endpoint cursors before storage entry", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    installHttpBoundary(app);
    await app.register(sourceRoutes);
    await app.ready();
    const authorization = `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}`;
    const crossEndpoint = encodeCatalogCursor("connectors", POSITION);

    for (const cursor of ["abc", crossEndpoint, "a".repeat(MAX_CATALOG_CURSOR_CHARS + 1)]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/sources?cursor=${encodeURIComponent(cursor)}`,
        headers: { authorization, "x-request-id": "catalog.invalid" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid request", request_id: "catalog.invalid" });
    }

    const unauthenticated = await app.inject({
      method: "GET",
      url: `/api/sources?cursor=${crossEndpoint}`,
      headers: { "x-request-id": "catalog.unauthorized" },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toEqual({ error: "unauthorized", request_id: "catalog.unauthorized" });
  });
});

async function insertSource(
  resource: TempSqliteLedger,
  accountId: string,
  id: string,
  createdAt: string
): Promise<void> {
  await resource.ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,status,meta,created_at)
     VALUES (?,?,?,'tabular',?,'ready','{}',?)`,
    [id, accountId, `source_${id}`, `Source ${id}`, createdAt]
  );
}
