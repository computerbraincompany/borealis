import { describe, expect, it } from "vitest";
import {
  analysisExportFilename,
  buildResultChartSpec,
  COMPARE_DIFF_ROWS_MAX,
  compareAnalysisResults,
  exportAnalysisResult,
  ResultChartError,
} from "../analysisCompare.js";
import type {
  AnalysisColumnScalarType,
  AnalysisResultCell,
  StoredAnalysisResult,
  StoredAnalysisRunSource,
} from "../analysisTypes.js";

function column(name: string, type: AnalysisColumnScalarType) {
  return { name, type };
}

function storedResult(input: {
  id: string;
  rows: readonly (readonly AnalysisResultCell[])[];
  columns?: readonly { name: string; type: AnalysisColumnScalarType }[];
  parameters?: readonly { name: string; value: string | null }[];
  sources?: readonly StoredAnalysisRunSource[];
  complete?: boolean;
  reasons?: readonly string[];
  analysisId?: string;
  revision?: number;
}): StoredAnalysisResult {
  const width = input.rows[0]?.length ?? input.columns?.length ?? 0;
  const columns = input.columns ?? Array.from({ length: width }, (_, index) => column(`c${index}`, "mixed" as const));
  const complete = input.complete ?? true;
  return Object.freeze({
    id: input.id,
    accountId: "a1111111-1111-4111-8111-111111111111",
    analysisId: input.analysisId ?? "analysis-1",
    runId: `run-${input.id}`,
    revision: input.revision ?? 1,
    columns: Object.freeze(columns.map((entry) => Object.freeze({ ...entry }))),
    rows: Object.freeze(input.rows.map((row) => Object.freeze([...row]))),
    returnedRows: input.rows.length,
    sourceRowTotal: input.rows.length,
    rowCountExact: true,
    completeness: Object.freeze({
      complete,
      reasons: Object.freeze(input.reasons ?? (complete ? [] : ["rows-truncated"])),
    }),
    parameterBindings: Object.freeze(
      (input.parameters ?? []).map((binding) => Object.freeze({ ...binding, type: "string" as const }))
    ),
    sourceProvenance: Object.freeze(input.sources ?? []),
    schemaFingerprint: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

function source(sourceId: string, readyGeneration: number, contentIdentity: string): StoredAnalysisRunSource {
  return Object.freeze({ sourceId, readyGeneration, contentIdentity });
}

const keyColumns = [column("id", "string"), column("v", "number"), column("note", "string")];

describe("compareAnalysisResults — keyed mode", () => {
  const left = storedResult({
    id: "left",
    columns: keyColumns,
    rows: [
      ["a", 10, "x"],
      ["b", 20, "y"],
    ],
    parameters: [{ name: "month", value: "2026-01" }],
    sources: [source("s1", 1, "g1|s10|p/x")],
  });
  const right = storedResult({
    id: "right",
    columns: keyColumns,
    rows: [
      ["a", 12, "x"],
      ["c", 5, "z"],
    ],
    parameters: [{ name: "month", value: "2026-02" }],
    sources: [source("s1", 2, "g2|s11|p/x")],
  });

  it("reports added/removed/changed rows with exact numeric deltas", () => {
    const comparison = compareAnalysisResults(left, right, ["id"]);
    expect(comparison.mode).toBe("keyed");
    expect(comparison.reason_code).toBeNull();
    expect(comparison.exhaustive).toBe(true);
    expect(comparison.added).toEqual([["c", 5, "z"]]);
    expect(comparison.removed).toEqual([["b", 20, "y"]]);
    expect(comparison.added_total).toBe(1);
    expect(comparison.removed_total).toBe(1);
    expect(comparison.changed_total).toBe(1);
    expect(comparison.changed).toEqual([{ key: ["a"], changes: [{ column: "v", before: 10, after: 12, delta: 2 }] }]);
  });

  it("always reports parameter, source-version, and schema diffs", () => {
    const comparison = compareAnalysisResults(left, right, ["id"]);
    expect(comparison.parameters.same).toBe(false);
    expect(comparison.parameters.changed).toEqual([{ name: "month", left: "2026-01", right: "2026-02" }]);
    expect(comparison.sources).toEqual([
      {
        source_id: "s1",
        status: "version-changed",
        left: { ready_generation: 1, content_identity: "g1|s10|p/x" },
        right: { ready_generation: 2, content_identity: "g2|s11|p/x" },
      },
    ]);
    expect(comparison.schema.same).toBe(true);
  });

  it("is deterministic across repeated evaluations", () => {
    const first = JSON.stringify(compareAnalysisResults(left, right, ["id"]));
    const second = JSON.stringify(compareAnalysisResults(left, right, ["id"]));
    expect(second).toBe(first);
  });

  it("supports composite keys and numeric deltas for every finite stored number", () => {
    const composite = compareAnalysisResults(
      storedResult({
        id: "l2",
        columns: [column("k1", "string"), column("k2", "number"), column("v", "number")],
        rows: [["x", 1, -3.5]],
      }),
      storedResult({
        id: "r2",
        columns: [column("k1", "string"), column("k2", "number"), column("v", "number")],
        rows: [["x", 1, 2.5]],
      }),
      ["k1", "k2"]
    );
    expect(composite.mode).toBe("keyed");
    expect(composite.changed).toEqual([
      { key: ["x", 1], changes: [{ column: "v", before: -3.5, after: 2.5, delta: 6 }] },
    ]);
  });

  it("bounds each diff category and flags truncation without losing totals", () => {
    const manyLeft = Array.from({ length: 1 }, (_, index) => [`k${index}`, 0, ""] as [string, number, string]);
    const manyRight = Array.from(
      { length: COMPARE_DIFF_ROWS_MAX + 50 },
      (_, index) => [`k${index}`, 0, ""] as [string, number, string]
    );
    const comparison = compareAnalysisResults(
      storedResult({ id: "bl", columns: keyColumns, rows: manyLeft }),
      storedResult({ id: "br", columns: keyColumns, rows: manyRight }),
      ["id"]
    );
    expect(comparison.added).toHaveLength(COMPARE_DIFF_ROWS_MAX);
    expect(comparison.truncated).toBe(true);
    expect(comparison.added_total).toBe(COMPARE_DIFF_ROWS_MAX + 49);
  });
});

describe("compareAnalysisResults — unsupported and side-by-side modes", () => {
  const left = storedResult({ id: "left", columns: keyColumns, rows: [["a", 1, "x"]] });
  const right = storedResult({ id: "right", columns: keyColumns, rows: [["a", 2, "y"]] });

  it("shows side-by-side tables only when no key is configured and never invents identity", () => {
    const comparison = compareAnalysisResults(left, right, null);
    expect(comparison.mode).toBe("side-by-side");
    expect(comparison.reason_code).toBe("no-comparison-key");
    expect(comparison.added).toBeUndefined();
    expect(comparison.removed).toBeUndefined();
    expect(comparison.changed).toBeUndefined();
    expect(comparison.left_table.rows).toEqual([["a", 1, "x"]]);
    expect(comparison.right_table.rows).toEqual([["a", 2, "y"]]);
  });

  it("reports an explicit unsupported reason for duplicate key values", () => {
    const duplicate = storedResult({
      id: "dup",
      columns: keyColumns,
      rows: [
        ["a", 1, "x"],
        ["a", 2, "x"],
      ],
    });
    const comparison = compareAnalysisResults(left, duplicate, ["id"]);
    expect(comparison.mode).toBe("side-by-side");
    expect(comparison.reason_code).toBe("key-value-duplicate");
  });

  it("reports an explicit unsupported reason for missing (null) key values", () => {
    const missing = storedResult({ id: "nullk", columns: keyColumns, rows: [[null, 2, "y"]] });
    const comparison = compareAnalysisResults(left, missing, ["id"]);
    expect(comparison.mode).toBe("side-by-side");
    expect(comparison.reason_code).toBe("key-value-null");
  });

  it("reports an explicit unsupported reason when key columns are absent", () => {
    const comparison = compareAnalysisResults(left, right, ["nope"]);
    expect(comparison.mode).toBe("side-by-side");
    expect(comparison.reason_code).toBe("key-column-missing");
    expect(comparison.reason_detail).toBe("nope");
  });

  it("reports an explicit unsupported reason when a stored column type changed", () => {
    const typedRight = storedResult({
      id: "typed",
      columns: [column("id", "string"), column("v", "string"), column("note", "string")],
      rows: [["a", "2", "y"]],
    });
    const comparison = compareAnalysisResults(left, typedRight, ["id"]);
    expect(comparison.mode).toBe("side-by-side");
    expect(comparison.reason_code).toBe("column-type-changed");
    expect(comparison.schema.changed_types).toEqual([{ name: "v", from: "number", to: "string" }]);
  });
});

describe("compareAnalysisResults — truncated inputs are previews only", () => {
  it("labels previews and never claims exhaustive added/removed totals", () => {
    const left = storedResult({
      id: "lt",
      columns: keyColumns,
      rows: [["a", 1, "x"]],
      complete: false,
      reasons: ["rows-truncated"],
    });
    const right = storedResult({
      id: "rt",
      columns: keyColumns,
      rows: [
        ["a", 1, "x"],
        ["b", 2, "y"],
      ],
    });
    const comparison = compareAnalysisResults(left, right, ["id"]);
    expect(comparison.mode).toBe("keyed");
    expect(comparison.exhaustive).toBe(false);
    expect(comparison.added_total).toBeNull();
    expect(comparison.removed_total).toBeNull();
    expect(comparison.changed_total).toBeNull();
    // The bounded preview diff itself is still computed from stored cells.
    expect(comparison.added).toEqual([["b", 2, "y"]]);
    expect(comparison.left_table.complete).toBe(false);
    expect(comparison.left_table.completeness_reasons).toEqual(["rows-truncated"]);
  });
});

describe("exportAnalysisResult", () => {
  const result = storedResult({
    id: "res1",
    columns: [column("label", "string"), column("amount", "number"), column("ok", "boolean")],
    rows: [
      ["=SUM(A1:A2)", 42, true],
      ['he said "hi", loudly\nsecond line', -3.5, false],
      [null, 0, null],
    ],
    parameters: [{ name: "month", value: "2026-01" }],
    sources: [source("s1", 3, "g3|s9|p/data.csv")],
  });

  it("escapes CSV fields and protects formula-leading strings", () => {
    const file = exportAnalysisResult(result, "Monthly Review!!", "csv");
    expect(file.contentType).toContain("text/csv");
    expect(file.body.startsWith("﻿")).toBe(true);
    const lines = file.body.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe("label,amount,ok");
    expect(lines[1]).toBe("'=SUM(A1:A2),42,true");
    // A quoted field keeps its embedded newline inside the record, so the
    // whole record stays one CRLF-separated line.
    expect(lines[2]).toBe('"he said ""hi"", loudly\nsecond line",-3.5,false');
    expect(lines[3]).toBe("null,0,null");
    // Negative numbers must not be altered; only string formulas are guarded.
    expect(file.body).not.toContain("'-3.5");
  });

  it("labels partial exports and names the download", () => {
    const partial = storedResult({ id: "res2", columns: keyColumns, rows: [["a", 1, "x"]], complete: false });
    const file = exportAnalysisResult(partial, "My Report", "csv");
    expect(file.filename).toMatch(/-partial\.csv$/);
    expect(file.body).toContain("# partial export: rows-truncated\r\n");
    const complete = exportAnalysisResult(result, "Monthly Review!!", "csv");
    expect(complete.body).not.toContain("# partial export");
  });

  it("preserves scalar types in JSON export", () => {
    const file = exportAnalysisResult(result, "Monthly Review!!", "json");
    const parsed = JSON.parse(file.body) as { rows: unknown[][]; columns: unknown[]; partial: boolean };
    expect(parsed.rows[0]).toEqual(["=SUM(A1:A2)", 42, true]);
    expect(parsed.rows[2]).toEqual([null, 0, null]);
    expect(parsed.partial).toBe(false);
    expect(parsed.columns).toEqual([
      { name: "label", type: "string" },
      { name: "amount", type: "number" },
      { name: "ok", type: "boolean" },
    ]);
  });

  it("emits provenance-only manifests without row payloads", () => {
    const file = exportAnalysisResult(result, "Monthly Review!!", "manifest");
    const manifest = JSON.parse(file.body) as Record<string, unknown>;
    expect(file.filename).toContain("-manifest.json");
    expect(manifest.artifact).toBe("analysis_result_manifest");
    expect(manifest.parameters).toEqual([{ name: "month", type: "string", value: "2026-01" }]);
    expect(manifest.source_provenance).toEqual([
      { source_id: "s1", ready_generation: 3, content_identity: "g3|s9|p/data.csv" },
    ]);
    expect((manifest.exported_result as Record<string, unknown>).analysis_title).toBe("Monthly Review!!");
    expect(manifest.rows).toBeUndefined();
  });

  it("derives explicit ASCII download names", () => {
    expect(analysisExportFilename("Monthly / Review: 2026!", "aaaaaaaa-1111-4111-8111-111111111111", "csv")).toBe(
      "monthly-review-2026-aaaaaaaa.csv"
    );
    expect(analysisExportFilename("", "bbbbbbbb-1111-4111-8111-111111111111", "json")).toBe("analysis-bbbbbbbb.json");
  });
});

describe("buildResultChartSpec", () => {
  it("copies a canonical spec from the stored snapshot: first string column, numeric series", () => {
    const result = storedResult({
      id: "chartable",
      columns: [column("month", "string"), column("spend", "number"), column("income", "number")],
      rows: [
        ["2026-01", 100, 250],
        ["2026-02", null, 260],
      ],
    });
    const spec = buildResultChartSpec(result, "Finance");
    expect(spec.type).toBe("bar");
    expect(spec.categories).toEqual(["2026-01", "2026-02"]);
    expect(spec.series.map((series) => series.name)).toEqual(["spend", "income"]);
    expect(spec.series[0].data).toEqual([100, 0]);
    expect(spec.x_label).toBe("month");
  });

  it("falls back to the first column for categories when nothing is textual", () => {
    const result = storedResult({
      id: "numbers",
      columns: [column("year", "number"), column("total", "number")],
      rows: [
        [2025, 10],
        [2026, 20],
      ],
    });
    const spec = buildResultChartSpec(result, "Years");
    expect(spec.categories).toEqual(["2025", "2026"]);
    expect(spec.series[0].name).toBe("total");
  });

  it("rejects results with no numeric columns and empty results", () => {
    expect(() =>
      buildResultChartSpec(
        storedResult({ id: "strings", columns: [column("a", "string"), column("b", "string")], rows: [["x", "y"]] }),
        "Nope"
      )
    ).toThrow(ResultChartError);
    expect(() =>
      buildResultChartSpec(
        storedResult({ id: "empty", columns: [column("a", "string"), column("b", "number")], rows: [] }),
        "Nope"
      )
    ).toThrow(ResultChartError);
  });
});
