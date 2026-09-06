import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { sha256Hex, splitsSurrogatePair } from "./sha256";

describe("sha256Hex", () => {
  it.each([
    "",
    "abc",
    "the quick brown fox jumps over the lazy dog",
    "Stable spend [1] and note [9].",
    "unicode: émojis 🦊 → arrows ↑↓ and CJK 漢字",
    "line one\nline two\ntrailing newline\n",
  ])("matches node:crypto for %j", (text) => {
    expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });

  it("is lowercase hex and 64 characters", () => {
    const digest = sha256Hex("probe");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("splitsSurrogatePair", () => {
  const text = "a🦊b";
  it("flags the inside of a surrogate pair only", () => {
    expect(splitsSurrogatePair(text, 1)).toBe(false);
    expect(splitsSurrogatePair(text, 2)).toBe(true);
    expect(splitsSurrogatePair(text, 3)).toBe(false);
    expect(splitsSurrogatePair(text, 0)).toBe(false);
    expect(splitsSurrogatePair(text, text.length)).toBe(false);
  });
});
