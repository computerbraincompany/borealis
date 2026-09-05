import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runStoreMock = vi.hoisted(() => ({
  insertPendingChart: vi.fn(),
  insertPendingReport: vi.fn(),
  getPendingChart: vi.fn(),
}));

vi.mock("../storageRuntime.js", () => ({ storageRuntime: () => ({ runs: runStoreMock }) }));
vi.mock("../retrieve.js", () => ({ retrieve: vi.fn() }));
vi.mock("../dataService.js", () => ({
  dataService: {
    listDatasetCatalog: vi.fn(),
    query: vi.fn(),
    describe: vi.fn(),
    chart: vi.fn(),
    buildReport: vi.fn(),
    pdf: vi.fn(),
  },
}));

import { config } from "../config.js";
import { dataService } from "../dataService.js";
import { retrieve } from "../retrieve.js";
import {
  TOOL_DEFS,
  captureQueryResult,
  executeTool,
  makeReportPayload,
  numberRetrievedPassages,
  sanitizeRetrievedEvidence,
  type ToolRunContext,
} from "../tools.js";
import type { ResolvedSourceScope } from "../sourceScope.js";

const retrieveMock = vi.mocked(retrieve);
const listDatasetCatalogMock = vi.mocked(dataService.listDatasetCatalog);
const queryMock = vi.mocked(dataService.query);
const describeMock = vi.mocked(dataService.describe);
const chartMock = vi.mocked(dataService.chart);
const buildReportMock = vi.mocked(dataService.buildReport);
const pdfMock = vi.mocked(dataService.pdf);
const SOURCE_A = "11111111-1111-4111-8111-111111111111";
const SOURCE_B = "22222222-2222-4222-8222-222222222222";
const CHART_A = "aaaaaaaa-1111-4111-8111-111111111111";

function scope(): ResolvedSourceScope {
  return Object.freeze({
    mode: "selected" as const,
    attached: Object.freeze([
      Object.freeze({
        id: SOURCE_A,
        name: "allowed_table",
        display_name: "Allowed.csv",
        kind: "tabular",
        status: "ready",
      }),
      Object.freeze({
        id: SOURCE_B,
        name: "pending_table",
        display_name: "Pending.csv",
        kind: "tabular",
        status: "index",
      }),
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
    runId: "33333333-3333-4333-8333-333333333333",
    model: "chat-model",
    sourceScope,
    readySourceIds: sourceScope.readySourceIds,
    readyTableNames: sourceScope.readyTableNames,
  };
}

beforeEach(() => {
  runStoreMock.insertPendingChart.mockReset();
  runStoreMock.insertPendingChart.mockResolvedValue({ id: "chart" });
  runStoreMock.insertPendingReport.mockReset();
  runStoreMock.insertPendingReport.mockResolvedValue({ id: "report" });
  runStoreMock.getPendingChart.mockReset();
  runStoreMock.getPendingChart.mockResolvedValue(undefined);
  retrieveMock.mockReset();
  listDatasetCatalogMock.mockReset();
  queryMock.mockReset();
  describeMock.mockReset();
  chartMock.mockReset();
  buildReportMock.mockReset();
  pdfMock.mockReset();
});

describe("source-scoped tools", () => {
  it("mirrors the canonical finite chart magnitude boundary in the model tool schema", () => {
    const definition = TOOL_DEFS.find((candidate) => candidate.function.name === "render_chart") as any;
    const seriesValue = definition.function.parameters.properties.spec.properties.series.items.properties.data.items;
    const itemValue = definition.function.parameters.properties.spec.properties.items.items.properties.value;
    expect(seriesValue).toMatchObject({ minimum: -1_000_000_000_000_000, maximum: 1_000_000_000_000_000 });
    expect(itemValue).toMatchObject({ minimum: 0, maximum: 1_000_000_000_000_000 });
  });

  it("directs the model to cite retrieved passages by bracketed number", () => {
    const definition = TOOL_DEFS.find((candidate) => candidate.function.name === "retrieve") as any;
    expect(definition.function.description).toContain("bracketed citation numbers, like [1]");
  });

  it("passes the snapshotted ready source ids to retrieval", async () => {
    const runContext = context();
    retrieveMock.mockResolvedValueOnce([
      {
        chunk_id: "42",
        source_id: SOURCE_A,
        source: "Allowed.csv",
        content: "A grounded passage",
        score: 0.875,
      },
    ]);
    const result = await executeTool("account", "retrieve", { query: "canary", top_k: 3 }, runContext);
    expect(retrieveMock).toHaveBeenCalledWith("account", "canary", [SOURCE_A], 3, undefined);
    expect(result.passages).toEqual([{ n: 1, source: "Allowed.csv", score: 0.875, content: "A grounded passage" }]);
    expect(result.trust).toBe("untrusted_source_content");
    expect(result.instruction).toContain("citation number in brackets, like [2]");
    expect(runContext.evidence).toEqual([
      {
        source_id: SOURCE_A,
        chunk_id: "42",
        source: "Allowed.csv",
        excerpt: "A grounded passage",
        score: 0.875,
      },
    ]);
  });

  it("lists attached status and only sanitized metadata for allowed ready tables", async () => {
    listDatasetCatalogMock.mockResolvedValueOnce({
      datasets: [
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
      ] as any,
      total: 1,
      returned: 1,
      omitted: 0,
      truncated: false,
    });

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
        columns_truncated: false,
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
    expect(queryMock).toHaveBeenCalledWith("account", "SELECT 1 AS answer", ["allowed_table"], undefined);
    expect(runContext.queryResults).toEqual([
      {
        id: "query-1",
        sql: "SELECT 1 AS answer",
        columns: ["answer"],
        rows: [[1]],
        row_count: 1,
        truncated: false,
      },
    ]);
  });

  it("short-circuits describe for an unselected table", async () => {
    const result = await executeTool("account", "describe_data", { table: "unselected_canary" }, context());
    expect(result).toEqual({ error: "that table is not selected and ready for this chat" });
    expect(describeMock).not.toHaveBeenCalled();
  });

  it("passes the same allowlist to describe for an allowed table", async () => {
    describeMock.mockResolvedValueOnce({ table: "allowed_table" });
    await executeTool("account", "describe_data", { table: "allowed_table" }, context());
    expect(describeMock).toHaveBeenCalledWith("account", "allowed_table", ["allowed_table"], undefined);
  });
});

describe("persisted render artifacts", () => {
  it("persists the canonical PNG returned by the initial chart render", async () => {
    chartMock.mockResolvedValueOnce({
      spec: { type: "bar", title: "A" },
      echarts: { series: [] },
      png_base64: "png-canary",
    });
    await executeTool("account", "render_chart", { spec: { type: "bar", title: "A" } }, context());

    expect(runStoreMock.insertPendingChart).toHaveBeenCalledWith({
      id: expect.any(String),
      accountId: "account",
      runId: "33333333-3333-4333-8333-333333333333",
      spec: { type: "bar", title: "A" },
      echarts: { series: [] },
      pngBase64: "png-canary",
    });
  });

  it("does not publish a late chart result after its run signal is cancelled", async () => {
    let release!: (value: any) => void;
    chartMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const controller = new AbortController();
    const runContext = context();
    runContext.abortSignal = controller.signal;
    const pending = executeTool("account", "render_chart", { spec: { type: "bar", title: "Late" } }, runContext);
    await vi.waitFor(() => expect(chartMock).toHaveBeenCalledOnce());

    controller.abort();
    release({ spec: { type: "bar", title: "Late" }, echarts: { series: [] }, png_base64: "late" });

    await expect(pending).rejects.toThrow("run cancelled");
    expect(runStoreMock.insertPendingChart).not.toHaveBeenCalled();
    expect(runContext.chartIds).toEqual([]);
  });

  it("locks and verifies the run is active immediately before inserting a chart", async () => {
    chartMock.mockResolvedValueOnce({
      spec: { type: "bar", title: "Too late" },
      echarts: { series: [] },
      png_base64: "late",
    });
    runStoreMock.insertPendingChart.mockRejectedValueOnce(new Error("run is no longer active"));

    await expect(
      executeTool("account", "render_chart", { spec: { type: "bar", title: "Too late" } }, context())
    ).rejects.toThrow("run is no longer active");

    expect(runStoreMock.insertPendingChart).toHaveBeenCalledOnce();
  });

  it("stores reports under exclusive account/report UUID directories", async () => {
    const originalReportDir = config.reportDir;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-report-test-"));
    const canonicalDirectory = await fs.realpath(directory);
    (config as { reportDir: string }).reportDir = directory;
    buildReportMock.mockResolvedValue({ title: "Same title", html: "<html>ok</html>" });
    pdfMock.mockResolvedValue(Buffer.from("pdf"));
    try {
      const first = await executeTool(
        SOURCE_A,
        "create_report",
        { title: "Same title", sections: [{ markdown: "body" }] },
        context()
      );
      const second = await executeTool(
        SOURCE_A,
        "create_report",
        { title: "Same title", sections: [{ markdown: "body" }] },
        context()
      );
      expect(first.report_id).not.toBe(second.report_id);
      const inserts = runStoreMock.insertPendingReport.mock.calls;
      expect(inserts).toHaveLength(2);
      for (const [input] of inserts) {
        expect(input.htmlPath).toBe(path.join(canonicalDirectory, SOURCE_A, String(input.id), "report.html"));
        expect(input.pdfPath).toBe(path.join(canonicalDirectory, SOURCE_A, String(input.id), "report.pdf"));
      }
    } finally {
      (config as { reportDir: string }).reportDir = originalReportDir;
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps unresolved chart ids out of the strict render payload", async () => {
    const originalReportDir = config.reportDir;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-report-unresolved-test-"));
    (config as { reportDir: string }).reportDir = directory;
    buildReportMock.mockResolvedValue({ title: "Partial report", html: "<html>ok</html>" });
    pdfMock.mockResolvedValue(Buffer.from("%PDF-test"));
    try {
      const result = await executeTool(
        SOURCE_A,
        "create_report",
        {
          title: "Partial report",
          sections: [{ heading: "Summary", markdown: "body" }],
          charts: [CHART_A],
        },
        context([])
      );

      expect(buildReportMock).toHaveBeenCalledWith(
        expect.not.objectContaining({ unresolved_chart_ids: expect.anything() }),
        undefined
      );
      expect(pdfMock).toHaveBeenCalledWith(
        expect.not.objectContaining({ unresolved_chart_ids: expect.anything() }),
        undefined
      );
      expect(result.unresolved_chart_ids).toEqual([CHART_A]);
    } finally {
      (config as { reportDir: string }).reportDir = originalReportDir;
      await fs.rm(directory, { recursive: true, force: true });
    }
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
    const columns = Array.from({ length: 51 }, (_, index) => (index === 0 ? "c".repeat(220) : `column_${index}`));
    const rows = Array.from({ length: 101 }, (_, rowIndex) =>
      Array.from({ length: 51 }, (_, columnIndex) => (columnIndex === 0 ? "x".repeat(550) : rowIndex + columnIndex))
    );

    const [artifact] = captureQueryResult([], "S".repeat(2_100), { columns, rows, row_count: 101 });

    expect(artifact.sql).toHaveLength(1_500);
    expect(artifact.columns).toHaveLength(32);
    expect(artifact.columns[0]).toHaveLength(100);
    expect(artifact.rows.length).toBeGreaterThan(0);
    expect(artifact.rows.reduce((count, row) => count + row.length, 0)).toBeLessThanOrEqual(500);
    expect(artifact.rows.every((row) => row.length === 32)).toBe(true);
    expect(String(artifact.rows[0][0])).toHaveLength(300);
    expect(JSON.stringify([artifact]).length).toBeLessThanOrEqual(30_000);
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
    await expect(executeTool("account", "query_data", { sql: "SELECT broken" }, runContext)).rejects.toThrow(
      "query failed"
    );
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
    expect(
      sanitizeRetrievedEvidence([
        null,
        {},
        { ...valid, source_id: "" },
        { ...valid, chunk_id: " " },
        { ...valid, content: "" },
        { ...valid, score: Number.POSITIVE_INFINITY },
        { ...valid, score: "0.9" },
        valid,
      ])
    ).toEqual([
      {
        source_id: SOURCE_A,
        chunk_id: "1",
        source: "Allowed",
        excerpt: "passage",
        score: 0.9,
      },
    ]);
  });

  it("bounds labels, excerpts, and total passages", () => {
    const evidence = sanitizeRetrievedEvidence(
      Array.from({ length: 12 }, (_, index) => ({
        source_id: SOURCE_A,
        chunk_id: String(index),
        source: `  ${"s".repeat(220)}  `,
        content: `  ${"x".repeat(900)}  `,
        score: 1 - index / 100,
      }))
    );

    expect(evidence.length).toBeLessThanOrEqual(8);
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0].source).toHaveLength(200);
    expect(evidence[0].excerpt).toHaveLength(800);
    expect(
      evidence.reduce(
        (count, entry) =>
          count + entry.source_id.length + entry.chunk_id.length + entry.source.length + entry.excerpt.length + 32,
        0
      )
    ).toBeLessThanOrEqual(6_000);
  });

  it("keeps the first eight unique passages across repeated retrievals", async () => {
    const runContext = context();
    retrieveMock.mockResolvedValueOnce(
      Array.from({ length: 6 }, (_, index) => ({
        chunk_id: String(index),
        source_id: SOURCE_A,
        source: "Allowed",
        content: `passage ${index}`,
        score: 0.9,
      }))
    );
    retrieveMock.mockResolvedValueOnce(
      Array.from({ length: 6 }, (_, index) => ({
        chunk_id: String(index + 4),
        source_id: SOURCE_A,
        source: "Allowed",
        content: `passage ${index + 4}`,
        score: 0.8,
      }))
    );

    await executeTool("account", "retrieve", { query: "first" }, runContext);
    expect(runContext.evidence.map((entry) => entry.chunk_id)).toEqual(["0", "1", "2", "3", "4", "5"]);
    await executeTool("account", "retrieve", { query: "second" }, runContext);

    expect(runContext.evidence.map((entry) => entry.chunk_id)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  });
});

describe("retrieve citation numbering", () => {
  it("numbers every retained passage with its 1-based evidence position", () => {
    const returned = [
      { chunk_id: "41", source_id: SOURCE_A, source: "Allowed.csv", content: "first", score: 0.9 },
      { chunk_id: "42", source_id: SOURCE_B, source: "Other.csv", content: "second", score: 0.8 },
    ];
    expect(numberRetrievedPassages(returned, sanitizeRetrievedEvidence(returned))).toEqual([
      { n: 1, source: "Allowed.csv", score: 0.9, content: "first" },
      { n: 2, source: "Other.csv", score: 0.8, content: "second" },
    ]);
  });

  it("leaves passages dropped by the evidence cap unnumbered", () => {
    const prior = Array.from({ length: 6 }, (_, index) => ({
      chunk_id: String(index),
      source_id: SOURCE_A,
      source: "Allowed",
      content: `prior ${index}`,
      score: 0.9,
    }));
    const returned = Array.from({ length: 6 }, (_, index) => ({
      chunk_id: String(index + 6),
      source_id: SOURCE_A,
      source: "Allowed",
      content: `new ${index}`,
      score: 0.8,
    }));
    const evidence = sanitizeRetrievedEvidence([...prior, ...returned]);

    const numbered = numberRetrievedPassages(returned, evidence);

    expect(numbered.map((passage) => passage.n)).toEqual([7, 8, undefined, undefined, undefined, undefined]);
    expect(numbered[2]).toEqual({ source: "Allowed", score: 0.8, content: "new 2" });
    expect(numbered[5]).toEqual({ source: "Allowed", score: 0.8, content: "new 5" });
  });

  it("does not number a duplicate chunk dropped by the sanitizer", () => {
    const first = { chunk_id: "41", source_id: SOURCE_A, source: "Allowed", content: "first", score: 0.9 };
    const duplicate = { ...first, content: "duplicate content", score: 0.5 };
    const fresh = { chunk_id: "42", source_id: SOURCE_B, source: "Other", content: "fresh", score: 0.7 };

    const numbered = numberRetrievedPassages(
      [first, duplicate, fresh],
      sanitizeRetrievedEvidence([first, duplicate, fresh])
    );

    expect(numbered).toEqual([
      { n: 1, source: "Allowed", score: 0.9, content: "first" },
      { source: "Allowed", score: 0.5, content: "duplicate content" },
      { n: 2, source: "Other", score: 0.7, content: "fresh" },
    ]);
  });

  it("numbers retrieved passages by their position in the merged run evidence", async () => {
    const runContext = context();
    retrieveMock.mockResolvedValueOnce([
      { chunk_id: "41", source_id: SOURCE_A, source: "Allowed.csv", content: "first", score: 0.9 },
    ]);
    const first = await executeTool("account", "retrieve", { query: "one" }, runContext);
    expect(first.passages).toEqual([{ n: 1, source: "Allowed.csv", score: 0.9, content: "first" }]);

    retrieveMock.mockResolvedValueOnce([
      { chunk_id: "42", source_id: SOURCE_B, source: "Pending.csv", content: "second", score: 0.8 },
      { chunk_id: "41", source_id: SOURCE_A, source: "Allowed.csv", content: "first again", score: 0.7 },
    ]);
    const second = await executeTool("account", "retrieve", { query: "two" }, runContext);
    expect(second.passages).toEqual([
      { n: 2, source: "Pending.csv", score: 0.8, content: "second" },
      { n: 1, source: "Allowed.csv", score: 0.7, content: "first again" },
    ]);
  });
});

describe("makeReportPayload current-run chart resolution", () => {
  it("resolves a well-formed chart id created in this run", async () => {
    runStoreMock.getPendingChart.mockResolvedValueOnce({ id: CHART_A, spec: { type: "bar" } });
    const payload = await makeReportPayload("account-1", { charts: [CHART_A] }, context([CHART_A]));
    expect(payload.charts).toEqual([{ id: CHART_A, spec: { type: "bar" } }]);
    expect(payload).not.toHaveProperty("unresolved_chart_ids");
    expect(runStoreMock.getPendingChart).toHaveBeenCalledWith(
      "account-1",
      "33333333-3333-4333-8333-333333333333",
      CHART_A
    );
  });

  it("resolves a dash-less prefix only inside the current run", async () => {
    const chartId = "abcdef01-2345-6789-abcd-ef0123456789";
    const raw = "abcdef012345";
    runStoreMock.getPendingChart.mockResolvedValueOnce({ id: chartId, spec: { type: "line" } });
    const payload = await makeReportPayload("account-1", { charts: [raw] }, context([chartId]));
    expect(payload.charts).toEqual([{ id: chartId, spec: { type: "line" } }]);
    expect(runStoreMock.getPendingChart).toHaveBeenCalledWith(
      "account-1",
      "33333333-3333-4333-8333-333333333333",
      chartId
    );
  });

  it("does not query an account chart that was not created in this run", async () => {
    const payload = await makeReportPayload("account-1", { charts: [CHART_A] }, context([]));
    expect(payload.charts).toEqual([]);
    expect(payload.unresolved_chart_ids).toEqual([CHART_A]);
    expect(runStoreMock.getPendingChart).not.toHaveBeenCalled();
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
    expect(runStoreMock.getPendingChart).not.toHaveBeenCalled();
  });

  it("reports database failures as unresolved without throwing", async () => {
    runStoreMock.getPendingChart.mockRejectedValueOnce(new Error("database unavailable"));
    const payload = await makeReportPayload("account-1", { charts: [CHART_A] }, context([CHART_A]));
    expect(payload.charts).toEqual([]);
    expect(payload.unresolved_chart_ids).toEqual([CHART_A]);
  });

  it("bounds report subtitles, charts, tables, rows, columns, cells, and nested values", async () => {
    const payload = await makeReportPayload(
      "account-1",
      {
        subtitle: "s".repeat(600),
        charts: Array.from({ length: 30 }, () => "not-a-chart"),
        tables: Array.from({ length: 10 }, () => ({
          columns: Array.from({ length: 40 }, (_, index) => `column-${index}-${"x".repeat(250)}`),
          rows: Array.from({ length: 70 }, () => ["v".repeat(600), { nested: { value: "secret" } }]),
        })),
      },
      context([])
    );

    expect(payload.subtitle).toHaveLength(500);
    expect(payload.unresolved_chart_ids).toHaveLength(20);
    expect(payload.tables.length).toBeGreaterThan(0);
    expect(payload.tables.length).toBeLessThanOrEqual(8);
    expect(payload.tables[0].columns).toHaveLength(32);
    expect(payload.tables[0].columns[0]).toHaveLength(200);
    expect(payload.tables[0].rows.length).toBeLessThanOrEqual(60);
    expect(payload.tables[0].rows[0]).toHaveLength(32);
    expect(payload.tables[0].rows[0][0]).toHaveLength(500);
    expect(payload.tables[0].rows[0][1]).toBe("[unsupported value]");
    expect(
      payload.tables.reduce(
        (count: number, table: { rows: unknown[][] }) =>
          count + table.rows.reduce((rowCount, row) => rowCount + row.length, 0),
        0
      )
    ).toBeLessThanOrEqual(1_000);
    expect(runStoreMock.getPendingChart).not.toHaveBeenCalled();
  });
});

it("rejects guessed disabled tools before any data access", async () => {
  await expect(
    executeTool("owner", "retrieve", { query: "guessed" }, { ...context(), allowedTools: [] })
  ).rejects.toThrow("disabled");
  expect(retrieveMock).not.toHaveBeenCalled();
});
