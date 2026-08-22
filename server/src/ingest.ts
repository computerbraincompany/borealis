import fs from "node:fs/promises";
import path from "node:path";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { config } from "./config.js";
import { q } from "./db.js";
import { embed } from "./llm.js";
import { py } from "./pythonClient.js";

GlobalWorkerOptions.workerSrc = "";

const EXT_TEXT = new Set([".txt", ".md", ".markdown", ".text", ".log"]);
const EXT_TABULAR = new Set([".csv", ".tsv", ".xlsx", ".xls", ".parquet", ".jsonl", ".json"]);
const EXT_DOC = new Set([".pdf", ".docx", ".doc"]);

export function chunkText(text: string, size = 900, overlap = 120): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += size - overlap) {
    chunks.push(clean.slice(i, i + size));
  }
  return chunks;
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items
      .map((it: any) => ("str" in it ? it.str : ""))
      .join(" ") + "\n\n";
  }
  return text;
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const res = await mammoth.extractRawText({ buffer });
  return res.value;
}

function extractXlsxText(buffer: Buffer): string {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const parts: string[] = [];
  for (const sheet of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: "" });
    if (rows.length) parts.push(`Sheet: ${sheet}\n` + rows.slice(0, 40).map((r) => (r as any[]).join("\t")).join("\n"));
  }
  return parts.join("\n\n");
}

export async function extractText(filePath: string, mime: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (EXT_TEXT.has(ext)) return fs.readFile(filePath, "utf8");
  if (ext === ".pdf" || mime.includes("pdf")) return extractPdf(await fs.readFile(filePath));
  if ([".docx", ".doc"].includes(ext) || mime.includes("word")) return extractDocx(await fs.readFile(filePath));
  if (EXT_TABULAR.has(ext) || mime.includes("csv") || mime.includes("excel") || mime.includes("spreadsheet"))
    return extractXlsxText(await fs.readFile(filePath));
  // fallback: try binary-to-text
  return (await fs.readFile(filePath, "utf8")).slice(0, 20000);
}

/**
 * Ingest an uploaded file (already stored at filePath) for an account.
 * Tabular files register with the Python service for SQL; every file also
 * produces RAG chunks (schema + sample + any natural text) embedded and
 * stored in pgvector so the agent can chat about the data.
 */
export async function ingestSource(opts: {
  accountId: string;
  sourceId: string;
  name: string;
  filePath: string;
  mime: string;
  kind: string;
  displayName: string;
  url?: string;
  connector?: string;
}) {
  const { accountId, sourceId, name, filePath, mime, kind, displayName, url, connector } = opts;
  await q(`UPDATE sources SET status='index' WHERE id=$1`, [sourceId]);
  const ext = path.extname(filePath).toLowerCase();
  const isTabular = EXT_TABULAR.has(ext) || mime.includes("csv") || mime.includes("spreadsheet") || mime.includes("excel");
  try {
    if (isTabular) {
      await py.registerDataset(accountId, name, filePath, "path", displayName, url);
    }
    let text = "";
    try {
      text = await extractText(filePath, mime);
    } catch (e) {
      console.warn("text extraction failed", e);
    }
    const srcdoc = text || "No readable text extracted.";
    const meta: any = { source: displayName, kind };
    if (url) meta.url = url;
    if (connector) meta.connector = connector;

    const chunks = chunkText(srcdoc, 800, 110);
    const embeddings = await embed(chunks);
    const rows = chunks.map((c, i) => ({
      content: c,
      embedding: `[${embeddings[i].join(",")}]`,
    }));
    if (rows.length) {
      await q(
        `INSERT INTO chunks (account_id, source_id, source_name, content, embedding, meta)
         SELECT $1, $2, $3, unnest($4::text[]), unnest($5::vector[]), $6::jsonb`,
        [accountId, sourceId, displayName, rows.map((r) => r.content), rows.map((r) => r.embedding), JSON.stringify(meta)]
      );
    }
    await q(`UPDATE sources SET status='ready', size_bytes=$2 WHERE id=$1`, [sourceId, await fs.stat(filePath).then((s) => s.size)]);
  } catch (e) {
    console.error("ingest failed", e);
    await q(`UPDATE sources SET status='error' WHERE id=$1`, [sourceId]);
    throw e;
  }
}

/**
 * Re-register every ready tabular source with the Python service.
 *
 * Python keeps an in-memory DuckDB registry; calling this at boot makes the
 * service durable across restarts (the sources table is the source of truth).
 */
export async function restoreDatasets(): Promise<void> {
  const sources = await q(
    `SELECT account_id, name, file_path, display_name FROM sources WHERE kind='tabular' AND status='ready' AND file_path IS NOT NULL`
  );
  for (const s of sources) {
    try {
      await py.registerDataset(s.account_id, s.name, s.file_path, "path", s.display_name);
    } catch (e) {
      console.warn("dataset restore failed:", s.name, String(e));
    }
  }
  if (sources.length) console.log(`restored ${sources.length} dataset(s) in python service`);
}
