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
import { executeTool, makeReportPayload, type ToolRunContext } from "../tools.js";
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
    retrieveMock.mockResolvedValueOnce([]);
    await executeTool("account", "retrieve", { query: "canary", top_k: 3 }, context());
    expect(retrieveMock).toHaveBeenCalledWith("account", "canary", [SOURCE_A], 3);
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
    queryMock.mockResolvedValueOnce({ columns: [], rows: [], row_count: 0 });
    await executeTool("account", "query_data", { sql: "SELECT 1" }, context());
    expect(queryMock).toHaveBeenCalledWith("account", "SELECT 1", ["allowed_table"]);
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
