import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";

import { config } from "../config.js";
import {
  KnowledgeConnectionConfigError,
  normalizeKnowledgeRelativePath,
  type KnowledgeConnectionRecord,
  type KnowledgeItemRecord,
  type KnowledgeScanBounds,
} from "../db/stores/knowledgeStore.js";
import { isSupportedSourcePath, sourceKindForPath, sourceMimeForPath } from "../ingestSupport.js";

import {
  KnowledgeScanFailureError,
  type KnowledgeInspection,
  type KnowledgeScanFileEntry,
  type KnowledgeScanOutcome,
  type KnowledgeScanSkipEntry,
  type KnowledgeScanUnsupportedEntry,
  type KnowledgeStagedEntry,
  type KnowledgeStageRequest,
  type KnowledgeTransportAdapter,
  type KnowledgeTransportContext,
} from "../knowledgeRefresh.js";
import type { DesktopFolderGrantConsumption, DesktopFolderGrantRegistry } from "./grants.js";
import { desktopFolderGrants } from "./grants.js";
import { ensureUploadResourceDirectory, readFileChunks, stagedFileBase, writeStagedFile } from "./uploadStaging.js";

/**
 * `desktop_folder` knowledge transport (M14 stage 2).
 *
 * The scan is the shared, bounded traversal that a later watch slice will
 * reuse: one iterative walk from the granted root with a visited-entry cap, a
 * directory-depth cap, a managed-file cap, and an aggregate-byte cap. Hidden
 * directories and every symlink are excluded and reported as skips; `.git`,
 * `node_modules`, and Borealis workspace directories are excluded and
 * reported. Exceeding a bound fails the entire scan — a preview never
 * activates from partial traversal.
 *
 * Selections are staged as an ordinary copy into the exact account/source
 * upload directory that owns (or will own) the bytes, so ingestion admission
 * and artifact proof remain the normal ones. Identity is the normalized
 * relative path; content hashes decide unchanged. The adapter never invokes
 * ingestion and never follows a symlink component, at read or write time.
 */

/** Directory basenames excluded as version control / dependency noise. */
export const FOLDER_EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".hg",
  ".svn",
  ".venv",
]);

/**
 * Borealis workspace directories: the browser-development storage root
 * (`.borealis`) and the Electron application-support directory (`Borealis`).
 * Scanning one would recursively ingest the product's own durable state.
 */
export const BOREALIS_WORKSPACE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([".borealis", "Borealis"]);

export function isExcludedDirectoryName(name: string): boolean {
  return FOLDER_EXCLUDED_DIRECTORY_NAMES.has(name) || BOREALIS_WORKSPACE_DIRECTORY_NAMES.has(name);
}

const SCAN_LIMIT = "KNOWLEDGE_SCAN_LIMIT";
const FOLDER_UNAVAILABLE = "KNOWLEDGE_FOLDER_UNAVAILABLE";
const PATH_INVALID = "KNOWLEDGE_RELATIVE_PATH_INVALID";
const TOO_LARGE = "KNOWLEDGE_FILE_TOO_LARGE";

function requireDesktopRoot(connection: KnowledgeConnectionRecord): string {
  if (connection.kind !== "desktop_folder") {
    throw new KnowledgeConnectionConfigError("the folder transport only serves desktop_folder connections");
  }
  if (connection.config.kind !== "desktop_folder") {
    throw new KnowledgeScanFailureError(FOLDER_UNAVAILABLE, "the folder connection configuration is unreadable");
  }
  return connection.config.root_path;
}

function relativeOf(dirRelative: string, name: string): string {
  return dirRelative ? `${dirRelative}/${name}` : name;
}

/**
 * Prove every path component under `root` (and the leaf) is free of symlink
 * components. Returns the leaf stat, or `null` when any proof fails (missing,
 * symlink component, non-directory intermediate, or a non-file leaf when one
 * is required).
 */
async function proveRealPathNoSymlink(
  root: string,
  segments: readonly string[],
  requireLeafFile: boolean
): Promise<import("node:fs").Stats | null> {
  if (segments.length < 1) return null;
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat || stat.isSymbolicLink()) return null;
    const isLast = index === segments.length - 1;
    if (!isLast && !stat.isDirectory()) return null;
    if (isLast && requireLeafFile && !stat.isFile()) return null;
  }
  return fs.lstat(current).catch(() => null);
}

async function proveRootDirectory(root: string): Promise<boolean> {
  const stat = await fs.lstat(root).catch(() => null);
  return Boolean(stat && !stat.isSymbolicLink() && stat.isDirectory());
}

function tooLarge(message = "a managed file exceeds the per-file upload budget"): KnowledgeScanFailureError {
  return new KnowledgeScanFailureError(TOO_LARGE, message);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function hashLocalFile(
  file: string,
  maxBytes: number,
  signal: AbortSignal
): Promise<{ hash: string; size: number }> {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw tooLarge();
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return Object.freeze({ hash: hash.digest("hex"), size: total });
}

export class DesktopFolderKnowledgeAdapter implements KnowledgeTransportAdapter {
  readonly kind = "desktop_folder" as const;

  /**
   * One bounded traversal. The shape is deliberately a plain queue walk over
   * `(directory, relative, depth)` entries so the watch slice can rescan with
   * the same bounds, skip rules, and hashing.
   */
  async scan(
    context: KnowledgeTransportContext,
    bounds: KnowledgeScanBounds,
    managed: readonly KnowledgeItemRecord[],
    signal: AbortSignal
  ): Promise<KnowledgeScanOutcome> {
    void managed;
    const root = requireDesktopRoot(context.connection);
    if (!(await proveRootDirectory(root))) {
      throw new KnowledgeScanFailureError(FOLDER_UNAVAILABLE, "the granted folder is unavailable");
    }
    const files: KnowledgeScanFileEntry[] = [];
    const unsupported: KnowledgeScanUnsupportedEntry[] = [];
    const skipped: KnowledgeScanSkipEntry[] = [];
    let visited = 0;
    let directories = 0;
    let aggregate = 0;
    const queue: Array<{ dir: string; relative: string; depth: number }> = [{ dir: root, relative: "", depth: 0 }];
    while (queue.length > 0) {
      const { dir, relative, depth } = queue.shift()!;
      signal.throwIfAborted();
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => {
        throw new KnowledgeScanFailureError(FOLDER_UNAVAILABLE, "a directory in the granted folder vanished");
      });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        signal.throwIfAborted();
        visited += 1;
        if (visited > bounds.maxVisited) {
          throw new KnowledgeScanFailureError(SCAN_LIMIT, "the scan visited too many entries");
        }
        const entryRelative = relativeOf(relative, entry.name);
        if (entry.name.startsWith(".")) {
          skipped.push({ relative_path: entryRelative, reason: "hidden" });
          continue;
        }
        if (entry.isSymbolicLink()) {
          skipped.push({ relative_path: entryRelative, reason: "symlink" });
          continue;
        }
        if (entry.isDirectory()) {
          if (isExcludedDirectoryName(entry.name)) {
            skipped.push({ relative_path: entryRelative, reason: "excluded" });
            continue;
          }
          if (depth + 1 > bounds.maxDepth) {
            skipped.push({ relative_path: entryRelative, reason: "depth" });
            continue;
          }
          // `directories` is the maximum directory level actually traversed
          // (the preview ledger validates it against the depth bound).
          directories = Math.max(directories, depth + 1);
          queue.push({ dir: path.join(dir, entry.name), relative: entryRelative, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) {
          skipped.push({ relative_path: entryRelative, reason: "excluded" });
          continue;
        }
        const absolute = path.join(dir, entry.name);
        const stat = await fs.stat(absolute).catch(() => null);
        if (!stat || !stat.isFile()) continue;
        if (!isSupportedSourcePath(entry.name) || stat.size > config.maxUploadBytes) {
          unsupported.push({ relative_path: entryRelative, size_bytes: stat.size });
          continue;
        }
        if (files.length + 1 > bounds.maxEntries) {
          throw new KnowledgeScanFailureError(SCAN_LIMIT, "the scan exceeded its managed-entry budget");
        }
        aggregate += stat.size;
        if (aggregate > bounds.maxAggregateBytes) {
          throw new KnowledgeScanFailureError(SCAN_LIMIT, "the scan exceeded its aggregate byte budget");
        }
        const hashed = await hashLocalFile(absolute, config.maxUploadBytes, signal).catch((error: unknown) => {
          if (error instanceof KnowledgeScanFailureError) throw error;
          throw tooLarge();
        });
        files.push({
          relative_path: entryRelative,
          content_hash: hashed.hash,
          size_bytes: hashed.size,
          mtime_hint: stat.mtime.toISOString(),
          etag_hint: null,
        });
      }
    }
    return Object.freeze({
      files: Object.freeze(files),
      unsupported: Object.freeze(unsupported),
      skipped: Object.freeze(skipped),
      visited_entries: visited,
      directories,
      aggregate_bytes: aggregate,
    });
  }

  async inspect(
    context: KnowledgeTransportContext,
    request: { relative_path: string; source_id: string; source_file_path: string | null },
    signal: AbortSignal
  ): Promise<KnowledgeInspection> {
    signal.throwIfAborted();
    const root = requireDesktopRoot(context.connection);
    const segments = managedSegments(request.relative_path);
    if (!segments) return { state: "missing" };
    if (!(await proveRootDirectory(root))) return { state: "missing" };
    const stat = await proveRealPathNoSymlink(root, segments, true);
    if (!stat || !stat.isFile()) return { state: "missing" };
    if (stat.size > config.maxUploadBytes) throw tooLarge();
    let hashed: { hash: string; size: number };
    try {
      hashed = await hashLocalFile(path.join(root, ...segments), config.maxUploadBytes, signal);
    } catch (error) {
      if (error instanceof KnowledgeScanFailureError) throw error;
      if (isNodeErrorWithCode(error, "ENOENT")) return { state: "missing" };
      throw tooLarge();
    }
    return Object.freeze({
      state: "present",
      content_hash: hashed.hash,
      size_bytes: hashed.size,
      mtime_hint: stat.mtime.toISOString(),
      etag_hint: null,
    });
  }

  async stage(
    context: KnowledgeTransportContext,
    request: KnowledgeStageRequest,
    signal: AbortSignal
  ): Promise<KnowledgeStagedEntry> {
    signal.throwIfAborted();
    const root = requireDesktopRoot(context.connection);
    const segments = managedSegments(request.relative_path);
    if (!segments) throw new KnowledgeScanFailureError(PATH_INVALID, "the managed relative path is invalid");
    const upstream = path.join(root, ...segments);
    if (!(await proveRootDirectory(root))) {
      throw new KnowledgeScanFailureError(FOLDER_UNAVAILABLE, "the granted folder is unavailable");
    }
    const sourceStat = await proveRealPathNoSymlink(root, segments, true);
    if (!sourceStat || !sourceStat.isFile()) {
      throw new KnowledgeScanFailureError(FOLDER_UNAVAILABLE, "the upstream file is unavailable");
    }
    if (sourceStat.size > config.maxUploadBytes) throw tooLarge();
    const sourceId = request.source_id ?? request.proposed_source_id ?? null;
    if (!sourceId) throw new KnowledgeScanFailureError(PATH_INVALID, "staging requires the owning source identity");
    // Two passes: hash first so the durable staged name is content-derived,
    // then stream the copy. A drift between passes surfaces as the standard
    // stale-preview hash refusal in the caller.
    let digest: string;
    try {
      digest = (await hashLocalFile(upstream, config.maxUploadBytes, signal)).hash;
    } catch (error) {
      if (error instanceof KnowledgeScanFailureError) throw error;
      if (isNodeErrorWithCode(error, "ENOENT")) {
        throw new KnowledgeScanFailureError(FOLDER_UNAVAILABLE, "the upstream file is unavailable");
      }
      throw tooLarge();
    }
    const directory = await ensureUploadResourceDirectory(context.accountId, sourceId);
    const staged = await writeStagedFile(
      directory,
      stagedFileBase(digest, path.basename(upstream)),
      readFileChunks(upstream, signal),
      { signal, maxBytes: config.maxUploadBytes }
    );
    if (staged.content_hash !== digest) {
      await fs.rm(staged.file_path, { force: true }).catch(() => {});
      throw new KnowledgeScanFailureError("KNOWLEDGE_STAGED_HASH_MISMATCH", "the staged copy drifted from upstream");
    }
    return Object.freeze({
      file_path: staged.file_path,
      content_hash: staged.content_hash,
      size_bytes: staged.size_bytes,
      mime: sourceMimeForPath(request.relative_path),
      kind: sourceKindForPath(request.relative_path),
    });
  }
}

/** Normalize a scan/inspect path to managed identity segments. */
function managedSegments(relativePath: string): string[] | null {
  const normalized = normalizeKnowledgeRelativePath(relativePath);
  if (normalized === null) return null;
  return normalized.split("/");
}

export const desktopFolderKnowledgeAdapter: KnowledgeTransportAdapter = new DesktopFolderKnowledgeAdapter();

/**
 * Create a `desktop_folder` connection exclusively from a consumed grant.
 * This is the only composition path that may install a local root: the grant
 * registry has proven the canonical directory, and consume-once semantics
 * bind the selection to exactly this authenticated account. The durable
 * connection row (account + canonical root_path) is the permanent provenance
 * record — a `desktop_folder` connection with an unconsumed root can never
 * exist — and every later scan re-proves the root from disk (existence, real
 * directory, no symlink component), so a replaced or symlinked root fails
 * closed instead of widening trust.
 */
export async function createDesktopFolderConnection(
  store: {
    createConnection: (
      accountId: string,
      input: {
        name: string;
        kind: "desktop_folder";
        config: { root_path: string; display_label: string };
        library_id: string;
        watch_enabled?: boolean;
      }
    ) => Promise<unknown>;
  },
  input: {
    accountId: string;
    grantId: string;
    name: string;
    libraryId: string;
    watchEnabled?: boolean;
    registry?: DesktopFolderGrantRegistry;
  }
): Promise<{ grant: DesktopFolderGrantConsumption; connection: unknown }> {
  const grant = await (input.registry ?? desktopFolderGrants).consume(input.accountId, input.grantId);
  const connection = await store.createConnection(input.accountId, {
    name: input.name,
    kind: "desktop_folder",
    config: { root_path: grant.root_path, display_label: grant.display_label },
    library_id: input.libraryId,
    watch_enabled: input.watchEnabled,
  });
  return Object.freeze({ grant, connection });
}
