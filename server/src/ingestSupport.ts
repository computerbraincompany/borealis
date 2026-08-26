import fs from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth";
import { config } from "./config.js";
GlobalWorkerOptions.workerSrc = "";

const EXT_TEXT = new Set([".txt", ".md", ".markdown", ".text", ".log"]);
const EXT_TABULAR = new Set([".csv", ".tsv", ".xlsx", ".parquet", ".jsonl", ".json"]);
const MAX_PDF_PAGES = 500;
const MAX_DOCX_MEMBERS = 2_048;
const MAX_DOCX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_DOCX_MEMBER_BYTES = 50 * 1024 * 1024;
const MAX_DOCX_COMPRESSION_RATIO = 200;
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

async function extractPdf(buffer: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  try {
    let text = "";
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PDF_PAGES) && text.length < config.maxExtractedChars; i += 1) {
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent();
        const maxItems = Math.min(content.items.length, 100_000);
        for (let itemIndex = 0; itemIndex < maxItems && text.length < config.maxExtractedChars; itemIndex += 1) {
          const item = content.items[itemIndex] as any;
          if (!("str" in item) || typeof item.str !== "string" || !item.str) continue;
          const remaining = config.maxExtractedChars - text.length;
          text += `${item.str.slice(0, remaining)} `;
        }
        if (text.length < config.maxExtractedChars) text += "\n\n";
      } finally {
        page.cleanup();
      }
    }
    return text.slice(0, config.maxExtractedChars);
  } finally {
    await doc.destroy();
  }
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

export async function extractText(filePath: string, mime: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".doc") {
    throw new Error("legacy .doc files are not supported; upload .docx instead");
  }
  if (EXT_TEXT.has(ext)) return (await fs.readFile(filePath, "utf8")).slice(0, config.maxExtractedChars);
  if (ext === ".pdf" || mime.includes("pdf")) return extractPdf(await fs.readFile(filePath));
  if (ext === ".docx" || mime.includes("officedocument.wordprocessingml")) {
    return extractDocx(await fs.readFile(filePath));
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
