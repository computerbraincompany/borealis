import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import * as tar from "tar-stream";
import Database from "better-sqlite3";

import { acquireWorkspaceLock } from "./workspaceLock.js";
import { verifyWorkspaceStores } from "./workspaceVerifier.js";

const HEADER_BYTES = 64;
const MAGIC = Buffer.from("BOREALIS-WORKSP\0", "ascii");
const ARCHIVE_VERSION = 1 as const;
const ENCRYPTED_FLAG = 1;
const AUTH_TAG_BYTES = 16;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
const MANIFEST_NAME = ".borealis-manifest.json";
const BACKUP_MARKER_SUFFIX = ".borealis-backup-marker";
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_MEMBERS = 250_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 550 * 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 10_000;
const MAX_EXTRACTION_MS = 60 * 60_000;
const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const MAX_PREMANIFEST_DECOMPRESSED_BYTES = MAX_MANIFEST_BYTES + 64 * 1024;
const MAX_PASSPHRASE_BYTES = 4_096;
const RESTORE_SPACE_RESERVE_BYTES = 64 * 1024 * 1024;
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const PORTABLE_ROOT_ADDITIONS = Object.freeze(
  new Map<string, "directory" | "file">([
    ["borealis.sqlite", "file"],
    ["lancedb", "directory"],
    ["uploads", "directory"],
    ["reports", "directory"],
    ["models", "directory"],
    ["settings.json", "file"],
    ["contained.json", "file"],
    ["jwt.secret", "file"],
  ])
);

type ModeClass = "directory" | "executable" | "file" | "secret";

interface ArchiveManifestEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly size: number;
  readonly mode: ModeClass;
  readonly sha256: string;
}

interface ArchiveManifest {
  readonly version: typeof ARCHIVE_VERSION;
  readonly workspace_root?: string;
  readonly workspace_aliases?: readonly string[];
  readonly relocations?: readonly ArchiveRelocation[];
  readonly entries: readonly ArchiveManifestEntry[];
  readonly total_bytes: number;
}

interface ArchiveRelocation {
  readonly name: string;
  readonly source_root: string;
  readonly source_aliases?: readonly string[];
  readonly archive_path?: string;
}

interface NormalizedArchiveAddition extends WorkspaceArchiveAddition {
  readonly sourceAlias?: string;
  readonly archivePath: string;
  readonly recordRelocation: boolean;
}

interface SourceEntry extends ArchiveManifestEntry {
  readonly sourcePath: string;
  readonly identity?: Readonly<{ dev: number; ino: number; size: number; mtimeMs: number }>;
}

export interface WorkspaceArchiveAddition {
  readonly name: string;
  readonly path: string;
}

export interface CreateWorkspaceArchiveOptions {
  readonly workspaceDirectory: string;
  readonly destination: string;
  readonly passphrase?: string | Buffer;
  readonly unsafePlaintext?: boolean;
  readonly additions?: readonly WorkspaceArchiveAddition[];
}

export interface ReadWorkspaceArchiveOptions {
  readonly archive: string;
  readonly passphrase?: string | Buffer;
  readonly allowUnsafePlaintext?: boolean;
}

export interface RestoreWorkspaceArchiveOptions extends ReadWorkspaceArchiveOptions {
  readonly targetDirectory: string;
  readonly embeddingDimension?: number;
  readonly verifyStores?: boolean;
}

export interface WorkspaceArchiveSummary {
  readonly version: typeof ARCHIVE_VERSION;
  readonly encrypted: boolean;
  readonly files: number;
  readonly directories: number;
  readonly total_bytes: number;
  readonly backup_created?: boolean;
}

interface ArchiveHeader {
  readonly encrypted: boolean;
  readonly salt: Buffer;
  readonly iv: Buffer;
  readonly n: number;
  readonly r: number;
  readonly p: number;
}

type TarWriteHeader = Parameters<tar.Pack["entry"]>[0];

export async function createWorkspaceArchive(options: CreateWorkspaceArchiveOptions): Promise<WorkspaceArchiveSummary> {
  const requestedWorkspace = validateAbsoluteDirectoryPath(options.workspaceDirectory, "workspace directory");
  const workspace = await proveAbsoluteDirectory(options.workspaceDirectory);
  const destination = await canonicalSiblingPath(options.destination, "archive destination");
  if (path.extname(destination) !== ".borealis-workspace") {
    throw new TypeError("archive destination must end in .borealis-workspace");
  }
  if (isWithinDirectory(destination, workspace)) {
    throw new TypeError("archive destination must be outside the workspace");
  }
  const unsafePlaintext = options.unsafePlaintext === true;
  const passphrase = unsafePlaintext ? undefined : passphraseBuffer(options.passphrase);
  const lock = await acquireWorkspaceLock(workspace);
  const part = `${destination}.part`;
  try {
    await assertDestinationAvailable(destination, part);
    const additions = await normalizeArchiveAdditions(options.additions ?? []);
    validateAdditionRoots(workspace, additions);
    if (additions.some((addition) => isWithinDirectory(destination, addition.path))) {
      throw new TypeError("archive destination must be outside named additions");
    }
    const entries = await collectSourceEntries(workspace, additions);
    const manifest = createManifest(
      entries,
      workspace,
      requestedWorkspace === workspace ? [] : [requestedWorkspace],
      additions
    );
    const header = createArchiveHeader(!unsafePlaintext);
    const headerBytes = encodeHeader(header);
    const key = header.encrypted ? await deriveArchiveKey(passphrase!, header) : undefined;
    const pack = tar.pack();
    const output = createWriteStream(part, { flags: "wx", mode: 0o600 });
    const gzip = createGzip({ level: 9 });
    const cipher = key ? createCipheriv("aes-256-gcm", key, header.iv) : undefined;
    if (cipher) cipher.setAAD(headerBytes);
    const envelope = new ArchiveEnvelopeTransform(headerBytes, cipher);
    const transport = cipher ? pipeline(pack, gzip, cipher, envelope, output) : pipeline(pack, gzip, envelope, output);
    try {
      await writeTarArchive(pack, manifest, entries);
      await transport;
    } finally {
      key?.fill(0);
    }
    await fs.chmod(part, 0o600);
    await syncFile(part);
    await fs.rename(part, destination);
    await fs.chmod(destination, 0o600);
    await syncDirectory(path.dirname(destination));
    return manifestSummary(manifest, header.encrypted);
  } catch (error) {
    await fs.unlink(part).catch(() => undefined);
    throw error;
  } finally {
    passphrase?.fill(0);
    await lock.release();
  }
}

export async function inspectWorkspaceArchive(options: ReadWorkspaceArchiveOptions): Promise<WorkspaceArchiveSummary> {
  return readArchive(options, undefined);
}

export async function restoreWorkspaceArchive(
  options: RestoreWorkspaceArchiveOptions
): Promise<WorkspaceArchiveSummary> {
  const target = validateAbsoluteDirectoryPath(options.targetDirectory, "restore target");
  const parent = await fs.realpath(path.dirname(target));
  const exactTarget = path.join(parent, path.basename(target));
  const stage = path.join(parent, `.${path.basename(target)}.restore.${randomUUID()}`);
  const backup = path.join(parent, `.${path.basename(target)}.backup.${randomUUID()}`);
  const backupMarker = backupMarkerPath(backup);
  const lock = await acquireWorkspaceLock(exactTarget);
  let backupCreated = false;
  try {
    await recoverInterruptedRestore(exactTarget);
    await fs.mkdir(stage, { mode: 0o700 });
    await fs.chmod(stage, 0o700);
    const summary = await readArchive(options, stage, exactTarget);
    await syncRestoredTree(stage);
    await verifyRestoredLayout(stage);
    if (options.verifyStores !== false) {
      await verifyWorkspaceStores({
        workspaceDirectory: stage,
        logicalWorkspaceDirectory: exactTarget,
        ...(options.embeddingDimension === undefined ? {} : { embeddingDimension: options.embeddingDimension }),
      });
    }
    const targetStat = await fs.lstat(exactTarget).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (targetStat) {
      if (
        !targetStat.isDirectory() ||
        targetStat.isSymbolicLink() ||
        (await fs.realpath(exactTarget)) !== exactTarget
      ) {
        throw new Error("restore target is not an exact regular directory");
      }
      await writeBackupMarker(backupMarker, exactTarget, backup, targetStat);
      await syncDirectory(parent);
      try {
        await fs.rename(exactTarget, backup);
      } catch (error) {
        await fs.unlink(backupMarker).catch(() => undefined);
        throw error;
      }
      backupCreated = true;
    }
    try {
      await fs.rename(stage, target);
      await syncDirectory(parent);
    } catch (error) {
      if (backupCreated) {
        try {
          await fs.rename(backup, target);
          await fs.unlink(backupMarker);
          await syncDirectory(parent);
        } catch {
          throw new Error("workspace restore rollback requires recovery");
        }
      }
      throw error;
    }
    return Object.freeze({ ...summary, backup_created: backupCreated });
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    await lock.release();
  }
}

export async function removeWorkspaceBackup(
  targetDirectory: string,
  backupDirectory: string,
  embeddingDimension?: number
): Promise<void> {
  const target = validateAbsoluteDirectoryPath(targetDirectory, "workspace target");
  const parent = await fs.realpath(path.dirname(target));
  const exactTarget = path.join(parent, path.basename(target));
  const backup = await canonicalSiblingPath(backupDirectory, "workspace backup");
  const expectedPrefix = `.${path.basename(target)}.backup.`;
  if (path.dirname(backup) !== parent || !path.basename(backup).startsWith(expectedPrefix)) {
    throw new TypeError("backup must be an exact generated sibling of the workspace");
  }
  const marker = backupMarkerPath(backup);
  const backupSuffix = path.basename(backup).slice(expectedPrefix.length);
  if (!backupSuffix) throw new TypeError("backup must be an exact generated sibling of the workspace");
  const tombstone = path.join(parent, `.${path.basename(target)}.backup-remove.${backupSuffix}`);
  const lock = await acquireWorkspaceLock(exactTarget);
  try {
    if (await resumeWorkspaceBackupRemoval(exactTarget, backup, marker, tombstone)) return;
    const canonical = await fs.realpath(backup);
    const stat = await fs.lstat(backup);
    if (canonical !== backup || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new TypeError("backup must be an exact regular directory");
    }
    await verifyBackupMarker(marker, exactTarget, backup, stat.dev, stat.ino);
    await verifyRestoredLayout(exactTarget);
    await verifyWorkspaceStores({
      workspaceDirectory: exactTarget,
      ...(embeddingDimension === undefined ? {} : { embeddingDimension }),
    });
    await verifyRestoredLayout(backup);
    await verifyWorkspaceStores({
      workspaceDirectory: backup,
      logicalWorkspaceDirectory: exactTarget,
      ...(embeddingDimension === undefined ? {} : { embeddingDimension }),
    });
    await fs.rename(backup, tombstone);
    await syncDirectory(parent);
    const [tombstoneCanonical, tombstoneStat] = await Promise.all([fs.realpath(tombstone), fs.lstat(tombstone)]);
    if (
      tombstoneCanonical !== tombstone ||
      !tombstoneStat.isDirectory() ||
      tombstoneStat.isSymbolicLink() ||
      tombstoneStat.dev !== stat.dev ||
      tombstoneStat.ino !== stat.ino
    ) {
      throw new Error("workspace backup identity changed before removal");
    }
    await fs.rm(tombstone, { recursive: true });
    await fs.unlink(marker);
    await syncDirectory(parent);
  } finally {
    await lock.release();
  }
}

async function resumeWorkspaceBackupRemoval(
  target: string,
  backup: string,
  marker: string,
  tombstone: string
): Promise<boolean> {
  const [backupStat, tombstoneStat] = await Promise.all([optionalLstat(backup), optionalLstat(tombstone)]);
  if (!tombstoneStat && backupStat) return false;
  const provenance = await readBackupMarker(marker);
  if (provenance.target !== path.basename(target) || provenance.backup !== path.basename(backup)) {
    throw new Error("workspace backup provenance is invalid");
  }
  if (tombstoneStat) {
    if (
      !tombstoneStat.isDirectory() ||
      tombstoneStat.isSymbolicLink() ||
      (await fs.realpath(tombstone)) !== tombstone ||
      tombstoneStat.dev !== provenance.dev ||
      tombstoneStat.ino !== provenance.ino
    ) {
      throw new Error("workspace backup removal recovery is required");
    }
    await fs.rm(tombstone, { recursive: true });
  }
  await fs.unlink(marker);
  await syncDirectory(path.dirname(target));
  return true;
}

async function optionalLstat(filename: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  return fs.lstat(filename).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function readArchive(
  options: ReadWorkspaceArchiveOptions,
  restoreDirectory: string | undefined,
  restoreTarget?: string
): Promise<WorkspaceArchiveSummary> {
  const archive = await proveAbsoluteFile(options.archive, "archive");
  const handle = await fs.open(archive, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let passphrase: Buffer | undefined;
  let key: Buffer | undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < HEADER_BYTES + 1) throw new Error("archive is truncated");
    if (stat.size > MAX_ARCHIVE_BYTES) throw new Error("archive byte limit");
    const headerBytes = Buffer.alloc(HEADER_BYTES);
    const headerRead = await handle.read({ buffer: headerBytes, position: 0 });
    if (headerRead.bytesRead !== HEADER_BYTES) throw new Error("archive is truncated");
    const header = decodeHeader(headerBytes);
    if (!header.encrypted && options.allowUnsafePlaintext !== true) {
      throw new Error("plaintext archive requires explicit unsafe opt-in");
    }
    const end = header.encrypted ? stat.size - AUTH_TAG_BYTES - 1 : stat.size - 1;
    if (end < HEADER_BYTES) throw new Error("archive is truncated");
    const payload = handle.createReadStream({ start: HEADER_BYTES, end, autoClose: false });
    let decrypt: Transform | undefined;
    if (header.encrypted) {
      passphrase = passphraseBuffer(options.passphrase);
      key = await deriveArchiveKey(passphrase, header);
      const tag = Buffer.alloc(AUTH_TAG_BYTES);
      const tagRead = await handle.read({ buffer: tag, position: stat.size - AUTH_TAG_BYTES });
      if (tagRead.bytesRead !== AUTH_TAG_BYTES) throw new Error("archive is truncated");
      const decipher = createDecipheriv("aes-256-gcm", key, header.iv);
      decipher.setAAD(headerBytes);
      decipher.setAuthTag(tag);
      decrypt = decipher;
    }
    const deadlineAt = performance.now() + MAX_EXTRACTION_MS;
    const deadlineController = new AbortController();
    const gunzip = createGunzip();
    const decompressed = new DecompressedArchiveGuard();
    const extract = tar.extract();
    const archiveReader = new StrictArchiveReader(restoreDirectory, stat.size, deadlineAt, decompressed);
    const transport = decrypt
      ? pipeline(payload, decrypt, gunzip, decompressed, extract as unknown as NodeJS.WritableStream, {
          signal: deadlineController.signal,
        })
      : pipeline(payload, gunzip, decompressed, extract as unknown as NodeJS.WritableStream, {
          signal: deadlineController.signal,
        });
    const deadlineTimer = setTimeout(
      () => deadlineController.abort(new Error("archive limit")),
      Math.max(1, deadlineAt - performance.now())
    );
    deadlineTimer.unref();
    try {
      for await (const stream of extract) {
        await archiveReader.consume(stream.header, stream as unknown as NodeJS.ReadableStream);
      }
      await transport;
    } catch (error) {
      extract.destroy(error instanceof Error ? error : new Error("archive member failed"));
      await transport.catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
    }
    const manifest = archiveReader.finish();
    if (restoreDirectory && restoreTarget && manifest.workspace_root) {
      await rebaseRestoredWorkspacePaths(restoreDirectory, restoreTarget, manifest);
    }
    return manifestSummary(manifest, header.encrypted);
  } catch {
    throw new Error("workspace archive could not be verified");
  } finally {
    passphrase?.fill(0);
    key?.fill(0);
    await handle.close().catch(() => undefined);
  }
}

class ArchiveEnvelopeTransform extends Transform {
  private prefixed = false;

  constructor(
    private readonly header: Buffer,
    private readonly cipher?: { getAuthTag(): Buffer }
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.prefixed) {
      this.push(this.header);
      this.prefixed = true;
    }
    this.push(chunk);
    callback();
  }

  override _flush(callback: (error?: Error | null) => void): void {
    if (!this.prefixed) this.push(this.header);
    if (this.cipher) this.push(this.cipher.getAuthTag());
    callback();
  }
}

class DecompressedArchiveGuard extends Transform {
  private decompressedBytes = 0;
  private maximumBytes = MAX_PREMANIFEST_DECOMPRESSED_BYTES;
  private armed = false;

  arm(manifest: ArchiveManifest, manifestBytes: number): void {
    if (this.armed) throw new Error("archive limit");
    this.armed = true;
    this.maximumBytes = maximumTarBytes(manifest, manifestBytes);
    if (this.decompressedBytes > this.maximumBytes) throw new Error("archive limit");
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const next = this.decompressedBytes + chunk.byteLength;
    if (!Number.isSafeInteger(next) || next > this.maximumBytes) {
      callback(new Error("archive limit"));
      return;
    }
    this.decompressedBytes = next;
    this.push(chunk);
    callback();
  }
}

class StrictArchiveReader {
  private manifest: ArchiveManifest | undefined;
  private readonly expected = new Map<string, ArchiveManifestEntry>();
  private readonly seen = new Set<string>();
  private readonly folded = new Set<string>();
  private memberCount = 0;
  private extractedBytes = 0;

  constructor(
    private readonly restoreDirectory: string | undefined,
    private readonly archiveBytes: number,
    private readonly deadlineAt: number,
    private readonly decompressed: DecompressedArchiveGuard
  ) {}

  async consume(header: tar.Header, stream: NodeJS.ReadableStream): Promise<void> {
    this.memberCount += 1;
    if (this.memberCount > MAX_MEMBERS || performance.now() >= this.deadlineAt) throw new Error("archive limit");
    const name = safeMemberName(header.name);
    this.assertUnique(name);
    if (header.linkname || !["file", "directory"].includes(header.type ?? "file"))
      throw new Error("archive member type");
    const size = safeByteCount(header.size ?? 0, MAX_FILE_BYTES);
    if (name === MANIFEST_NAME) {
      if (this.manifest || this.memberCount !== 1 || header.type === "directory" || size > MAX_MANIFEST_BYTES) {
        throw new Error("manifest order");
      }
      const body = await this.withDeadline(stream, () => readBoundedStream(stream, MAX_MANIFEST_BYTES));
      this.manifest = decodeManifest(body);
      this.decompressed.arm(this.manifest, size);
      for (const entry of this.manifest.entries) this.expected.set(entry.path, entry);
      if (this.manifest.total_bytes > this.archiveBytes * MAX_COMPRESSION_RATIO) throw new Error("compression ratio");
      if (this.restoreDirectory) await ensureRestoreCapacity(this.restoreDirectory, this.manifest.total_bytes);
      return;
    }
    if (!this.manifest) throw new Error("manifest missing");
    const expected = this.expected.get(name);
    if (!expected || expected.kind !== (header.type === "directory" ? "directory" : "file") || expected.size !== size) {
      throw new Error("manifest mismatch");
    }
    this.extractedBytes = safeByteCount(this.extractedBytes + size, MAX_TOTAL_BYTES);
    const hash = createHash("sha256");
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    if (this.restoreDirectory) {
      const destination = safeRestorePath(this.restoreDirectory, name);
      await this.assertParentReady(name, destination);
      if (expected.kind === "directory") {
        await this.withDeadline(stream, () => drainStream(stream));
        await fs.mkdir(destination, { recursive: false, mode: 0o700 });
        await fs.chmod(destination, 0o700);
      } else {
        const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
        await this.withDeadline(stream, () => pipeline(stream as Readable, hasher, output));
        await fs.chmod(destination, expected.mode === "executable" ? 0o700 : 0o600);
      }
    } else {
      await this.withDeadline(stream, () => pipeline(stream as Readable, hasher, new NullTransform()));
    }
    const digest = expected.kind === "directory" ? EMPTY_SHA256 : hash.digest("hex");
    if (digest !== expected.sha256) throw new Error("archive checksum");
    this.seen.add(name);
  }

  finish(): ArchiveManifest {
    if (!this.manifest || this.seen.size !== this.manifest.entries.length) throw new Error("archive incomplete");
    for (const entry of this.manifest.entries) if (!this.seen.has(entry.path)) throw new Error("archive incomplete");
    if (this.extractedBytes !== this.manifest.total_bytes) throw new Error("archive size mismatch");
    return this.manifest;
  }

  private assertUnique(name: string): void {
    const folded = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (this.seen.has(name) || this.folded.has(folded)) throw new Error("duplicate archive member");
    this.folded.add(folded);
  }

  private async assertParentReady(name: string, destination: string): Promise<void> {
    const parentName = path.posix.dirname(name);
    if (parentName !== "." && !this.seen.has(parentName)) throw new Error("archive parent order");
    const expectedParent =
      parentName === "." ? this.restoreDirectory! : safeRestorePath(this.restoreDirectory!, parentName);
    if (path.dirname(destination) !== expectedParent) throw new Error("archive parent mismatch");
    const [stat, real] = await Promise.all([fs.lstat(expectedParent), fs.realpath(expectedParent)]);
    if (!stat.isDirectory() || stat.isSymbolicLink() || real !== expectedParent)
      throw new Error("archive parent unsafe");
  }

  private async withDeadline<T>(stream: NodeJS.ReadableStream, operation: () => Promise<T>): Promise<T> {
    const remaining = this.deadlineAt - performance.now();
    if (remaining <= 0) throw new Error("archive limit");
    const readable = stream as Readable;
    const timer = setTimeout(() => readable.destroy(new Error("archive limit")), remaining);
    timer.unref();
    try {
      return await operation();
    } finally {
      clearTimeout(timer);
    }
  }
}

class NullTransform extends Transform {
  override _transform(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

async function writeTarArchive(
  pack: ReturnType<typeof tar.pack>,
  manifest: ArchiveManifest,
  entries: readonly SourceEntry[]
): Promise<void> {
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  await writePackBuffer(
    pack,
    {
      name: MANIFEST_NAME,
      type: "file",
      size: manifestBytes.length,
      mode: 0o600,
      mtime: new Date(0),
      uid: 0,
      gid: 0,
    },
    manifestBytes
  );
  for (const entry of entries) {
    const header: TarWriteHeader = {
      name: entry.path,
      type: entry.kind,
      size: entry.size,
      mode: entry.mode === "directory" || entry.mode === "executable" ? 0o700 : 0o600,
      mtime: new Date(0),
      uid: 0,
      gid: 0,
    };
    if (entry.kind === "directory") {
      await writePackBuffer(pack, header, Buffer.alloc(0));
      continue;
    }
    await assertSourceIdentity(entry);
    const hash = createHash("sha256");
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const target = pack.entry(header);
    await pipeline(createReadStream(entry.sourcePath), hasher, target);
    if (hash.digest("hex") !== entry.sha256) throw new Error("workspace changed while archiving");
    await assertSourceIdentity(entry);
  }
  pack.finalize();
}

function writePackBuffer(pack: ReturnType<typeof tar.pack>, header: TarWriteHeader, body: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    pack.entry(header, body, (error) => (error ? reject(error) : resolve()));
  });
}

async function collectSourceEntries(
  workspace: string,
  additions: readonly NormalizedArchiveAddition[]
): Promise<readonly SourceEntry[]> {
  const entries: SourceEntry[] = [];
  const seen = new Set<string>();
  const workspaceNames = await fs.readdir(workspace);
  workspaceNames.sort(compareArchiveNames);
  for (const relative of workspaceNames) {
    const source = path.join(workspace, relative);
    await walkSource(source, relative, entries, seen);
  }
  const portableSqlite = additions.find((addition) => addition.archivePath === "borealis.sqlite");
  if (
    portableSqlite &&
    entries.some((entry) =>
      ["borealis.sqlite", "borealis.sqlite-wal", "borealis.sqlite-shm", "borealis.sqlite-journal"].includes(entry.path)
    )
  ) {
    throw new Error("relocated SQLite files collide with the workspace root");
  }
  const portableLance = additions.find((addition) => addition.archivePath === "lancedb");
  const portableMigrationRoot = additions.find((addition) => addition.archivePath === ".lancedb-migrations");
  if (
    portableLance &&
    entries.some((entry) => entry.path === ".lancedb-migrations" || entry.path.startsWith(".lancedb-migrations/"))
  ) {
    throw new Error("relocated LanceDB migration files collide with the workspace root");
  }
  if (portableLance && entries.some((entry) => entry.path === "embedding-migration.json") && !portableMigrationRoot) {
    throw new Error("relocated LanceDB migration staging is missing");
  }
  for (const addition of additions) {
    if (addition.archivePath.startsWith("relocated/") && !entries.some((entry) => entry.path === "relocated")) {
      entries.push(
        Object.freeze({
          path: "relocated",
          sourcePath: workspace,
          kind: "directory",
          size: 0,
          mode: "directory",
          sha256: EMPTY_SHA256,
        })
      );
      seen.add("relocated");
    }
    await walkSource(addition.path, addition.archivePath, entries, seen);
    if (addition.archivePath === "borealis.sqlite") {
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        const sidecar = `${addition.path}${suffix}`;
        const sidecarStat = await fs.lstat(sidecar).catch((error: unknown) => {
          if (isNodeError(error) && error.code === "ENOENT") return undefined;
          throw error;
        });
        if (sidecarStat) await walkSource(sidecar, `borealis.sqlite${suffix}`, entries, seen);
      }
    }
  }
  if (!entries.some((entry) => entry.path === "borealis.sqlite" && entry.kind === "file")) {
    throw new Error("workspace SQLite ledger is missing");
  }
  if (!entries.some((entry) => entry.path === "lancedb" && entry.kind === "directory")) {
    throw new Error("workspace LanceDB directory is missing");
  }
  entries.sort((left, right) => compareArchiveNames(left.path, right.path));
  if (entries.length > MAX_MEMBERS - 1) throw new Error("workspace member limit exceeded");
  let total = 0;
  for (const entry of entries) total = safeByteCount(total + entry.size, MAX_TOTAL_BYTES);
  return Object.freeze(entries);
}

async function walkSource(
  sourcePath: string,
  archivePathInput: string,
  entries: SourceEntry[],
  seen: Set<string>
): Promise<void> {
  const archivePath = safeMemberName(archivePathInput.split(path.sep).join("/"));
  const folded = archivePath.normalize("NFC").toLocaleLowerCase("en-US");
  if (seen.has(folded)) throw new Error("workspace path collision");
  seen.add(folded);
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("unsupported workspace entry");
  if ((await fs.realpath(sourcePath)) !== path.resolve(sourcePath))
    throw new Error("workspace entry has a symlink component");
  if (stat.isDirectory()) {
    entries.push(
      Object.freeze({
        path: archivePath,
        sourcePath,
        kind: "directory",
        size: 0,
        mode: "directory",
        sha256: EMPTY_SHA256,
      })
    );
    const names = await fs.readdir(sourcePath);
    names.sort(compareArchiveNames);
    for (const name of names) await walkSource(path.join(sourcePath, name), `${archivePath}/${name}`, entries, seen);
    return;
  }
  const size = safeByteCount(stat.size, MAX_FILE_BYTES);
  const sha256 = await hashFile(sourcePath);
  entries.push(
    Object.freeze({
      path: archivePath,
      sourcePath,
      kind: "file",
      size,
      mode: secretPath(archivePath) ? "secret" : stat.mode & 0o100 ? "executable" : "file",
      sha256,
      identity: Object.freeze({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }),
    })
  );
}

function createManifest(
  entries: readonly SourceEntry[],
  workspace: string,
  workspaceAliases: readonly string[],
  additions: readonly NormalizedArchiveAddition[]
): ArchiveManifest {
  const publicEntries = entries.map(({ sourcePath: _sourcePath, identity: _identity, ...entry }) =>
    Object.freeze(entry)
  );
  const totalBytes = publicEntries.reduce((sum, entry) => safeByteCount(sum + entry.size, MAX_TOTAL_BYTES), 0);
  const relocations = additions
    .filter((addition) => addition.recordRelocation)
    .map((addition) =>
      Object.freeze({
        name: addition.name,
        source_root: addition.path,
        source_aliases: Object.freeze(addition.sourceAlias ? [addition.sourceAlias] : []),
        archive_path: addition.archivePath,
      })
    );
  return Object.freeze({
    version: ARCHIVE_VERSION,
    workspace_root: workspace,
    workspace_aliases: Object.freeze([...workspaceAliases]),
    relocations: Object.freeze(relocations),
    entries: Object.freeze(publicEntries),
    total_bytes: totalBytes,
  });
}

function compareArchiveNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decodeManifest(buffer: Buffer): ArchiveManifest {
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("invalid archive manifest");
  }
  if (!isRecord(value) || value.version !== ARCHIVE_VERSION || !Array.isArray(value.entries)) {
    throw new Error("invalid archive manifest");
  }
  const keys = Object.keys(value).sort().join(",");
  if (
    ![
      "entries,total_bytes,version",
      "entries,relocations,total_bytes,version,workspace_root",
      "entries,relocations,total_bytes,version,workspace_aliases,workspace_root",
    ].includes(keys) ||
    value.entries.length > MAX_MEMBERS - 1
  ) {
    throw new Error("invalid archive manifest");
  }
  let workspaceRoot: string | undefined;
  let workspaceAliases: readonly string[] | undefined;
  let relocations: readonly ArchiveRelocation[] | undefined;
  if ("workspace_root" in value || "relocations" in value) {
    workspaceRoot = validateArchivedAbsolutePath(value.workspace_root);
    const rawWorkspaceAliases = value.workspace_aliases ?? [];
    if (!Array.isArray(rawWorkspaceAliases) || rawWorkspaceAliases.length > 4) {
      throw new Error("invalid archive manifest");
    }
    workspaceAliases = Object.freeze(rawWorkspaceAliases.map(validateArchivedAbsolutePath));
    if (new Set([workspaceRoot, ...workspaceAliases]).size !== workspaceAliases.length + 1) {
      throw new Error("invalid archive manifest");
    }
    if (!Array.isArray(value.relocations) || value.relocations.length > MAX_MEMBERS - 1) {
      throw new Error("invalid archive manifest");
    }
    const relocationNames = new Set<string>();
    relocations = Object.freeze(
      value.relocations.map((raw): ArchiveRelocation => {
        if (
          !isRecord(raw) ||
          ![
            "archive_path,name,source_root",
            "archive_path,name,source_aliases,source_root",
            "name,source_root",
            "name,source_aliases,source_root",
          ].includes(Object.keys(raw).sort().join(","))
        ) {
          throw new Error("invalid archive manifest");
        }
        const name = validateAdditionName(raw.name);
        if (relocationNames.has(name)) throw new Error("invalid archive manifest");
        relocationNames.add(name);
        const sourceRoot = validateArchivedAbsolutePath(raw.source_root);
        const sourceAliases = raw.source_aliases ?? [];
        if (!Array.isArray(sourceAliases) || sourceAliases.length > 4) throw new Error("invalid archive manifest");
        const aliases = sourceAliases.map(validateArchivedAbsolutePath);
        if (new Set([sourceRoot, ...aliases]).size !== aliases.length + 1) {
          throw new Error("invalid archive manifest");
        }
        const archivePath =
          raw.archive_path === undefined ? `relocated/${name}` : safeMemberName(String(raw.archive_path));
        return Object.freeze({
          name,
          source_root: sourceRoot,
          source_aliases: Object.freeze(aliases),
          archive_path: archivePath,
        });
      })
    );
  }
  const seen = new Set<string>();
  const folded = new Set<string>();
  const entries = value.entries.map((raw): ArchiveManifestEntry => {
    if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== "kind,mode,path,sha256,size") {
      throw new Error("invalid archive manifest");
    }
    const memberPath = safeMemberName(raw.path);
    const lower = memberPath.normalize("NFC").toLocaleLowerCase("en-US");
    if (seen.has(memberPath) || folded.has(lower)) throw new Error("invalid archive manifest");
    seen.add(memberPath);
    folded.add(lower);
    if (
      !["directory", "file"].includes(String(raw.kind)) ||
      !["directory", "executable", "file", "secret"].includes(String(raw.mode)) ||
      (raw.kind === "directory" && raw.mode !== "directory") ||
      (raw.kind === "file" && raw.mode === "directory") ||
      typeof raw.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(raw.sha256)
    ) {
      throw new Error("invalid archive manifest");
    }
    const size = safeByteCount(raw.size, MAX_FILE_BYTES);
    if (raw.kind === "directory" && (size !== 0 || raw.sha256 !== EMPTY_SHA256)) {
      throw new Error("invalid archive manifest");
    }
    return Object.freeze({
      path: memberPath,
      kind: raw.kind as "directory" | "file",
      size,
      mode: raw.mode as ModeClass,
      sha256: raw.sha256,
    });
  });
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    const parent = path.posix.dirname(entry.path);
    if (parent !== "." && byPath.get(parent)?.kind !== "directory") {
      throw new Error("invalid archive manifest");
    }
  }
  const totalBytes = safeByteCount(value.total_bytes, MAX_TOTAL_BYTES);
  const calculatedTotal = entries.reduce((sum, entry) => safeByteCount(sum + entry.size, MAX_TOTAL_BYTES), 0);
  if (calculatedTotal !== totalBytes) throw new Error("invalid archive manifest");
  return Object.freeze({
    version: ARCHIVE_VERSION,
    ...(workspaceRoot
      ? {
          workspace_root: workspaceRoot,
          workspace_aliases: workspaceAliases ?? Object.freeze([]),
          relocations: relocations ?? Object.freeze([]),
        }
      : {}),
    entries: Object.freeze(entries),
    total_bytes: totalBytes,
  });
}

function createArchiveHeader(encrypted: boolean): ArchiveHeader {
  return Object.freeze({
    encrypted,
    salt: encrypted ? randomBytes(SALT_BYTES) : Buffer.alloc(SALT_BYTES),
    iv: encrypted ? randomBytes(IV_BYTES) : Buffer.alloc(IV_BYTES),
    n: encrypted ? SCRYPT_N : 0,
    r: encrypted ? SCRYPT_R : 0,
    p: encrypted ? SCRYPT_P : 0,
  });
}

function encodeHeader(header: ArchiveHeader): Buffer {
  const output = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(output, 0);
  output.writeUInt8(ARCHIVE_VERSION, 16);
  output.writeUInt8(header.encrypted ? ENCRYPTED_FLAG : 0, 17);
  output.writeUInt32BE(header.n, 18);
  output.writeUInt32BE(header.r, 22);
  output.writeUInt32BE(header.p, 26);
  header.salt.copy(output, 30);
  header.iv.copy(output, 46);
  return output;
}

function decodeHeader(input: Buffer): ArchiveHeader {
  if (
    input.length !== HEADER_BYTES ||
    !input.subarray(0, MAGIC.length).equals(MAGIC) ||
    input.readUInt8(16) !== ARCHIVE_VERSION ||
    input.subarray(58).some((byte) => byte !== 0)
  ) {
    throw new Error("unsupported archive header");
  }
  const flags = input.readUInt8(17);
  if (![0, ENCRYPTED_FLAG].includes(flags)) throw new Error("unsupported archive flags");
  const encrypted = flags === ENCRYPTED_FLAG;
  const n = input.readUInt32BE(18);
  const r = input.readUInt32BE(22);
  const p = input.readUInt32BE(26);
  if (encrypted ? n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P : n !== 0 || r !== 0 || p !== 0) {
    throw new Error("unsupported archive key derivation");
  }
  return Object.freeze({
    encrypted,
    salt: Buffer.from(input.subarray(30, 46)),
    iv: Buffer.from(input.subarray(46, 58)),
    n,
    r,
    p,
  });
}

async function deriveArchiveKey(passphrase: Buffer, header: ArchiveHeader): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      header.salt,
      32,
      { N: header.n, r: header.r, p: header.p, maxmem: SCRYPT_MAXMEM },
      (error, key) => (error ? reject(error) : resolve(key))
    );
  });
}

function passphraseBuffer(value: string | Buffer | undefined): Buffer {
  if (value === undefined) throw new Error("archive passphrase is required");
  const buffer = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
  if (buffer.length < 12 || buffer.length > MAX_PASSPHRASE_BYTES || buffer.includes(0)) {
    buffer.fill(0);
    throw new Error("archive passphrase is invalid");
  }
  return buffer;
}

function manifestSummary(manifest: ArchiveManifest, encrypted: boolean): WorkspaceArchiveSummary {
  return Object.freeze({
    version: ARCHIVE_VERSION,
    encrypted,
    files: manifest.entries.filter((entry) => entry.kind === "file").length,
    directories: manifest.entries.filter((entry) => entry.kind === "directory").length,
    total_bytes: manifest.total_bytes,
  });
}

async function hashFile(filename: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(filename),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    })
  );
  return hash.digest("hex");
}

async function assertSourceIdentity(entry: SourceEntry): Promise<void> {
  if (!entry.identity) return;
  const stat = await fs.lstat(entry.sourcePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.dev !== entry.identity.dev ||
    stat.ino !== entry.identity.ino ||
    stat.size !== entry.identity.size ||
    stat.mtimeMs !== entry.identity.mtimeMs
  ) {
    throw new Error("workspace changed while archiving");
  }
}

async function proveAbsoluteDirectory(input: string): Promise<string> {
  const directory = validateAbsoluteDirectoryPath(input, "workspace directory");
  const [stat, real] = await Promise.all([fs.lstat(directory), fs.realpath(directory)]);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("workspace directory must be an exact regular directory");
  }
  return real;
}

function validateAbsoluteDirectoryPath(input: string, label: string): string {
  if (typeof input !== "string" || !path.isAbsolute(input) || input.includes("\0")) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return path.resolve(input);
}

async function canonicalSiblingPath(input: string, label: string): Promise<string> {
  const resolved = validateAbsoluteDirectoryPath(input, label);
  const parent = await fs.realpath(path.dirname(resolved));
  return path.join(parent, path.basename(resolved));
}

async function proveAbsoluteFile(input: string, label: string): Promise<string> {
  const resolved = validateAbsoluteDirectoryPath(input, label);
  const [leaf, real] = await Promise.all([fs.lstat(resolved), fs.realpath(resolved)]);
  if (!leaf.isFile() || leaf.isSymbolicLink()) throw new TypeError(`${label} must be an exact regular file`);
  return real;
}

async function proveAbsoluteEntry(input: string, label: string): Promise<string> {
  const resolved = validateAbsoluteDirectoryPath(input, label);
  const [leaf, real] = await Promise.all([fs.lstat(resolved), fs.realpath(resolved)]);
  if (leaf.isSymbolicLink() || (!leaf.isFile() && !leaf.isDirectory())) {
    throw new TypeError(`${label} must be an exact file or directory`);
  }
  return real;
}

function isWithinDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function safeMemberName(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 4_096 ||
    input.includes("\0") ||
    input.includes("\\")
  ) {
    throw new Error("unsafe archive member");
  }
  if (
    path.posix.isAbsolute(input) ||
    path.posix.normalize(input) !== input ||
    input.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("unsafe archive member");
  }
  return input.normalize("NFC");
}

function safeRestorePath(root: string, member: string): string {
  const output = path.resolve(root, ...member.split("/"));
  if (output === root || !output.startsWith(`${root}${path.sep}`)) throw new Error("unsafe restore path");
  return output;
}

function maximumTarBytes(manifest: ArchiveManifest, manifestBytes: number): number {
  let total = addTarBytes(TAR_BLOCK_BYTES, paddedTarBodyBytes(manifestBytes));
  for (const entry of manifest.entries) {
    if (tarPathNeedsPax(entry.path, entry.kind)) {
      total = addTarBytes(total, TAR_BLOCK_BYTES);
      total = addTarBytes(total, paddedTarBodyBytes(paxPathRecordBytes(entry.path)));
    }
    total = addTarBytes(total, TAR_BLOCK_BYTES);
    total = addTarBytes(total, paddedTarBodyBytes(entry.size));
  }
  return addTarBytes(total, TAR_END_BYTES);
}

function tarPathNeedsPax(member: string, kind: ArchiveManifestEntry["kind"]): boolean {
  let name = kind === "directory" ? `${member}/` : member;
  if (Buffer.byteLength(name) !== name.length) return true;
  let prefix = "";
  while (Buffer.byteLength(name) > 100) {
    const separator = name.indexOf("/");
    if (separator === -1) return true;
    prefix += `${prefix ? "/" : ""}${name.slice(0, separator)}`;
    name = name.slice(separator + 1);
  }
  return Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155;
}

function paxPathRecordBytes(member: string): number {
  const bodyBytes = Buffer.byteLength(` path=${member}\n`);
  let prefixDigits = String(bodyBytes).length;
  if (bodyBytes + prefixDigits >= 10 ** prefixDigits) prefixDigits += 1;
  return bodyBytes + prefixDigits;
}

function paddedTarBodyBytes(size: number): number {
  const remainder = size % TAR_BLOCK_BYTES;
  return remainder === 0 ? size : addTarBytes(size, TAR_BLOCK_BYTES - remainder);
}

function addTarBytes(left: number, right: number): number {
  return safeByteCount(left + right, Number.MAX_SAFE_INTEGER);
}

function safeByteCount(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error("archive byte limit");
  }
  return value;
}

function validateAdditionName(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) {
    throw new TypeError("addition name is invalid");
  }
  return value;
}

function validateArchivedAbsolutePath(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0") || value.length > 32_768) {
    throw new Error("invalid archive manifest");
  }
  return path.resolve(value);
}

async function normalizeArchiveAdditions(
  additions: readonly WorkspaceArchiveAddition[]
): Promise<readonly NormalizedArchiveAddition[]> {
  if (additions.length > MAX_MEMBERS - 1) throw new Error("workspace member limit exceeded");
  const names = new Set<string>();
  const normalized: NormalizedArchiveAddition[] = [];
  for (const addition of additions) {
    const name = validateAdditionName(addition.name);
    if (names.has(name)) throw new TypeError("addition names must be unique");
    names.add(name);
    const requested = validateAbsoluteDirectoryPath(addition.path, "addition path");
    const canonical = await proveAbsoluteEntry(requested, "addition path");
    const archivePath = PORTABLE_ROOT_ADDITIONS.has(name) ? name : `relocated/${name}`;
    const requiredKind = PORTABLE_ROOT_ADDITIONS.get(name);
    if (requiredKind) {
      const stat = await fs.lstat(canonical);
      if (stat.isSymbolicLink() || (requiredKind === "file" ? !stat.isFile() : !stat.isDirectory())) {
        throw new TypeError(`addition ${name} must be a ${requiredKind}`);
      }
    }
    normalized.push(
      Object.freeze({
        name,
        path: canonical,
        archivePath,
        recordRelocation: true,
        ...(requested === canonical ? {} : { sourceAlias: requested }),
      })
    );
  }
  const portableLance = normalized.find((addition) => addition.archivePath === "lancedb");
  if (portableLance) {
    const migrationRoot = path.join(
      path.dirname(portableLance.path),
      `.${path.basename(portableLance.path)}-migrations`
    );
    const stat = await fs.lstat(migrationRoot).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat) {
      const canonical = await proveAbsoluteEntry(migrationRoot, "LanceDB migration path");
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new TypeError("LanceDB migration path must be an exact directory");
      }
      normalized.push(
        Object.freeze({
          name: "lancedb-migrations",
          path: canonical,
          archivePath: ".lancedb-migrations",
          recordRelocation: false,
        })
      );
    }
  }
  return Object.freeze(normalized);
}

function validateAdditionRoots(workspace: string, additions: readonly WorkspaceArchiveAddition[]): void {
  for (let index = 0; index < additions.length; index += 1) {
    const addition = additions[index]!;
    if (isWithinDirectory(addition.path, workspace) || isWithinDirectory(workspace, addition.path)) {
      throw new TypeError("addition paths must not overlap the workspace");
    }
    for (const other of additions.slice(0, index)) {
      if (isWithinDirectory(addition.path, other.path) || isWithinDirectory(other.path, addition.path)) {
        throw new TypeError("addition paths must not overlap");
      }
    }
  }
}

async function rebaseRestoredWorkspacePaths(
  restoredDirectory: string,
  targetDirectory: string,
  manifest: ArchiveManifest
): Promise<void> {
  const mappings = [
    Object.freeze({ source: manifest.workspace_root!, target: targetDirectory, exactOnly: false }),
    ...(manifest.workspace_aliases ?? []).map((source) =>
      Object.freeze({ source, target: targetDirectory, exactOnly: false })
    ),
    ...(manifest.relocations ?? [])
      .map((relocation) => {
        const archivePath = relocation.archive_path ?? `relocated/${relocation.name}`;
        const entry = manifest.entries.find((candidate) => candidate.path === archivePath);
        if (!entry) throw new Error("invalid archive relocation");
        return Object.freeze({
          source: relocation.source_root,
          target: path.join(targetDirectory, ...archivePath.split("/")),
          exactOnly: entry.kind === "file",
        });
      })
      .flatMap((mapping, index) => [
        mapping,
        ...(manifest.relocations?.[index]?.source_aliases ?? []).map((source) => Object.freeze({ ...mapping, source })),
      ]),
  ].sort((left, right) => right.source.length - left.source.length);
  const rebase = (value: string): string => rebaseDurablePath(value, mappings);
  const sqlitePath = path.join(restoredDirectory, "borealis.sqlite");
  if (await hasSqliteHeader(sqlitePath)) {
    const database = new Database(sqlitePath, { fileMustExist: true });
    try {
      database.pragma("foreign_keys = ON");
      database.transaction(() => {
        rebaseSqliteTextColumns(database, "sources", ["file_path"], rebase);
        rebaseSqliteJsonObjectPaths(
          database,
          "sources",
          "meta",
          ["connector_previous_location", "connector_candidate_location", "connector_activation_previous_location"],
          rebase
        );
        rebaseSqliteTextColumns(database, "pending_source_deletes", ["file_path"], rebase);
        rebaseSqliteJsonStringArray(database, "pending_source_deletes", "dataset_locations", rebase);
        rebaseSqliteTextColumns(database, "dataset_cache_cleanup_jobs", ["location"], rebase);
        rebaseSqliteTextColumns(database, "reports", ["html_path", "pdf_path"], rebase);
        rebaseSqliteTextColumns(database, "report_artifact_cleanup_jobs", ["html_path", "pdf_path"], rebase);
      })();
      database.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      database.close();
    }
  }
  await rebaseContainedConfig(restoredDirectory, rebase);
}

async function hasSqliteHeader(filename: string): Promise<boolean> {
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read({ buffer: header, position: 0 });
    return bytesRead === header.length && header.equals(Buffer.from("SQLite format 3\0", "ascii"));
  } finally {
    await handle.close();
  }
}

function rebaseDurablePath(
  value: string,
  mappings: readonly Readonly<{ source: string; target: string; exactOnly: boolean }>[]
): string {
  if (!path.isAbsolute(value) || value.includes("\0")) return value;
  const resolved = path.resolve(value);
  for (const mapping of mappings) {
    const relative = path.relative(mapping.source, resolved);
    if (relative === "") return mapping.target;
    if (
      !mapping.exactOnly &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    ) {
      return path.join(mapping.target, relative);
    }
  }
  return value;
}

function sqliteTableExists(database: Database.Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function rebaseSqliteTextColumns(
  database: Database.Database,
  table: string,
  columns: readonly string[],
  rebase: (value: string) => string
): void {
  if (!sqliteTableExists(database, table)) return;
  const select = database.prepare(`SELECT rowid AS _rowid, ${columns.join(", ")} FROM ${table}`);
  const assignments = columns.map((column) => `${column}=?`).join(", ");
  const update = database.prepare(`UPDATE ${table} SET ${assignments} WHERE rowid=?`);
  for (const row of select.all() as Array<Record<string, unknown> & { _rowid: number | bigint }>) {
    const before = columns.map((column) => row[column]);
    const after = before.map((value) => (typeof value === "string" ? rebase(value) : value));
    if (after.some((value, index) => value !== before[index])) update.run(...after, row._rowid);
  }
}

function rebaseSqliteJsonObjectPaths(
  database: Database.Database,
  table: string,
  column: string,
  keys: readonly string[],
  rebase: (value: string) => string
): void {
  if (!sqliteTableExists(database, table)) return;
  const update = database.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`);
  for (const row of database.prepare(`SELECT rowid AS _rowid, ${column} AS value FROM ${table}`).all() as Array<{
    _rowid: number | bigint;
    value: unknown;
  }>) {
    if (typeof row.value !== "string") continue;
    const parsed = JSON.parse(row.value) as unknown;
    if (!isRecord(parsed)) continue;
    let changed = false;
    for (const key of keys) {
      if (typeof parsed[key] !== "string") continue;
      const next = rebase(parsed[key]);
      if (next !== parsed[key]) {
        parsed[key] = next;
        changed = true;
      }
    }
    if (changed) update.run(JSON.stringify(parsed), row._rowid);
  }
}

function rebaseSqliteJsonStringArray(
  database: Database.Database,
  table: string,
  column: string,
  rebase: (value: string) => string
): void {
  if (!sqliteTableExists(database, table)) return;
  const update = database.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`);
  for (const row of database.prepare(`SELECT rowid AS _rowid, ${column} AS value FROM ${table}`).all() as Array<{
    _rowid: number | bigint;
    value: unknown;
  }>) {
    if (typeof row.value !== "string") continue;
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) continue;
    const next = parsed.map((value) => rebase(value));
    if (next.some((value, index) => value !== parsed[index])) update.run(JSON.stringify(next), row._rowid);
  }
}

async function rebaseContainedConfig(restoredDirectory: string, rebase: (value: string) => string): Promise<void> {
  const filename = path.join(restoredDirectory, "contained.json");
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("contained config is invalid");
    const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("contained config is invalid");
    let changed = false;
    for (const key of ["binary_path", "model_path"] as const) {
      if (typeof parsed[key] !== "string") continue;
      const next = rebase(parsed[key]);
      if (next !== parsed[key]) {
        parsed[key] = next;
        changed = true;
      }
    }
    if (!changed) return;
    await handle.close();
    handle = undefined;
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await fs.chmod(temporary, 0o600);
      await syncFile(temporary);
      await fs.rename(temporary, filename);
      await syncDirectory(restoredDirectory);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function secretPath(value: string): boolean {
  return ["settings.json", "contained.json", "jwt.secret"].includes(value);
}

async function assertDestinationAvailable(destination: string, part: string): Promise<void> {
  for (const filename of [destination, part]) {
    const stat = await fs.lstat(filename).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat) throw new Error("archive destination already exists");
  }
  await fs.access(path.dirname(destination), fsConstants.W_OK);
}

async function verifyRestoredLayout(directory: string): Promise<void> {
  const [sqlite, lance] = await Promise.all([
    fs.lstat(path.join(directory, "borealis.sqlite")),
    fs.lstat(path.join(directory, "lancedb")),
  ]);
  if (!sqlite.isFile() || sqlite.isSymbolicLink() || !lance.isDirectory() || lance.isSymbolicLink()) {
    throw new Error("restored workspace layout is incomplete");
  }
}

function backupMarkerPath(backup: string): string {
  return path.join(path.dirname(backup), `${BACKUP_MARKER_SUFFIX}.${path.basename(backup)}`);
}

async function writeBackupMarker(
  marker: string,
  target: string,
  backup: string,
  stat: Readonly<{ isDirectory(): boolean; isSymbolicLink(): boolean; dev: number; ino: number }>
): Promise<void> {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("workspace backup is unsafe");
  const payload = Buffer.from(
    `${JSON.stringify({
      version: 1,
      target: path.basename(target),
      backup: path.basename(backup),
      dev: stat.dev,
      ino: stat.ino,
    })}\n`,
    "utf8"
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      marker,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(payload);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Recover only a positively identified interrupted target-to-backup rename. */
async function recoverInterruptedRestore(target: string): Promise<void> {
  const parent = path.dirname(target);
  const backupPrefix = `.${path.basename(target)}.backup.`;
  const markerPrefix = `${BACKUP_MARKER_SUFFIX}.${backupPrefix}`;
  const markerNames = (await fs.readdir(parent)).filter((name) => name.startsWith(markerPrefix)).sort();
  for (const markerName of markerNames) {
    const marker = path.join(parent, markerName);
    const backupName = markerName.slice(`${BACKUP_MARKER_SUFFIX}.`.length);
    if (!backupName.startsWith(backupPrefix) || path.basename(backupName) !== backupName) {
      throw new Error("workspace restore recovery is required");
    }
    const backup = path.join(parent, backupName);
    const [targetStat, backupStat] = await Promise.all([
      fs.lstat(target).catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw error;
      }),
      fs.lstat(backup).catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw error;
      }),
    ]);
    if (targetStat && backupStat) {
      await verifyBackupMarker(marker, target, backup, backupStat.dev, backupStat.ino);
      throw new Error("an existing workspace backup must be removed before another restore");
    }
    if (backupStat) {
      if (!backupStat.isDirectory() || backupStat.isSymbolicLink() || (await fs.realpath(backup)) !== backup) {
        throw new Error("workspace restore recovery is required");
      }
      await verifyBackupMarker(marker, target, backup, backupStat.dev, backupStat.ino);
      await fs.rename(backup, target);
      await fs.unlink(marker);
      await syncDirectory(parent);
      continue;
    }
    if (targetStat) {
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink() || (await fs.realpath(target)) !== target) {
        throw new Error("workspace restore recovery is required");
      }
      await verifyBackupMarker(marker, target, backup, targetStat.dev, targetStat.ino);
      await fs.unlink(marker);
      await syncDirectory(parent);
      continue;
    }
    throw new Error("workspace restore recovery is required");
  }
}

async function verifyBackupMarker(
  marker: string,
  target: string,
  backup: string,
  dev: number,
  ino: number
): Promise<void> {
  const value = await readBackupMarker(marker);
  if (
    value.target !== path.basename(target) ||
    value.backup !== path.basename(backup) ||
    value.dev !== dev ||
    value.ino !== ino
  ) {
    throw new Error("workspace backup provenance is invalid");
  }
}

interface BackupMarker {
  readonly target: string;
  readonly backup: string;
  readonly dev: number;
  readonly ino: number;
}

async function readBackupMarker(marker: string): Promise<BackupMarker> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(marker, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1_024) {
      throw new Error("workspace backup provenance is invalid");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("workspace backup provenance is invalid");
    }
    const value = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== "backup,dev,ino,target,version" ||
      value.version !== 1 ||
      typeof value.target !== "string" ||
      path.basename(value.target) !== value.target ||
      typeof value.backup !== "string" ||
      path.basename(value.backup) !== value.backup ||
      typeof value.dev !== "number" ||
      !Number.isSafeInteger(value.dev) ||
      value.dev < 0 ||
      typeof value.ino !== "number" ||
      !Number.isSafeInteger(value.ino) ||
      value.ino < 1
    ) {
      throw new Error("workspace backup provenance is invalid");
    }
    return Object.freeze({ target: value.target, backup: value.backup, dev: value.dev, ino: value.ino });
  } catch {
    throw new Error("workspace backup provenance is invalid");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBoundedStream(stream: NodeJS.ReadableStream, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of stream as Readable) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > maximum) throw new Error("archive member limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function drainStream(stream: NodeJS.ReadableStream): Promise<void> {
  for await (const _chunk of stream as Readable) {
    // Directory bodies must be empty by the declared header size.
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Atomic publication already fsyncs archive content; directory sync is best-effort.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncFile(filename: string): Promise<void> {
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("archive file is unsafe");
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function syncRestoredTree(directory: string): Promise<void> {
  const names = await fs.readdir(directory);
  names.sort(compareArchiveNames);
  for (const name of names) {
    const entry = path.join(directory, name);
    const stat = await fs.lstat(entry);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error("restored workspace contains an unsafe entry");
    }
    if (stat.isDirectory()) await syncRestoredTree(entry);
    else await syncFile(entry);
  }
  await syncDirectoryStrict(directory);
}

async function syncDirectoryStrict(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    const code = isNodeError(error) ? error.code : undefined;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "ENOSYS") throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function ensureRestoreCapacity(directory: string, payloadBytes: number): Promise<void> {
  const stats = await fs.statfs(directory, { bigint: true });
  const available = stats.bavail * stats.bsize;
  const required = BigInt(payloadBytes) + BigInt(RESTORE_SPACE_RESERVE_BYTES);
  if (available < required) throw new Error("workspace restore does not have enough free space");
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
