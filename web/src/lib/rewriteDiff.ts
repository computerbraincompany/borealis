/**
 * Bounded line-level diff for reviewing a rewrite proposal against the
 * current selection (M13 stage 3 web).
 *
 * The server's revision diff lives in `server/src/documentDiff.ts`; proposals
 * are not revisions, so the workbench mirrors that contract client-side: the
 * same `equal | insert | delete` op shape and 1-based line numbers the
 * `DiffPanel` already renders, over the proposal's replacement versus the
 * exact saved selection text. The computation is bounded: common prefix and
 * suffix lines are trimmed, the LCS runs only under an explicit edit budget,
 * and everything beyond the caps collapses to one bounded delete+insert run
 * reported through `truncated` — never silently dropped.
 */

import type { DocumentDiffOp } from "@/lib/api";

export const REWRITE_DIFF_MAX_OPS = 240;
export const REWRITE_DIFF_CONTEXT_LINES = 3;
const REWRITE_DIFF_MAX_CELLS = 400_000;

export interface RewriteDiff {
  ops: DocumentDiffOp[];
  truncated: boolean;
}

/**
 * The final truncation guard: show a bounded delete run and a bounded insert
 * run, each announcing its omitted remainder, so a collapsed review diff
 * still shows both sides of the change instead of being cut off mid-run.
 */
function capCoarse(before: string, after: string): DocumentDiffOp[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const ops: DocumentDiffOp[] = [];
  const deleteBudget = Math.min(oldLines.length, Math.floor(REWRITE_DIFF_MAX_OPS / 2) - 1);
  for (let index = 0; index < deleteBudget; index += 1) {
    ops.push({ kind: "delete", old_line: index + 1, new_line: null, text: oldLines[index] });
  }
  if (oldLines.length > deleteBudget) {
    ops.push({
      kind: "equal",
      old_line: null,
      new_line: null,
      text: `… ${oldLines.length - deleteBudget} more changed lines omitted`,
    });
  }
  const insertBudget = Math.min(newLines.length, REWRITE_DIFF_MAX_OPS - ops.length - 1);
  for (let index = 0; index < insertBudget; index += 1) {
    ops.push({ kind: "insert", old_line: null, new_line: index + 1, text: newLines[index] });
  }
  if (newLines.length > insertBudget) {
    ops.push({
      kind: "equal",
      old_line: null,
      new_line: null,
      text: `… ${newLines.length - insertBudget} more changed lines omitted`,
    });
  }
  return ops;
}

function coarseDiff(oldLines: readonly string[], newLines: readonly string[]): RewriteDiff {
  const ops: DocumentDiffOp[] = [];
  for (const [offset, text] of oldLines.entries()) {
    ops.push({ kind: "delete", old_line: offset + 1, new_line: null, text });
  }
  for (const [offset, text] of newLines.entries()) {
    ops.push({ kind: "insert", old_line: null, new_line: offset + 1, text });
  }
  return { ops, truncated: true };
}

export function diffRewriteText(before: string, after: string): RewriteDiff {
  if (before === after) return { ops: [], truncated: false };
  let oldLines = before.split("\n");
  let newLines = after.split("\n");

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const headKeep = Math.min(prefix, REWRITE_DIFF_CONTEXT_LINES);
  const tailKeep = Math.min(suffix, REWRITE_DIFF_CONTEXT_LINES);
  const contextOmitted = prefix - headKeep > 0 || suffix - tailKeep > 0;

  const head = oldLines.slice(0, headKeep);
  const tail = suffix > 0 ? oldLines.slice(oldLines.length - suffix).slice(suffix - tailKeep) : [];
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const middleOldOffset = prefix - 1;
  const middleNewOffset = prefix - 1;

  const bounded: RewriteDiff = {
    ops: [],
    truncated: contextOmitted || oldMiddle.length * newMiddle.length > REWRITE_DIFF_MAX_CELLS,
  };
  if (bounded.truncated && oldMiddle.length * newMiddle.length > REWRITE_DIFF_MAX_CELLS) {
    const coarse = coarseDiff(oldMiddle, newMiddle);
    bounded.ops.push(...coarse.ops);
  } else {
    const cells: Uint32Array = new Uint32Array((oldMiddle.length + 1) * (newMiddle.length + 1));
    const width = newMiddle.length + 1;
    for (let i = oldMiddle.length - 1; i >= 0; i -= 1) {
      for (let j = newMiddle.length - 1; j >= 0; j -= 1) {
        cells[i * width + j] =
          oldMiddle[i] === newMiddle[j]
            ? cells[(i + 1) * width + j + 1] + 1
            : Math.max(cells[(i + 1) * width + j], cells[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < oldMiddle.length && j < newMiddle.length) {
      if (oldMiddle[i] === newMiddle[j]) {
        bounded.ops.push({
          kind: "equal",
          old_line: middleOldOffset + i + 2,
          new_line: middleNewOffset + j + 2,
          text: oldMiddle[i],
        });
        i += 1;
        j += 1;
      } else if (cells[(i + 1) * width + j] >= cells[i * width + j + 1]) {
        bounded.ops.push({
          kind: "delete",
          old_line: middleOldOffset + i + 2,
          new_line: null,
          text: oldMiddle[i],
        });
        i += 1;
      } else {
        bounded.ops.push({
          kind: "insert",
          old_line: null,
          new_line: middleNewOffset + j + 2,
          text: newMiddle[j],
        });
        j += 1;
      }
    }
    while (i < oldMiddle.length) {
      bounded.ops.push({ kind: "delete", old_line: middleOldOffset + i + 2, new_line: null, text: oldMiddle[i] });
      i += 1;
    }
    while (j < newMiddle.length) {
      bounded.ops.push({ kind: "insert", old_line: null, new_line: middleNewOffset + j + 2, text: newMiddle[j] });
      j += 1;
    }
  }

  const ops: DocumentDiffOp[] = [];
  for (const [offset, text] of head.entries()) {
    ops.push({ kind: "equal", old_line: offset + 1, new_line: offset + 1, text });
  }
  ops.push(...bounded.ops);
  const tailOldStart = oldLines.length - tailKeep;
  const tailNewStart = newLines.length - tailKeep;
  for (const [offset, text] of tail.entries()) {
    ops.push({
      kind: "equal",
      old_line: tailOldStart + offset + 1,
      new_line: tailNewStart + offset + 1,
      text,
    });
  }

  oldLines = [];
  newLines = [];
  if (ops.length > REWRITE_DIFF_MAX_OPS) {
    return { ops: capCoarse(before, after), truncated: true };
  }
  return { ops, truncated: bounded.truncated };
}
