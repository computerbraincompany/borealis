import type { RetrievedEvidence } from "./tools.js";

/** Resolved citation metadata persisted in assistant message meta. */
export interface CitationRef {
  n: number; // 1-based evidence index
  source_id: string;
  chunk_id: string;
  source: string; // sanitized source label
}

// The marker grammar admits at most the distinct values 0..99, so the scan
// bound is the grammar itself, not a byte budget over model output.
const MAX_DISTINCT_MARKERS = 100;
const MAX_CITATIONS = 8;
const CITATION_MARKER_PATTERN = /\[(\d{1,2})\]/g;

/** Distinct bracketed citation markers in ascending order, including unresolved values such as 0. */
export function extractCitationMarkers(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(CITATION_MARKER_PATTERN)) {
    found.add(Number(match[1]));
    if (found.size >= MAX_DISTINCT_MARKERS) break;
  }
  return [...found].sort((left, right) => left - right);
}

/**
 * Map citation markers onto the run's own sanitized evidence. Markers outside
 * `1..evidence.length` (including 0) stay plain text; the array is the single
 * source of truth and at most eight entries are recorded.
 */
export function buildCitations(text: string, evidence: readonly RetrievedEvidence[]): CitationRef[] {
  if (!evidence.length) return [];
  const citations: CitationRef[] = [];
  for (const n of extractCitationMarkers(text)) {
    if (citations.length >= MAX_CITATIONS) break;
    if (n < 1 || n > evidence.length) continue;
    const entry = evidence[n - 1];
    citations.push({ n, source_id: entry.source_id, chunk_id: entry.chunk_id, source: entry.source });
  }
  return citations;
}
