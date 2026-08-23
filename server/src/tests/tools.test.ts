import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ q: vi.fn() }));
vi.mock("../retrieve.js", () => ({ retrieve: vi.fn() }));
vi.mock("../pythonClient.js", () => ({
  py: {
    listDatasets: vi.fn(),
    query: vi.fn(),
    describe: vi.fn(),
    chart: vi.fn(),
    buildReport: vi.fn(),
    pdf: vi.fn(),
  },
}));

import { q } from "../db.js";
import { py } from "../pythonClient.js";
import { retrieve } from "../retrieve.js";
import {
  captureQueryResult,
  executeTool,
  makeReportPayload,
  sanitizeRetrievedEvidence,
  type ToolRunContext,
} from "../tools.js";
import type { ResolvedSourceScope } from "../sourceScope.js";

const qMock = vi.mocked(q);
const retrieveMock = vi.mocked(retrieve);
const listDatasetsMock = vi.mocked(py.listDatasets);
const queryMock = vi.mocked(py.query);
const describeMock = vi.mocked(py.describe);
const SOURCE_A = "11111111-1111-4111-8111-111111111111";
const SOURCE_B = "22222222-2222-4222-8222-222222222222";
const CHART_A = "aaaaaaaa-1111-4111-8111-111111111111";

function scope(): ResolvedSourceScope {
  return Object.freeze({
    mode: "selected" as const,
    attached: Object.freeze([
      Object.freeze({ id: SOURCE_A, name: "allowed_table", display_name: "Allowed.csv", kind: "tabular", status: "ready" }),
      Object.freeze({ id: SOURCE_B, name: "pending_table", display_name: "Pending.csv", kind: "tabular", status: "index" }),
    ]),
    readySourceIds: Object.freeze([SOURCE_A]),
    readyTableNames: Object.freeze(["allowed_table"]),
  });
}

function context(chartIds: string[] = []): ToolRunContext {
  const sourceScope = scope();
  return {
    chartIds,
    evidence: [],
    queryResults: [],
    chatId: "chat-1",
    model: "chat-model",
    sourceScope,
    readySourceIds: sourceScope.readySourceIds,
    readyTableNames: sourceScope.readyTableNames,
  };
}

describe("source-scoped tools", () => {
  beforeEach(() => {
    qMock.mockReset();
    retrieveMock.mockReset();
    listDatasetsMock.mockReset();
    queryMock.mockReset();
    describeMock.mockReset();
  });

  it("passes the snapshotted ready source ids to retrieval", async () => {
    const runContext = context();
    retrieveMock.mockResolvedValueOnce([{
      chunk_id: "42",
      source_id: SOURCE_A,
      source: "Allowed.csv",
      content: "A grounded passage",
      score: 0.875,
    }]);
    const result = await executeTool("account", "retrieve", { query: "canary", top_k: 3 }, runContext);
    expect(retrieveMock).toHaveBeenCalledWith("account", "canary", [SOURCE_A], 3);
    expect(result.passages).toEqual([{ source: "Allowed.csv", score: 0.875, content: "A grounded passage" }]);
    expect(runContext.evidence).toEqual([{
      source_id: SOURCE_A,
      chunk_id: "42",
      source: "Allowed.csv",
      excerpt: "A grounded passage",
      score: 0.875,
    }]);
  });

  it("lists attached status and only sanitized metadata for allowed ready tables", async () => {
    listDatasetsMock.mockResolvedValueOnce([
      {
        table: "allowed_table",
        original_name: "Allowed.csv",
        rows: 2,
        columns: [{ name: "amount", type: "DOUBLE" }],
        exists: true,
        location: "/private/canary.csv",
        safe_location: "/private/canary.csv",
        url: "https://secret.invalid",
        preview: [["secret"]],
      },
      { table: "unselected_canary", original_name: "Canary.csv", rows: 1 },
    ]);

    const result = await executeTool("account", "list_sources", {}, context());

    expect(result.source_mode).toBe("selected");
    expect(result.sources).toHaveLength(2);
    expect(result.datasets).toEqual([
      {
        table: "allowed_table",
        original_name: "Allowed.csv",
        rows: 2,
        columns: [{ name: "amount", type: "DOUBLE" }],
        exists: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("unselected_canary");
    expect(JSON.stringify(result)).not.toContain("/private/");
    expect(JSON.stringify(result)).not.toContain("secret.invalid");
  });

  it("forwards the exact immutable table allowlist to query", async () => {
    const runContext = context();
    const queryResult = { columns: ["answer"], rows: [[1]], row_count: 1 };
    queryMock.mockResolvedValueOnce(queryResult);
    const result = await executeTool("account", "query_data", { sql: "SELECT 1 AS answer" }, runContext);
    expect(result).toBe(queryResult);
    expect(queryMock).toHaveBeenCalledWith("account", "SELECT 1 AS answer", ["allowed_table"]);
    expect(runContext.queryResults).toEqual([{
      id: "query-1",
      sql: "SELECT 1 AS answer",
      columns: ["answer"],
      rows: [[1]],
      row_count: 1,
      truncated: false,
    }]);
  });

  it("short-circuits describe for an unselected table", async () => {
    const result = await executeTool("account", "describe_data", { table: "unselected_canary" }, context());
    expect(result).toEqual({ error: "that table is not selected and ready for this chat" });
    expect(describeMock).not.toHaveBeenCalled();
  });

  it("passes the same allowlist to describe for an allowed table", async () => {
    describeMock.mockResolvedValueOnce({ table: "allowed_table" });
    await executeTool("account", "describe_data", { table: "allowed_table" }, context());
    expect(describeMock).toHaveBeenCalledWith("account", "allowed_table", ["allowed_table"]);
  });
});

describe("query result artifact capture", () => {
  it("keeps at most three successful artifacts with deterministic ids", () => {
    let artifacts: ReturnType<typeof captureQueryResult> = [];
    for (let index = 0; index < 4; index += 1) {
      artifacts = captureQueryResult(artifacts, `SELECT ${index}`, {
        columns: ["value"],
        rows: [[index]],
        row_count: 1,
      });
    }

    expect(artifacts).toHaveLength(3);
    expect(artifacts.map((artifact) => artifact.id)).toEqual(["query-1", "query-2", "query-3"]);
    expect(artifacts.map((artifact) => artifact.rows[0][0])).toEqual([0, 1, 2]);
  });

  it("bounds SQL, columns, rows, labels, and cells", () => {
    const columns = Array.from({ length: 51 }, (_, index) => index === 0 ? "c".repeat(220) : `column_${index}`);
    const rows = Array.from({ length: 101 }, (_, rowIndex) => (
      Array.from({ length: 51 }, (_, columnIndex) => columnIndex === 0 ? "x".repeat(550) : rowIndex + columnIndex)
    ));

    const [artifact] = captureQueryResult([], "S".repeat(2_100), { columns, rows, row_count: 101 });

    expect(artifact.sql).toHaveLength(2_000);
    expect(artifact.columns).toHaveLength(50);
    expect(artifact.columns[0]).toHaveLength(200);
    expect(artifact.rows).toHaveLength(100);
    expect(artifact.rows.every((row) => row.length === 50)).toBe(true);
    expect(String(artifact.rows[0][0])).toHaveLength(500);
    expect(artifact.row_count).toBe(101);
    expect(artifact.truncated).toBe(true);
  });

  it("rectangularizes rows and safely converts supported and complex cells", () => {
    const [artifact] = captureQueryResult([], "SELECT values", {
      columns: ["nullish", "number", "boolean", "text", "object", "array", "date"],
      rows: [
        [Number.NaN, -42, true, "hello", { nested: 1 }, ["a", "b"], new Date("2026-08-23T00:00:00Z")],
        [null, 2],
        "malformed",
      ],
      row_count: 3,
    });

    expect(artifact.rows).toEqual([
      [null, -42, true, "hello", '{"nested":1}', '["a","b"]', "2026-08-23T00:00:00.000Z"],
      [null, 2, null, null, null, null, null],
    ]);
    expect(artifact.truncated).toBe(true);
  });

  it("records nothing for returned or thrown query errors", async () => {
    const prior = captureQueryResult([], "SELECT 1", { columns: ["n"], rows: [[1]], row_count: 1 });
    expect(captureQueryResult(prior, "SELECT broken", { error: "query failed" })).toEqual(prior);

    const runContext = context();
    queryMock.mockRejectedValueOnce(new Error("query failed"));
    await expect(executeTool("account", "query_data", { sql: "SELECT broken" }, runContext)).rejects.toThrow("query failed");
    expect(runContext.queryResults).toEqual([]);
  });
});

describe("retrieved evidence sanitizer", () => {
  it("deduplicates by source and chunk while preserving first-seen order", () => {
    const evidence = sanitizeRetrievedEvidence([
      { source_id: SOURCE_A, chunk_id: "1", source: "First", content: "first passage", score: 0.9 },
      { source_id: SOURCE_A, chunk_id: "1", source: "Duplicate", content: "duplicate passage", score: 0.8 },
      { source_id: SOURCE_B, chunk_id: "1", source: "Second", content: "second passage", score: 0.7 },
    ]);

    expect(evidence).toEqual([
      { source_id: SOURCE_A, chunk_id: "1", source: "First", excerpt: "first passage", score: 0.9 },
      { source_id: SOURCE_B, chunk_id: "1", source: "Second", excerpt: "second passage", score: 0.7 },
    ]);
  });

  it("omits malformed values and non-finite scores", () => {
    const valid = { source_id: SOURCE_A, chunk_id: "1", source: "Allowed", content: "passage", score: 0.9 };
    expect(sanitizeRetrievedEvidence([
      null,
      {},
      { ...valid, source_id: "" },
      { ...valid, chunk_id: " " },
      { ...valid, content: "" },
      { ...valid, score: Number.POSITIVE_INFINITY },
      { ...valid, score: "0.9" },
      valid,
    ])).toEqual([{
      source_id: SOURCE_A,
      chunk_id: "1",
      source: "Allowed",
      excerpt: "passage",
      score: 0.9,
    }]);
  });

  it("bounds labels, excerpts, and total passages", () => {
    const evidence = sanitizeRetrievedEvidence(Array.from({ length: 12 }, (_, index) => ({
      source_id: SOURCE_A,
      chunk_id: String(index),
      source: `  ${"s".repeat(220)}  `,
      content: `  ${"x".repeat(900)}  `,
      score: 1 - index / 100,
    })));

    expect(evidence).toHaveLength(8);
    expect(evidence[0].source).toHaveLength(200);
    expect(evidence[0].excerpt).toHaveLength(800);
    expect(evidence.map((entry) => entry.chunk_id)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  });

  it("keeps the first eight unique passages across repeated retrievals", async () => {
    const runContext = context();
    retrieveMock.mockResolvedValueOnce(Array.from({ length: 6 }, (_, index) => ({
      chunk_id: String(index),
      source_id: SOURCE_A,
      source: "Allowed",
      content: `passage ${index}`,
      score: 0.9,
    })));
    retrieveMock.mockResolvedValueOnce(Array.from({ length: 6 }, (_, index) => ({
      chunk_id: String(index + 4),
      source_id: SOURCE_A,
      source: "Allowed",
      content: `passage ${index + 4}`,
      score: 0.8,
    })));

    await executeTool("account", "retrieve", { query: "first" }, runContext);
    expect(runContext.evidence.map((entry) => entry.chunk_id)).toEqual(["0", "1", "2", "3", "4", "5"]);
    await executeTool("account", "retrieve", { query: "second" }, runContext);

    expect(runContext.evidence.map((entry) => entry.chunk_id)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  });
});

describe("makeReportPayload current-run chart resolution", () => {
  beforeEach(() => qMock.mockReset());

  it("resolves a well-formed chart id created in this run", async () => {
    qMock.mockResolvedValueOnce([{ spec: { type: "bar" } }]);
    const payload = await makeReportPayload("account-1", { charts: [CHART_A] }, context([CHART_A]));
    expect(payload.charts).toEqual([{ id: CHART_A, spec: { type: "bar" } }]);
    expect(payload).not.toHaveProperty("unresolved_chart_ids");
    expect(qMock).toHaveBeenCalledWith(expect.stringContaining("id::text=$1"), [CHART_A, "account-1"]);
  });

  it("resolves a dash-less prefix only inside the current run", async () => {
    const chartId = "abcdef01-2345-6789-abcd-ef0123456789";
    const raw = "abcdef012345";
    qMock.mockResolvedValueOnce([{ spec: { type: "line" } }]);
    const payload = await makeReportPayload("account-1", { charts: [raw] }, context([chartId]));
    expect(payload.charts).toEqual([{ id: chartId, spec: { type: "line" } }]);
    expect(qMock).toHaveBeenCalledOnce();
    expect(qMock.mock.calls[0][1]).toEqual([chartId, "account-1"]);
  });

  it("does not query an account chart that was not created in this run", async () => {
    const payload = await makeReportPayload("account-1", { charts: [CHART_A] }, context([]));
    expect(payload.charts).toEqual([]);
    expect(payload.unresolved_chart_ids).toEqual([CHART_A]);
    expect(qMock).not.toHaveBeenCalled();
  });

  it("reports short garbage and ambiguous run prefixes as unresolved", async () => {
    const one = "abcdef01-2345-4111-8111-111111111111";
    const two = "abcdef01-2345-4222-8222-222222222222";
    const payload = await makeReportPayload(
      "account-1",
      { charts: ["not-a-chart", "abcdef012345"] },
      context([one, two])
    );
    expect(payload.unresolved_chart_ids).toEqual(["not-a-chart", "abcdef012345"]);
    expect(qMock).not.toHaveBeenCalled();
  });

  it("reports database failures as unresolved without throwing", async () => {
    qMock.mockRejectedValueOnce(new Error("database unavailable"));
    const payload = await makeReportPayload("account-1", { charts: [CHART_A] }, context([CHART_A]));
    expect(payload.charts).toEqual([]);
    expect(payload.unresolved_chart_ids).toEqual([CHART_A]);
  });
});
