import { describe, expect, it } from "vitest";

import { buildCitations, extractCitationMarkers } from "../citations.js";
import type { RetrievedEvidence } from "../tools.js";

const evidence: RetrievedEvidence[] = [
  {
    source_id: "11111111-1111-4111-8111-111111111111",
    chunk_id: "41",
    source: "Annual Report.pdf",
    excerpt: "Revenue grew",
    score: 0.9,
  },
  {
    source_id: "22222222-2222-4222-8222-222222222222",
    chunk_id: "42",
    source: "Ledger.csv",
    excerpt: "Food spend rose",
    score: 0.8,
  },
  {
    source_id: "33333333-3333-4333-8333-333333333333",
    chunk_id: "43",
    source: "Meeting Notes.pdf",
    excerpt: "Follow-up actions",
    score: 0.7,
  },
];

describe("extractCitationMarkers", () => {
  it("returns distinct markers in ascending order", () => {
    expect(extractCitationMarkers("A claim [2], then [1], then [2] again.")).toEqual([1, 2]);
  });

  it("parses one and two digit markers and keeps unresolved zero", () => {
    expect(extractCitationMarkers("[9] lead [12] trail [99]")).toEqual([9, 12, 99]);
    expect(extractCitationMarkers("[0] is parsed but never resolvable")).toEqual([0]);
  });

  it("ignores brackets that are not one or two bare digits", () => {
    expect(extractCitationMarkers("[abc] [] [1x] [1.2] x[1]y [123]")).toEqual([1]);
  });

  it("returns empty for text without markers", () => {
    expect(extractCitationMarkers("No citations here.")).toEqual([]);
  });
});

describe("buildCitations", () => {
  it("maps valid markers to their 1-based evidence entries", () => {
    expect(buildCitations("Revenue grew [1] while food spend rose [3].", evidence)).toEqual([
      { n: 1, source_id: evidence[0].source_id, chunk_id: "41", source: "Annual Report.pdf" },
      { n: 3, source_id: evidence[2].source_id, chunk_id: "43", source: "Meeting Notes.pdf" },
    ]);
  });

  it("drops out-of-range markers and deduplicates repeats", () => {
    expect(buildCitations("[0] [2] [2] [4] then [2] again", evidence)).toEqual([
      { n: 2, source_id: evidence[1].source_id, chunk_id: "42", source: "Ledger.csv" },
    ]);
  });

  it("returns empty without evidence or without markers", () => {
    expect(buildCitations("an answer that cites [1]", [])).toEqual([]);
    expect(buildCitations("an answer without citations", evidence)).toEqual([]);
  });

  it("records at most eight citations", () => {
    const wide = Array.from({ length: 12 }, (_, index) => ({
      source_id: "11111111-1111-4111-8111-111111111111",
      chunk_id: String(index),
      source: "Wide.pdf",
      excerpt: "passage",
      score: 1,
    }));
    const text = Array.from({ length: 12 }, (_, index) => `[${index + 1}]`).join(" ");

    expect(buildCitations(text, wide).map((citation) => citation.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
