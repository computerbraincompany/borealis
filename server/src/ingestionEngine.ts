import fs from "node:fs/promises";

import type { IngestionJob, SqliteIngestionStore } from "./db/stores/ingestionStore.js";
import type { SourceStore } from "./db/stores/sourceStore.js";
import { DataServiceError } from "./dataService.js";
import { IngestionStageError, publicIngestionFailure, type IngestionFailureCode } from "./ingestionFailures.js";
import type { IngestionVectorLifecycle } from "./vector/lifecycle.js";

const EMBED_BATCH_SIZE = 16;
const MAX_JOB_ATTEMPTS = 3;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface IngestionExecutionInput {
  readonly accountId: string;
  readonly sourceId: string;
  readonly name: string;
  readonly filePath: string;
  readonly mime: string;
  readonly kind: string;
  readonly displayName: string;
  readonly url?: string;
  readonly connector?: string;
  readonly generation: number;
  readonly leaseToken: string;
  readonly meta?: unknown;
}

export interface IngestionDataOperations {
  registerDataset(
    accountId: string,
    name: string,
    registration: Record<string, unknown>
  ): Promise<{ previous_location?: unknown } | undefined>;
  extractDataset(accountId: string, name: string, maxRows: number): Promise<Record<string, unknown>>;
  extractPreparedDataset(
    accountId: string,
    name: string,
    version: string,
    expectedFormat: "csv" | "json",
    maxRows: number
  ): Promise<Record<string, unknown>>;
  activateDatasetRefresh(
    accountId: string,
    name: string,
    version: string,
    url: string,
    originalName: string,
    expectedFormat: "csv" | "json",
    previousLocation: string | null
  ): Promise<{ version?: unknown; location?: unknown }>;
  cleanupDatasetCache(accountId: string, name: string, location: string): Promise<unknown>;
}

export interface IngestionExecutorDependencies {
  readonly store: SqliteIngestionStore;
  readonly lifecycle: IngestionVectorLifecycle;
  readonly data: IngestionDataOperations;
  readonly embeddingDimension: number;
  readonly embed: (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
  readonly resolveArtifact: (input: {
    accountId: string;
    sourceId: string;
    name: string;
    filePath: string;
    connector?: string;
  }) => Promise<string | undefined>;
  readonly isTabular: (filePath: string, mime: string) => boolean;
  readonly extractText: (filePath: string, mime: string) => Promise<string>;
  readonly chunkText: (text: string, size: number, overlap: number) => string[];
  readonly datasetRegistration: (input: {
    sourceId: string;
    filePath: string;
    displayName: string;
    url?: string;
    connector?: string;
    expectedFormat?: "csv" | "json";
  }) => Record<string, unknown>;
  readonly datasetPreviewText: (preview: Record<string, unknown>) => string;
}

export class ConnectorRefreshActivatedError extends Error {
  constructor() {
    super("connector refresh activated; durable promotion must retry");
    this.name = "ConnectorRefreshActivatedError";
  }
}

/** Extracts, embeds, and executes the two-store promotion protocol for one exact lease. */
export class IngestionExecutor {
  constructor(private readonly dependencies: IngestionExecutorDependencies) {
    if (
      !Number.isSafeInteger(dependencies.embeddingDimension) ||
      dependencies.embeddingDimension < 1 ||
      dependencies.embeddingDimension > 16_384
    ) {
      throw new RangeError("embeddingDimension is invalid");
    }
  }

  async ingest(input: IngestionExecutionInput): Promise<void> {
    const { store, lifecycle, data } = this.dependencies;
    const sourceMeta = recordMeta(input.meta);
    const refreshVersion =
      input.connector && typeof sourceMeta.connector_refresh_version === "string"
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
    const expectedFormat: "csv" | "json" = input.mime.toLowerCase().includes("json") ? "json" : "csv";
    const requestedPath = candidateLocation ?? input.filePath;
    let activationStarted = false;

    await store.assertLease(input.accountId, input.sourceId, input.generation, input.leaseToken);
    await store.markSourceProcessing(input.accountId, input.sourceId, input.generation, input.leaseToken);
    try {
      const artifact = await this.dependencies.resolveArtifact({
        accountId: input.accountId,
        sourceId: input.sourceId,
        name: input.name,
        filePath: requestedPath,
        connector: input.connector,
      });
      if (!artifact) throw new Error("source artifact is unavailable");

      let text: string;
      if (refreshVersion && candidateLocation && input.connector && input.url) {
        text = this.dependencies.datasetPreviewText(
          await data.extractPreparedDataset(input.accountId, input.name, refreshVersion, expectedFormat, 40)
        );
      } else if (this.dependencies.isTabular(artifact, input.mime)) {
        const registration = await data.registerDataset(
          input.accountId,
          input.name,
          this.dependencies.datasetRegistration({
            sourceId: input.sourceId,
            filePath: artifact,
            displayName: input.displayName,
            url: input.url,
            connector: input.connector,
            expectedFormat: input.connector ? expectedFormat : undefined,
          })
        );
        const previousLocation =
          input.connector &&
          typeof registration?.previous_location === "string" &&
          registration.previous_location !== artifact
            ? registration.previous_location
            : undefined;
        if (previousLocation) {
          await store.rememberConnectorPreviousLocation({
            accountId: input.accountId,
            sourceId: input.sourceId,
            generation: input.generation,
            leaseToken: input.leaseToken,
            location: previousLocation,
          });
        }
        text = this.dependencies.datasetPreviewText(await data.extractDataset(input.accountId, input.name, 40));
      } else {
        text = await this.dependencies.extractText(artifact, input.mime);
      }
      if (!text.trim()) throw new Error("no readable text extracted");
      const contents = this.dependencies.chunkText(text, 800, 110);
      if (!contents.length) throw new Error("no readable text extracted");
      const chunkMeta: Record<string, string> = { source: input.displayName, kind: input.kind };
      if (input.url) chunkMeta.url = input.url;
      if (input.connector) chunkMeta.connector = input.connector;

      const staged = await lifecycle.stageText({
        accountId: input.accountId,
        sourceId: input.sourceId,
        generation: input.generation,
        leaseToken: input.leaseToken,
        sourceName: input.displayName,
        chunks: contents.map((content) => ({ content, meta: chunkMeta })),
      });
      for (let start = 0; start < staged.length; start += EMBED_BATCH_SIZE) {
        await store.assertLease(input.accountId, input.sourceId, input.generation, input.leaseToken);
        const batch = staged.slice(start, start + EMBED_BATCH_SIZE);
        let embeddings: number[][];
        try {
          embeddings = await this.dependencies.embed(batch.map((chunk) => chunk.content));
        } catch {
          throw new IngestionStageError("EMBEDDING_UNAVAILABLE");
        }
        this.assertEmbeddings(embeddings, batch.length);
        await lifecycle.indexBatch({
          accountId: input.accountId,
          sourceId: input.sourceId,
          generation: input.generation,
          leaseToken: input.leaseToken,
          chunks: batch.map((chunk, index) => ({ chunk, vector: embeddings[index]! })),
        });
      }

      const sizeBytes = await fs.stat(artifact).then((stat) => stat.size);
      await store.assertLease(input.accountId, input.sourceId, input.generation, input.leaseToken);
      if (refreshVersion && candidateLocation && input.connector && input.url) {
        activationStarted = true;
        const activated = await data.activateDatasetRefresh(
          input.accountId,
          input.name,
          refreshVersion,
          input.url,
          input.displayName,
          expectedFormat,
          activationPreviousLocation
        );
        if (activated.version !== refreshVersion || activated.location !== candidateLocation) {
          throw new Error("connector refresh activation mismatch");
        }
        await store.assertLease(input.accountId, input.sourceId, input.generation, input.leaseToken);
      }

      await lifecycle.promote({
        accountId: input.accountId,
        sourceId: input.sourceId,
        generation: input.generation,
        leaseToken: input.leaseToken,
        sizeBytes,
        ...(refreshVersion ? { promotedFilePath: artifact } : {}),
      });

      const current = await store.getSource(input.accountId, input.sourceId);
      const previous = current?.meta.connector_previous_location;
      if (input.connector && typeof previous === "string" && previous && previous !== current.filePath) {
        await data.cleanupDatasetCache(input.accountId, input.name, previous);
        await store.clearSourceMetaValue({
          accountId: input.accountId,
          sourceId: input.sourceId,
          key: "connector_previous_location",
          expectedValue: previous,
        });
      }
    } catch (error) {
      if (refreshVersion && activationStarted) throw new ConnectorRefreshActivatedError();
      throw error;
    }
  }

  private assertEmbeddings(embeddings: number[][], expected: number): void {
    if (
      embeddings.length !== expected ||
      embeddings.some(
        (vector) =>
          !Array.isArray(vector) ||
          vector.length !== this.dependencies.embeddingDimension ||
          vector.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
      )
    ) {
      throw new IngestionStageError("EMBEDDING_INVALID_RESPONSE");
    }
  }
}

export interface IngestionWorkerDependencies {
  readonly store: SqliteIngestionStore;
  readonly sources: SourceStore;
  readonly lifecycle: IngestionVectorLifecycle;
  readonly ingest: (input: IngestionExecutionInput) => Promise<void>;
  readonly now?: () => Date;
  readonly heartbeatIntervalMs?: number;
}

/** Single-process durable lease worker backed by serialized SQLite claims. */
export class IngestionWorker {
  private readonly now: () => Date;
  private readonly heartbeatIntervalMs: number;

  constructor(private readonly dependencies: IngestionWorkerDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 1) {
      throw new RangeError("heartbeatIntervalMs must be a positive safe integer");
    }
  }

  async processOne(): Promise<boolean> {
    const job = await this.dependencies.store.claimNext("pending", this.now());
    if (!job) return false;
    const source = await this.dependencies.sources.getSource(job.accountId, job.sourceId);
    const meta = recordMeta(source?.meta);
    const candidate =
      typeof meta.connector_candidate_location === "string" ? meta.connector_candidate_location : undefined;
    const filePath = source?.filePath ?? candidate;
    if (!source || !filePath || !job.leaseToken) {
      await this.dependencies.lifecycle.failGeneration({
        accountId: job.accountId,
        sourceId: job.sourceId,
        generation: job.generation,
        leaseToken: job.leaseToken ?? undefined,
        errorCode: "SOURCE_UNAVAILABLE",
        failure: publicIngestionFailure("SOURCE_UNAVAILABLE"),
      });
      return true;
    }

    let heartbeatTail = Promise.resolve();
    const heartbeat = setInterval(() => {
      heartbeatTail = heartbeatTail.then(async () => {
        await this.dependencies.store
          .heartbeat(job.accountId, job.sourceId, job.generation, job.leaseToken!)
          .catch(() => false);
      });
    }, this.heartbeatIntervalMs);
    heartbeat.unref?.();
    try {
      await this.dependencies.ingest({
        accountId: source.accountId,
        sourceId: source.id,
        name: source.name,
        filePath,
        mime: source.mime ?? "application/octet-stream",
        kind: source.kind,
        displayName: source.displayName,
        url: source.url ?? undefined,
        connector: source.connectorId ?? undefined,
        generation: job.generation,
        leaseToken: job.leaseToken,
        meta: source.meta,
      });
    } catch (error) {
      const code = ingestionFailureCode(error);
      const retrying =
        error instanceof ConnectorRefreshActivatedError ||
        (job.attempts < MAX_JOB_ATTEMPTS && isRetryableIngestError(error));
      const retryAt = retrying
        ? new Date(this.now().getTime() + Math.min(300, 2 ** Math.min(job.attempts, 8)) * 1_000)
        : undefined;
      await this.dependencies.lifecycle.failGeneration({
        accountId: job.accountId,
        sourceId: job.sourceId,
        generation: job.generation,
        leaseToken: job.leaseToken,
        errorCode: code,
        failure: publicIngestionFailure(code),
        terminal: !retrying,
        retryAt,
      });
    } finally {
      clearInterval(heartbeat);
      await heartbeatTail;
    }
    return true;
  }
}

function recordMeta(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Optional corrupt metadata is ignored; durable columns remain authoritative.
    }
  }
  return {};
}

export function ingestionFailureCode(error: unknown): IngestionFailureCode {
  if (error instanceof IngestionStageError) return error.failureCode;
  if (error instanceof DataServiceError) {
    if (error.status === 422) return "DATASET_PARSE_FAILED";
    if (error.status === 404) return "SOURCE_UNAVAILABLE";
    if (error.status === 429 || error.status >= 500) return "DATA_SERVICE_UNAVAILABLE";
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("no readable text")) return "NO_READABLE_TEXT";
  if (message.includes("not supported")) return "UNSUPPORTED_FORMAT";
  if (message.includes("artifact is unavailable")) return "SOURCE_UNAVAILABLE";
  return "INGEST_FAILED";
}

function isRetryableIngestError(error: unknown): boolean {
  if (error instanceof IngestionStageError) return error.failureCode === "EMBEDDING_UNAVAILABLE";
  if (error instanceof DataServiceError) return error.status === 429 || error.status >= 500;
  const message = error instanceof Error ? error.message : "";
  return !["no readable text", "not supported", "artifact is unavailable", "shape mismatch", "superseded"].some(
    (fragment) => message.includes(fragment)
  );
}

export function jobRequestContext(job: IngestionJob): string {
  return `ingest.${job.sourceId}.${job.generation}`;
}
