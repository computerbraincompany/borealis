import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth";
import { config } from "./config.js";
import { LocalOcrError, LocalOcrUnavailableError, recognizeLocalPdfPages, type PdfOcrPage } from "./localPdfOcr.js";
const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;

const EXT_TEXT = new Set([".txt", ".md", ".markdown", ".text", ".log"]);
const EXT_TABULAR = new Set([".csv", ".tsv", ".xlsx", ".parquet", ".jsonl", ".json"]);
const MAX_PDF_PAGES = 500;
const MAX_DOCX_MEMBERS = 2_048;
const MAX_DOCX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_DOCX_MEMBER_BYTES = 50 * 1024 * 1024;
const MAX_DOCX_COMPRESSION_RATIO = 200;
const MIN_MEANINGFUL_PDF_PAGE_CHARACTERS = 8;
const MIN_DENSE_PDF_PAGE_CHARACTERS = 16;
const HIGH_CONFIDENCE_PDF_PAGE_CHARACTERS = 48;
const MIN_PDF_PAGE_WORDS = 3;
const MIN_PDF_CHARACTERS_PER_100K_POINTS = 4;
const MIN_PDF_TEXT_AREA_RATIO = 0.001;
const PDF_PAGE_MARGIN_FRACTION = 0.08;
const MAX_PDF_TEXT_LINE_BANDS = 64;

interface PdfPageTextMetrics {
  readonly pageArea: number;
  alphanumericCharacters: number;
  interiorAlphanumericCharacters: number;
  wordCount: number;
  textArea: number;
  readonly lineBands: Set<number>;
}

export interface PdfOcrOperation {
  (filePath: string, pages: readonly number[], signal?: AbortSignal): Promise<readonly PdfOcrPage[]>;
}
export function isTabularSource(filePath: string, mime: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  void mime;
  // The UUID-scoped stored filename has already passed the upload allowlist;
  // client-controlled MIME metadata must not change which parser receives it.
  return EXT_TABULAR.has(ext);
}

export function datasetRegistrationForSource(source: {
  sourceId?: string;
  filePath: string;
  displayName: string;
  url?: string;
  connector?: string;
  expectedFormat?: "csv" | "json";
}) {
  if (source.connector && source.url) {
    return {
      location: source.filePath,
      kind: "url" as const,
      url: source.url,
      originalName: source.displayName,
      ...(source.expectedFormat ? { expectedFormat: source.expectedFormat } : {}),
    };
  }
  return {
    location: source.filePath,
    kind: "path" as const,
    originalName: source.displayName,
    sourceId: source.sourceId,
  };
}

export function sanitizeDatasetName(filename: string): string {
  let base = path
    .basename(filename, path.extname(filename))
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (base && !/^[a-z]/.test(base)) base = `d_${base}`;
  return base.slice(0, 60) || "dataset";
}

export function chunkText(text: string, size = 900, overlap = 120): string[] {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, config.maxExtractedChars);
  if (!clean) return [];
  const chunks: string[] = [];
  for (let i = 0; i < clean.length && chunks.length < config.maxIngestChunks; i += size - overlap) {
    chunks.push(clean.slice(i, i + size));
    if (i + size >= clean.length) break;
  }
  return chunks;
}

/** Extract embedded text first and OCR only bounded pages without meaningful text. */
export async function extractPdfText(
  filePath: string,
  buffer: Buffer,
  recognize: PdfOcrOperation = recognizeLocalPdfPages,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  try {
    const pageTexts: string[] = [];
    const meaningfulPages: boolean[] = [];
    const emptyPages: number[] = [];
    let extractedCharacters = 0;
    for (
      let i = 1;
      i <= Math.min(doc.numPages, MAX_PDF_PAGES) && extractedCharacters < config.maxExtractedChars;
      i += 1
    ) {
      signal?.throwIfAborted();
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 });
        const pageWidth = positiveFinite(viewport.width);
        const pageHeight = positiveFinite(viewport.height);
        const metrics: PdfPageTextMetrics = {
          pageArea: Math.max(1, pageWidth * pageHeight),
          alphanumericCharacters: 0,
          interiorAlphanumericCharacters: 0,
          wordCount: 0,
          textArea: 0,
          lineBands: new Set(),
        };
        let pageText = "";
        const maxItems = Math.min(content.items.length, 100_000);
        for (
          let itemIndex = 0;
          itemIndex < maxItems && extractedCharacters + pageText.length < config.maxExtractedChars;
          itemIndex += 1
        ) {
          const item = content.items[itemIndex] as any;
          if (!("str" in item) || typeof item.str !== "string" || !item.str) continue;
          const remaining = config.maxExtractedChars - extractedCharacters - pageText.length;
          const fragment = item.str.slice(0, remaining);
          pageText += `${fragment} `;
          accumulatePdfTextMetrics(metrics, item, fragment, pageWidth, pageHeight);
        }
        pageTexts.push(pageText);
        extractedCharacters += pageText.length + 2;
        const meaningful = meaningfulPdfPageText(pageText, metrics);
        meaningfulPages.push(meaningful);
        if (!meaningful && emptyPages.length < config.ocrMaxPages) emptyPages.push(i);
      } finally {
        page.cleanup();
      }
    }

    if (emptyPages.length) {
      try {
        const recognized = await recognize(filePath, emptyPages, signal);
        signal?.throwIfAborted();
        const byPage = new Map(recognized.map((entry) => [entry.page, entry.text]));
        for (const pageNumber of emptyPages) {
          const text = byPage.get(pageNumber);
          if (text) pageTexts[pageNumber - 1] = `[Page ${pageNumber} — OCR]\n${text}`;
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (
          (error instanceof LocalOcrUnavailableError || error instanceof LocalOcrError) &&
          meaningfulPages.some(Boolean)
        ) {
          // Mixed/text PDFs remain useful when the optional local capability is absent.
        } else {
          throw error;
        }
      }
    }
    signal?.throwIfAborted();
    return pageTexts.join("\n\n").slice(0, config.maxExtractedChars);
  } finally {
    await doc.destroy();
  }
}

function positiveFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function accumulatePdfTextMetrics(
  metrics: PdfPageTextMetrics,
  item: Record<string, unknown>,
  text: string,
  pageWidth: number,
  pageHeight: number
): void {
  const characters = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (!characters) return;
  metrics.alphanumericCharacters += characters;
  metrics.wordCount += text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;

  const transform = Array.isArray(item.transform) ? item.transform : [];
  const x = positiveFinite(transform[4]);
  const y = positiveFinite(transform[5]);
  const width = Math.min(pageWidth, positiveFinite(item.width));
  const height = Math.min(pageHeight, positiveFinite(item.height));
  metrics.textArea += Math.min(metrics.pageArea, width * height);

  if (
    y >= pageHeight * PDF_PAGE_MARGIN_FRACTION &&
    y <= pageHeight * (1 - PDF_PAGE_MARGIN_FRACTION) &&
    x <= pageWidth
  ) {
    metrics.interiorAlphanumericCharacters += characters;
  }
  if (metrics.lineBands.size < MAX_PDF_TEXT_LINE_BANDS) {
    const bandHeight = Math.max(4, height, pageHeight / 100);
    metrics.lineBands.add(Math.round(y / bandHeight));
  }
}

function meaningfulPdfPageText(value: string, metrics: PdfPageTextMetrics): boolean {
  const characters = metrics.alphanumericCharacters;
  if (characters < MIN_MEANINGFUL_PDF_PAGE_CHARACTERS || !value.trim()) return false;

  // Sparse text layers often contain only a footer, page label, or watermark.
  // Require actual interior text plus density relative to the PDF page instead
  // of letting a handful of glyphs suppress OCR for the imaged page beneath.
  const requiredInterior = Math.min(12, Math.ceil(characters / 2));
  if (metrics.interiorAlphanumericCharacters < requiredInterior) return false;
  if (characters >= HIGH_CONFIDENCE_PDF_PAGE_CHARACTERS && metrics.lineBands.size >= 2) return true;

  const charactersPer100kPoints = characters / (metrics.pageArea / 100_000);
  const textAreaRatio = Math.min(metrics.textArea, metrics.pageArea) / metrics.pageArea;
  return (
    characters >= MIN_DENSE_PDF_PAGE_CHARACTERS &&
    metrics.wordCount >= MIN_PDF_PAGE_WORDS &&
    charactersPer100kPoints >= MIN_PDF_CHARACTERS_PER_100K_POINTS &&
    textAreaRatio >= MIN_PDF_TEXT_AREA_RATIO
  );
}

async function extractDocx(buffer: Buffer): Promise<string> {
  preflightDocxArchive(buffer);
  const res = await mammoth.extractRawText({ buffer });
  return res.value.slice(0, config.maxExtractedChars);
}

/**
 * Inspect only the ZIP central directory before Mammoth expands a DOCX.
 * Encrypted/ZIP64 archives and excessive members, expansion, or compression
 * ratios fail before the XML parser sees attacker-controlled output.
 */
export function preflightDocxArchive(buffer: Buffer): void {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  const searchStart = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > buffer.length) throw new Error("invalid DOCX archive");
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entries !== entriesOnDisk ||
    entries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    entries < 1 ||
    entries > MAX_DOCX_MEMBERS ||
    centralOffset + centralSize > eocd
  ) {
    throw new Error("DOCX archive exceeds safe limits");
  }

  let cursor = centralOffset;
  let expandedBytes = 0;
  let sawContentTypes = false;
  let sawDocument = false;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== centralSignature) {
      throw new Error("invalid DOCX archive");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const expandedSize = buffer.readUInt32LE(cursor + 24);
    const filenameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + filenameLength + extraLength + commentLength;
    if (
      next > buffer.length ||
      compressedSize === 0xffffffff ||
      expandedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      (flags & 0x1) !== 0 ||
      ![0, 8].includes(compressionMethod) ||
      expandedSize > MAX_DOCX_MEMBER_BYTES ||
      (compressedSize === 0 ? expandedSize > 0 : expandedSize / compressedSize > MAX_DOCX_COMPRESSION_RATIO)
    ) {
      throw new Error("DOCX archive exceeds safe limits");
    }
    expandedBytes += expandedSize;
    if (expandedBytes > MAX_DOCX_EXPANDED_BYTES) throw new Error("DOCX archive exceeds safe limits");
    const filename = buffer.subarray(cursor + 46, cursor + 46 + filenameLength).toString("utf8");
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== localSignature) {
      throw new Error("invalid DOCX archive");
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localCompressionMethod = buffer.readUInt16LE(localOffset + 8);
    const localFilenameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localFilenameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    const localFilename = buffer.subarray(localOffset + 30, localOffset + 30 + localFilenameLength).toString("utf8");
    if (
      (localFlags & 0x1) !== 0 ||
      localCompressionMethod !== compressionMethod ||
      localFilename !== filename ||
      dataStart > centralOffset ||
      dataEnd > centralOffset
    ) {
      throw new Error("invalid DOCX archive");
    }
    let actualExpandedSize: number;
    try {
      if (compressionMethod === 0) {
        actualExpandedSize = compressedSize;
      } else if (compressedSize === 0 && expandedSize === 0) {
        actualExpandedSize = 0;
      } else {
        actualExpandedSize = inflateRawSync(buffer.subarray(dataStart, dataEnd), {
          maxOutputLength:
            Math.min(expandedSize, MAX_DOCX_MEMBER_BYTES, MAX_DOCX_EXPANDED_BYTES - (expandedBytes - expandedSize)) + 1,
        }).length;
      }
    } catch {
      throw new Error("DOCX archive exceeds safe limits");
    }
    if (actualExpandedSize !== expandedSize) throw new Error("invalid DOCX archive");
    if (filename === "[Content_Types].xml") sawContentTypes = true;
    if (filename === "word/document.xml") sawDocument = true;
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize || !sawContentTypes || !sawDocument) {
    throw new Error("invalid DOCX archive");
  }
}

export async function extractText(filePath: string, mime: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".doc") {
    throw new Error("legacy .doc files are not supported; upload .docx instead");
  }
  if (EXT_TEXT.has(ext)) {
    const text = await fs.readFile(filePath, "utf8");
    signal?.throwIfAborted();
    return text.slice(0, config.maxExtractedChars);
  }
  if (ext === ".pdf" || mime.includes("pdf")) {
    const buffer = await fs.readFile(filePath);
    signal?.throwIfAborted();
    return extractPdfText(filePath, buffer, recognizeLocalPdfPages, signal);
  }
  if (ext === ".docx" || mime.includes("officedocument.wordprocessingml")) {
    const buffer = await fs.readFile(filePath);
    signal?.throwIfAborted();
    const text = await extractDocx(buffer);
    signal?.throwIfAborted();
    return text;
  }
  throw new Error("file format is not supported");
}

export function datasetPreviewText(preview: {
  columns?: unknown;
  rows?: unknown;
  total_row_count?: unknown;
  returned_row_count?: unknown;
  truncated?: unknown;
}): string {
  const columns = Array.isArray(preview.columns) ? preview.columns.map((value) => String(value).slice(0, 200)) : [];
  const rows = Array.isArray(preview.rows) ? preview.rows.slice(0, 40) : [];
  const lines = rows.map((row) =>
    Array.isArray(row)
      ? row
          .slice(0, columns.length)
          .map((value) => String(value ?? "").slice(0, 500))
          .join("\t")
      : ""
  );
  const rowCount = Number.isFinite(Number(preview.total_row_count))
    ? Math.max(0, Math.trunc(Number(preview.total_row_count)))
    : rows.length;
  return `Columns: ${columns.join(", ")}\nRows: ${rowCount}${preview.truncated ? " (preview truncated)" : ""}\n${lines.join("\n")}`;
}
