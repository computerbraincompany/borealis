import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { KnowledgeConnectionKind, KnowledgeScanBounds } from "../db/stores/knowledgeStore.js";
import type { SqliteLedger } from "../db/types.js";
import {
  KnowledgeScanFailureError,
  type KnowledgeInspection,
  type KnowledgeScanOutcome,
  type KnowledgeStagedEntry,
  type KnowledgeStageRequest,
  type KnowledgeTransportAdapter,
  type KnowledgeTransportContext,
} from "../knowledgeRefresh.js";

/**
 * The in-process deterministic fake for the stage-2 transport seam.
 *
 * Upstream state is an in-memory path -> content map plus three switches:
 * `unauthorized` (every read fails closed), `forbidden` (a named path is
 * reported skipped, proving skip reporting), and hidden/depth simulation is
 * unnecessary here because the folder adapter itself is stage 2. `stage`
 * writes into a real temp directory so staged paths are durable files and
 * content hashes are the sha256 of the actual bytes.
 */

const hash = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");

export class DeterministicKnowledgeAdapter implements KnowledgeTransportAdapter {
  readonly kind: KnowledgeConnectionKind;
  readonly stagingDir: string;
  files = new Map<string, string>();
  unauthorized = false;
  skipped: { relative_path: string; reason: "hidden" | "symlink" | "excluded" | "depth" | "limit" }[] = [];
  scanCount = 0;
  inspectCount = 0;
  lastSecrets: KnowledgeTransportContext["secrets"];

  constructor(kind: KnowledgeConnectionKind, stagingDir: string) {
    this.kind = kind;
    this.stagingDir = stagingDir;
  }

  put(relativePath: string, content: string): void {
    this.files.set(relativePath, content);
  }

  rename(from: string, to: string): void {
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`fixture: ${from} not present`);
    this.files.delete(from);
    this.files.set(to, content);
  }

  remove(relativePath: string): void {
    this.files.delete(relativePath);
  }

  async scan(
    context: KnowledgeTransportContext,
    bounds: KnowledgeScanBounds,
    managed: readonly { relative_path: string; content_hash: string }[],
    signal: AbortSignal
  ): Promise<KnowledgeScanOutcome> {
    signal.throwIfAborted();
    if (this.unauthorized) {
      throw new KnowledgeScanFailureError("KNOWLEDGE_UPSTREAM_UNAUTHORIZED", "upstream rejected credentials");
    }
    this.scanCount += 1;
    this.lastSecrets = context.secrets;
    void managed;
    const files = [...this.files.entries()].map(([relative_path, content]) => ({
      relative_path,
      content_hash: hash(content),
      size_bytes: Buffer.byteLength(content, "utf8"),
    }));
    if (files.length > bounds.maxEntries) {
      throw new KnowledgeScanFailureError("KNOWLEDGE_SCAN_LIMIT", "too many supported files");
    }
    return {
      files,
      unsupported: [],
      skipped: this.skipped,
      visited_entries: files.length,
      directories: new Set(files.map((file) => path.posix.dirname(file.relative_path))).size,
      aggregate_bytes: files.reduce((total, file) => total + file.size_bytes, 0),
    };
  }

  async inspect(
    context: KnowledgeTransportContext,
    request: { relative_path: string },
    signal: AbortSignal
  ): Promise<KnowledgeInspection> {
    signal.throwIfAborted();
    if (this.unauthorized) return { state: "unauthorized" };
    this.lastSecrets = context.secrets;
    this.inspectCount += 1;
    const content = this.files.get(request.relative_path);
    if (content === undefined) return { state: "missing" };
    return {
      state: "present",
      content_hash: hash(content),
      size_bytes: Buffer.byteLength(content, "utf8"),
      mtime_hint: `mtime-${hash(content).slice(0, 8)}`,
      etag_hint: `etag-${hash(content).slice(0, 8)}`,
    };
  }

  async stage(
    _context: KnowledgeTransportContext,
    request: KnowledgeStageRequest,
    signal: AbortSignal
  ): Promise<KnowledgeStagedEntry> {
    signal.throwIfAborted();
    const content = this.files.get(request.relative_path);
    if (content === undefined) throw new Error(`fixture: ${request.relative_path} vanished before staging`);
    const digest = hash(content);
    const fileName = `${digest.slice(0, 12)}-${request.source_id ?? "new"}-${path.basename(request.relative_path)}`;
    const filePath = path.join(this.stagingDir, fileName);
    await fs.writeFile(filePath, content, "utf8");
    return {
      file_path: filePath,
      content_hash: digest,
      size_bytes: Buffer.byteLength(content, "utf8"),
      mime: path.extname(request.relative_path) === ".csv" ? "text/csv" : "text/markdown",
      kind: "document",
    };
  }
}

/**
 * Reserves generations directly in the durable ingestion ledger, exactly as
 * normal ingestion admission does, and optionally promotes immediately so
 * tests can await real ready generations. `calls` proves unchanged content
 * never reserves anything, and `generations` captures the reserved sequence.
 */
export function makeIngestionSimulator(
  ledger: SqliteLedger,
  state: { calls: number; generations: number[]; autoPromote: boolean }
): (accountId: string, sourceId: string) => Promise<{ generation: number }> {
  return async (accountId: string, sourceId: string) => {
    state.calls += 1;
    const generation = await ledger.withImmediateTransaction((transaction) => {
      const source = transaction.get<{ ready_generation: unknown }>(
        "SELECT ready_generation FROM sources WHERE id=? AND account_id=?",
        [sourceId, accountId]
      );
      if (!source) throw new Error("simulated reservation for a foreign source");
      const job = transaction.get<{ generation: unknown }>(
        "SELECT generation FROM ingestion_jobs WHERE source_id=? AND account_id=?",
        [sourceId, accountId]
      );
      const next = job ? Number(job.generation) + 1 : Math.max(1, Number(source.ready_generation ?? 0) + 1);
      transaction.run(
        `INSERT INTO ingestion_jobs (source_id,account_id,generation,status,attempts,available_at,updated_at)
         VALUES (?,?,?,'pending',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(source_id) DO UPDATE SET
           generation=excluded.generation,status='pending',attempts=0,available_at=excluded.available_at,updated_at=excluded.updated_at`,
        [sourceId, accountId, next]
      );
      transaction.run("UPDATE sources SET status='index' WHERE id=? AND account_id=?", [sourceId, accountId]);
      if (state.autoPromote) {
        transaction.run("UPDATE ingestion_jobs SET status='done' WHERE source_id=? AND account_id=?", [
          sourceId,
          accountId,
        ]);
        transaction.run("UPDATE sources SET status='ready',ready_generation=? WHERE id=? AND account_id=?", [
          next,
          sourceId,
          accountId,
        ]);
      }
      return next;
    });
    state.generations.push(generation);
    return { generation };
  };
}

/** Simulates the durable ingestion worker promoting one queued generation. */
export async function promoteGeneration(ledger: SqliteLedger, sourceId: string, generation = 1): Promise<void> {
  await ledger.run("UPDATE ingestion_jobs SET status='done' WHERE source_id=?", [sourceId]);
  await ledger.run("UPDATE sources SET status='ready',ready_generation=? WHERE id=?", [generation, sourceId]);
}
