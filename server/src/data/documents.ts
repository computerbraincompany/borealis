/**
 * Frozen-revision publication compiler (M13 stage 4).
 *
 * One frozen document revision compiles here into all four export formats —
 * self-contained HTML, static PDF, a Markdown ZIP bundle, and DOCX — from the
 * SAME immutable tree so every artifact agrees byte-for-byte on content.
 *
 * HTML and PDF go through the existing bounded renderer pipeline (the shared
 * `NormalizedReport` contract extended only with the shared versioned
 * appendix/status fields, and the existing Playwright/Electron backends,
 * whose deny-by-default `about:blank` + bounded canonical PNG policy is
 * untouched). The Markdown bundle contains a real `.md` file, relative
 * canonical chart PNG assets, and a provenance manifest — never remote
 * references, absolute filesystem paths, or executable macros. DOCX uses the
 * pinned workspace `docx` writer with native paragraphs, headings, tables,
 * citations/appendix, and embedded canonical chart PNGs — no macros, no
 * linked images, no external document fetching.
 *
 * Every format failure is explicit and typed (`DocumentFormatError` with the
 * failed format), so the caller records a retryable publication failure and
 * the draft plus the previous publication stay intact.
 */

import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import {
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  Table as DocxTable,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

import {
  buildPublicationAppendix,
  buildPublicationValidity,
  compileDocumentTree,
  isVerifiedEvidenceRef,
  type DocumentTree,
} from "../documentTypes.js";
import type { CanonicalChartSpec } from "./charts.js";
import { renderChartPng, renderReportPdf } from "./playwrightRender.js";
import { buildHtml, type NormalizedReport, type ReportCell } from "./reports.js";

export const DOCUMENT_EXPORT_FORMATS = ["html", "pdf", "markdown", "docx"] as const;
export type DocumentExportFormat = (typeof DOCUMENT_EXPORT_FORMATS)[number];

/** Output ceilings from the M13 export contract. */
export const DOCUMENT_MARKDOWN_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_DOCX_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;

/** Fixed artifact file names inside the exact publication directory. */
export const DOCUMENT_ARTIFACT_FILENAMES = Object.freeze({
  html: "document.html",
  pdf: "document.pdf",
  markdown: "document.zip",
  docx: "document.docx",
} as const);

export type DocumentCompileErrorCode =
  | "PUBLICATION_HTML_FAILED"
  | "PUBLICATION_PDF_FAILED"
  | "PUBLICATION_MARKDOWN_FAILED"
  | "PUBLICATION_DOCX_FAILED"
  | "PUBLICATION_RENDER_FAILED";

/** Explicit per-format failure; the publication stays retryable. */
export class DocumentFormatError extends Error {
  readonly code: DocumentCompileErrorCode;
  readonly format: DocumentExportFormat | null;

  constructor(code: DocumentCompileErrorCode, format: DocumentExportFormat | null, cause?: unknown) {
    super(`document publication ${format ?? "render"} failed`, { cause });
    this.name = "DocumentFormatError";
    this.code = code;
    this.format = format;
  }
}

// ---------------------------------------------------------------------------
// Deterministic ZIP container (no third-party zip writer)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/**
 * Builds a deterministic ZIP archive: fixed 1980-01-01 timestamps, entry
 * order exactly as given, UTF-8 names, and no comments. Members are
 * deflated unless stored would be smaller.
 */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    if (entry.name.startsWith("/") || entry.name.includes("\\") || entry.name.split("/").includes("..")) {
      throw new DocumentFormatError("PUBLICATION_MARKDOWN_FAILED", "markdown");
    }
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const centralStart = offset;
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuffer, end]);
}

/**
 * Reads every member of a ZIP archive (used to validate magic-byte-verified
 * containers and assert bundle contents in tests). Throws on malformed input
 * so a corrupt archive can never pass a validation gate.
 */
export function readZipMembers(value: Buffer): Map<string, Buffer> {
  if (!hasZipMagic(value)) throw new Error("not a ZIP archive");
  let eocd = -1;
  const scanFrom = Math.max(0, value.length - 66_565);
  for (let i = value.length - 22; i >= scanFrom; i -= 1) {
    if (value.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP end-of-central-directory missing");
  const count = value.readUInt16LE(eocd + 10);
  const centralSize = value.readUInt32LE(eocd + 12);
  const centralOffset = value.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not accepted");
  }
  const members = new Map<string, Buffer>();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (value.readUInt32LE(cursor) !== 0x02014b50) throw new Error("ZIP central directory is malformed");
    const method = value.readUInt16LE(cursor + 10);
    const crc = value.readUInt32LE(cursor + 16);
    const compressedSize = value.readUInt32LE(cursor + 20);
    const uncompressedSize = value.readUInt32LE(cursor + 24);
    const nameLength = value.readUInt16LE(cursor + 28);
    const extraLength = value.readUInt16LE(cursor + 30);
    const commentLength = value.readUInt16LE(cursor + 32);
    const localOffset = value.readUInt32LE(cursor + 42);
    const name = value.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;

    if (value.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("ZIP local header is malformed");
    const localNameLength = value.readUInt16LE(localOffset + 26);
    const localExtraLength = value.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = value.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = Buffer.from(inflateRawSync(raw));
    else throw new Error(`unsupported ZIP compression method ${method}`);
    if (data.length !== uncompressedSize || crc32(data) !== crc) throw new Error("ZIP member failed CRC check");
    members.set(name, data);
  }
  return members;
}

// ---------------------------------------------------------------------------
// Magic-byte validation
// ---------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function hasPngMagic(value: Buffer): boolean {
  return value.length >= 8 && value.subarray(0, 8).equals(PNG_MAGIC);
}

export function hasPdfMagic(value: Buffer): boolean {
  return value.length >= 5 && value.subarray(0, 5).equals(Buffer.from("%PDF-"));
}

export function hasZipMagic(value: Buffer): boolean {
  return value.length >= 4 && value.readUInt32LE(0) === 0x04034b50;
}

/** OOXML proof: a ZIP container carrying the required Wordprocessing parts. */
export function isOoxmlDocument(value: Buffer): boolean {
  if (!hasZipMagic(value)) return false;
  try {
    const members = readZipMembers(value);
    return members.has("[Content_Types].xml") && members.has("word/document.xml");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Renderer seam (defaults to the shipped Playwright/Electron dispatch)
// ---------------------------------------------------------------------------

export interface DocumentRenderers {
  renderChartPng(spec: CanonicalChartSpec, signal?: AbortSignal): Promise<Buffer>;
  renderReportPdf(report: NormalizedReport, signal?: AbortSignal): Promise<Buffer>;
}

export const defaultDocumentRenderers: DocumentRenderers = Object.freeze({
  renderChartPng: (spec: CanonicalChartSpec, signal?: AbortSignal) => renderChartPng(spec, signal),
  renderReportPdf: (report: NormalizedReport, signal?: AbortSignal) => renderReportPdf(report, signal),
});

// ---------------------------------------------------------------------------
// Compile: frozen tree -> the shared report contract (with appendix/status)
// ---------------------------------------------------------------------------

export interface CompiledPublication {
  readonly report: NormalizedReport;
  readonly validity: string;
  readonly appendix: string;
}

/**
 * Compiles one frozen revision into the shared report contract, charged
 * against the existing renderer bounds by `compileDocumentTree` plus the
 * separately bounded appendix/status fields. The account id is injected so
 * `renderReportPdf` (which requires it) consumes the exact same payload.
 */
export function compilePublicationReport(
  tree: DocumentTree,
  accountId: string,
  generatedAt: string
): CompiledPublication {
  try {
    compileDocumentTree(tree, generatedAt);
  } catch (error) {
    throw new DocumentFormatError("PUBLICATION_RENDER_FAILED", null, error);
  }
  const validity = buildPublicationValidity(tree);
  const appendix = buildPublicationAppendix(tree);
  const report = {
    account_id: accountId,
    title: tree.title,
    subtitle: tree.subtitle,
    generated_at: generatedAt,
    sections: tree.sections.map((section) => ({ heading: section.heading, markdown: section.markdown })),
    charts: tree.charts.map((chart) => ({ id: chart.id, spec: chart.spec })),
    tables: tree.tables.map((table) => ({
      columns: [...table.columns],
      rows: table.rows.map((row) => [...row]),
    })),
    appendix,
    status: validity,
  };
  return Object.freeze({ report: report as NormalizedReport, validity, appendix });
}

// ---------------------------------------------------------------------------
// Markdown bundle
// ---------------------------------------------------------------------------

const CHART_TOKEN_GLOBAL_RE = /:::[A-Za-z0-9_-]+:([A-Za-z0-9_.-]+):::|!\[[^\]]*\]\(chart:([^)]*)\)/g;

function chartAssetName(index: number): string {
  return `assets/chart-${index + 1}.png`;
}

function markdownTableCell(cell: ReportCell): string {
  if (cell === null) return "";
  return String(cell).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function tableProvenanceLine(table: DocumentTree["tables"][number]): string | null {
  if (!table.analysis) return null;
  const completeness = table.analysis.completeness.complete
    ? "complete"
    : `incomplete: ${table.analysis.completeness.reasons.join("; ") || "unknown"}`;
  return (
    `*Analysis ${table.analysis.analysis_id} revision ${table.analysis.analysis_revision} · ` +
    `result ${table.analysis.result_id} · ${completeness}*`
  );
}

/**
 * Builds the bundle's `document.md`: real Markdown with relative chart asset
 * references, GFM tables with provenance captions, and the deterministic
 * evidence appendix. No remote references and no absolute paths.
 */
export function buildDocumentMarkdown(
  tree: DocumentTree,
  validity: string,
  generatedAt: string,
  referencedCharts: ReadonlySet<string>
): string {
  const chartByIndex = new Map<string, string>();
  tree.charts.forEach((chart, index) => chartByIndex.set(chart.id, chartAssetName(index)));
  // Chart tokens are replaced (or stripped) BEFORE any other handling; the
  // same grammar `cleanMarkdown` strips is consumed here so known charts keep
  // their inline position as relative assets.
  const replaceTokens = (markdown: string): string =>
    markdown.replace(CHART_TOKEN_GLOBAL_RE, (_match, first: string | undefined, second: string | undefined) => {
      const id = first ?? second ?? "";
      const asset = chartByIndex.get(id);
      if (!asset) return "";
      const spec = tree.charts.find((chart) => chart.id === id)?.spec;
      return `![${(spec?.title || "Chart").replace(/[[\]]/g, "")}](${asset})`;
    });

  const blocks: string[] = [`# ${tree.title}`];
  if (tree.subtitle) blocks.push(tree.subtitle);
  blocks.push(`**${validity}**`);
  if (generatedAt) blocks.push(`Generated ${generatedAt}`);
  for (const section of tree.sections) {
    const heading = section.heading ? `## ${section.heading}` : "";
    const body = replaceTokens(section.markdown);
    blocks.push([heading, body].filter(Boolean).join("\n\n"));
  }
  // Charts never referenced by a section token appear after the prose, in
  // canonical order — the same layout the HTML/PDF compile produces.
  const unreferenced = tree.charts.filter((chart) => !referencedCharts.has(chart.id));
  if (unreferenced.length) {
    blocks.push(
      unreferenced
        .map((chart) => {
          const index = tree.charts.indexOf(chart);
          return `![${(chart.spec.title || "Chart").replace(/[[\]]/g, "")}](${chartAssetName(index)})`;
        })
        .join("\n\n")
    );
  }
  tree.tables.forEach((table, index) => {
    const header = `| ${table.columns.map(markdownTableCell).join(" | ")} |`;
    const divider = `| ${table.columns.map(() => "---").join(" | ")} |`;
    const rows = table.rows.map((row) => `| ${row.map(markdownTableCell).join(" | ")} |`);
    const caption = `**Table ${index + 1}**`;
    const provenance = tableProvenanceLine(table);
    blocks.push([caption, [header, divider, ...rows].join("\n"), provenance].filter(Boolean).join("\n\n"));
  });
  const appendix = buildPublicationAppendix(tree);
  if (appendix) blocks.push(appendix);
  return `${blocks.filter((block) => block.trim() !== "").join("\n\n")}\n`;
}

function manifestFor(tree: DocumentTree, validity: string, generatedAt: string, meta: PublicationCompileMeta): string {
  return `${JSON.stringify(
    {
      contract: "borealis-document-export/1",
      generated_at: generatedAt,
      document_id: meta.documentId,
      document_title: tree.title,
      revision_id: meta.revisionId,
      revision: meta.revision,
      publication_version: meta.version,
      validity,
      verified: tree.verified,
      charts: tree.charts.map((chart, index) => ({
        number: index + 1,
        file: chartAssetName(index),
        id: chart.id,
        title: chart.spec.title,
      })),
      tables: tree.tables.map((table, index) => ({
        number: index + 1,
        columns: [...table.columns],
        rows: table.rows.length,
        provenance: table.analysis
          ? {
              analysis_id: table.analysis.analysis_id,
              analysis_revision: table.analysis.analysis_revision,
              result_id: table.analysis.result_id,
              complete: table.analysis.completeness.complete,
              completeness_reasons: [...table.analysis.completeness.reasons],
            }
          : null,
      })),
      evidence: tree.evidence.map((ref, index) => ({
        number: index + 1,
        id: ref.id,
        source_id: ref.source_id,
        source_name: ref.source_name,
        generation: ref.generation,
        content_identity: ref.content_identity,
        locator: ref.locator,
        verified: isVerifiedEvidenceRef(ref),
      })),
      assets: ["document.md", "manifest.json", ...tree.charts.map((_, index) => chartAssetName(index))],
    },
    null,
    2
  )}\n`;
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

const CHART_IMAGE_WIDTH = 600;

function chartImageRun(png: Buffer): ImageRun {
  return new ImageRun({
    type: "png",
    data: png,
    transformation: { width: CHART_IMAGE_WIDTH, height: Math.round(CHART_IMAGE_WIDTH * (728 / 1330)) },
    altText: { title: "Chart", description: "Canonical chart rendered by Borealis", name: "chart" },
  });
}

interface InlineToken {
  text: string;
  bold?: boolean;
  italics?: boolean;
  code?: boolean;
}

/** Bounded inline Markdown tokenizer: **bold**, *em*, `code`; text survives. */
function inlineTokens(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    if ((match.index ?? 0) > cursor) tokens.push({ text: line.slice(cursor, match.index) });
    if (match[2] !== undefined) tokens.push({ text: match[2], bold: true });
    else if (match[3] !== undefined) tokens.push({ text: match[3], italics: true });
    else if (match[4] !== undefined) tokens.push({ text: match[4], code: true });
    cursor = (match.index ?? 0) + match[0].length;
  }
  if (cursor < line.length) tokens.push({ text: line.slice(cursor) });
  return tokens.length ? tokens : [{ text: line }];
}

function paragraphFromLine(line: string): Paragraph {
  return new Paragraph({
    children: inlineTokens(line).map(
      (token) =>
        new TextRun({
          text: token.text,
          bold: token.bold,
          italics: token.italics,
          ...(token.code ? { font: "Consolas" } : {}),
        })
    ),
  });
}

function docxTableFor(columns: readonly string[], rows: readonly (readonly ReportCell[])[]): DocxTable {
  const cell = (text: string, header: boolean) =>
    new TableCell({
      shading: header ? { type: ShadingType.CLEAR, fill: "EEF2FF" } : undefined,
      children: [new Paragraph({ children: [new TextRun({ text, bold: header })] })],
    });
  const headerRow = new TableRow({
    tableHeader: true,
    children: columns.map((column) => cell(String(column ?? ""), true)),
  });
  const bodyRows = rows.map(
    (row) =>
      new TableRow({
        children: row.map((entry) => cell(entry === null ? "" : String(entry), false)),
      })
  );
  return new DocxTable({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  });
}

/**
 * Renders one section's Markdown into native DOCX paragraphs/headings (with
 * inline chart images where chart tokens appeared). Unknown markup degrades
 * to plain paragraph text — the text itself is always preserved exactly.
 */
function sectionChildren(
  markdown: string,
  chartPngs: ReadonlyMap<string, Buffer>,
  chartByIndex: ReadonlyMap<string, { assetIndex: number }>
): (Paragraph | DocxTable)[] {
  const children: (Paragraph | DocxTable)[] = [];
  let inFence = false;
  let tableLines: string[] = [];
  const flushTable = () => {
    if (!tableLines.length) return;
    const rows = tableLines.map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cellValue) => cellValue.trim())
    );
    tableLines = [];
    const [header, ...rest] = rows;
    if (!header) return;
    const body = rest.filter((row) => !row.every((cellValue) => /^:?-{2,}:?$/.test(cellValue)));
    children.push(
      docxTableFor(
        header.map((cellValue) => cellValue),
        body.map((row) => row.map((cellValue): ReportCell => cellValue))
      )
    );
  };
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.replace(
      CHART_TOKEN_GLOBAL_RE,
      (_match, first: string | undefined, second: string | undefined) => {
        const id = first ?? second ?? "";
        const png = chartPngs.get(id);
        if (png && chartByIndex.has(id)) {
          children.push(new Paragraph({ children: [chartImageRun(png)] }));
        }
        return "";
      }
    );
    if (/^\s*```/.test(line)) {
      flushTable();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: rawLine, font: "Consolas" })],
          shading: { type: ShadingType.CLEAR, fill: "F1F5F9" },
        })
      );
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      tableLines.push(line);
      continue;
    }
    flushTable();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, Math.max(3, heading[1].length + 2));
      const headings: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
        3: HeadingLevel.HEADING_3,
        4: HeadingLevel.HEADING_4,
        5: HeadingLevel.HEADING_5,
        6: HeadingLevel.HEADING_6,
      };
      children.push(new Paragraph({ text: heading[2], heading: headings[level] }));
      continue;
    }
    if (/^\s*[>\s]*[-*+]\s+/.test(line)) {
      children.push(
        new Paragraph({
          children: inlineTokens(line.replace(/^\s*[>\s]*[-*+]\s+/, "")).map(
            (token) => new TextRun({ text: token.text, bold: token.bold, italics: token.italics })
          ),
          bullet: { level: 0 },
        })
      );
      continue;
    }
    if (!line.trim()) continue;
    children.push(paragraphFromLine(line));
  }
  flushTable();
  return children;
}

export interface DocxBuiltOptions {
  readonly tree: DocumentTree;
  readonly validity: string;
  readonly generatedAt: string;
  readonly chartPngs: ReadonlyMap<string, Buffer>;
  readonly referencedCharts: ReadonlySet<string>;
}

/** Native-structure DOCX: headings, paragraphs, tables, embedded PNGs, appendix. */
export async function buildDocumentDocx(options: DocxBuiltOptions): Promise<Buffer> {
  const { tree, validity, generatedAt, chartPngs, referencedCharts } = options;
  const chartByIndex = new Map<string, { assetIndex: number }>();
  tree.charts.forEach((chart, index) => chartByIndex.set(chart.id, { assetIndex: index }));
  const children: (Paragraph | DocxTable)[] = [new Paragraph({ text: tree.title, heading: HeadingLevel.HEADING_1 })];
  if (tree.subtitle) children.push(new Paragraph({ children: [new TextRun({ text: tree.subtitle, italics: true })] }));
  children.push(
    new Paragraph({ children: [new TextRun({ text: validity, bold: true })] }),
    ...(generatedAt ? [new Paragraph({ children: [new TextRun({ text: `Generated ${generatedAt}` })] })] : [])
  );
  for (const section of tree.sections) {
    if (section.heading) children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_2 }));
    children.push(...sectionChildren(section.markdown, chartPngs, chartByIndex));
  }
  for (const chart of tree.charts) {
    if (referencedCharts.has(chart.id)) continue;
    const png = chartPngs.get(chart.id);
    if (png) children.push(new Paragraph({ children: [chartImageRun(png)] }));
  }
  tree.tables.forEach((table, index) => {
    children.push(new Paragraph({ children: [new TextRun({ text: `Table ${index + 1}`, bold: true })] }));
    children.push(docxTableFor(table.columns, table.rows));
    const provenance = tableProvenanceLine(table);
    if (provenance) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: provenance.replace(/^\*|\*$/g, ""), italics: true })] })
      );
    }
  });
  if (tree.evidence.length) {
    children.push(new Paragraph({ text: "Evidence", heading: HeadingLevel.HEADING_2 }));
    tree.evidence.forEach((ref, index) => {
      const parts = [`[${index + 1}] ${ref.source_name}`];
      if (ref.locator) parts.push(`· ${ref.locator}`);
      parts.push(isVerifiedEvidenceRef(ref) ? "· provenance verified" : "· provenance unknown");
      if (typeof ref.generation === "number") parts.push(`· generation ${ref.generation}`);
      children.push(new Paragraph({ children: [new TextRun({ text: parts.join(" "), bold: true })] }));
      children.push(new Paragraph({ children: [new TextRun({ text: ref.excerpt })] }));
    });
  }
  const file = new Document({
    creator: "Borealis",
    title: tree.title,
    description: validity,
    sections: [{ children }],
  });
  return await Packer.toBuffer(file);
}

// ---------------------------------------------------------------------------
// Full publication compile (writes the four artifacts)
// ---------------------------------------------------------------------------

export interface PublicationCompileMeta {
  readonly documentId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly version: number;
}

export interface PublicationCompileResult {
  readonly htmlPath: string;
  readonly pdfPath: string;
  readonly markdownPath: string;
  readonly docxPath: string;
  readonly html: Buffer;
  readonly pdf: Buffer;
  readonly markdownZip: Buffer;
  readonly docx: Buffer;
  readonly validity: string;
}

export interface PublicationCompileInput {
  readonly accountId: string;
  readonly directory: string;
  readonly tree: DocumentTree;
  readonly meta: PublicationCompileMeta;
  readonly generatedAt: string;
  readonly renderers?: DocumentRenderers;
  readonly signal?: AbortSignal;
  /** Test seam: called after validation, before any file is written. */
  readonly beforeWrite?: (
    result: Omit<PublicationCompileResult, "htmlPath" | "pdfPath" | "markdownPath" | "docxPath">
  ) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("operation cancelled");
    error.name = "AbortError";
    throw error;
  }
}

/**
 * Compiles the frozen revision through the existing renderer pipeline and
 * writes exactly four artifacts into the caller-provided exact directory:
 * `document.html`, `document.pdf`, `document.zip` (Markdown bundle), and
 * `document.docx`. Every artifact is magic-byte validated before the write;
 * any per-format failure aborts with a typed `DocumentFormatError` so the
 * publication is recorded retryable and nothing is half-promoted.
 */
export async function compileDocumentPublication(input: PublicationCompileInput): Promise<PublicationCompileResult> {
  const { accountId, directory, tree, meta, generatedAt, signal } = input;
  const renderers = input.renderers ?? defaultDocumentRenderers;
  const compiled = compilePublicationReport(tree, accountId, generatedAt);
  const { report, validity } = compiled;

  // Canonical chart PNGs (rendered once, shared by HTML/Markdown/DOCX).
  const chartPngs = new Map<string, Buffer>();
  try {
    for (const chart of tree.charts) {
      throwIfAborted(signal);
      const png = await renderers.renderChartPng(chart.spec, signal);
      if (!hasPngMagic(png)) throw new DocumentFormatError("PUBLICATION_RENDER_FAILED", null);
      chartPngs.set(chart.id, png);
    }
  } catch (error) {
    if (error instanceof DocumentFormatError) throw error;
    throw new DocumentFormatError("PUBLICATION_RENDER_FAILED", null, error);
  }

  // Self-contained static HTML with embedded PNGs.
  let html: Buffer;
  try {
    throwIfAborted(signal);
    const chartImages = new Map<string, string>();
    for (const [id, png] of chartPngs) chartImages.set(id, png.toString("base64"));
    html = Buffer.from(buildHtml(report, { static: true, chartImages }), "utf8");
    if (html.length === 0) throw new Error("empty html");
  } catch (error) {
    if (error instanceof DocumentFormatError) throw error;
    throw new DocumentFormatError("PUBLICATION_HTML_FAILED", "html", error);
  }

  // Static PDF through the existing bounded renderer backend.
  let pdf: Buffer;
  try {
    throwIfAborted(signal);
    pdf = await renderers.renderReportPdf(report, signal);
    if (!hasPdfMagic(pdf)) throw new DocumentFormatError("PUBLICATION_PDF_FAILED", "pdf");
  } catch (error) {
    if (error instanceof DocumentFormatError) throw error;
    throw new DocumentFormatError("PUBLICATION_PDF_FAILED", "pdf", error);
  }

  const referencedCharts = new Set<string>();
  for (const section of tree.sections) {
    for (const match of section.markdown.matchAll(CHART_TOKEN_GLOBAL_RE)) {
      const id = match[1] ?? match[2] ?? "";
      if (chartPngs.has(id)) referencedCharts.add(id);
    }
  }

  // Markdown ZIP bundle.
  let markdownZip: Buffer;
  try {
    const markdown = buildDocumentMarkdown(tree, validity, generatedAt, referencedCharts);
    const manifest = manifestFor(tree, validity, generatedAt, meta);
    const entries: ZipEntry[] = [
      { name: "document.md", data: Buffer.from(markdown, "utf8") },
      { name: "manifest.json", data: Buffer.from(manifest, "utf8") },
    ];
    tree.charts.forEach((chart, index) => {
      const png = chartPngs.get(chart.id);
      if (png) entries.push({ name: chartAssetName(index), data: png });
    });
    markdownZip = buildZip(entries);
    if (!hasZipMagic(markdownZip) || markdownZip.length > DOCUMENT_MARKDOWN_OUTPUT_MAX_BYTES) {
      throw new DocumentFormatError("PUBLICATION_MARKDOWN_FAILED", "markdown");
    }
    const members = readZipMembers(markdownZip);
    if (!members.has("document.md") || !members.has("manifest.json")) {
      throw new DocumentFormatError("PUBLICATION_MARKDOWN_FAILED", "markdown");
    }
  } catch (error) {
    if (error instanceof DocumentFormatError) throw error;
    throw new DocumentFormatError("PUBLICATION_MARKDOWN_FAILED", "markdown", error);
  }

  // DOCX.
  let docx: Buffer;
  try {
    docx = await buildDocumentDocx({ tree, validity, generatedAt, chartPngs, referencedCharts });
    if (!isOoxmlDocument(docx) || docx.length > DOCUMENT_DOCX_OUTPUT_MAX_BYTES) {
      throw new DocumentFormatError("PUBLICATION_DOCX_FAILED", "docx");
    }
  } catch (error) {
    if (error instanceof DocumentFormatError) throw error;
    throw new DocumentFormatError("PUBLICATION_DOCX_FAILED", "docx", error);
  }

  const result = {
    html,
    pdf,
    markdownZip,
    docx,
    validity,
    htmlPath: path.join(directory, DOCUMENT_ARTIFACT_FILENAMES.html),
    pdfPath: path.join(directory, DOCUMENT_ARTIFACT_FILENAMES.pdf),
    markdownPath: path.join(directory, DOCUMENT_ARTIFACT_FILENAMES.markdown),
    docxPath: path.join(directory, DOCUMENT_ARTIFACT_FILENAMES.docx),
  };
  input.beforeWrite?.(result);
  return result;
}

export type { NormalizedReport };
