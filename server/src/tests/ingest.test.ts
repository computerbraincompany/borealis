import { describe, expect, it } from "vitest";
import {
  chunkText,
  datasetRegistrationForSource,
  isTabularSource,
  sanitizeDatasetName,
} from "../ingest.js";

describe("sanitizeDatasetName", () => {
  it("prefixes digit-leading bank-export names with a letter", () => {
    const name = sanitizeDatasetName("22-08-2026_Umsatzliste_Girokonto_DE33120300001054151210.csv");

    expect(name).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
  });

  it("keeps long names within the registry limit", () => {
    expect(sanitizeDatasetName(`${"a".repeat(200)}.csv`).length).toBeLessThanOrEqual(63);
  });

  it("falls back for empty names", () => {
    expect(sanitizeDatasetName("___.csv")).toBe("dataset");
    expect(sanitizeDatasetName("")).toBe("dataset");
  });

  it("preserves valid letter-leading names without a prefix", () => {
    expect(sanitizeDatasetName("Budget 2026.xlsx")).toBe("budget_2026");
  });
});

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
    const text = Array.from({ length: 35 }, (_, i) => String.fromCharCode(33 + i)).join("");
    const out = chunkText(text, 20, 5);
    expect(out).toEqual([text.slice(0, 20), text.slice(15, 35)]);
    // chunk[1] starts 15 chars in, so it shares its first 5 chars with chunk[0]'s tail
    expect(out[1].slice(0, 5)).toBe(out[0].slice(-5));
    expect(out[1]).not.toBe(out[0].slice(-5));
  });

  it("keeps a real tail longer than the overlap without duplicating a suffix", () => {
    const text = "x".repeat(41);
    const out = chunkText(text, 20, 5);

    expect(out).toHaveLength(3);
    expect(out.map((chunk) => chunk.length)).toEqual([20, 20, 11]);
    expect(out[2]).not.toBe(out[1].slice(-5));
  });
});

describe("tabular source registration", () => {
  it.each([
    ["events.json", "application/octet-stream"],
    ["events.bin", "application/json"],
    ["events.jsonl", "application/x-ndjson"],
    ["ledger.csv", "text/plain"],
  ])("classifies %s (%s) for scoped SQL", (filePath, mime) => {
    expect(isTabularSource(filePath, mime)).toBe(true);
  });

  it("keeps connector URL provenance while using the fetched local file", () => {
    expect(datasetRegistrationForSource({
      filePath: "/safe/cache/ledger.csv",
      displayName: "Finance ledger",
      connector: "connector-id",
      url: "https://example.invalid/private.csv?signature=secret",
    })).toEqual({
      location: "/safe/cache/ledger.csv",
      kind: "url",
      url: "https://example.invalid/private.csv?signature=secret",
      originalName: "Finance ledger",
    });
  });

  it("does not put an uploaded file's display name in the URL field", () => {
    expect(datasetRegistrationForSource({
      filePath: "/safe/uploads/ledger.csv",
      displayName: "Ledger.csv",
    })).toEqual({
      location: "/safe/uploads/ledger.csv",
      kind: "path",
      originalName: "Ledger.csv",
    });
  });
});
