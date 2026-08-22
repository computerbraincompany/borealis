import { describe, expect, it } from "vitest";
import { chunkText } from "../ingest.js";

describe("chunkText", () => {
  it("returns [] for empty or whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t  ")).toEqual([]);
  });

  it("returns a single collapsed chunk for short input", () => {
    const out = chunkText("hello   world", 900, 120);
    expect(out).toEqual(["hello world"]);
  });

  it("splits long input into chunks no longer than size", () => {
    const text = "a".repeat(2000);
    const out = chunkText(text, 900, 120);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.length).toBeLessThanOrEqual(900);
    }
    // first chunk starts at 0; the final chunk ends exactly at the text boundary
    expect(out[0]).toBe("a".repeat(900));
    expect(out[out.length - 1]).toBe("a".repeat(2000 - (out.length - 1) * 780));
  });

  it("applies overlap between consecutive chunks", () => {
    // size=20, overlap=5 -> step of 15
    const text = "x".repeat(35);
    const out = chunkText(text, 20, 5);
    expect(out).toHaveLength(3);
    // chunk[1] starts 15 chars in, so it shares its first 5 chars with chunk[0]'s tail
    expect(out[1].slice(0, 5)).toBe(out[0].slice(-5));
    expect(out[2].slice(0, 5)).toBe(out[1].slice(-5));
  });
});
