import fs from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth";
import { config } from "./config.js";
import { pool, q } from "./db.js";
import { embed } from "./llm.js";
import { py } from "./pythonClient.js";
import { PythonServiceError } from "./pythonClient.js";
import { appLog } from "./appLogger.js";
import { runWithRequestContext } from "./requestContext.js";
import { resolveSourceArtifact } from "./storageArtifacts.js";

GlobalWorkerOptions.workerSrc = "";

const EXT_TEXT = new Set([".txt", ".md", ".markdown", ".text", ".log"]);
const EXT_TABULAR = new Set([".csv", ".tsv", ".xlsx", ".parquet", ".jsonl", ".json"]);
const EMBED_BATCH_SIZE = 16;
const STAGING_BATCH_SIZE = 64;
const WORKER_CONCURRENCY = 2;
const PREPARE_WORKER_CONCURRENCY = 2;
const LEASE_TIMEOUT_MINUTES = 10;
const LEASE_HEARTBEAT_MS = 30_000;
const MAX_JOB_ATTEMPTS = 3;
const MAX_PDF_PAGES = 500;
const MAX_DOCX_MEMBERS = 2_048;
const MAX_DOCX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_DOCX_MEMBER_BYTES = 50 * 1024 * 1024;
const MAX_DOCX_COMPRESSION_RATIO = 200;

export interface IngestSourceOptions {
  accountId: string;
  sourceId: string;
  name: string;
  filePath: string;
  mime: string;
  kind: string;
  displayName: string;
  url?: string;
  connector?: string;
  generation?: number;
  leaseToken?: string;
  meta?: unknown;
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

function datasetPreviewText(preview: {
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

/** Register, extract within strict budgets, embed incrementally, then atomically promote chunks. */
export async function ingestSource(opts: IngestSourceOptions): Promise<void> {
  const { accountId, sourceId, name, filePath, mime, kind, displayName, url, connector } = opts;
  const generation = opts.generation ?? 0;
  const leaseToken = opts.leaseToken;
  const sourceMeta = parseSourceMeta(opts.meta);
  const refreshVersion =
    connector && typeof sourceMeta.connector_refresh_version === "string"
      ? sourceMeta.connector_refresh_version
      : undefined;
  const candidateLocation =
    refreshVersion && typeof sourceMeta.connector_candidate_location === "string"
      ? sourceMeta.connector_candidate_location
      : undefined;
  const activationPreviousLocation =
    refreshVersion && typeof sourceMeta.connector_activation_previous_location === "string"
      ? sourceMeta.connector_activation_previous_location
      : null;
  const expectedFormat: "csv" | "json" = mime.toLowerCase().includes("json") ? "json" : "csv";
  const requestedIngestFilePath = candidateLocation ?? filePath;
  let refreshActivationStarted = false;
  await assertIngestLease(sourceId, generation, leaseToken);
  await q(
    `UPDATE sources SET status=CASE WHEN status='ready' THEN 'ready' ELSE 'index' END
     WHERE id=$1 AND account_id=$2
       AND ($3::int=0 OR EXISTS (
         SELECT 1 FROM ingestion_jobs j WHERE j.source_id=$1 AND j.generation=$3
           AND j.status='running' AND ($4::uuid IS NULL OR j.lease_token=$4)
       ))`,
    [sourceId, accountId, generation, leaseToken ?? null]
  );
  try {
    const resolvedArtifact = await resolveSourceArtifact({
      accountId,
      sourceId,
      name,
      filePath: requestedIngestFilePath,
      connector,
    });
    if (!resolvedArtifact) throw new Error("source artifact is unavailable");
    const ingestFilePath = resolvedArtifact;
    const tabular = isTabularSource(ingestFilePath, mime);
    let text: string;
    if (refreshVersion && candidateLocation && connector && url) {
      text = datasetPreviewText(await py.extractPreparedDataset(accountId, name, refreshVersion, expectedFormat, 40));
    } else if (tabular) {
      const registration = await py.registerDataset(
        accountId,
        name,
        datasetRegistrationForSource({
          sourceId,
          filePath: ingestFilePath,
          displayName,
          url,
          connector,
          expectedFormat: connector ? expectedFormat : undefined,
        })
      );
      const pythonPreviousLocation =
        connector &&
        typeof registration?.previous_location === "string" &&
        registration.previous_location !== ingestFilePath
          ? registration.previous_location
          : undefined;
      if (pythonPreviousLocation) {
        await assertIngestLease(sourceId, generation, leaseToken);
        await q(
          `UPDATE sources SET meta=(meta - 'connector_previous_location') ||
             jsonb_build_object('connector_previous_location',$3::text)
           WHERE id=$1 AND account_id=$2
             AND ($4::int=0 OR EXISTS (
               SELECT 1 FROM ingestion_jobs j WHERE j.source_id=$1 AND j.generation=$4
                 AND j.status='running' AND ($5::uuid IS NULL OR j.lease_token=$5)
             ))`,
          [sourceId, accountId, pythonPreviousLocation, generation, leaseToken ?? null]
        );
      }
      text = datasetPreviewText(await py.extractDataset(accountId, name, 40));
    } else {
      text = await extractText(ingestFilePath, mime);
    }
    if (!text.trim()) throw new Error("no readable text extracted");

    const chunks = chunkText(text, 800, 110);
    if (!chunks.length) throw new Error("no readable text extracted");
    await assertIngestLease(sourceId, generation, leaseToken);
    const meta: Record<string, string> = { source: displayName, kind };
    if (url) meta.url = url;
    if (connector) meta.connector = connector;
    await q(`DELETE FROM ingestion_chunk_staging WHERE source_id=$1 AND generation=$2`, [sourceId, generation]);

    let sequence = 0;
    for (let start = 0; start < chunks.length; start += EMBED_BATCH_SIZE) {
      await assertIngestLease(sourceId, generation, leaseToken);
      const batch = chunks.slice(start, start + EMBED_BATCH_SIZE);
      const embeddings = await embed(batch);
      if (
        embeddings.length !== batch.length ||
        embeddings.some(
          (value) =>
            !Array.isArray(value) ||
            value.length !== config.embeddingDim ||
            value.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
        )
      ) {
        throw new Error("embedding response shape mismatch");
      }
      for (let offset = 0; offset < batch.length; offset += STAGING_BATCH_SIZE) {
        await assertIngestLease(sourceId, generation, leaseToken);
        const contents = batch.slice(offset, offset + STAGING_BATCH_SIZE);
        const vectors = embeddings.slice(offset, offset + STAGING_BATCH_SIZE).map((value) => `[${value.join(",")}]`);
        await q(
          `INSERT INTO ingestion_chunk_staging
             (source_id, generation, seq, account_id, source_name, content, embedding, meta)
           SELECT $1, $2, unnest($3::int[]), $4, $5, unnest($6::text[]), unnest($7::vector[]), $8::jsonb`,
          [
            sourceId,
            generation,
            contents.map(() => sequence++),
            accountId,
            displayName,
            contents,
            vectors,
            JSON.stringify(meta),
          ]
        );
      }
    }

    const sizeBytes = await fs.stat(ingestFilePath).then((stat) => stat.size);
    await assertIngestLease(sourceId, generation, leaseToken);
    if (refreshVersion && candidateLocation && connector && url) {
      refreshActivationStarted = true;
      const activated = await py.activateDatasetRefresh(
        accountId,
        name,
        refreshVersion,
        url,
        displayName,
        expectedFormat,
        activationPreviousLocation
      );
      if (activated?.version !== refreshVersion || activated?.location !== candidateLocation) {
        throw new Error("connector refresh activation mismatch");
      }
      await assertIngestLease(sourceId, generation, leaseToken);
    }
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      if (generation !== 0) {
        const lockedJob = await client.query(
          `SELECT source_id FROM ingestion_jobs
           WHERE source_id=$1 AND generation=$2 AND status='running'
             AND ($3::uuid IS NULL OR lease_token=$3)
           FOR UPDATE`,
          [sourceId, generation, leaseToken ?? null]
        );
        if (!lockedJob.rows.length) throw new Error("source ingestion superseded");
      }
      const lockedSource = await client.query(
        `SELECT id FROM sources
         WHERE id=$1 AND account_id=$2
         FOR UPDATE`,
        [sourceId, accountId]
      );
      if (!lockedSource.rows.length) throw new Error("source ingestion superseded");
      await client.query(`DELETE FROM chunks WHERE source_id=$1 AND account_id=$2`, [sourceId, accountId]);
      await client.query(
        `INSERT INTO chunks (account_id, source_id, source_name, content, embedding, meta)
         SELECT account_id, source_id, source_name, content, embedding, meta
         FROM ingestion_chunk_staging WHERE source_id=$1 AND generation=$2 ORDER BY seq`,
        [sourceId, generation]
      );
      if (connector) {
        await client.query(
          `UPDATE connectors SET sync_status='idle', sync_error=NULL, last_sync=now()
           WHERE id=$1 AND account_id=$2`,
          [connector, accountId]
        );
      }
      await client.query(`DELETE FROM ingestion_chunk_staging WHERE source_id=$1 AND generation=$2`, [
        sourceId,
        generation,
      ]);
      await client.query(
        `UPDATE sources
         SET status='ready', size_bytes=$3,
             file_path=CASE WHEN $4::text IS NULL THEN file_path ELSE $4::text END,
             meta=meta - 'error' - 'connector_refresh_version' - 'connector_candidate_location' -
                  'connector_activation_previous_location'
         WHERE id=$1 AND account_id=$2`,
        [sourceId, accountId, sizeBytes, refreshVersion ? ingestFilePath : null]
      );
      if (generation !== 0) {
        const completed = await client.query(
          `UPDATE ingestion_jobs
           SET status='done', leased_at=NULL, lease_token=NULL, last_error=NULL, updated_at=now()
           WHERE source_id=$1 AND generation=$2 AND status='running'
             AND ($3::uuid IS NULL OR lease_token=$3)
           RETURNING source_id`,
          [sourceId, generation, leaseToken ?? null]
        );
        if (!completed.rows.length) throw new Error("source ingestion superseded");
      }
      await client.query("COMMIT");
      inTransaction = false;
      if (connector)
        await cleanupPromotedConnectorCache({ id: sourceId, account_id: accountId, connector }).catch(() => {});
    } catch (error) {
      if (inTransaction) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    await q(`DELETE FROM ingestion_chunk_staging WHERE source_id=$1 AND generation=$2`, [sourceId, generation]).catch(
      () => {}
    );
    if (refreshVersion) {
      if (refreshActivationStarted) {
        const activatedError = new Error("connector refresh activated; durable promotion must retry");
        activatedError.name = "ConnectorRefreshActivatedError";
        throw activatedError;
      }
      throw error;
    }
    const publicDetail = ingestErrorCode(error);
    await q(
      `UPDATE sources
       SET status=CASE WHEN sources.connector IS NOT NULL THEN 'error'
                       WHEN EXISTS (SELECT 1 FROM chunks c WHERE c.source_id=sources.id) THEN 'ready'
                       ELSE 'error' END,
           meta=meta || jsonb_build_object('error',$3::text)
       WHERE id=$1 AND account_id=$2
         AND ($4::int=0 OR EXISTS (
           SELECT 1 FROM ingestion_jobs j WHERE j.source_id=$1 AND j.generation=$4
             AND j.status='running' AND ($5::uuid IS NULL OR j.lease_token=$5)
         ))`,
      [sourceId, accountId, publicDetail, generation, leaseToken ?? null]
    );
    if (connector) {
      await q(
        `UPDATE connectors SET sync_status='error', sync_error='Connector indexing failed.'
         WHERE id=$1 AND account_id=$2
           AND ($3::int=0 OR EXISTS (
             SELECT 1 FROM ingestion_jobs j
             WHERE j.source_id=$4 AND j.generation=$3 AND j.status='running'
               AND ($5::uuid IS NULL OR j.lease_token=$5)
           ))`,
        [connector, accountId, generation, sourceId, leaseToken ?? null]
      ).catch(() => {});
    }
    // Never drop a Python identity by account/name here. A source can be
    // deleted and the same table name recreated while this worker is winding
    // down; a name-only delete would remove the replacement. Connector cache
    // identities are retired later through exact-location CAS cleanup.
    throw error;
  }
}

async function assertIngestLease(sourceId: string, generation: number, leaseToken?: string): Promise<void> {
  if (generation === 0) return;
  const rows = await q(
    `SELECT 1 FROM ingestion_jobs
     WHERE source_id=$1 AND generation=$2 AND status='running'
       AND ($3::uuid IS NULL OR lease_token=$3)`,
    [sourceId, generation, leaseToken ?? null]
  );
  if (!rows.length) throw new Error("source ingestion superseded");
}

function ingestErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("no readable text")) return "No readable text could be extracted.";
  if (message.includes("not supported")) return "This file format is not supported.";
  if (message.includes("embedding")) return "Embedding failed.";
  return "Ingestion failed. Retry after checking the service logs.";
}

let workerPump: Promise<void> | undefined;
let connectorPreparePump: Promise<void> | undefined;
const activeSourceJobs = new Set<string>();

export async function enqueueIngestion(accountId: string, sourceId: string): Promise<number> {
  const client = await pool.connect();
  try {
    const generation = await reserveIngestionJob(client, accountId, sourceId);
    scheduleIngestionPump();
    return generation;
  } finally {
    client.release();
  }
}

export async function reserveIngestionJob(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  accountId: string,
  sourceId: string
): Promise<number> {
  const result = await client.query(
    `INSERT INTO ingestion_jobs (source_id, account_id, generation, status, attempts, available_at, updated_at)
     VALUES ($1,$2,1,'pending',0,now(),now())
     ON CONFLICT (source_id) DO UPDATE
       SET generation=ingestion_jobs.generation+1, status='pending', attempts=0,
           available_at=now(), leased_at=NULL, lease_token=NULL, last_error=NULL, updated_at=now()
     RETURNING generation`,
    [sourceId, accountId]
  );
  const generation = Number(result.rows[0]?.generation ?? 1);
  // A new generation supersedes every partially persisted predecessor. Keep
  // this in the caller's transaction so a crash cannot strand large staging
  // vectors while publishing the replacement job.
  await client.query(`DELETE FROM ingestion_chunk_staging WHERE source_id=$1 AND generation<$2`, [
    sourceId,
    generation,
  ]);
  return generation;
}

export async function reserveDatasetCacheCleanup(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  accountId: string,
  name: string,
  locations: readonly string[]
): Promise<void> {
  const unique = [...new Set(locations.filter((location) => typeof location === "string" && location))];
  if (!unique.length) return;
  await client.query(
    `INSERT INTO dataset_cache_cleanup_jobs (account_id, name, location)
     SELECT $1,$2,unnest($3::text[])
     ON CONFLICT (account_id,name,location) DO UPDATE SET updated_at=now()`,
    [accountId, name, unique]
  );
}

export async function processDatasetCacheCleanup(accountId?: string, name?: string): Promise<number> {
  const jobs = await q(
    `SELECT account_id, name, location FROM dataset_cache_cleanup_jobs
     WHERE ($1::uuid IS NULL OR account_id=$1) AND ($2::text IS NULL OR name=$2)
     ORDER BY updated_at LIMIT 20`,
    [accountId ?? null, name ?? null]
  );
  let completed = 0;
  for (const job of jobs) {
    try {
      // Compare-and-drop only this deleted version. A deferred retry must not
      // remove a newer source that reused the same account/table identity.
      await py.deactivateDatasetLocation(job.account_id, job.name, job.location);
      await py.cleanupDatasetCache(job.account_id, job.name, job.location);
      await q(`DELETE FROM dataset_cache_cleanup_jobs WHERE account_id=$1 AND name=$2 AND location=$3`, [
        job.account_id,
        job.name,
        job.location,
      ]);
      completed += 1;
    } catch {
      await q(
        `UPDATE dataset_cache_cleanup_jobs SET attempts=attempts+1, updated_at=now()
         WHERE account_id=$1 AND name=$2 AND location=$3`,
        [job.account_id, job.name, job.location]
      ).catch(() => {});
    }
  }
  return completed;
}

function scheduleIngestionPump(): void {
  if (workerPump) return;
  workerPump = Promise.resolve()
    .then(async () => {
      while (true) {
        const outcomes = await Promise.all(Array.from({ length: WORKER_CONCURRENCY }, () => processOneJob()));
        if (!outcomes.some(Boolean)) break;
      }
    })
    .catch(() => {
      appLog.warn({ error_code: "INGESTION_PUMP_FAILED" }, "ingestion worker pump failed");
    })
    .finally(() => {
      workerPump = undefined;
    });
}

/** Wake the durable workers after another module atomically reserves a job. */
export function wakeIngestionWorkers(): void {
  scheduleIngestionPump();
}

/** Resume durable connector downloads without delaying HTTP server startup. */
export function wakeConnectorPrepareWorkers(): void {
  if (connectorPreparePump) return;
  connectorPreparePump = Promise.resolve()
    .then(async () => {
      while (true) {
        const outcomes = await Promise.all(
          Array.from({ length: PREPARE_WORKER_CONCURRENCY }, () => processOnePreparingConnectorRefresh())
        );
        if (!outcomes.some(Boolean)) break;
      }
    })
    .catch(() => {
      appLog.warn({ error_code: "CONNECTOR_PREPARE_PUMP_FAILED" }, "connector prepare pump failed");
    })
    .finally(() => {
      connectorPreparePump = undefined;
    });
}

export async function processOneJob(runIngest: typeof ingestSource = ingestSource): Promise<boolean> {
  const [job] = await q(
    `WITH candidate AS (
       SELECT source_id FROM ingestion_jobs
       WHERE status='pending' AND available_at<=now()
       ORDER BY updated_at, source_id
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE ingestion_jobs j
       SET status='running', attempts=attempts+1, leased_at=now(), lease_token=gen_random_uuid(), updated_at=now()
     FROM candidate c WHERE j.source_id=c.source_id
     RETURNING j.source_id, j.account_id, j.generation, j.attempts, j.lease_token`
  );
  if (!job) return false;
  return runWithRequestContext(`ingest.${job.source_id}.${job.generation}`, async () => {
    if (activeSourceJobs.has(job.source_id)) {
      await q(
        `UPDATE ingestion_jobs SET status='pending', attempts=GREATEST(0,attempts-1), leased_at=NULL, lease_token=NULL,
          available_at=now()+interval '1 second', updated_at=now()
       WHERE source_id=$1 AND generation=$2 AND lease_token=$3`,
        [job.source_id, job.generation, job.lease_token]
      );
      return true;
    }
    activeSourceJobs.add(job.source_id);
    const heartbeat = setInterval(() => {
      void q(
        `UPDATE ingestion_jobs SET leased_at=now(), updated_at=now()
         WHERE source_id=$1 AND generation=$2 AND status='running' AND lease_token=$3`,
        [job.source_id, job.generation, job.lease_token]
      ).catch(() =>
        appLog.warn(
          { source_id: job.source_id, error_code: "LEASE_HEARTBEAT_FAILED" },
          "ingestion lease heartbeat failed"
        )
      );
    }, LEASE_HEARTBEAT_MS);
    heartbeat.unref();
    let source: any;
    try {
      [source] = await q(
        `SELECT id, account_id, name, file_path, mime, kind, display_name, url, connector, meta
       FROM sources WHERE id=$1 AND account_id=$2`,
        [job.source_id, job.account_id]
      );
    } catch (error) {
      clearInterval(heartbeat);
      activeSourceJobs.delete(job.source_id);
      throw error;
    }
    const sourceMeta = parseSourceMeta(source?.meta);
    const preparedCandidate =
      typeof sourceMeta.connector_candidate_location === "string" ? sourceMeta.connector_candidate_location : undefined;
    const ingestFilePath = source?.file_path || preparedCandidate;
    if (!source || !ingestFilePath) {
      await q(
        `UPDATE ingestion_jobs SET status='error', last_error='SOURCE_UNAVAILABLE', updated_at=now() WHERE source_id=$1 AND generation=$2`,
        [job.source_id, job.generation]
      );
      clearInterval(heartbeat);
      activeSourceJobs.delete(job.source_id);
      return true;
    }
    try {
      await runIngest({
        accountId: source.account_id,
        sourceId: source.id,
        name: source.name,
        filePath: ingestFilePath,
        mime: source.mime || "application/octet-stream",
        kind: source.kind,
        displayName: source.display_name,
        url: source.url || undefined,
        connector: source.connector || undefined,
        generation: job.generation,
        leaseToken: job.lease_token,
        meta: source.meta,
      });
      const completed = await q(
        `UPDATE ingestion_jobs SET status='done', leased_at=NULL, lease_token=NULL, last_error=NULL, updated_at=now()
       WHERE source_id=$1 AND generation=$2 AND lease_token=$3
       RETURNING source_id`,
        [job.source_id, job.generation, job.lease_token]
      );
      if (completed.length) await cleanupPromotedConnectorCache(source).catch(() => {});
    } catch (error) {
      const activatedRefresh = error instanceof Error && error.name === "ConnectorRefreshActivatedError";
      const retrying = activatedRefresh || (job.attempts < MAX_JOB_ATTEMPTS && isRetryableIngestError(error));
      appLog.warn(
        {
          source_id: job.source_id,
          generation: job.generation,
          error_code: retrying ? "TRANSIENT_FAILURE" : "INGEST_FAILED",
          retrying,
        },
        "ingestion job failed"
      );
      if (retrying) {
        const reserved = await q(
          `UPDATE ingestion_jobs
         SET status='pending', leased_at=NULL, lease_token=NULL, last_error='TRANSIENT_FAILURE',
             available_at=now()+($3::int * interval '1 second'), updated_at=now()
         WHERE source_id=$1 AND generation=$2 AND lease_token=$4
         RETURNING source_id`,
          [job.source_id, job.generation, Math.min(300, 2 ** Math.min(job.attempts, 8)), job.lease_token]
        );
        if (reserved.length) {
          await q(
            `UPDATE sources
             SET status=CASE WHEN sources.connector IS NOT NULL THEN 'index'
                             WHEN EXISTS (SELECT 1 FROM chunks c WHERE c.source_id=sources.id) THEN 'ready'
                             ELSE 'index' END
             WHERE id=$1 AND account_id=$2
               AND EXISTS (
                 SELECT 1 FROM ingestion_jobs j
                 WHERE j.source_id=$1 AND j.generation=$3 AND j.status='pending'
               )`,
            [job.source_id, job.account_id, job.generation]
          );
          await q(
            `UPDATE connectors c SET sync_status='indexing', sync_error=NULL
             FROM sources s
             WHERE s.id=$1 AND s.account_id=$2 AND s.connector=c.id AND c.account_id=$2
               AND EXISTS (
                 SELECT 1 FROM ingestion_jobs j
                 WHERE j.source_id=$1 AND j.generation=$3 AND j.status='pending'
               )`,
            [job.source_id, job.account_id, job.generation]
          );
        }
      } else {
        const terminal = await q(
          `UPDATE ingestion_jobs SET status='error', leased_at=NULL, lease_token=NULL,
             last_error='INGEST_FAILED', updated_at=now()
         WHERE source_id=$1 AND generation=$2 AND lease_token=$3
         RETURNING source_id`,
          [job.source_id, job.generation, job.lease_token]
        );
        if (terminal.length && source.connector) {
          const restored = await rollbackConnectorLastGood(source, job.generation).catch(() => false);
          if (restored) {
            await q(
              `UPDATE connectors SET sync_status='error', sync_error='Connector indexing failed.'
               WHERE id=$1 AND account_id=$2`,
              [source.connector, job.account_id]
            ).catch(() => {});
          } else {
            await q(
              `UPDATE ingestion_jobs SET status='pending', available_at=now()+interval '30 seconds', updated_at=now()
               WHERE source_id=$1 AND generation=$2 AND status='error'`,
              [job.source_id, job.generation]
            );
            await q(`UPDATE sources SET status='index' WHERE id=$1 AND account_id=$2`, [job.source_id, job.account_id]);
            await q(
              `UPDATE connectors c SET sync_status='indexing', sync_error=NULL
               FROM sources s WHERE s.id=$1 AND s.account_id=$2 AND s.connector=c.id AND c.account_id=$2`,
              [job.source_id, job.account_id]
            );
          }
        }
      }
    } finally {
      clearInterval(heartbeat);
      activeSourceJobs.delete(job.source_id);
    }
    return true;
  });
}

function parseSourceMeta(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Corrupt optional metadata is ignored; durable source columns remain authoritative.
    }
  }
  return {};
}

async function cleanupPromotedConnectorCache(source: any): Promise<void> {
  if (!source?.connector) return;
  const [current] = await q(
    `SELECT name, file_path, meta FROM sources WHERE id=$1 AND account_id=$2 AND status='ready'`,
    [source.id, source.account_id]
  );
  if (!current) return;
  const previous = parseSourceMeta(current.meta).connector_previous_location;
  if (typeof previous !== "string" || !previous || previous === current.file_path) return;
  await py.cleanupDatasetCache(source.account_id, current.name, previous);
  await q(
    `UPDATE sources SET meta=meta - 'connector_previous_location'
     WHERE id=$1 AND account_id=$2 AND status='ready'
       AND meta->>'connector_previous_location'=$3`,
    [source.id, source.account_id, previous]
  );
}

/** Restore the old Python/file identity after the final failed refresh attempt. */
async function rollbackConnectorLastGood(source: any, generation: number): Promise<boolean> {
  if (!source?.connector) return true;
  const [current] = await q(
    `SELECT id, account_id, name, file_path, display_name, url, mime, meta
     FROM sources WHERE id=$1 AND account_id=$2`,
    [source.id, source.account_id]
  );
  if (!current) return true;
  const meta = parseSourceMeta(current.meta);
  const refreshVersion = meta.connector_refresh_version;
  const candidateLocation = meta.connector_candidate_location;
  if (typeof refreshVersion === "string" && typeof candidateLocation === "string") {
    const expectedFormat: "csv" | "json" = String(current.mime).toLowerCase().includes("json") ? "json" : "csv";
    await py.abortDatasetRefresh(current.account_id, current.name, refreshVersion, expectedFormat);
    const restored = await q(
      `UPDATE sources s
       SET status=CASE WHEN s.file_path IS NOT NULL AND EXISTS (
                    SELECT 1 FROM chunks c WHERE c.source_id=s.id
                  ) THEN 'ready' ELSE 'error' END,
           meta=(meta - 'connector_refresh_version' - 'connector_candidate_location' -
                 'connector_activation_previous_location' - 'connector_previous_location' - 'error') ||
                CASE WHEN s.file_path IS NOT NULL AND EXISTS (
                       SELECT 1 FROM chunks c WHERE c.source_id=s.id
                     ) THEN '{}'::jsonb
                     ELSE jsonb_build_object('error','Connector indexing failed.') END
       WHERE s.id=$1 AND s.account_id=$2
         AND EXISTS (
           SELECT 1 FROM ingestion_jobs j
           WHERE j.source_id=s.id AND j.generation=$3 AND j.status='error'
         )
       RETURNING s.status`,
      [current.id, current.account_id, generation]
    );
    return restored.length > 0;
  }
  const previous = meta.connector_previous_location;
  const candidate = typeof current.file_path === "string" ? current.file_path : "";
  if (typeof previous !== "string" || !previous || previous === candidate) {
    // A first sync has no last-known-good version. Remove its failed live
    // registry identity and immutable candidate rather than exposing it.
    if (candidate) {
      await py.deactivateDatasetLocation(current.account_id, current.name, candidate).catch(() => {});
      await py.cleanupDatasetCache(current.account_id, current.name, candidate).catch(() => {});
    }
    return true;
  }

  const expectedFormat: "csv" | "json" = String(current.mime).toLowerCase().includes("json") ? "json" : "csv";
  await py.registerDataset(current.account_id, current.name, {
    location: previous,
    kind: "url",
    url: current.url,
    originalName: current.display_name,
    expectedFormat,
  });
  const restored = await q(
    `UPDATE sources s
     SET file_path=$3,
         status=CASE WHEN EXISTS (SELECT 1 FROM chunks c WHERE c.source_id=s.id) THEN 'ready' ELSE 'error' END,
         meta=(meta - 'error' - 'connector_previous_location') ||
              CASE WHEN EXISTS (SELECT 1 FROM chunks c WHERE c.source_id=s.id) THEN '{}'::jsonb
                   ELSE jsonb_build_object('error','Connector indexing failed.') END
     WHERE s.id=$1 AND s.account_id=$2
       AND s.file_path=$4
       AND EXISTS (
         SELECT 1 FROM ingestion_jobs j
         WHERE j.source_id=s.id AND j.generation=$5 AND j.status='error'
       )
     RETURNING s.status`,
    [current.id, current.account_id, previous, candidate, generation]
  );
  if (!restored.length) return false;
  await py.cleanupDatasetCache(current.account_id, current.name, candidate).catch(() => {});
  return true;
}

function isRetryableIngestError(error: unknown): boolean {
  if (error instanceof PythonServiceError) return error.status === 429 || error.status >= 500;
  const message = error instanceof Error ? error.message : "";
  if (
    message.includes("no readable text") ||
    message.includes("not supported") ||
    message.includes("artifact is unavailable") ||
    message.includes("shape mismatch") ||
    message.includes("superseded")
  ) {
    return false;
  }
  return true;
}

export async function startIngestionWorkers(): Promise<void> {
  // In the supported single-server deployment every pre-existing running
  // lease belongs to the prior process and is orphaned at boot. Periodic
  // recovery below remains expiry-based so it never steals healthy work.
  await recoverExpiredIngestionLeases(true);
  await recoverPreparingConnectorLeases(true);
  await q(
    `INSERT INTO ingestion_jobs (source_id, account_id, generation, status, attempts, available_at, updated_at)
     SELECT id, account_id, 1, 'pending', 0, now(), now()
     FROM sources WHERE status='index' AND file_path IS NOT NULL
     ON CONFLICT (source_id) DO UPDATE
       SET generation=ingestion_jobs.generation+1, status='pending', attempts=0,
           available_at=now(), leased_at=NULL, lease_token=NULL, last_error=NULL, updated_at=now()
       WHERE ingestion_jobs.status IN ('done','error')`
  );
  await q(
    `UPDATE connectors c SET sync_status='indexing', sync_error=NULL
     FROM sources s JOIN ingestion_jobs j ON j.source_id=s.id
     WHERE s.connector=c.id AND s.account_id=c.account_id AND s.status='index'
       AND j.status IN ('pending','running')
       AND c.sync_status IN ('idle','syncing','error')`
  );
  // Recovery above is DB-only and completes before traffic is accepted. Slow
  // remote connector downloads resume in a bounded background pump.
  wakeConnectorPrepareWorkers();
  scheduleIngestionPump();
  const pumpTimer = setInterval(() => {
    void recoverExpiredIngestionLeases()
      .catch(() => appLog.warn({ error_code: "LEASE_RECOVERY_FAILED" }, "ingestion lease recovery failed"))
      .finally(scheduleIngestionPump);
  }, 15_000);
  pumpTimer.unref();

  let reconciling = false;
  const reconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      runWithRequestContext("connector-prepare-reconciliation.periodic", () => wakeConnectorPrepareWorkers());
      await runWithRequestContext("dataset-reconciliation.periodic", () => restoreDatasets(1));
      await runWithRequestContext("dataset-cache-cleanup.periodic", () => processDatasetCacheCleanup());
    } finally {
      reconciling = false;
    }
  };
  const reconciliationTimer = setInterval(
    () =>
      void reconcile().catch(() =>
        appLog.warn({ error_code: "DATASET_RECONCILIATION_FAILED" }, "dataset registry reconciliation failed")
      ),
    60_000
  );
  reconciliationTimer.unref();
}

export async function recoverPreparingConnectorLeases(startup = false): Promise<number> {
  const rows = startup
    ? await q(
        `UPDATE ingestion_jobs
         SET leased_at=NULL, lease_token=NULL, available_at=now(),
             last_error='PROCESS_RESTARTED', updated_at=now()
         WHERE status='preparing' AND (leased_at IS NOT NULL OR lease_token IS NOT NULL)
         RETURNING source_id`
      )
    : await q(
        `UPDATE ingestion_jobs
         SET leased_at=NULL, lease_token=NULL, available_at=now(),
             last_error='PREPARE_LEASE_EXPIRED', updated_at=now()
         WHERE status='preparing'
           AND leased_at < now() - ($1::int * interval '1 minute')
         RETURNING source_id`,
        [LEASE_TIMEOUT_MINUTES]
      );
  return rows.length;
}

export async function resumePreparingConnectorRefreshes(): Promise<number> {
  const outcomes = await Promise.all(
    Array.from({ length: PREPARE_WORKER_CONCURRENCY }, () => processOnePreparingConnectorRefresh())
  );
  return outcomes.filter(Boolean).length;
}

export async function processOnePreparingConnectorRefresh(): Promise<boolean> {
  const [job] = await q(
    `WITH candidate AS (
       SELECT source_id FROM ingestion_jobs
       WHERE status='preparing' AND available_at<=now()
         AND (leased_at IS NULL OR leased_at < now() - ($1::int * interval '1 minute'))
       ORDER BY updated_at, source_id
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE ingestion_jobs j
     SET attempts=attempts+1, leased_at=now(), lease_token=gen_random_uuid(), updated_at=now()
     FROM candidate c WHERE j.source_id=c.source_id
     RETURNING j.source_id, j.account_id, j.generation, j.attempts, j.lease_token`,
    [LEASE_TIMEOUT_MINUTES]
  );
  if (!job) return false;

  return runWithRequestContext(`connector-prepare.${job.source_id}.${job.generation}`, async () => {
    const [source] = await q(
      `SELECT s.id, s.account_id, s.name, s.file_path, s.display_name, s.url, s.mime, s.meta,
              c.id AS connector_id, c.type, c.target_table, c.config
       FROM sources s
       JOIN connectors c ON c.id=s.connector AND c.account_id=s.account_id
       WHERE s.id=$1 AND s.account_id=$2 AND s.status='index'`,
      [job.source_id, job.account_id]
    );
    const meta = parseSourceMeta(source?.meta);
    const version = meta.connector_refresh_version;
    const expectedFormat: "csv" | "json" = source?.type === "url_json" ? "json" : "csv";
    let configValue: any;
    try {
      configValue = typeof source?.config === "string" ? JSON.parse(source.config) : source?.config;
    } catch {
      configValue = undefined;
    }
    if (!source || typeof version !== "string" || typeof configValue?.url !== "string") {
      await terminalizePreparingConnector(job, source, "PREPARE_STATE_INVALID");
      return true;
    }

    try {
      const prepared = await py.prepareDatasetRefresh(
        source.account_id,
        source.target_table,
        version,
        configValue.url,
        source.display_name,
        expectedFormat
      );
      if (prepared?.version !== version || typeof prepared?.location !== "string" || !prepared.location) {
        throw new Error("connector returned an invalid prepared artifact");
      }
      const activationPrevious =
        typeof prepared.previous_location === "string" && prepared.previous_location
          ? prepared.previous_location
          : null;
      const cleanupPrevious =
        source.file_path && source.file_path !== prepared.location ? source.file_path : activationPrevious;
      const client = await pool.connect();
      let inTransaction = false;
      let finalized = false;
      try {
        await client.query("BEGIN");
        inTransaction = true;
        const owned = await client.query(
          `SELECT source_id FROM ingestion_jobs
           WHERE source_id=$1 AND account_id=$2 AND generation=$3 AND status='preparing' AND lease_token=$4
           FOR UPDATE`,
          [job.source_id, job.account_id, job.generation, job.lease_token]
        );
        if (!owned.rows.length) {
          await client.query("ROLLBACK");
          inTransaction = false;
          return true;
        }
        const updated = await client.query(
          `UPDATE sources
           SET meta=(meta - 'connector_candidate_location' - 'connector_activation_previous_location' -
                     'connector_previous_location') ||
                    jsonb_build_object(
                      'connector_candidate_location',$4::text,
                      'connector_activation_previous_location',to_jsonb($5::text)
                    ) || CASE WHEN $6::text IS NULL THEN '{}'::jsonb
                              ELSE jsonb_build_object('connector_previous_location',$6::text) END
           WHERE id=$1 AND account_id=$2 AND status='index' AND meta->>'connector_refresh_version'=$3
           RETURNING id`,
          [source.id, source.account_id, version, prepared.location, activationPrevious, cleanupPrevious]
        );
        if (!updated.rows.length) throw new Error("connector prepare ownership lost");
        await client.query(
          `UPDATE ingestion_jobs
           SET status='pending', available_at=now(), leased_at=NULL, lease_token=NULL, last_error=NULL, updated_at=now()
           WHERE source_id=$1 AND account_id=$2 AND generation=$3 AND status='preparing' AND lease_token=$4`,
          [job.source_id, job.account_id, job.generation, job.lease_token]
        );
        await client.query(
          `UPDATE connectors SET sync_status='indexing', sync_error=NULL
           WHERE id=$1 AND account_id=$2`,
          [source.connector_id, source.account_id]
        );
        await client.query("COMMIT");
        inTransaction = false;
        finalized = true;
      } catch (error) {
        if (inTransaction) await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      if (finalized) scheduleIngestionPump();
      return true;
    } catch (error) {
      const abortConfirmed = await py
        .abortDatasetRefresh(source.account_id, source.target_table, version, expectedFormat)
        .then(() => true)
        .catch(() => false);
      const retryable = error instanceof PythonServiceError ? error.status === 429 || error.status >= 500 : false;
      if (!abortConfirmed || (retryable && job.attempts < MAX_JOB_ATTEMPTS)) {
        await q(
          `UPDATE ingestion_jobs
           SET leased_at=NULL, lease_token=NULL,
               available_at=now()+(LEAST(300, power(2, LEAST(attempts,8))) * interval '1 second'),
               last_error=$5, updated_at=now()
           WHERE source_id=$1 AND account_id=$2 AND generation=$3
             AND status='preparing' AND lease_token=$4`,
          [
            job.source_id,
            job.account_id,
            job.generation,
            job.lease_token,
            abortConfirmed ? "PREPARE_TRANSIENT" : "PREPARE_OUTCOME_UNCERTAIN",
          ]
        );
      } else {
        await terminalizePreparingConnector(job, source, "PREPARE_FAILED");
      }
      return true;
    }
  });
}

async function terminalizePreparingConnector(job: any, source: any, errorCode: string): Promise<boolean> {
  const rows = await q(
    `WITH failed_job AS (
       UPDATE ingestion_jobs
       SET status='error', leased_at=NULL, lease_token=NULL, last_error=$5, updated_at=now()
       WHERE source_id=$1 AND account_id=$2 AND generation=$3
         AND status='preparing' AND lease_token=$4
       RETURNING source_id, account_id
     ), restored_source AS (
       UPDATE sources s
       SET status=CASE WHEN s.file_path IS NOT NULL AND EXISTS (
                    SELECT 1 FROM chunks c WHERE c.source_id=s.id
                  ) THEN 'ready' ELSE 'error' END,
           meta=(meta - 'connector_refresh_version' - 'connector_candidate_location' -
                 'connector_activation_previous_location' - 'connector_previous_location' - 'error') ||
                CASE WHEN s.file_path IS NOT NULL AND EXISTS (
                       SELECT 1 FROM chunks c WHERE c.source_id=s.id
                     ) THEN '{}'::jsonb
                     ELSE jsonb_build_object('error','Connector sync failed.') END
       FROM failed_job j
       WHERE s.id=j.source_id AND s.account_id=j.account_id
       RETURNING s.connector, s.account_id
     )
     UPDATE connectors c SET sync_status='error', sync_error='Connector sync failed.'
     FROM restored_source s WHERE c.id=s.connector AND c.account_id=s.account_id
     RETURNING c.id`,
    [job.source_id, job.account_id, job.generation, job.lease_token, errorCode]
  );
  return rows.length > 0;
}

export async function recoverExpiredIngestionLeases(startup = false): Promise<number> {
  const recovered = startup
    ? await q(
        `UPDATE ingestion_jobs j
         SET generation=j.generation+1,
             status=CASE WHEN j.attempts >= $1::int THEN 'error' ELSE 'pending' END,
             leased_at=NULL, lease_token=NULL,
             available_at=now()+(LEAST(300, power(2, LEAST(j.attempts,8))) * interval '1 second'),
             last_error='PROCESS_RESTARTED', updated_at=now()
         WHERE status='running'
         RETURNING j.source_id, j.account_id, j.generation, j.status`,
        [MAX_JOB_ATTEMPTS]
      )
    : await q(
        `UPDATE ingestion_jobs j
         SET generation=j.generation+1,
             status=CASE WHEN j.attempts >= $2::int THEN 'error' ELSE 'pending' END,
             leased_at=NULL, lease_token=NULL,
             available_at=now()+(LEAST(300, power(2, LEAST(j.attempts,8))) * interval '1 second'),
             last_error='LEASE_EXPIRED', updated_at=now()
         WHERE j.status='running'
           AND (j.leased_at IS NULL OR j.leased_at < now() - ($1::int * interval '1 minute'))
         RETURNING j.source_id, j.account_id, j.generation, j.status`,
        [LEASE_TIMEOUT_MINUTES, MAX_JOB_ATTEMPTS]
      );
  for (const job of recovered) {
    await q(`DELETE FROM ingestion_chunk_staging WHERE source_id=$1 AND generation<$2`, [
      job.source_id,
      job.generation,
    ]).catch(() => {});
  }
  for (const job of recovered.filter((candidate) => candidate.status === "error")) {
    const [source] = await q(
      `SELECT id, account_id, name, file_path, display_name, url, mime, connector, meta
       FROM sources WHERE id=$1 AND account_id=$2`,
      [job.source_id, job.account_id]
    );
    if (source?.connector) {
      const restored = await rollbackConnectorLastGood(source, job.generation).catch(() => false);
      if (!restored) {
        await q(
          `UPDATE ingestion_jobs SET status='pending', available_at=now()+interval '30 seconds', updated_at=now()
           WHERE source_id=$1 AND generation=$2 AND status='error'`,
          [job.source_id, job.generation]
        );
        await q(`UPDATE sources SET status='index' WHERE id=$1 AND account_id=$2`, [job.source_id, job.account_id]);
      } else {
        await q(
          `UPDATE connectors SET sync_status='error', sync_error='Connector indexing failed.'
           WHERE id=$1 AND account_id=$2`,
          [source.connector, job.account_id]
        );
      }
    } else if (source) {
      await q(
        `UPDATE sources SET status=CASE WHEN EXISTS (
           SELECT 1 FROM chunks c WHERE c.source_id=sources.id
         ) THEN 'ready' ELSE 'error' END,
         meta=meta || jsonb_build_object('error','Ingestion lease expired.')
         WHERE id=$1 AND account_id=$2`,
        [job.source_id, job.account_id]
      );
    }
  }
  return recovered.length;
}

export interface RestoreSummary {
  attempted: number;
  restored: number;
  failed: number;
  stale_attempted: number;
  removed: number;
  remove_failed: number;
}

export async function restoreDatasets(attempts = 8): Promise<RestoreSummary> {
  const ledgerRows = await q(
    `SELECT u.id AS account_id, s.id AS source_id, s.name, s.file_path, s.display_name,
            s.url, s.connector, s.mime, s.status, s.meta->>'connector_previous_location' AS previous_location
     FROM users u
     LEFT JOIN sources s ON s.account_id=u.id AND s.kind='tabular'
     ORDER BY u.id, s.name`
  );
  const sources = ledgerRows.filter((row) => row.status === "ready" && row.file_path);
  let ready = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await py.health()) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2_000)));
  }
  if (!ready) {
    return {
      attempted: sources.length,
      restored: 0,
      failed: sources.length,
      stale_attempted: 0,
      removed: 0,
      remove_failed: 0,
    };
  }

  const byAccount = new Map<string, { protectedNames: Set<string>; readySources: any[] }>();
  for (const row of ledgerRows) {
    const account = byAccount.get(row.account_id) ?? { protectedNames: new Set<string>(), readySources: [] };
    // Keep ready identities and names currently owned by an ingestion worker.
    // Terminal error identities are not queryable and must not pin stale
    // Python registry entries indefinitely.
    if (row.name && (row.status === "ready" || row.status === "index")) account.protectedNames.add(row.name);
    if (row.status === "ready" && row.file_path) account.readySources.push(row);
    byAccount.set(row.account_id, account);
  }

  let attempted = 0;
  let restored = 0;
  let failed = 0;
  let staleAttempted = 0;
  let removed = 0;
  let removeFailed = 0;
  for (const [accountId, accountLedger] of byAccount) {
    let registered: any[];
    try {
      registered = await py.listDatasets(accountId);
    } catch {
      failed += accountLedger.readySources.length;
      continue;
    }
    const current = new Map(registered.map((dataset) => [String(dataset.table), dataset]));
    for (const dataset of registered) {
      const table = String(dataset.table);
      if (!table || accountLedger.protectedNames.has(table)) continue;
      staleAttempted += 1;
      try {
        if (typeof dataset.location !== "string" || !dataset.location) throw new Error("missing dataset identity");
        // Exact-location CAS makes a stale reconciliation snapshot harmless if
        // the same table name is recreated before this request reaches Python.
        await py.deactivateDatasetLocation(accountId, table, dataset.location);
        if (dataset.kind === "url") await py.cleanupDatasetCache(accountId, table, dataset.location);
        removed += 1;
      } catch {
        removeFailed += 1;
      }
    }
    for (const source of accountLedger.readySources) {
      const existing = current.get(source.name);
      let cleanupLocation =
        typeof source.previous_location === "string" && source.previous_location !== source.file_path
          ? source.previous_location
          : undefined;
      // Python's registry observes same-path file signature changes lazily at
      // its scoped-query boundary, so only a missing or differently located
      // identity requires the expensive parse/register operation here.
      if (existing?.exists === false || existing?.location !== source.file_path) {
        attempted += 1;
        const client = await pool.connect();
        let inTransaction = false;
        try {
          await client.query("BEGIN");
          inTransaction = true;
          // Hold a shared row lock across the cross-service registration and
          // recheck the durable identity. Connector refresh/promotion takes an
          // UPDATE lock, so reconciliation can never restore an old path after
          // activation has moved the source into its `index` transition.
          const fresh = await client.query(
            `SELECT id FROM sources
             WHERE id=$1 AND account_id=$2 AND status='ready' AND file_path=$3
             FOR SHARE`,
            [source.source_id, source.account_id, source.file_path]
          );
          if (!fresh.rows.length) {
            await client.query("ROLLBACK");
            inTransaction = false;
            continue;
          }
          const ownedLocation = await resolveSourceArtifact({
            accountId: source.account_id,
            sourceId: source.source_id,
            name: source.name,
            filePath: source.file_path,
            connector: source.connector || undefined,
          });
          if (!ownedLocation) throw new Error("source artifact is unavailable");
          const registration = await py.registerDataset(
            source.account_id,
            source.name,
            datasetRegistrationForSource({
              sourceId: source.source_id,
              filePath: ownedLocation,
              displayName: source.display_name,
              url: source.url || undefined,
              connector: source.connector || undefined,
              expectedFormat: source.connector
                ? String(source.mime).toLowerCase().includes("json")
                  ? "json"
                  : "csv"
                : undefined,
            })
          );
          if (
            typeof registration?.previous_location === "string" &&
            registration.previous_location !== source.file_path
          ) {
            cleanupLocation = registration.previous_location;
          }
          await client.query("COMMIT");
          inTransaction = false;
          restored += 1;
        } catch {
          if (inTransaction) await client.query("ROLLBACK").catch(() => {});
          failed += 1;
          continue;
        } finally {
          client.release();
        }
      }
      if (source.connector && cleanupLocation) {
        try {
          await py.cleanupDatasetCache(source.account_id, source.name, cleanupLocation);
          await q(
            `UPDATE sources SET meta=meta - 'connector_previous_location'
             WHERE id=$1 AND account_id=$2 AND file_path=$3
               AND meta->>'connector_previous_location'=$4`,
            [source.source_id, source.account_id, source.file_path, cleanupLocation]
          );
        } catch {
          // Preserve the durable marker so the next reconciliation retries.
        }
      }
    }
  }
  return { attempted, restored, failed, stale_attempted: staleAttempted, removed, remove_failed: removeFailed };
}
