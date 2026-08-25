import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { config } from "../config.js";
import { pool, q } from "../db.js";
import {
  isTabularSource,
  processDatasetCacheCleanup,
  reserveDatasetCacheCleanup,
  reserveIngestionJob,
  sanitizeDatasetName,
  wakeIngestionWorkers,
} from "../ingest.js";
import { publicIngestionFailure } from "../ingestionFailures.js";
import { py } from "../pythonClient.js";
import { sourceReferencedByActiveRun } from "../sourceMutationGuard.js";
import {
  cleanupCreatedUploadResource,
  createUploadResourceDirectory,
  removeSourceArtifact,
} from "../storageArtifacts.js";
import { idParamsSchema } from "./schemas.js";

const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".text",
  ".log",
  ".pdf",
  ".docx",
  ".csv",
  ".tsv",
  ".xlsx",
  ".parquet",
  ".jsonl",
  ".json",
]);

export async function sourceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/sources", { preHandler: requireAuth }, async (req, reply) => {
    const account = getAccountId(req);
    const rows = await q(
      `SELECT s.id, s.name, s.kind, s.display_name, s.mime, s.size_bytes, s.status, s.meta, s.created_at,
              j.attempts AS ingestion_attempts, j.updated_at AS ingestion_updated_at
       FROM sources s
       LEFT JOIN ingestion_jobs j ON j.source_id=s.id AND j.account_id=s.account_id
       WHERE s.account_id=$1 ORDER BY s.created_at DESC`,
      [account]
    );
    let tabular: any[] = [];
    try {
      tabular = await py.listDatasetSummaries(account);
    } catch {
      // The source ledger remains usable while Python is unavailable.
    }
    const tabularByName = new Map(
      tabular.map((dataset) => [
        String(dataset.table),
        {
          table: String(dataset.table || ""),
          original_name: String(dataset.original_name || ""),
          rows: Math.max(0, Number(dataset.rows || 0)),
        },
      ])
    );
    return reply.send(
      rows.map((source) => {
        const rawMeta = source.meta && typeof source.meta === "object" ? source.meta : {};
        const failure = source.status === "error" ? publicIngestionFailure(rawMeta.error_code) : null;
        const { ingestion_attempts: attempts, ingestion_updated_at: updatedAt, meta: _meta, ...publicSource } = source;
        return {
          ...publicSource,
          meta: failure
            ? {
                error: failure.summary,
                error_code: failure.code,
                error_detail: failure.detail,
                error_stage: failure.stage,
              }
            : {},
          ...(failure
            ? {
                ingestion: {
                  attempts: Math.max(0, Math.min(100, Number(attempts) || 0)),
                  updated_at: updatedAt,
                },
              }
            : {}),
          ...(source.name && tabularByName.has(source.name) ? { tabular: tabularByName.get(source.name) } : {}),
        };
      })
    );
  });

  app.post(
    "/api/sources/upload",
    { preHandler: requireAuth, bodyLimit: config.maxUploadBytes + 64 * 1024 },
    async (req, reply) => {
      const account = getAccountId(req);
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "no file" });
      const safeOriginal =
        path
          .basename(file.filename)
          .replace(/[^\w.\- ]+/g, "_")
          .slice(0, 180) || "upload";
      const extension = path.extname(safeOriginal).toLowerCase();
      if (extension === ".xls" || extension === ".doc") {
        file.file.resume();
        return reply.code(422).send({ error: "legacy binary Office files are not supported" });
      }
      if (!SUPPORTED_UPLOAD_EXTENSIONS.has(extension)) {
        file.file.resume();
        return reply.code(422).send({ error: "unsupported upload file type" });
      }
      const sourceId = randomUUID();
      const directory = await createUploadResourceDirectory(account, sourceId);
      const filePath = path.join(directory, safeOriginal);
      try {
        await pipeline(file.file, createWriteStream(filePath, { flags: "wx" }));
      } catch (error) {
        await cleanupCreatedUploadResource(account, sourceId, filePath);
        throw error;
      }
      const sizeBytes = await fs.stat(filePath).then((stat) => stat.size);
      if (file.file.truncated || sizeBytes > config.maxUploadBytes) {
        await cleanupCreatedUploadResource(account, sourceId, filePath);
        return reply.code(413).send({ error: "upload exceeds the configured size limit" });
      }
      if (await hasOleCompoundFileSignature(filePath)) {
        await cleanupCreatedUploadResource(account, sourceId, filePath);
        return reply.code(422).send({ error: "legacy binary Office files are not supported" });
      }

      const base = sanitizeDatasetName(safeOriginal);
      let source: any;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [account]);
        let name = base;
        let suffix = 1;
        while (
          (await client.query(`SELECT 1 FROM sources WHERE account_id=$1 AND name=$2`, [account, name])).rows.length
        ) {
          name = `${base.slice(0, Math.max(1, 61 - String(suffix).length))}_${suffix++}`;
        }
        const inserted = await client.query(
          `INSERT INTO sources (id, account_id, name, kind, display_name, file_path, mime, size_bytes, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'index') RETURNING *`,
          [sourceId, account, name, mimeKind(file.mimetype, filePath), safeOriginal, filePath, file.mimetype, sizeBytes]
        );
        source = inserted.rows[0];
        await reserveIngestionJob(client, account, source.id);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        await cleanupCreatedUploadResource(account, sourceId, filePath);
        throw error;
      } finally {
        client.release();
      }
      wakeIngestionWorkers();
      return reply.send({ ...source, processing: true });
    }
  );

  app.post(
    "/api/sources/:id/reingest",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const account = getAccountId(req);
      const id = (req.params as any).id;
      const client = await pool.connect();
      let updated: any;
      try {
        await client.query("BEGIN");
        const selected = await client.query(`SELECT * FROM sources WHERE id=$1 AND account_id=$2 FOR UPDATE`, [
          id,
          account,
        ]);
        const source = selected.rows[0];
        if (!source) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "source not found" });
        }
        if (!source.file_path) {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "source has no uploaded file" });
        }
        if (await sourceReferencedByActiveRun(client, account, source.id)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "source is in use by an active run" });
        }
        if (source.connector) {
          const connector = await client.query(
            `SELECT sync_status FROM connectors WHERE id=$1 AND account_id=$2 FOR UPDATE`,
            [source.connector, account]
          );
          if (["syncing", "indexing"].includes(connector.rows[0]?.sync_status)) {
            await client.query("ROLLBACK");
            return reply.code(409).send({ error: "connector sync is active" });
          }
        }

        let name = source.name;
        if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
          const base = sanitizeDatasetName(source.display_name || name);
          name = base;
          let suffix = 1;
          while (
            (
              await client.query(`SELECT 1 FROM sources WHERE account_id=$1 AND name=$2 AND id<>$3`, [
                account,
                name,
                id,
              ])
            ).rows.length
          ) {
            name = `${base.slice(0, Math.max(1, 61 - String(suffix).length))}_${suffix++}`;
          }
        }
        updated = (
          await client.query(
            `UPDATE sources SET name=$2, status='index',
                 meta=meta - 'error' - 'error_code' - 'error_detail' - 'error_stage'
             WHERE id=$1 AND account_id=$3 RETURNING *`,
            [id, name, account]
          )
        ).rows[0];
        await reserveIngestionJob(client, account, source.id);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      wakeIngestionWorkers();
      return reply.send({ ...updated, processing: true });
    }
  );

  app.delete(
    "/api/sources/:id",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const account = getAccountId(req);
      const id = (req.params as any).id;
      // Delete the durable identity first. Its cascades cancel queued ingestion
      // before slower filesystem and Python-registry cleanup can race a worker.
      const client = await pool.connect();
      let source: any;
      try {
        await client.query("BEGIN");
        const selected = await client.query(`SELECT * FROM sources WHERE id=$1 AND account_id=$2 FOR UPDATE`, [
          id,
          account,
        ]);
        source = selected.rows[0];
        if (!source) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "source not found" });
        }
        if (source.connector) {
          const connector = await client.query(
            `SELECT sync_status FROM connectors WHERE id=$1 AND account_id=$2 FOR UPDATE`,
            [source.connector, account]
          );
          if (["syncing", "indexing"].includes(connector.rows[0]?.sync_status)) {
            await client.query("ROLLBACK");
            return reply.code(409).send({ error: "connector sync is active" });
          }
        }
        if (await sourceReferencedByActiveRun(client, account, source.id)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "source is in use by an active run" });
        }
        if (source.connector) {
          const meta = source.meta && typeof source.meta === "object" ? source.meta : {};
          await reserveDatasetCacheCleanup(client, account, source.name, [
            source.file_path,
            typeof meta.connector_previous_location === "string" ? meta.connector_previous_location : "",
            typeof meta.connector_candidate_location === "string" ? meta.connector_candidate_location : "",
            typeof meta.connector_activation_previous_location === "string"
              ? meta.connector_activation_previous_location
              : "",
          ]);
        }
        const deleted = await client.query(`DELETE FROM sources WHERE id=$1 AND account_id=$2 RETURNING id`, [
          id,
          account,
        ]);
        if (!deleted.rows.length) throw new Error("source deletion lost ownership lock");
        if (source.connector) {
          await client.query(`DELETE FROM connectors WHERE id=$1 AND account_id=$2`, [source.connector, account]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      if (source.connector) {
        await processDatasetCacheCleanup(account, source.name).catch(() => {});
      } else if (source.file_path) {
        await removeSourceArtifact({
          accountId: account,
          sourceId: source.id,
          name: source.name,
          filePath: source.file_path,
          connector: source.connector,
        });
      }
      // Do not drop a dataset by name after committing deletion: the same
      // account/table identity may already have been recreated. Stored-data
      // tools use the durable ready-source allowlist, so the stale in-memory
      // path is unreachable and is overwritten by a later registration.
      return reply.send({ ok: true });
    }
  );
}

async function hasOleCompoundFileSignature(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const signature = Buffer.alloc(8);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    return bytesRead === 8 && signature.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  } finally {
    await handle.close();
  }
}

function mimeKind(mime: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (isTabularSource(filePath, mime)) return "tabular";
  if (mime.includes("pdf") || ext === ".pdf") return "document";
  if (mime.includes("word") || ext === ".docx") return "document";
  return "document";
}
