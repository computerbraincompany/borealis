import { describe, expect, it } from "vitest";

import {
  DOCUMENT_DIFF_MAX_SECTION_OPS,
  DOCUMENT_DIFF_MAX_TOTAL_TEXT_CHARS,
  diffDocumentTrees,
  type DocumentRevisionDiff,
} from "../documentDiff.js";
import { normalizeDocumentTree, type DocumentTree } from "../documentTypes.js";

const SECTION_A = "11111111-1111-4111-8111-111111111111";
const SECTION_B = "22222222-2222-4222-8222-222222222222";
const SECTION_C = "33333333-3333-4333-8333-333333333333";

function ref(revision: number, title = "Doc") {
  return { revision_id: `00000000-0000-4000-8000-00000000000${revision}`, revision, title };
}

function tree(input: unknown): DocumentTree {
  return normalizeDocumentTree(input).tree;
}

function diff(base: DocumentTree, target: DocumentTree): DocumentRevisionDiff {
  return diffDocumentTrees(base, target, { base: ref(1), target: ref(2) });
}

describe("diffDocumentTrees", () => {
  it("reports an identical revision as empty and is deterministic across calls", () => {
    const t = tree({
      title: "Same",
      sections: [
        { id: SECTION_A, heading: "One", markdown: "line 1\nline 2" },
        { id: SECTION_B, heading: "Two", markdown: "solo" },
      ],
    });
    const first = diff(t, t);
    expect(first.sections.added).toEqual([]);
    expect(first.sections.removed).toEqual([]);
    expect(first.sections.moved).toEqual([]);
    expect(first.sections.modified).toEqual([]);
    expect(first.text_diffs).toEqual([]);
    expect(first.truncated).toBe(false);
    expect(JSON.stringify(diff(t, t))).toBe(JSON.stringify(first));
  });

  it("classifies added, removed, moved, and modified sections by stable UUID", () => {
    const base = tree({
      title: "Doc",
      sections: [
        { id: SECTION_A, heading: "A", markdown: "a text" },
        { id: SECTION_B, heading: "B", markdown: "b text" },
        { id: SECTION_C, heading: "C", markdown: "c text" },
      ],
    });
    const target = tree({
      title: "Doc",
      sections: [
        { id: SECTION_C, heading: "C", markdown: "c text" },
        { id: SECTION_B, heading: "B", markdown: "b text revised" },
        { id: "44444444-4444-4444-8444-444444444444", heading: "D", markdown: "d text" },
      ],
    });
    const result = diff(base, target);
    // A dropped out of the target order entirely; C stayed in a stable
    // relative position; B moved before C AND changed text.
    expect(result.sections.removed).toEqual([{ id: SECTION_A, heading: "A", index: 0 }]);
    expect(result.sections.added).toEqual([
      { id: "44444444-4444-4444-8444-444444444444", heading: "D", index: 2 },
    ]);
    expect(result.sections.modified.map((entry) => entry.id)).toEqual([SECTION_B]);
    expect(result.text_diffs.map((entry) => entry.section_id)).toEqual([
      SECTION_B,
      "44444444-4444-4444-8444-444444444444",
      SECTION_A,
    ]);
  });

  it("detects reordering of surviving sections via the LCS order", () => {
    const base = tree({
      title: "Doc",
      sections: [
        { id: SECTION_A, heading: "A", markdown: "a" },
        { id: SECTION_B, heading: "B", markdown: "b" },
        { id: SECTION_C, heading: "C", markdown: "c" },
      ],
    });
    // Moving C to the front keeps [A,B] as the stable relative order, so
    // exactly the moved section is reported — never a silent re-add.
    const movedUp = tree({
      title: "Doc",
      sections: [
        { id: SECTION_C, heading: "C", markdown: "c" },
        { id: SECTION_A, heading: "A", markdown: "a" },
        { id: SECTION_B, heading: "B", markdown: "b" },
      ],
    });
    const result = diff(base, movedUp);
    expect(result.sections.added).toEqual([]);
    expect(result.sections.removed).toEqual([]);
    expect(result.sections.modified).toEqual([]);
    expect(result.text_diffs).toEqual([]);
    expect(result.sections.moved).toEqual([{ id: SECTION_C, heading: "C", base_index: 2, target_index: 0 }]);
    // A pure adjacent swap reports the minimal single-move interpretation and
    // is deterministic across repeated calls.
    const swapped = tree({
      title: "Doc",
      sections: [
        { id: SECTION_B, heading: "B", markdown: "b" },
        { id: SECTION_A, heading: "A", markdown: "a" },
        { id: SECTION_C, heading: "C", markdown: "c" },
      ],
    });
    const swap = diff(base, swapped);
    expect(swap.sections.moved).toHaveLength(1);
    expect(JSON.stringify(diff(base, swapped))).toBe(JSON.stringify(swap));
  });

  it("emits a unified-style line diff for a modified section with context", () => {
    const base = tree({
      title: "Doc",
      sections: [
        {
          id: SECTION_A,
          heading: "A",
          markdown: "keep 1\nkeep 2\nold line\nkeep 3\nkeep 4\nkeep 5\nkeep 6\nkeep 7",
        },
      ],
    });
    const target = tree({
      title: "Doc",
      sections: [
        {
          id: SECTION_A,
          heading: "A",
          markdown: "keep 1\nkeep 2\nnew line\nkeep 3\nkeep 4\nkeep 5\nkeep 6\nkeep 7",
        },
      ],
    });
    const sectionDiff = diff(base, target).text_diffs[0]!;
    expect(sectionDiff.truncated).toBe(false);
    expect(sectionDiff.ops).toContainEqual({ kind: "delete", old_line: 3, new_line: null, text: "old line" });
    expect(sectionDiff.ops).toContainEqual({ kind: "insert", old_line: null, new_line: 3, text: "new line" });
    expect(sectionDiff.ops).toContainEqual({ kind: "equal", old_line: 2, new_line: 2, text: "keep 2" });
    // Context-bounded: line 7 of 8 is far from the change and omitted.
    expect(sectionDiff.ops.some((op) => op.text === "keep 7")).toBe(false);
  });

  it("bounds section ops and total text, flagging truncation instead of dropping silently", () => {
    const baseLines = Array.from({ length: 4_500 }, (_, i) => `b${i}`).join("\n");
    const targetLines = Array.from({ length: 4_500 }, (_, i) => `t${i}`).join("\n");
    const base = tree({ title: "Doc", sections: [{ id: SECTION_A, heading: "A", markdown: baseLines }] });
    const target = tree({ title: "Doc", sections: [{ id: SECTION_A, heading: "A", markdown: targetLines }] });
    const result = diff(base, target);
    expect(result.truncated).toBe(true);
    const sectionDiff = result.text_diffs[0]!;
    expect(sectionDiff.truncated).toBe(true);
    expect(sectionDiff.ops.length).toBeLessThanOrEqual(DOCUMENT_DIFF_MAX_SECTION_OPS);
    const totalChars = result.text_diffs.reduce(
      (sum, entry) => sum + entry.ops.reduce((inner, op) => inner + op.text.length, 0),
      0
    );
    expect(totalChars).toBeLessThanOrEqual(DOCUMENT_DIFF_MAX_TOTAL_TEXT_CHARS);
  });

  it("falls back to a bounded coarse diff when sections exceed the line bound", () => {
    const hugeBase = Array.from({ length: 2_500 }, (_, i) => `x${i}`).join("\n");
    const hugeTarget = Array.from({ length: 2_500 }, (_, i) => `y${i}`).join("\n");
    const base = tree({ title: "Doc", sections: [{ id: SECTION_A, heading: "A", markdown: hugeBase }] });
    const target = tree({ title: "Doc", sections: [{ id: SECTION_A, heading: "A", markdown: hugeTarget }] });
    const result = diff(base, target);
    expect(result.truncated).toBe(true);
    expect(result.sections.modified.map((entry) => entry.id)).toEqual([SECTION_A]);
    expect(result.text_diffs[0]!.ops.length).toBeLessThanOrEqual(DOCUMENT_DIFF_MAX_SECTION_OPS);
  });

  it("summarizes chart, table, evidence, and field changes deterministically", () => {
    const spec = {
      type: "bar" as const,
      title: "T",
      subtitle: "",
      categories: ["a"],
      series: [{ name: "s", data: [1], color: "#6366F1" }],
      items: [],
      x_label: "",
      y_label: "",
    };
    const base = tree({
      title: "Before",
      subtitle: "same",
      sections: [],
      charts: [
        { id: "chart-1", spec },
        { id: "chart-gone", spec },
      ],
      tables: [{ columns: ["month"], rows: [["jan"]] }, { columns: ["gone"], rows: [] }],
      evidence: [
        {
          id: "55555555-5555-5555-8555-555555555555",
          source_id: "66666666-6666-4666-8666-666666666666",
          source_name: "ledger.csv",
          generation: 3,
          content_identity: "abc",
          locator: "p.1",
          excerpt: "excerpt text",
        },
      ],
    });
    const target = tree({
      title: "After",
      subtitle: "same",
      sections: [],
      charts: [
        { id: "chart-1", spec: { ...spec, title: "T2" } },
        { id: "chart-new", spec },
      ],
      tables: [
        { columns: ["month"], rows: [["jan"], ["feb"]] },
        { columns: ["new"], rows: [] },
      ],
      evidence: [],
    });
    const result = diff(base, target);
    expect(result.fields).toEqual({ title_changed: true, subtitle_changed: false, verified_changed: false });
    expect(result.charts).toEqual({ added: ["chart-new"], removed: ["chart-gone"], changed: ["chart-1"] });
    expect(result.tables.changed).toEqual([0]);
    expect(result.tables.added).toEqual([{ index: 1, columns: ["new"] }]);
    expect(result.tables.removed).toEqual([{ index: 1, columns: ["gone"] }]);
    expect(result.evidence.removed.map((entry) => entry.source_name)).toEqual(["ledger.csv"]);
    // Determinism: byte-identical repeat.
    expect(JSON.stringify(diff(base, target))).toBe(JSON.stringify(result));
  });

  it("keeps astral and surrogate-bearing lines intact in the text diff", () => {
    const base = tree({ title: "D", sections: [{ id: SECTION_A, heading: "A", markdown: "😀 keep\nremove me" }] });
    const target = tree({ title: "D", sections: [{ id: SECTION_A, heading: "A", markdown: "😀 keep\nadd you" }] });
    const ops = diff(base, target).text_diffs[0]!.ops;
    expect(ops).toContainEqual({ kind: "delete", old_line: 2, new_line: null, text: "remove me" });
    expect(ops).toContainEqual({ kind: "insert", old_line: null, new_line: 2, text: "add you" });
    expect(ops).toContainEqual({ kind: "equal", old_line: 1, new_line: 1, text: "😀 keep" });
  });
});
