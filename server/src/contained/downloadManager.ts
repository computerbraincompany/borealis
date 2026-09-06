/**
 * Owned, bounded, drainable contained-model downloads (Plan 008).
 *
 * Transport: downloads never use global `fetch`. The default transport routes
 * `https:` through the untouched public-destination policy and `http:`
 * through the separately validated loopback-only resolver, then pins the
 * validated DNS result to the socket with normal TLS hostname verification.
 * One combined cancel-plus-timeout signal covers resolution, request, and
 * every body byte. Requests send `Accept-Encoding: identity`; encoded bodies
 * are rejected. Fresh transfers accept only `200`; resumes accept `200`
 * (truncate/restart through the opened handle) or a `206` whose
 * `Content-Range` starts exactly at the opened partial's size and ends
 * exactly at `TOTAL - 1`.
 *
 * File authority: resumable partials live only below the real, non-symlink
 * `<contained>/.borealis-partials/` directory; ambiguous legacy root-level
 * `*.part` entries are never read, migrated, truncated, or deleted. One
 * `O_NOFOLLOW` handle is opened per attempt and every resume-size read,
 * write, truncate, `fsync`, SHA-256, and identity recheck uses that same
 * handle. Publication is one atomic rename through the still-absent final
 * path, gated by a `publicationStarted` linearization point with no `await`
 * between the final abort check, the flag, and the initiated rename.
 *
 * Ownership: `start()` installs the case-folded reservation, abort
 * controller, state row, and tracked run promise synchronously before its
 * first `await`; only the exact entry may release its reservation. A
 * download state row is observability, never ownership. `quiesceAndDrain()`
 * closes admission synchronously, aborts every not-yet-publishing entry, and
 * joins all runs through publication and directory fsync; `beginLifecycle()`
 * reopens admission only after a completed drain.
 *
 * Threat model, consistent with Plan 007: these proofs close deterministic
 * application races and symlink attacks. They are not an OS sandbox; a
 * hostile process with the same OS-user write access to the model directory
 * can still race pathname replacement between checks.
 */
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import type { BigIntStats } from "node:fs";
import type { IncomingMessage } from "node:http";
import {
  combineSignals,
  isLoopbackAddress,
  requestPinned,
  resolveContainedDownloadDestination,
  type ResolvedAddress,
} from "../networkPolicy.js";
import {
  ensureContainedModelRoot,
  ensureContainedPartialsDirectory,
  isReservedArtifactBasename,
} from "./filePolicy.js";

const FILENAME_PATTERN = /^[A-Za-z0-9._-]{1,180}$/;
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;
/** Sane hard default; operators can raise it for large models. */
const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 86_400_000;
const MIN_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_TIMEOUT_MS = 604_800_000;
const DOWNLOAD_USER_AGENT = "Borealis-Contained/1";
const HASH_CHUNK_BYTES = 64 * 1024;

export type ContainedDownloadState = "downloading" | "verifying" | "complete" | "failed" | "canceled";

export interface ContainedDownload {
  readonly filename: string;
  readonly url_host: string;
  readonly state: ContainedDownloadState;
  readonly bytes_received: number;
  readonly total_bytes: number | null;
  readonly error: string | null;
}

/** Internal, mutable bookkeeping; snapshots freeze into ContainedDownload. */
interface MutableContainedDownload {
  filename: string;
  url_host: string;
  state: ContainedDownloadState;
  bytes_received: number;
  total_bytes: number | null;
  error: string | null;
}

export class ContainedDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainedDownloadError";
  }
}

/**
 * Injectable pinned transport following the repository's
 * `{resolve,request}` pattern (connector fetch). `request` must pin the
 * validated addresses to the socket and must not perform a second lookup.
 */
export interface ContainedDownloadTransport {
  resolve(url: URL, signal: AbortSignal): Promise<ResolvedAddress[]>;
  request(
    url: URL,
    addresses: ResolvedAddress[],
    signal: AbortSignal,
    headers: Record<string, string>
  ): Promise<IncomingMessage>;
}

/**
 * Package-internal deterministic seams for transport/publication tests.
 * Production composition (`contained/runtime.ts`) never passes these, and no
 * route input can reach them.
 */
export interface ContainedDownloadTestHooks {
  /** Runs after hashing/identity proof and before the publication rechecks. */
  beforePublication?(context: { filename: string }): Promise<void>;
  /** Replaces `fs.rename` so tests can defer the initiated publication. */
  rename?(from: string, to: string): Promise<void>;
  /** Replaces the best-effort directory fsync so tests can defer it. */
  syncDirectory?(directory: string): Promise<void>;
}

export interface ContainedDownloadDependencies {
  readonly transport?: ContainedDownloadTransport;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly hooks?: ContainedDownloadTestHooks;
}

const defaultTransport: ContainedDownloadTransport = {
  resolve: resolveContainedDownloadDestination,
  request: requestPinned,
};

function envSafeInteger(raw: string | undefined): number | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

function maxDownloadBytes(): number {
  const raw = envSafeInteger(process.env.CONTAINED_MAX_DOWNLOAD_BYTES);
  return raw !== undefined && raw > 0 ? raw : DEFAULT_MAX_DOWNLOAD_BYTES;
}

/** `CONTAINED_DOWNLOAD_TIMEOUT_MS`: 24 h default, 1 min – 7 d closed range. */
function downloadTimeoutMs(): number {
  const raw = envSafeInteger(process.env.CONTAINED_DOWNLOAD_TIMEOUT_MS);
  return raw !== undefined && raw >= MIN_DOWNLOAD_TIMEOUT_MS && raw <= MAX_DOWNLOAD_TIMEOUT_MS
    ? raw
    : DEFAULT_DOWNLOAD_TIMEOUT_MS;
}

function sanitizeFilename(value: unknown): string {
  if (typeof value !== "string" || !FILENAME_PATTERN.test(value) || value.includes("..")) {
    throw new ContainedDownloadError("filename must be 1-180 characters of [A-Za-z0-9._-] without separators");
  }
  // Plan 007's shared predicate: dot-only names, the reserved `.borealis-
  // partials` basename, and any `.part` suffix under ASCII case folding can
  // never be a final model name, rejected before any filesystem touch.
  if (isReservedArtifactBasename(value)) {
    throw new ContainedDownloadError("filename selects a reserved or invalid artifact name");
  }
  return value;
}

function requireSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new ContainedDownloadError("sha256 must be a 64-character hex digest");
  }
  return value.toLowerCase();
}

/** Synchronous host-form screen; the async resolver proves every address. */
function isAcceptedHttpHostForm(parsed: URL): boolean {
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost") return true;
  return isIP(hostname) !== 0 && isLoopbackAddress(hostname);
}

function requireUrl(value: unknown): { url: URL; host: string } {
  let parsed: URL;
  try {
    parsed = new URL(typeof value === "string" ? value : "");
  } catch {
    throw new ContainedDownloadError("url must be an absolute HTTPS or loopback HTTP origin");
  }
  const isLoopbackHttp = parsed.protocol === "http:" && isAcceptedHttpHostForm(parsed);
  if (parsed.protocol !== "https:" && !isLoopbackHttp) {
    throw new ContainedDownloadError("model downloads require HTTPS or a loopback HTTP origin");
  }
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new ContainedDownloadError("url must be a bare origin + path without credentials, query, or fragment");
  }
  return { url: new URL(parsed.toString()), host: parsed.host };
}

interface PartialIdentity {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function identityOf(stat: BigIntStats): PartialIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameIdentity(a: PartialIdentity, b: PartialIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

/** One owned in-flight download. History rows are observability only. */
interface DownloadEntry {
  readonly key: string;
  readonly filename: string;
  readonly url: URL;
  readonly state: MutableContainedDownload;
  readonly abort: AbortController;
  run: Promise<void>;
  cancelReason: "explicit" | "quiesce" | null;
  publicationStarted: boolean;
  owned: { partialPath: string; dev: bigint; ino: bigint } | null;
}

function parseContentRange(value: unknown): { start: number; end: number; total: number } | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) {
    return undefined;
  }
  return { start, end, total };
}

/** Presence-aware numeric header check; malformed declarations are failures. */
function declaredLength(response: IncomingMessage): number | undefined {
  const raw = response.headers["content-length"];
  if (typeof raw !== "string") return undefined;
  if (!/^\d+$/.test(raw)) return Number.NaN;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

function isAbortNamed(error: unknown): boolean {
  const name = (error as Error | undefined)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export function createContainedDownloadManager(dependencies: ContainedDownloadDependencies = {}) {
  /** Observability rows only; never authorize cancel, cleanup, or release. */
  const history = new Map<string, MutableContainedDownload>();
  /** foldKey → the one exact entry that owns the filename. */
  const activeReservations = new Map<string, DownloadEntry>();

  let admitting = true;
  let lifecycleEpoch = 0;
  let drain: { epoch: number; promise: Promise<void>; settled: boolean } | undefined;

  function snapshot(): ContainedDownload[] {
    return [...history.values()].map((state) => ({ ...state }));
  }

  /**
   * Step 4: every check and installation below runs synchronously in the
   * caller's turn — URL/filename/digest/admission validation, the exact
   * reservation, state row, abort controller, and tracked run promise — so a
   * concurrent same-name or case-alias start fails before any filesystem,
   * DNS, or transport work. The attempt itself is deferred: its first
   * statement awaits, so it can never throw or finalize before the entry and
   * its promise exist.
   */
  async function start(input: { url: unknown; filename: unknown; sha256: unknown }): Promise<ContainedDownload> {
    const { url, host } = requireUrl(input.url);
    const filename = sanitizeFilename(input.filename);
    const sha256 = requireSha256(input.sha256);
    if (!admitting) {
      throw new ContainedDownloadError("contained downloads are not accepting new work");
    }
    const key = filename.toLowerCase();
    if (activeReservations.has(key)) {
      throw new ContainedDownloadError("a download for this filename is already active");
    }
    const state: MutableContainedDownload = {
      filename,
      url_host: host,
      state: "downloading",
      bytes_received: 0,
      total_bytes: null,
      error: null,
    };
    const entry: DownloadEntry = {
      key,
      filename,
      url,
      state,
      abort: new AbortController(),
      run: Promise.resolve(),
      cancelReason: null,
      publicationStarted: false,
      owned: null,
    };
    history.set(key, state);
    activeReservations.set(key, entry);
    entry.run = attempt(entry, sha256);
    return { ...state };
  }

  /** The complete deferred run; it always settles its own outcome. */
  async function attempt(entry: DownloadEntry, sha256: string): Promise<void> {
    // Deferred launch: the reservation, state, and run promise are already
    // installed; all setup/transport/work below happens on a later turn.
    await Promise.resolve();
    try {
      await runDownload(entry, sha256);
    } catch (error) {
      recordFailure(entry, error);
    } finally {
      if (entry.cancelReason === "explicit") await removeOwnedPartial(entry);
      if (activeReservations.get(entry.key) === entry) activeReservations.delete(entry.key);
    }
  }

  function recordFailure(entry: DownloadEntry, error: unknown): void {
    if (entry.state.state === "complete" || entry.state.state === "failed" || entry.state.state === "canceled") {
      return;
    }
    if (entry.abort.signal.aborted) {
      // An accepted explicit cancel or lifecycle quiescence: state only.
      // Owned-partial removal belongs to the run's identity-checked release.
      entry.state.state = "canceled";
      entry.state.error = "download cancelled";
      return;
    }
    entry.state.state = "failed";
    if (error instanceof ContainedDownloadError) entry.state.error = error.message;
    else if (isAbortNamed(error)) entry.state.error = "download timed out";
    else entry.state.error = "download failed";
  }

  /**
   * Reject a final-path entry or ASCII-case alias of any file type:
   * direct-child enumeration plus an exact `lstat` requiring ENOENT.
   */
  async function assertFinalNamespaceClear(root: string, key: string, filename: string): Promise<void> {
    const names = await fs.readdir(root);
    if (names.some((name) => name.toLowerCase() === key)) {
      throw new ContainedDownloadError("this filename already exists or collides in the model directory");
    }
    try {
      await fs.lstat(path.join(root, filename));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ContainedDownloadError("this filename already exists or collides in the model directory");
      }
      return;
    }
    throw new ContainedDownloadError("this filename already exists or collides in the model directory");
  }

  /**
   * Enumerate the internal partial directory and prove the exact
   * `${filename}.part` child owns its case-folded key: an alias with
   * different spelling fails closed; the exact name means resume.
   */
  async function partialExistsForResume(partialsDir: string, partialName: string): Promise<boolean> {
    const names = await fs.readdir(partialsDir);
    const folded = partialName.toLowerCase();
    for (const name of names) {
      if (name.toLowerCase() === folded && name !== partialName) {
        throw new ContainedDownloadError("a case-alias download partial already exists");
      }
    }
    return names.includes(partialName);
  }

  /** Open the internal partial exactly once with the no-follow discipline. */
  async function openPartial(
    entry: DownloadEntry,
    partialPath: string,
    existing: boolean
  ): Promise<{ handle: fs.FileHandle; resumeSize: number; stat: BigIntStats }> {
    const createFlags =
      fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
    if (!existing) {
      try {
        const handle = await fs.open(partialPath, createFlags, 0o600);
        try {
          await handle.chmod(0o600);
          const stat = await handle.stat({ bigint: true });
          if (!stat.isFile() || stat.nlink !== 1n)
            throw new ContainedDownloadError("download partial failed its proof");
          return { handle, resumeSize: 0, stat };
        } catch (error) {
          await handle.close().catch(() => undefined);
          throw error;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // A raced creation or symlink at the pathname is proven below rather
        // than followed or truncated blindly.
        if (code !== "EEXIST" && code !== "ELOOP") {
          throw new ContainedDownloadError("download partial could not be created");
        }
      }
    }
    let listed: BigIntStats;
    try {
      listed = await fs.lstat(partialPath, { bigint: true });
    } catch {
      throw new ContainedDownloadError("download partial could not be opened");
    }
    if (listed.isSymbolicLink() || !listed.isFile() || listed.nlink !== 1n) {
      throw new ContainedDownloadError("download partial is not a singly-linked regular file");
    }
    const handle = await fs.open(partialPath, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== listed.dev || stat.ino !== listed.ino) {
        throw new ContainedDownloadError("download partial changed while opening");
      }
      const resumeSize = Number(stat.size);
      if (!Number.isSafeInteger(resumeSize)) throw new ContainedDownloadError("download partial size is unusable");
      return { handle, resumeSize, stat };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  /** Identity-checked removal of the attempt's own partial; never a blind rm. */
  async function removeOwnedPartial(entry: DownloadEntry): Promise<void> {
    const owned = entry.owned;
    if (!owned) return;
    try {
      const stat = await fs.lstat(owned.partialPath, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== owned.dev || stat.ino !== owned.ino) return;
      await fs.unlink(owned.partialPath);
    } catch {
      // The partial may already be gone; anything else stays untouched.
    }
  }

  async function pathMatchesIdentity(partialPath: string, identity: PartialIdentity): Promise<boolean> {
    try {
      const stat = await fs.lstat(partialPath, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
      return sameIdentity(identityOf(stat), identity);
    } catch {
      return false;
    }
  }

  /** SHA-256 from the retained handle via positional reads, never a reopen. */
  async function hashHandle(entry: DownloadEntry, handle: fs.FileHandle): Promise<string> {
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      if (entry.abort.signal.aborted) throw new ContainedDownloadError("download cancelled");
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  }

  async function syncDirectoryBestEffort(directory: string): Promise<void> {
    try {
      if (dependencies.hooks?.syncDirectory) {
        await dependencies.hooks.syncDirectory(directory);
        return;
      }
      const handle = await fs.open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch {
      // Best-effort durability hardening after the durable rename commit.
    }
  }

  /**
   * Strict response contract: identity encoding only, fresh transfers accept
   * only 200, resumes accept 200 (truncate/restart through the opened
   * handle) or a single terminal-tail 206, declared lengths must be
   * internally consistent within the maximum, and premature EOF fails.
   */
  async function transfer(input: {
    entry: DownloadEntry;
    response: IncomingMessage;
    handle: fs.FileHandle;
    resumeSize: number;
    max: number;
  }): Promise<void> {
    const { entry, response, handle, resumeSize, max } = input;
    let rejected = false;
    try {
      const status = response.statusCode ?? 502;
      const accepted = resumeSize > 0 ? status === 200 || status === 206 : status === 200;
      if (!accepted) throw new ContainedDownloadError("download refused by the origin");

      const encoding = response.headers["content-encoding"];
      if (typeof encoding === "string" && encoding.trim().toLowerCase() !== "identity") {
        throw new ContainedDownloadError("download response was not identity-encoded");
      }

      let base = resumeSize;
      let segment: number | null = null;
      const contentLength = declaredLength(response);
      if (Number.isNaN(contentLength)) throw new ContainedDownloadError("download declared an invalid length");

      if (status === 206) {
        const range = parseContentRange(response.headers["content-range"]);
        if (!range) throw new ContainedDownloadError("download resume range was refused");
        if (range.start !== resumeSize || range.end < range.start || range.end !== range.total - 1) {
          throw new ContainedDownloadError("download resume range did not cover the expected tail");
        }
        if (range.total <= 0 || range.total > max) {
          throw new ContainedDownloadError("download exceeds the configured size bound");
        }
        segment = range.total - range.start;
        if (contentLength !== undefined && contentLength !== segment) {
          throw new ContainedDownloadError("download response length contradicted its range");
        }
        entry.state.total_bytes = range.total;
      } else {
        if (contentLength !== undefined && contentLength > max) {
          throw new ContainedDownloadError("download exceeds the configured size bound");
        }
        if (resumeSize > 0) {
          // The origin restarted the transfer: truncate through the same
          // proven handle so a 200 can never append onto resumed bytes.
          await handle.truncate(0);
          base = 0;
          entry.state.bytes_received = 0;
        }
        segment = contentLength ?? null;
        entry.state.total_bytes = contentLength ?? null;
      }

      let written = 0;
      for await (const rawChunk of response) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
        written += chunk.length;
        if (base + written > max) throw new ContainedDownloadError("download exceeds the configured size bound");
        await handle.write(chunk);
        entry.state.bytes_received = base + written;
      }
      if (segment !== null && written !== segment) {
        throw new ContainedDownloadError("download response ended before its declared length");
      }
    } catch (error) {
      rejected = true;
      throw error;
    } finally {
      if (rejected) response.destroy();
    }
  }

  /**
   * The whole deferred attempt: layout proof, namespace scans, one no-follow
   * handle, one bounded signal across resolution/request/body, same-handle
   * fsync+hash, and the linearized atomic publication.
   */
  async function runDownload(entry: DownloadEntry, sha256: string): Promise<void> {
    const max = dependencies.maxBytes ?? maxDownloadBytes();
    const timeoutMs = dependencies.timeoutMs ?? downloadTimeoutMs();
    const transport = dependencies.transport ?? defaultTransport;
    // One combined cancel-plus-timeout signal covers resolution, request,
    // headers, and every streamed body byte.
    const operationSignal = combineSignals(entry.abort.signal, timeoutMs);

    const { root, rootReal } = await ensureContainedModelRoot();
    const partials = await ensureContainedPartialsDirectory(root, rootReal);
    await assertFinalNamespaceClear(root, entry.key, entry.filename);
    const partialName = `${entry.filename}.part`;
    const partialPath = path.join(partials.directory, partialName);
    const existingPartial = await partialExistsForResume(partials.directory, partialName);

    const opened = await openPartial(entry, partialPath, existingPartial);
    let handle: fs.FileHandle | undefined = opened.handle;
    entry.owned = { partialPath, dev: opened.stat.dev, ino: opened.stat.ino };
    try {
      if (opened.resumeSize > max) throw new ContainedDownloadError("download exceeds the configured size bound");
      const headers: Record<string, string> = {
        Accept: "application/octet-stream",
        "Accept-Encoding": "identity",
        "User-Agent": DOWNLOAD_USER_AGENT,
      };
      if (opened.resumeSize > 0) headers.Range = `bytes=${opened.resumeSize}-`;
      const addresses = await transport.resolve(entry.url, operationSignal);
      const response = await transport.request(entry.url, addresses, operationSignal, headers);
      await transfer({ entry, response, handle, resumeSize: opened.resumeSize, max });

      entry.state.state = "verifying";
      await handle.sync();
      const digest = await hashHandle(entry, handle);
      // Fresh post-write/post-sync/post-hash fstat from the same handle: the
      // publication identity, never the necessarily stale pre-write values.
      const finalStat = await handle.stat({ bigint: true });
      if (!finalStat.isFile() || finalStat.nlink !== 1n) {
        throw new ContainedDownloadError("download partial failed its final proof");
      }
      if (finalStat.dev !== opened.stat.dev || finalStat.ino !== opened.stat.ino) {
        throw new ContainedDownloadError("download partial changed during verification");
      }
      const finalIdentity = identityOf(finalStat);
      if (digest !== sha256) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        // Remove only the partial we still own; a replacement is left alone.
        if (await pathMatchesIdentity(partialPath, finalIdentity)) {
          await fs.unlink(partialPath).catch(() => undefined);
          entry.owned = null;
        }
        throw new ContainedDownloadError("checksum mismatch: the downloaded bytes did not match sha256");
      }

      await dependencies.hooks?.beforePublication?.({ filename: entry.filename });
      if (!(await pathMatchesIdentity(partialPath, finalIdentity))) {
        throw new ContainedDownloadError("download partial changed before publication");
      }
      await assertFinalNamespaceClear(root, entry.key, entry.filename);
      await handle.close();
      handle = undefined;

      // Synchronous point of no return: final abort check, flag, and the
      // initiated rename share one turn — no await between them.
      if (entry.abort.signal.aborted) throw new ContainedDownloadError("download cancelled");
      entry.publicationStarted = true;
      const initiatedRename = (dependencies.hooks?.rename ?? ((from: string, to: string) => fs.rename(from, to)))(
        partialPath,
        path.join(root, entry.filename)
      );
      await initiatedRename;
      // Both directories are below one canonical root: a same-filesystem
      // atomic rename, fsynced best-effort like the settings file. The
      // reservation stays held until both attempts settle.
      await syncDirectoryBestEffort(partials.directoryReal);
      await syncDirectoryBestEffort(rootReal);

      entry.state.state = "complete";
      entry.state.error = null;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
  }

  /**
   * Cancel linearizes on the synchronous `publicationStarted` flag. Before
   * it: set the explicit-cancel reason, abort, join the run, and return true
   * only after owned cleanup. At/after it: too late — join without touching
   * state or signal and return false; cleanup belongs to the joined run.
   */
  async function cancel(filenameValue: unknown): Promise<boolean> {
    const filename = sanitizeFilename(filenameValue);
    const entry = activeReservations.get(filename.toLowerCase());
    if (!entry) return false;
    if (entry.publicationStarted) {
      await entry.run;
      return false;
    }
    entry.cancelReason = "explicit";
    entry.abort.abort();
    await entry.run;
    return true;
  }

  /**
   * Process-lifecycle boundary: admission closes and every exact reservation
   * is captured and aborted (pre-publication only) synchronously, before the
   * first await. Publishing entries are joined without changing their
   * outcome. Idempotent: repeated calls join the same drain promise.
   */
  function quiesceAndDrain(): Promise<void> {
    if (drain) return drain.promise;
    admitting = false;
    const captured = [...activeReservations.values()];
    for (const entry of captured) {
      if (!entry.publicationStarted) {
        entry.cancelReason = "quiesce";
        entry.abort.abort();
      }
    }
    const promise = Promise.allSettled(captured.map((entry) => entry.run)).then(() => undefined);
    const tracked: { epoch: number; promise: Promise<void>; settled: boolean } = {
      epoch: lifecycleEpoch,
      promise,
      settled: false,
    };
    void promise.then(() => {
      if (drain === tracked) drain = { ...tracked, settled: true };
    });
    drain = tracked;
    return promise;
  }

  /**
   * Reopen admission only after the prior drain settled and released every
   * reservation; an attempt while drainage is in flight is rejected. Within
   * an active lifecycle this is idempotent. A successful reopen advances the
   * lifecycle epoch so stale completions can only mutate their own captured
   * entry.
   */
  async function beginLifecycle(): Promise<void> {
    if (drain) {
      if (!drain.settled) throw new ContainedDownloadError("contained download drain is still running");
      if (activeReservations.size > 0) {
        throw new ContainedDownloadError("contained download drain did not release every reservation");
      }
      drain = undefined;
      lifecycleEpoch += 1;
    }
    admitting = true;
  }

  return { start, cancel, snapshot, quiesceAndDrain, beginLifecycle };
}
