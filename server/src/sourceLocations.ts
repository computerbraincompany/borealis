/**
 * Structured extraction locators for inspectable source search (M14 stage 3).
 *
 * Extraction produces an ordered list of text segments (PDF pages, Markdown/
 * text/DOCX spans with an optional heading, and tabular preview lines with
 * known row indices). Ingestion chunks exactly the same normalized text as
 * before and records, per chunk, the bounded typed locators describing where
 * each chunk begins inside its original segments. The chunkers and mappers
 * here must reproduce `chunkText` byte-for-byte; a locator that cannot be
 * mapped is simply omitted, so a missing locator stays an honest
 * "location-unavailable" state rather than an inferred or fabricated anchor.
 *
 * Offset conventions (stable, documented, and test-pinned):
 * - `pdf_page`: `char_start`/`char_len` index the normalized extracted text
 *   of that one page (for OCR'd pages that text includes the
 *   `[Page N — OCR]` prefix that ingestion prepends), with the real 1-based
 *   PDF page number and an `ocr` flag.
 * - `text_span`: `char_start`/`char_len` index the normalized extracted
 *   document text; `heading` is recorded only when the extractor actually
 *   saw an ATX Markdown heading.
 * - `tabular_rows`: names the sheet/table and the inclusive 1-based data-row
 *   range only when preview extraction actually knows them.
 */

import { config } from "./config.js";

export const MAX_CHUNK_LOCATORS_PER_CHUNK = 8;
export const MAX_LOCATOR_HEADING_CHARS = 200;
export const MAX_LOCATOR_SHEET_CHARS = 120;

export interface PdfPageAnchor {
  readonly kind: "pdf_page";
  readonly page: number;
  readonly ocr: boolean;
}

export interface TextSpanAnchor {
  readonly kind: "text_span";
  readonly heading?: string;
}

export interface TabularRowsAnchor {
  readonly kind: "tabular_rows";
  readonly sheet?: string;
  readonly row_start?: number;
  readonly row_end?: number;
}

export type SegmentAnchor = PdfPageAnchor | TextSpanAnchor | TabularRowsAnchor;

export interface ExtractedSegment {
  readonly text: string;
  readonly anchor: SegmentAnchor;
}

export interface PdfPageLocator {
  readonly kind: "pdf_page";
  readonly page: number;
  readonly ocr: boolean;
  readonly char_start: number;
  readonly char_len: number;
}

export interface TextSpanLocator {
  readonly kind: "text_span";
  readonly char_start: number;
  readonly char_len: number;
  readonly heading?: string;
}

export interface TabularRowsLocator {
  readonly kind: "tabular_rows";
  readonly sheet?: string;
  readonly row_start?: number;
  readonly row_end?: number;
}

export type ChunkLocator = PdfPageLocator | TextSpanLocator | TabularRowsLocator;

export interface LocatedChunk {
  readonly content: string;
  readonly locators: readonly ChunkLocator[];
}

export interface NormalizedSegmentRange {
  readonly anchor: SegmentAnchor;
  /** Start offset within the normalized (collapsed, trimmed) document text. */
  readonly start: number;
  /** Exclusive end offset within the normalized document text. */
  readonly end: number;
}

function isWhitespaceCharacter(character: string): boolean {
  return /\s/.test(character);
}

/**
 * Collapse `text` exactly like `chunkText` (`replace(/\s+/g,' ')` plus trim)
 * while recording, for each raw offset in `boundaries`, the length of the
 * emitted normalized content strictly before it plus whether separator
 * whitespace was pending at that offset. Pending whitespace materializes as
 * exactly one space only when content follows, so a segment whose raw start
 * lands after pending whitespace has its normalized content at
 * `contentMark + 1`; a segment ending mid-run has its content end at the
 * content mark (trailing pending whitespace never materializes inside the
 * segment). These marks line the segment content ranges up with the exact
 * offsets `chunkText` slices.
 */
function collapseWithBoundaries(
  text: string,
  boundaries: readonly number[]
): { clean: string; marks: number[]; pending: boolean[] } {
  const marks = new Array<number>(boundaries.length).fill(0);
  const pending = new Array<boolean>(boundaries.length).fill(false);
  let ordered = true;
  for (let index = 1; index < boundaries.length; index += 1) {
    if (boundaries[index] < boundaries[index - 1]) ordered = false;
  }
  if (!ordered) throw new RangeError("locator boundaries must be non-decreasing");
  let out = "";
  let pendingSpace = false;
  let hasContent = false;
  let boundaryIndex = 0;
  for (let offset = 0; offset < text.length; offset += 1) {
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex] === offset) {
      marks[boundaryIndex] = out.length;
      pending[boundaryIndex] = pendingSpace;
      boundaryIndex += 1;
    }
    const character = text[offset];
    if (isWhitespaceCharacter(character)) {
      if (hasContent) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += character;
    hasContent = true;
  }
  while (boundaryIndex < boundaries.length) {
    marks[boundaryIndex] = out.length;
    pending[boundaryIndex] = pendingSpace;
    boundaryIndex += 1;
  }
  return { clean: out, marks, pending };
}

/**
 * Map ordered extraction segments onto normalized-text ranges. The raw
 * concatenation of `segments` with `separator` must equal `text` exactly —
 * that is the byte-compatibility contract with the text adapters — otherwise
 * mapping refuses (`null`) and callers keep the honest unlocated state.
 */
export function mapSegmentsToNormalized(
  text: string,
  segments: readonly ExtractedSegment[],
  separator: string
): { clean: string; ranges: readonly NormalizedSegmentRange[] } | null {
  if (!segments.length) return null;
  let joined = "";
  const rawOffsets: number[] = [];
  for (const segment of segments) {
    if (typeof segment.text !== "string" || !segment.anchor) return null;
    rawOffsets.push(joined.length, joined.length + segment.text.length);
    joined += segment.text;
    joined += separator;
  }
  joined = joined.slice(0, joined.length - separator.length);
  if (joined.length !== text.length || joined !== text) return null;
  const { clean, marks, pending } = collapseWithBoundaries(text, rawOffsets);
  const truncated = clean.slice(0, config.maxExtractedChars);
  const ranges: NormalizedSegmentRange[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const contentStart = (marks[index * 2] ?? 0) + (pending[index * 2] ? 1 : 0);
    const start = Math.min(contentStart, truncated.length);
    const end = Math.min(marks[index * 2 + 1] ?? 0, truncated.length);
    if (end <= start) continue;
    ranges.push(Object.freeze({ anchor: segments[index].anchor, start, end }));
  }
  return Object.freeze({ clean: truncated, ranges: Object.freeze(ranges) });
}

function boundedHeading(heading: string | undefined): string | undefined {
  if (typeof heading !== "string") return undefined;
  const trimmed = heading.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_LOCATOR_HEADING_CHARS ? trimmed.slice(0, MAX_LOCATOR_HEADING_CHARS) : trimmed;
}

function boundedSheet(sheet: string | undefined): string | undefined {
  if (typeof sheet !== "string") return undefined;
  const trimmed = sheet.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_LOCATOR_SHEET_CHARS ? trimmed.slice(0, MAX_LOCATOR_SHEET_CHARS) : trimmed;
}

/**
 * Intersect one chunk range with the normalized segment ranges and produce
 * the bounded typed locator list for that chunk. Consecutive tabular row
 * segments inside one chunk merge into one inclusive row range; at most
 * `MAX_CHUNK_LOCATORS_PER_CHUNK` entries are kept (the chunk's first locator
 * is always retained).
 */
export function locatorsForRange(
  ranges: readonly NormalizedSegmentRange[],
  start: number,
  end: number
): readonly ChunkLocator[] {
  const locators: ChunkLocator[] = [];
  let pendingRows: { sheet?: string; row_start: number; row_end: number } | undefined;
  let sawSheetOnly = false;
  const flushRows = () => {
    if (!pendingRows) return;
    locators.push(
      Object.freeze({
        kind: "tabular_rows",
        ...(pendingRows.sheet === undefined ? {} : { sheet: pendingRows.sheet }),
        row_start: pendingRows.row_start,
        row_end: pendingRows.row_end,
      })
    );
    pendingRows = undefined;
  };
  for (const range of ranges) {
    if (range.end <= start) continue;
    if (range.start >= end) break;
    const from = Math.max(range.start, start);
    const to = Math.min(range.end, end);
    const anchor = range.anchor;
    if (anchor.kind === "pdf_page") {
      flushRows();
      locators.push(
        Object.freeze({
          kind: "pdf_page",
          page: anchor.page,
          ocr: anchor.ocr,
          char_start: from - range.start,
          char_len: to - from,
        })
      );
      continue;
    }
    if (anchor.kind === "text_span") {
      flushRows();
      const heading = boundedHeading(anchor.heading);
      locators.push(
        Object.freeze({
          kind: "text_span",
          char_start: from,
          char_len: to - from,
          ...(heading === undefined ? {} : { heading }),
        })
      );
      continue;
    }
    const sheet = boundedSheet(anchor.sheet);
    if (
      typeof anchor.row_start === "number" &&
      typeof anchor.row_end === "number" &&
      anchor.row_start >= 1 &&
      anchor.row_end >= anchor.row_start
    ) {
      if (pendingRows && pendingRows.sheet === sheet && anchor.row_start === pendingRows.row_end + 1) {
        pendingRows = { sheet, row_start: pendingRows.row_start, row_end: anchor.row_end };
        continue;
      }
      flushRows();
      pendingRows = { sheet, row_start: anchor.row_start, row_end: anchor.row_end };
      continue;
    }
    // A sheet-level anchor without known rows (the preview header line) is
    // recorded once per chunk; it never asserts a row range.
    if (!sawSheetOnly) {
      flushRows();
      sawSheetOnly = true;
      locators.push(Object.freeze({ kind: "tabular_rows", ...(sheet === undefined ? {} : { sheet }) }));
    }
  }
  flushRows();
  return Object.freeze(locators.slice(0, MAX_CHUNK_LOCATORS_PER_CHUNK).map((locator) => Object.freeze(locator)));
}

/**
 * Chunk `text` byte-for-byte exactly like `chunkText(text, size, overlap)`
 * and attach each chunk's typed locators. When the segment mapping is not
 * usable (absent segments or a raw-concatenation mismatch), chunks are still
 * byte-identical and carry no locators.
 */
export function chunkTextWithLocators(
  text: string,
  segments: readonly ExtractedSegment[] | null,
  separator: string,
  size = 900,
  overlap = 120
): readonly LocatedChunk[] {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, config.maxExtractedChars);
  if (!clean) return Object.freeze([]);
  const mapping = segments ? mapSegmentsToNormalized(text, segments, separator) : null;
  const locatorsAt = (start: number, end: number): readonly ChunkLocator[] =>
    mapping ? locatorsForRange(mapping.ranges, start, end) : Object.freeze([]);
  const chunks: LocatedChunk[] = [];
  for (let i = 0; i < clean.length && chunks.length < config.maxIngestChunks; i += size - overlap) {
    const content = clean.slice(i, i + size);
    chunks.push(Object.freeze({ content, locators: locatorsAt(i, i + content.length) }));
    if (i + size >= clean.length) break;
  }
  return Object.freeze(chunks);
}

const LOCATOR_KINDS = new Set(["pdf_page", "text_span", "tabular_rows"]);

function finiteInteger(value: unknown, maximum: number): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) return null;
  return value;
}

/**
 * Validate a stored chunk-meta `loc` array defensively. Anything malformed
 * degrades to omission (never to a fabricated anchor), and the result is
 * capped again even if stored data grew past the bound.
 */
export function parseChunkLocators(meta: Record<string, unknown> | null | undefined): readonly ChunkLocator[] {
  const raw = meta?.loc;
  if (!Array.isArray(raw)) return Object.freeze([]);
  const locators: ChunkLocator[] = [];
  for (const entry of raw) {
    if (locators.length >= MAX_CHUNK_LOCATORS_PER_CHUNK) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    if (typeof kind !== "string" || !LOCATOR_KINDS.has(kind)) continue;
    const charStart = finiteInteger(record.char_start, Number.MAX_SAFE_INTEGER);
    const charLen = finiteInteger(record.char_len, Number.MAX_SAFE_INTEGER);
    if (kind === "pdf_page") {
      const page = finiteInteger(record.page, 1_000_000);
      if (page === null || page < 1 || charStart === null || charLen === null) continue;
      locators.push(
        Object.freeze({
          kind: "pdf_page",
          page,
          ocr: record.ocr === true,
          char_start: charStart,
          char_len: charLen,
        })
      );
      continue;
    }
    if (kind === "text_span") {
      if (charStart === null || charLen === null) continue;
      const heading = boundedHeading(typeof record.heading === "string" ? record.heading : undefined);
      locators.push(
        Object.freeze({
          kind: "text_span",
          char_start: charStart,
          char_len: charLen,
          ...(heading === undefined ? {} : { heading }),
        })
      );
      continue;
    }
    const rowStart = finiteInteger(record.row_start, Number.MAX_SAFE_INTEGER);
    const rowEnd = finiteInteger(record.row_end, Number.MAX_SAFE_INTEGER);
    const sheet = boundedSheet(typeof record.sheet === "string" ? record.sheet : undefined);
    const hasRows = rowStart !== null && rowEnd !== null && rowStart >= 1 && rowEnd >= rowStart;
    if (!hasRows && sheet === undefined) continue;
    locators.push(
      Object.freeze({
        kind: "tabular_rows",
        ...(sheet === undefined ? {} : { sheet }),
        ...(hasRows ? { row_start: rowStart, row_end: rowEnd } : {}),
      })
    );
  }
  return Object.freeze(locators);
}
