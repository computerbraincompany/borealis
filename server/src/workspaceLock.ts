import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const LOCK_SUFFIX = ".borealis-instance.lock";
const LOCK_VERSION = 2 as const;
const MAX_LOCK_BYTES = 1_024;
const MAX_NAMESPACE_ENTRIES = 4_096;
const MAX_SCAN_PASSES = 16;
const UUID_PATTERN = /^[0-9a-f-]{36}$/i;

interface LockPayload {
  readonly version: typeof LOCK_VERSION;
  readonly pid: number;
  readonly token: string;
  readonly publication: string;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
}

interface CandidateIdentity extends FileIdentity {
  readonly name: string;
  readonly path: string;
  readonly payload: LockPayload;
}

interface WorkspaceLockNamespace {
  readonly parent: string;
  readonly path: string;
}

interface ReapedEntry {
  readonly directory: string;
  readonly path: string;
  readonly originalName: string;
}

export interface WorkspaceLock {
  /** The unique owner record held by this acquisition. */
  readonly path: string;
  release(): Promise<void>;
}

export class WorkspaceLockedError extends Error {
  readonly code = "WORKSPACE_LOCKED";

  constructor() {
    super("workspace is already in use");
    this.name = "WorkspaceLockedError";
  }
}

export interface AcquireWorkspaceLockOptions {
  readonly pid?: number;
  readonly processAlive?: (pid: number) => boolean;
  readonly token?: string;
}

/** Own one exact workspace for the server or an offline archive operation. */
export async function acquireWorkspaceLock(
  workspaceDirectory: string,
  options: AcquireWorkspaceLockOptions = {}
): Promise<WorkspaceLock> {
  const namespace = await canonicalWorkspaceLockNamespace(workspaceDirectory);
  const pid = normalizePid(options.pid ?? process.pid);
  const token = normalizeUuid(options.token ?? randomUUID());
  const processAlive = options.processAlive ?? defaultProcessAlive;

  await ensureNamespace(namespace);
  await recoverReapDirectories(namespace, processAlive);
  await cleanupAbandonedTemps(namespace, processAlive);

  const candidate = await publishCandidate(namespace, pid, token);
  try {
    await stabilizeOwnership(namespace, candidate, processAlive);
  } catch (error) {
    await removeCandidate(namespace, candidate);
    throw error;
  }
  return createOwnedLock(namespace, candidate);
}

/** The persistent private namespace containing unique owner records. */
export function workspaceLockPath(workspaceDirectory: string): string {
  if (
    typeof workspaceDirectory !== "string" ||
    !path.isAbsolute(workspaceDirectory) ||
    workspaceDirectory.includes("\0")
  ) {
    throw new TypeError("workspace directory must be an absolute path");
  }
  const resolved = path.resolve(workspaceDirectory);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}${LOCK_SUFFIX}`);
}

async function canonicalWorkspaceLockNamespace(input: string): Promise<WorkspaceLockNamespace> {
  if (typeof input !== "string" || !path.isAbsolute(input) || input.includes("\0")) {
    throw new TypeError("workspace directory must be an absolute path");
  }
  const resolved = path.resolve(input);
  // A fresh workspace may sit below an as-yet missing parent chain. Creating
  // only that chain preserves first-run behavior without touching the workspace
  // itself before ownership is established in the sibling lock namespace.
  const unresolvedParent = path.dirname(resolved);
  await fs.mkdir(unresolvedParent, { recursive: true, mode: 0o700 });
  const parent = await fs.realpath(unresolvedParent);
  const workspace = path.join(parent, path.basename(resolved));
  const stat = await fs.lstat(workspace).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(workspace)) !== workspace)) {
    throw new TypeError("workspace directory must be an exact regular directory");
  }
  return Object.freeze({ parent, path: workspaceLockPath(workspace) });
}

async function ensureNamespace(namespace: WorkspaceLockNamespace): Promise<void> {
  let created = false;
  try {
    await fs.mkdir(namespace.path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  const [stat, real] = await Promise.all([fs.lstat(namespace.path), fs.realpath(namespace.path)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedByCurrentUser(stat.uid) || real !== namespace.path) {
    throw new WorkspaceLockedError();
  }
  if ((stat.mode & 0o777) !== 0o700) await fs.chmod(namespace.path, 0o700);
  await syncDirectory(namespace.path);
  if (created) await syncDirectory(namespace.parent);
}

async function publishCandidate(
  namespace: WorkspaceLockNamespace,
  pid: number,
  token: string
): Promise<CandidateIdentity> {
  const publication = randomUUID();
  const temporaryName = `.tmp.${pid}.${publication}`;
  const candidateName = `owner.${pid}.${publication}`;
  const temporaryPath = path.join(namespace.path, temporaryName);
  const candidatePath = path.join(namespace.path, candidateName);
  const payload = Object.freeze({ version: LOCK_VERSION, pid, token, publication } satisfies LockPayload);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let published = false;
  try {
    handle = await fs.open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    const stat = await handle.stat();
    if (!validPrivateFile(stat, false)) throw new WorkspaceLockedError();
    temporaryIdentity = Object.freeze({ dev: stat.dev, ino: stat.ino, uid: stat.uid });
    await handle.close();
    handle = undefined;
    await syncDirectory(namespace.path);
    if (await pathEntryExists(candidatePath)) throw new WorkspaceLockedError();
    await fs.rename(temporaryPath, candidatePath);
    published = true;
    await syncDirectory(namespace.path);
    const candidate = await readCandidate(candidatePath, candidateName);
    if (!candidate || !sameFile(candidate, temporaryIdentity) || !samePayload(candidate.payload, payload)) {
      throw new WorkspaceLockedError();
    }
    return candidate;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (!published && temporaryIdentity) {
      await removeRawUniqueFile(namespace, temporaryPath, temporaryIdentity).catch(() => undefined);
    }
    throw error;
  }
}

async function stabilizeOwnership(
  namespace: WorkspaceLockNamespace,
  own: CandidateIdentity,
  processAlive: (pid: number) => boolean
): Promise<void> {
  for (let pass = 0; pass < MAX_SCAN_PASSES; pass += 1) {
    await recoverReapDirectories(namespace, processAlive);
    await cleanupAbandonedTemps(namespace, processAlive);
    const candidates = await readPublishedCandidates(namespace);
    let removedStale = false;
    for (const candidate of candidates) {
      if (sameFile(candidate, own)) continue;
      if (processAlive(candidate.payload.pid)) throw new WorkspaceLockedError();
      await removeCandidate(namespace, candidate);
      removedStale = true;
    }
    if (removedStale) continue;

    const confirmed = await readPublishedCandidates(namespace);
    if (!confirmed.some((candidate) => sameFile(candidate, own))) throw new WorkspaceLockedError();
    if (confirmed.some((candidate) => !sameFile(candidate, own))) continue;
    return;
  }
  throw new WorkspaceLockedError();
}

async function readPublishedCandidates(namespace: WorkspaceLockNamespace): Promise<readonly CandidateIdentity[]> {
  const names = await boundedNamespaceEntries(namespace.path);
  const candidates: CandidateIdentity[] = [];
  for (const name of names) {
    if (parseTempName(name)) {
      if (!(await readBasicPrivateFile(path.join(namespace.path, name), true))) throw new WorkspaceLockedError();
      continue;
    }
    if (parseReapName(name)) throw new WorkspaceLockedError();
    const parsed = parseCandidateName(name);
    if (!parsed) throw new WorkspaceLockedError();
    const candidate = await readCandidate(path.join(namespace.path, name), name);
    if (!candidate || candidate.payload.pid !== parsed.pid || candidate.payload.publication !== parsed.publication) {
      throw new WorkspaceLockedError();
    }
    candidates.push(candidate);
  }
  return Object.freeze(candidates);
}

async function cleanupAbandonedTemps(
  namespace: WorkspaceLockNamespace,
  processAlive: (pid: number) => boolean
): Promise<void> {
  for (const name of await boundedNamespaceEntries(namespace.path)) {
    const parsed = parseTempName(name);
    if (!parsed) continue;
    const filename = path.join(namespace.path, name);
    const identity = await readBasicPrivateFile(filename, true);
    if (!identity) throw new WorkspaceLockedError();
    if (processAlive(parsed.pid)) continue;
    await removeRawUniqueFile(namespace, filename, identity);
  }
}

async function recoverReapDirectories(
  namespace: WorkspaceLockNamespace,
  processAlive: (pid: number) => boolean
): Promise<void> {
  for (const name of await boundedNamespaceEntries(namespace.path)) {
    const parsed = parseReapName(name);
    if (!parsed) continue;
    const directory = path.join(namespace.path, name);
    const stat = await fs.lstat(directory).catch(() => undefined);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || !ownedByCurrentUser(stat.uid)) {
      throw new WorkspaceLockedError();
    }
    if (processAlive(parsed.pid)) throw new WorkspaceLockedError();
    const entries = await fs.readdir(directory);
    if (entries.length === 0) {
      await fs.rmdir(directory);
      await syncDirectory(namespace.path);
      continue;
    }
    if (entries.length !== 1) throw new WorkspaceLockedError();
    const originalName = entries[0]!;
    const movedPath = path.join(directory, originalName);
    const candidateName = parseCandidateName(originalName);
    const tempName = parseTempName(originalName);
    if (candidateName) {
      let candidate = await readCandidate(movedPath, originalName);
      let restoredInterruptedPair = false;
      if (!candidate) {
        candidate = await finishInterruptedCandidateRestore(
          namespace,
          { directory, path: movedPath, originalName },
          originalName
        );
        restoredInterruptedPair = Boolean(candidate);
      }
      if (!candidate) throw new WorkspaceLockedError();
      if (processAlive(candidate.payload.pid)) {
        if (!restoredInterruptedPair) {
          await restoreReapedEntry(namespace, { directory, path: movedPath, originalName }, candidate);
        }
        throw new WorkspaceLockedError();
      }
      if (!restoredInterruptedPair) {
        await removeReapedEntry(namespace, { directory, path: movedPath, originalName });
      }
      continue;
    }
    if (tempName) {
      let identity = await readBasicPrivateFile(movedPath, true);
      let restoredInterruptedPair = false;
      if (!identity) {
        identity = await finishInterruptedRawRestore(namespace, { directory, path: movedPath, originalName }, true);
        restoredInterruptedPair = Boolean(identity);
      }
      if (!identity) throw new WorkspaceLockedError();
      if (processAlive(tempName.pid)) {
        if (!restoredInterruptedPair) {
          await restoreReapedEntry(namespace, { directory, path: movedPath, originalName }, identity, true);
        }
      } else if (!restoredInterruptedPair) {
        await removeReapedEntry(namespace, { directory, path: movedPath, originalName });
      }
      continue;
    }
    throw new WorkspaceLockedError();
  }
}

async function removeCandidate(
  namespace: WorkspaceLockNamespace,
  expected: CandidateIdentity
): Promise<"missing" | "removed"> {
  const reaped = await moveUniquePathToReap(namespace, expected.path);
  if (!reaped) return "missing";
  const moved = await readCandidate(reaped.path, expected.name);
  if (!moved || !sameFile(moved, expected) || !samePayload(moved.payload, expected.payload)) {
    if (moved) await restoreReapedEntry(namespace, reaped, moved);
    throw new WorkspaceLockedError();
  }
  await removeReapedEntry(namespace, reaped);
  return "removed";
}

async function removeRawUniqueFile(
  namespace: WorkspaceLockNamespace,
  filename: string,
  expected: FileIdentity
): Promise<void> {
  const reaped = await moveUniquePathToReap(namespace, filename);
  if (!reaped) return;
  const moved = await readBasicPrivateFile(reaped.path, true);
  if (!moved || !sameFile(moved, expected)) {
    if (moved) await restoreReapedEntry(namespace, reaped, moved, true);
    throw new WorkspaceLockedError();
  }
  await removeReapedEntry(namespace, reaped);
}

async function moveUniquePathToReap(
  namespace: WorkspaceLockNamespace,
  filename: string
): Promise<ReapedEntry | undefined> {
  const prefix = path.join(namespace.path, `.reap.${process.pid}.${randomUUID()}.`);
  const directory = await fs.mkdtemp(prefix);
  await fs.chmod(directory, 0o700);
  await syncDirectory(directory);
  await syncDirectory(namespace.path);
  const originalName = path.basename(filename);
  const movedPath = path.join(directory, originalName);
  try {
    await fs.rename(filename, movedPath);
  } catch (error) {
    await fs.rmdir(directory).catch(() => undefined);
    await syncDirectory(namespace.path);
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  await syncDirectory(directory);
  await syncDirectory(namespace.path);
  return Object.freeze({ directory, path: movedPath, originalName });
}

async function restoreReapedEntry(
  namespace: WorkspaceLockNamespace,
  reaped: ReapedEntry,
  expected: FileIdentity,
  allowEmpty = false
): Promise<void> {
  const destination = path.join(namespace.path, reaped.originalName);
  try {
    await fs.link(reaped.path, destination);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const current = await readBasicPrivateFile(destination, allowEmpty, 2);
    if (!current || !sameFile(current, expected)) throw new WorkspaceLockedError();
  }
  await syncDirectory(namespace.path);
  const moved = await readBasicPrivateFile(reaped.path, allowEmpty, 2);
  if (!moved || !sameFile(moved, expected)) throw new WorkspaceLockedError();
  await fs.unlink(reaped.path);
  await fs.rmdir(reaped.directory);
  await syncDirectory(namespace.path);
}

async function finishInterruptedCandidateRestore(
  namespace: WorkspaceLockNamespace,
  reaped: ReapedEntry,
  candidateName: string
): Promise<CandidateIdentity | undefined> {
  const moved = await readCandidate(reaped.path, candidateName, 2);
  if (!moved) return undefined;
  const destination = path.join(namespace.path, reaped.originalName);
  const published = await readCandidate(destination, candidateName, 2);
  if (!published || !sameFile(published, moved) || !samePayload(published.payload, moved.payload)) {
    throw new WorkspaceLockedError();
  }
  await restoreReapedEntry(namespace, reaped, moved);
  const restored = await readCandidate(destination, candidateName);
  if (!restored || !sameFile(restored, moved) || !samePayload(restored.payload, moved.payload)) {
    throw new WorkspaceLockedError();
  }
  return restored;
}

async function finishInterruptedRawRestore(
  namespace: WorkspaceLockNamespace,
  reaped: ReapedEntry,
  allowEmpty: boolean
): Promise<FileIdentity | undefined> {
  const moved = await readBasicPrivateFile(reaped.path, allowEmpty, 2);
  if (!moved) return undefined;
  const destination = path.join(namespace.path, reaped.originalName);
  const published = await readBasicPrivateFile(destination, allowEmpty, 2);
  if (!published || !sameFile(published, moved)) throw new WorkspaceLockedError();
  await restoreReapedEntry(namespace, reaped, moved, allowEmpty);
  const restored = await readBasicPrivateFile(destination, allowEmpty);
  if (!restored || !sameFile(restored, moved)) throw new WorkspaceLockedError();
  return restored;
}

async function removeReapedEntry(namespace: WorkspaceLockNamespace, reaped: ReapedEntry): Promise<void> {
  await fs.unlink(reaped.path);
  await fs.rmdir(reaped.directory);
  await syncDirectory(namespace.path);
}

async function readCandidate(
  filename: string,
  name: string,
  expectedLinks = 1
): Promise<CandidateIdentity | undefined> {
  const parsedName = parseCandidateName(name);
  if (!parsedName) return undefined;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!validPrivateFile(stat, true, expectedLinks)) return undefined;
    if ((stat.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    const payload = decodePayload(await handle.readFile("utf8"));
    if (payload.pid !== parsedName.pid || payload.publication !== parsedName.publication) return undefined;
    return Object.freeze({
      name,
      path: filename,
      payload,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
    });
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBasicPrivateFile(
  filename: string,
  allowEmpty: boolean,
  expectedLinks = 1
): Promise<FileIdentity | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!validPrivateFile(stat, allowEmpty, expectedLinks)) return undefined;
    if ((stat.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    return Object.freeze({ dev: stat.dev, ino: stat.ino, uid: stat.uid });
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validPrivateFile(
  stat: Readonly<{
    isFile(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    nlink: number;
    uid: number;
  }>,
  allowEmpty: boolean,
  expectedLinks = 1
): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    ownedByCurrentUser(stat.uid) &&
    stat.nlink === expectedLinks &&
    stat.size <= MAX_LOCK_BYTES &&
    (allowEmpty || stat.size >= 1)
  );
}

function createOwnedLock(namespace: WorkspaceLockNamespace, identity: CandidateIdentity): WorkspaceLock {
  let released = false;
  let activeRelease: Promise<void> | undefined;
  return Object.freeze({
    path: identity.path,
    async release(): Promise<void> {
      if (released) return;
      if (!activeRelease) {
        activeRelease = (async () => {
          const current = await readCandidate(identity.path, identity.name);
          if (!current || !sameFile(current, identity) || !samePayload(current.payload, identity.payload)) {
            throw new WorkspaceLockedError();
          }
          await removeCandidate(namespace, identity);
          released = true;
        })();
      }
      try {
        await activeRelease;
      } finally {
        activeRelease = undefined;
      }
    },
  });
}

async function boundedNamespaceEntries(directory: string): Promise<readonly string[]> {
  const names = await fs.readdir(directory);
  if (names.length > MAX_NAMESPACE_ENTRIES) throw new WorkspaceLockedError();
  names.sort();
  return Object.freeze(names);
}

function parseCandidateName(name: string): { readonly pid: number; readonly publication: string } | undefined {
  return parsePidUuidName(name, "owner");
}

function parseTempName(name: string): { readonly pid: number; readonly publication: string } | undefined {
  return parsePidUuidName(name, ".tmp");
}

function parsePidUuidName(
  name: string,
  prefix: "owner" | ".tmp"
): { readonly pid: number; readonly publication: string } | undefined {
  const start = `${prefix}.`;
  if (!name.startsWith(start)) return undefined;
  const separator = name.indexOf(".", start.length);
  if (separator === -1) return undefined;
  const rawPid = Number(name.slice(start.length, separator));
  const publication = name.slice(separator + 1);
  if (!validPid(rawPid) || !UUID_PATTERN.test(publication)) return undefined;
  return Object.freeze({ pid: rawPid, publication });
}

function parseReapName(name: string): { readonly pid: number } | undefined {
  const match = /^\.reap\.(\d+)\.([0-9a-f-]{36})\.([A-Za-z0-9]{6})$/i.exec(name);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!validPid(pid) || !UUID_PATTERN.test(match[2]!)) return undefined;
  return Object.freeze({ pid });
}

function decodePayload(contents: string): LockPayload {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new WorkspaceLockedError();
  }
  if (
    !isRecord(value) ||
    value.version !== LOCK_VERSION ||
    Object.keys(value).sort().join(",") !== "pid,publication,token,version"
  ) {
    throw new WorkspaceLockedError();
  }
  return Object.freeze({
    version: LOCK_VERSION,
    pid: normalizePid(value.pid),
    token: normalizeUuid(value.token),
    publication: normalizeUuid(value.publication),
  });
}

function samePayload(left: LockPayload, right: LockPayload): boolean {
  return (
    left.version === right.version &&
    left.pid === right.pid &&
    left.token === right.token &&
    left.publication === right.publication
  );
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function normalizePid(value: unknown): number {
  if (typeof value !== "number" || !validPid(value)) throw new WorkspaceLockedError();
  return value;
}

function validPid(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function normalizeUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new WorkspaceLockedError();
  return value;
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function pathEntryExists(filename: string): Promise<boolean> {
  return fs
    .lstat(filename)
    .then(() => true)
    .catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    });
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Candidate files are fsynced; directory sync remains best-effort where unsupported.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
