import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { config } from "../config.js";
import { SourceIngestionTransitionError } from "../db/stores/sourceIngestionTransitions.js";
import { SourceStoreError, type SourceRecord } from "../db/stores/sourceStore.js";
import { dataService } from "../dataService.js";
import { isTabularSource, sanitizeDatasetName, wakeIngestionWorkers } from "../ingest.js";
import { publicIngestionFailure } from "../ingestionFailures.js";
import { completeSourceDeleteIntents } from "../sourceCleanup.js";
import { enforceRemoteEgressConsent } from "../egressPolicy.js";
import { auditRemoteEgress } from "../egressAudit.js";
import { storageRuntime } from "../storageRuntime.js";
import { cleanupCreatedUploadResource, createUploadResourceDirectory } from "../storageArtifacts.js";
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
    const accountId = getAccountId(req);
    const runtime = storageRuntime();
    const sources = await runtime.sources.listSources(accountId);
    const ingestion = await runtime.sourceIngestion.ingestionSummaries(
      accountId,
      sources.map((source) => source.id)
    );
    let tabular: Array<{ table?: unknown; original_name?: unknown; rows?: unknown }> = [];
    try {
      tabular = await dataService.listDatasetSummaries(accountId);
    } catch {
      // The durable source ledger remains usable if the data worker is unavailable.
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
      sources.map((source) => {
        const rawMeta = isRecord(source.meta) ? source.meta : {};
        const failure = source.status === "error" ? publicIngestionFailure(rawMeta.error_code) : null;
        const job = ingestion.get(source.id);
        return {
          id: source.id,
          name: source.name,
          kind: source.kind,
          display_name: source.displayName,
          mime: source.mime,
          size_bytes: source.sizeBytes,
          status: source.status,
          created_at: source.createdAt,
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
                  attempts: Math.max(0, Math.min(100, job?.attempts ?? 0)),
                  updated_at: job?.updatedAt ?? null,
                },
              }
            : {}),
          ...(tabularByName.has(source.name) ? { tabular: tabularByName.get(source.name) } : {}),
        };
      })
    );
  });

  app.post(
    "/api/sources/upload",
    { preHandler: requireAuth, bodyLimit: config.maxUploadBytes + 64 * 1024 },
    async (req, reply) => {
      const accountId = getAccountId(req);
      if (!(await enforceRemoteEgressConsent(reply, accountId))) return;
      void auditRemoteEgress("remote_ingest", accountId);
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
      const directory = await createUploadResourceDirectory(accountId, sourceId);
      const filePath = path.join(directory, safeOriginal);
      try {
        await pipeline(file.file, createWriteStream(filePath, { flags: "wx" }));
      } catch (error) {
        await cleanupCreatedUploadResource(accountId, sourceId, filePath);
        throw error;
      }
      const sizeBytes = await fs.stat(filePath).then((stat) => stat.size);
      if (file.file.truncated || sizeBytes > config.maxUploadBytes) {
        await cleanupCreatedUploadResource(accountId, sourceId, filePath);
        return reply.code(413).send({ error: "upload exceeds the configured size limit" });
      }
      if (await hasOleCompoundFileSignature(filePath)) {
        await cleanupCreatedUploadResource(accountId, sourceId, filePath);
        return reply.code(422).send({ error: "legacy binary Office files are not supported" });
      }

      let reservation;
      try {
        reservation = await storageRuntime().sourceIngestion.createUploadSource(accountId, {
          id: sourceId,
          baseName: sanitizeDatasetName(safeOriginal),
          kind: mimeKind(file.mimetype, filePath),
          displayName: safeOriginal,
          filePath,
          mime: file.mimetype,
          sizeBytes,
        });
      } catch (error) {
        await cleanupCreatedUploadResource(accountId, sourceId, filePath);
        throw error;
      }
      wakeIngestionWorkers();
      return reply.send({ ...sourceToApi(reservation.source), processing: true });
    }
  );

  app.post(
    "/api/sources/:id/reingest",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      if (!(await enforceRemoteEgressConsent(reply, getAccountId(req)))) return;
      void auditRemoteEgress("remote_ingest", getAccountId(req));
      try {
        const reservation = await storageRuntime().sourceIngestion.reserveSourceReingest(
          getAccountId(req),
          (req.params as { id: string }).id
        );
        wakeIngestionWorkers();
        return reply.send({ ...sourceToApi(reservation.source), processing: true });
      } catch (error) {
        return sendSourceError(reply, error);
      }
    }
  );

  app.delete(
    "/api/sources/:id",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      try {
        const deletion = await storageRuntime().sources.deleteSource(
          getAccountId(req),
          (req.params as { id: string }).id
        );
        await completeSourceDeleteIntents([deletion.intent]);
        return reply.send({ ok: true });
      } catch (error) {
        return sendSourceError(reply, error);
      }
    }
  );
}

function sourceToApi(source: SourceRecord): Record<string, unknown> {
  return {
    id: source.id,
    account_id: source.accountId,
    name: source.name,
    kind: source.kind,
    connector: source.connectorId,
    display_name: source.displayName,
    file_path: source.filePath,
    url: source.url,
    mime: source.mime,
    size_bytes: source.sizeBytes,
    status: source.status,
    meta: source.meta,
    ready_generation: source.readyGeneration,
    created_at: source.createdAt,
  };
}

function sendSourceError(reply: FastifyReply, error: unknown) {
  const code =
    error instanceof SourceStoreError || error instanceof SourceIngestionTransitionError ? error.code : undefined;
  if (code === "SOURCE_STORE_SOURCE_NOT_FOUND" || code === "SOURCE_TRANSITION_SOURCE_NOT_FOUND") {
    return reply.code(404).send({ error: "source not found" });
  }
  if (code === "SOURCE_TRANSITION_SOURCE_NO_FILE") {
    return reply.code(400).send({ error: "source has no uploaded file" });
  }
  if (code === "SOURCE_STORE_SOURCE_IN_USE" || code === "SOURCE_TRANSITION_SOURCE_IN_USE") {
    return reply.code(409).send({ error: "source is in use by an active run" });
  }
  if (code === "SOURCE_STORE_CONNECTOR_SYNC_ACTIVE" || code === "SOURCE_TRANSITION_CONNECTOR_SYNC_ACTIVE") {
    return reply.code(409).send({ error: "connector sync is active" });
  }
  throw error;
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
  const extension = path.extname(filePath).toLowerCase();
  if (isTabularSource(filePath, mime)) return "tabular";
  if (mime.includes("pdf") || extension === ".pdf") return "document";
  if (mime.includes("word") || extension === ".docx") return "document";
  return "document";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
