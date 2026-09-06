import { describe, expect, it } from "vitest";

import { diffRewriteText, REWRITE_DIFF_MAX_OPS } from "./rewriteDiff";

describe("diffRewriteText", () => {
  it("is empty for identical text", () => {
    expect(diffRewriteText("same", "same")).toEqual({ ops: [], truncated: false });
  });

  it("emits bounded line ops with 1-based numbering", () => {
    const diff = diffRewriteText("keep\nold tail", "keep\nnew tail");
    expect(diff.truncated).toBe(false);
    expect(diff.ops).toEqual([
      { kind: "equal", old_line: 1, new_line: 1, text: "keep" },
      { kind: "delete", old_line: 2, new_line: null, text: "old tail" },
      { kind: "insert", old_line: null, new_line: 2, text: "new tail" },
    ]);
  });

  it("trims unchanged prefix and suffix lines", () => {
    const before = ["h1", "h2", "old middle", "t1", "t2"].join("\n");
    const after = ["h1", "h2", "new middle", "t1", "t2"].join("\n");
    const ops = diffRewriteText(before, after).ops;
    expect(ops.map((op) => op.kind)).toEqual(["equal", "equal", "delete", "insert", "equal", "equal"]);
  });

  it("caps total ops and reports truncation", () => {
    const before = Array.from({ length: 400 }, (_, index) => `l${index}`).join("\n");
    const after = Array.from({ length: 400 }, (_, index) => `m${index}`).join("\n");
    const diff = diffRewriteText(before, after);
    expect(diff.ops.length).toBeLessThanOrEqual(REWRITE_DIFF_MAX_OPS);
    expect(diff.truncated).toBe(true);
  });

  it("falls back to a bounded coarse diff beyond the edit budget", () => {
    const before = Array.from({ length: 700 }, (_, index) => `a${index}`).join("\n");
    const after = Array.from({ length: 700 }, (_, index) => `b${index}`).join("\n");
    const diff = diffRewriteText(before, after);
    expect(diff.truncated).toBe(true);
    expect(diff.ops.length).toBeLessThanOrEqual(REWRITE_DIFF_MAX_OPS);
    expect(diff.ops.some((op) => op.kind === "delete")).toBe(true);
    expect(diff.ops.some((op) => op.kind === "insert")).toBe(true);
  });

  it("handles whole-string replacement (selection without lines)", () => {
    const diff = diffRewriteText("one sentence", "another sentence entirely");
    expect(diff.ops).toEqual([
      { kind: "delete", old_line: 1, new_line: null, text: "one sentence" },
      { kind: "insert", old_line: null, new_line: 1, text: "another sentence entirely" },
    ]);
    expect(diff.truncated).toBe(false);
  });
});
