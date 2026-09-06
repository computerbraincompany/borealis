import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import { config } from "../config.js";

/**
 * Durable staging for knowledge transports (M14 stage 2).
 *
 * Folder and WebDAV transports never invent a private storage namespace:
 * every managed byte is written into the ordinary account/source upload
 * directory `uploads/<account-id>/<source-id>/` that browser uploads use, so
 * the existing ingestion artifact proof (`resolveSourceArtifact`) and source
 * cleanup contracts hold unchanged. Files are written exactly once
 * (`O_CREAT|O_EXCL`, no symlink following, mode `0600`) under a content-hash
 * derived name, and the returned path is the final durable path — staging is
 * a copy, never a move of the upstream bytes.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_STAGE_NAME_ATTEMPTS = 64;
const MAX_STAGE_FILE_BYTES_SLACK = 1;

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function isExactDirectory(lexical: string): Promise<boolean> {
  const stat = await fs.lstat(lexical).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  const resolved = await fs.realpath(lexical).catch(() => undefined);
  return resolved === lexical;
}

/**
 * Ensure the exact `uploads/<account>/<source>` directory exists and is a
 * real (never symlinked) directory, mirroring the storage-namespace proofs of
 * `storageArtifacts` but tolerating an already-present directory (changed
 * items restage inside a source directory that already owns earlier bytes).
 */
export async function ensureUploadResourceDirectory(accountId: string, sourceId: string): Promise<string> {
  if (!UUID_RE.test(accountId) || !UUID_RE.test(sourceId)) throw new Error("invalid knowledge staging identity");
  await fs.mkdir(config.uploadDir, { recursive: true });
  const root = await fs.realpath(config.uploadDir);
  const accountDirectory = path.join(root, accountId);
  const resourceDirectory = path.join(accountDirectory, sourceId);
  await fs.mkdir(accountDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await isExactDirectory(accountDirectory))) throw new Error("unsafe knowledge staging namespace");
  await fs.mkdir(resourceDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await isExactDirectory(resourceDirectory))) throw new Error("unsafe knowledge staging namespace");
  return resourceDirectory;
}

/** Upload-style bounded display sanitization of a staged filename base. */
export function stagedFileBase(contentHash: string, displayName: string): string {
  const safe =
    path
      .basename(displayName)
      .replace(/[^\w.\- ]+/g, "_")
      .slice(0, 120) || "file";
  return `${contentHash.slice(0, 12)}-${safe}`;
}

export interface StagedWrite {
  readonly file_path: string;
  readonly content_hash: string;
  readonly size_bytes: number;
}

/**
 * Write one staged copy: stream `chunks` into `directory` under
 * `<base>` (collision-suffixed), hashing as we go, capped at `maxBytes`, and
 * commit atomically enough for the durable ledger: an `O_EXCL` exclusive
 * file at mode `0600`, fsynced before the path is returned. A failed write
 * removes exactly its own partial file. The caller pairs the returned hash
 * with the scanned hash; a mismatch is the standard stale-preview refusal.
 */
export async function writeStagedFile(
  directory: string,
  base: string,
  chunks: AsyncIterable<Buffer | string> | Iterable<Buffer | string>,
  options: { readonly signal: AbortSignal; readonly maxBytes: number }
): Promise<StagedWrite> {
  options.signal.throwIfAborted();
  let handle: FileHandle | undefined;
  let filePath = "";
  for (let attempt = 0; attempt < MAX_STAGE_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt}`;
    const candidatePath = path.join(directory, candidate);
    try {
      handle = await fs.open(
        candidatePath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600
      );
      filePath = candidatePath;
      break;
    } catch (error) {
      if (isNodeError(error, "EEXIST")) continue;
      throw error;
    }
  }
  if (!handle) throw new Error("knowledge staging filename space is exhausted");
  const hash = createHash("sha256");
  let total = 0;
  try {
    for await (const raw of chunks) {
      options.signal.throwIfAborted();
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.length;
      if (total > options.maxBytes + MAX_STAGE_FILE_BYTES_SLACK) throw new Error("staged file exceeds its byte budget");
      hash.update(chunk);
      await handle.write(chunk);
    }
    if (total > options.maxBytes) throw new Error("staged file exceeds its byte budget");
    await handle.sync();
    await handle.chmod(0o600).catch(() => undefined);
    await handle.close();
    handle = undefined;
    return Object.freeze({ file_path: filePath, content_hash: hash.digest("hex"), size_bytes: total });
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(filePath, { force: true }).catch(() => {});
    throw error;
  }
}

/** Stream one locally proven file path into `writeStagedFile`'s chunk form. */
export async function* readFileChunks(file: string, signal: AbortSignal): AsyncGenerator<Buffer> {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return;
      yield Buffer.from(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close().catch(() => {});
  }
}
