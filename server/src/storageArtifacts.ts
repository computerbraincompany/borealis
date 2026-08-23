import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "./config.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TABLE_RE = /^[a-z][a-z0-9_]{0,62}$/;
const CACHE_VERSION_RE = /^[0-9a-f]{32}\.(?:csv|json)$/;

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function realRoot(root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  return fs.realpath(root);
}

async function isExactDirectory(lexical: string, canonical: string): Promise<boolean> {
  const stat = await fs.lstat(lexical).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  const resolved = await fs.realpath(lexical).catch(() => undefined);
  return resolved === canonical;
}

async function isExactRegularFile(lexical: string, canonical: string): Promise<boolean> {
  const stat = await fs.lstat(lexical).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) return false;
  const resolved = await fs.realpath(lexical).catch(() => undefined);
  return resolved === canonical;
}

async function removeExactFileAndEmptyDirectory(file: string, directory: string): Promise<boolean> {
  try {
    await fs.unlink(file);
  } catch {
    return false;
  }
  await fs.rmdir(directory).catch(() => {});
  return true;
}

async function createExactResourceDirectory(rootPath: string, accountId: string, resourceId: string): Promise<string> {
  if (!UUID_RE.test(accountId) || !UUID_RE.test(resourceId)) throw new Error("invalid storage identity");
  const root = await realRoot(rootPath);
  const accountDirectory = path.join(root, accountId);
  const resourceDirectory = path.join(accountDirectory, resourceId);
  await fs.mkdir(accountDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await isExactDirectory(accountDirectory, accountDirectory))) throw new Error("unsafe storage namespace");
  await fs.mkdir(resourceDirectory);
  if (!(await isExactDirectory(resourceDirectory, resourceDirectory))) throw new Error("unsafe storage namespace");
  return resourceDirectory;
}

export function createUploadResourceDirectory(accountId: string, sourceId: string): Promise<string> {
  return createExactResourceDirectory(config.uploadDir, accountId, sourceId);
}

export function createReportResourceDirectory(accountId: string, reportId: string): Promise<string> {
  return createExactResourceDirectory(config.reportDir, accountId, reportId);
}

export async function cleanupCreatedUploadResource(
  accountId: string,
  sourceId: string,
  filePath: string
): Promise<void> {
  if (!UUID_RE.test(accountId) || !UUID_RE.test(sourceId)) return;
  const root = await realRoot(config.uploadDir);
  const accountDirectory = path.join(root, accountId);
  const directory = path.join(accountDirectory, sourceId);
  const candidate = path.resolve(filePath);
  if (
    path.dirname(candidate) !== directory ||
    !(await isExactDirectory(accountDirectory, accountDirectory)) ||
    !(await isExactDirectory(directory, directory))
  ) {
    return;
  }
  const stat = await fs.lstat(candidate).catch(() => undefined);
  if (stat && !stat.isSymbolicLink() && stat.isFile()) await fs.unlink(candidate).catch(() => {});
  await fs.rmdir(directory).catch(() => {});
}

/** Resolve exactly one source-owned upload/cache version for read access. */
export async function resolveSourceArtifact(input: {
  accountId: string;
  sourceId: string;
  name: string;
  filePath: string;
  connector?: string | null;
}): Promise<string | undefined> {
  if (!UUID_RE.test(input.accountId) || !UUID_RE.test(input.sourceId)) return undefined;
  const root = await realRoot(config.uploadDir);
  const lexicalCandidate = path.resolve(input.filePath);
  const lexicalRoot = [path.resolve(config.uploadDir), root].find(
    (candidateRoot) => path.dirname(lexicalCandidate) === path.join(candidateRoot, input.accountId, input.sourceId)
  );
  if (!lexicalRoot && !input.connector) return undefined;
  const namespaceRoot = lexicalRoot ?? root;
  const accountDirectory = path.join(namespaceRoot, input.accountId);
  const expectedDirectory = path.join(accountDirectory, input.sourceId);
  const canonicalAccountDirectory = path.join(root, input.accountId);
  const canonicalExpectedDirectory = path.join(canonicalAccountDirectory, input.sourceId);
  if (path.dirname(lexicalCandidate) === expectedDirectory) {
    const canonicalCandidate = path.join(canonicalExpectedDirectory, path.basename(lexicalCandidate));
    if (
      isWithin(canonicalCandidate, root) &&
      (await isExactDirectory(accountDirectory, canonicalAccountDirectory)) &&
      (await isExactDirectory(expectedDirectory, canonicalExpectedDirectory)) &&
      (await isExactRegularFile(lexicalCandidate, canonicalCandidate))
    ) {
      return canonicalCandidate;
    }
    return undefined;
  }

  if (!input.connector || !TABLE_RE.test(input.name) || !CACHE_VERSION_RE.test(path.basename(lexicalCandidate))) {
    return undefined;
  }
  const accountKey = createHash("sha256").update(input.accountId, "utf8").digest("hex").slice(0, 24);
  const cacheNamespaceRoot = [path.resolve(config.uploadDir), root].find((candidateRoot) => {
    const accountKey = createHash("sha256").update(input.accountId, "utf8").digest("hex").slice(0, 24);
    return path.dirname(lexicalCandidate) === path.join(candidateRoot, "url_cache", accountKey, input.name);
  });
  if (!cacheNamespaceRoot) return undefined;
  const cacheRoot = path.join(cacheNamespaceRoot, "url_cache");
  const accountCacheRoot = path.join(cacheRoot, accountKey);
  const tableCacheRoot = path.join(accountCacheRoot, input.name);
  if (path.dirname(lexicalCandidate) !== tableCacheRoot) return undefined;
  const canonicalCacheRoot = path.join(root, "url_cache");
  const canonicalAccountCacheRoot = path.join(canonicalCacheRoot, accountKey);
  const canonicalTableCacheRoot = path.join(canonicalAccountCacheRoot, input.name);
  const canonicalCandidate = path.join(canonicalTableCacheRoot, path.basename(lexicalCandidate));
  if (
    isWithin(canonicalCandidate, root) &&
    (await isExactDirectory(cacheRoot, canonicalCacheRoot)) &&
    (await isExactDirectory(accountCacheRoot, canonicalAccountCacheRoot)) &&
    (await isExactDirectory(tableCacheRoot, canonicalTableCacheRoot)) &&
    (await isExactRegularFile(lexicalCandidate, canonicalCandidate))
  ) {
    return canonicalCandidate;
  }
  return undefined;
}

/** Delete exactly one source-owned artifact, never an inferred broad parent. */
export async function removeSourceArtifact(input: {
  accountId: string;
  sourceId: string;
  name: string;
  filePath: string;
  connector?: string | null;
}): Promise<boolean> {
  if (!UUID_RE.test(input.accountId) || !UUID_RE.test(input.sourceId)) return false;
  const root = await realRoot(config.uploadDir);
  const lexicalRoot = path.resolve(config.uploadDir);
  const lexicalCandidate = path.resolve(input.filePath);
  const accountDirectory = path.join(lexicalRoot, input.accountId);
  const expectedDirectory = path.join(accountDirectory, input.sourceId);
  const canonicalAccountDirectory = path.join(root, input.accountId);
  const canonicalExpectedDirectory = path.join(canonicalAccountDirectory, input.sourceId);
  if (path.dirname(lexicalCandidate) === expectedDirectory) {
    const canonicalCandidate = path.join(canonicalExpectedDirectory, path.basename(lexicalCandidate));
    if (
      !isWithin(canonicalExpectedDirectory, root) ||
      !(await isExactDirectory(accountDirectory, canonicalAccountDirectory)) ||
      !(await isExactDirectory(expectedDirectory, canonicalExpectedDirectory)) ||
      !(await isExactRegularFile(lexicalCandidate, canonicalCandidate))
    ) {
      return false;
    }
    return removeExactFileAndEmptyDirectory(lexicalCandidate, expectedDirectory);
  }

  // Python connector caches are scoped under a deterministic hash of the full
  // account id. Prove that boundary before removing exactly one immutable
  // cache version. Arbitrary legacy shared-prefix uploads fail closed because
  // their truncated directory name cannot prove tenant ownership.
  if (input.connector && TABLE_RE.test(input.name) && CACHE_VERSION_RE.test(path.basename(lexicalCandidate))) {
    const accountKey = createHash("sha256").update(input.accountId, "utf8").digest("hex").slice(0, 24);
    const cacheRoot = path.join(lexicalRoot, "url_cache");
    const accountCacheRoot = path.join(cacheRoot, accountKey);
    const tableCacheRoot = path.join(accountCacheRoot, input.name);
    if (path.dirname(lexicalCandidate) === tableCacheRoot) {
      const canonicalCacheRoot = path.join(root, "url_cache");
      const canonicalAccountCacheRoot = path.join(canonicalCacheRoot, accountKey);
      const canonicalTableCacheRoot = path.join(canonicalAccountCacheRoot, input.name);
      const canonicalCandidate = path.join(canonicalTableCacheRoot, path.basename(lexicalCandidate));
      if (
        isWithin(canonicalTableCacheRoot, root) &&
        (await isExactDirectory(cacheRoot, canonicalCacheRoot)) &&
        (await isExactDirectory(accountCacheRoot, canonicalAccountCacheRoot)) &&
        (await isExactDirectory(tableCacheRoot, canonicalTableCacheRoot)) &&
        (await isExactRegularFile(lexicalCandidate, canonicalCandidate))
      ) {
        return removeExactFileAndEmptyDirectory(lexicalCandidate, tableCacheRoot);
      }
    }
  }
  return false;
}

/** Remove only an exact UUID-scoped report directory after canonical proof. */
export async function removeReportArtifacts(input: {
  accountId: string;
  reportId: string;
  htmlPath?: string | null;
  pdfPath?: string | null;
}): Promise<void> {
  if (!UUID_RE.test(input.accountId) || !UUID_RE.test(input.reportId)) return;
  const root = await realRoot(config.reportDir);
  const lexicalRoot = path.resolve(config.reportDir);
  const accountDirectory = path.join(lexicalRoot, input.accountId);
  const expectedDirectory = path.join(accountDirectory, input.reportId);
  const canonicalAccountDirectory = path.join(root, input.accountId);
  const canonicalExpectedDirectory = path.join(root, input.accountId, input.reportId);
  const candidates = [
    input.htmlPath ? [input.htmlPath, "report.html"] : undefined,
    input.pdfPath ? [input.pdfPath, "report.pdf"] : undefined,
  ].filter((value): value is [string, string] => Boolean(value));
  if (
    candidates.length === 0 ||
    candidates.some(([value, fileName]) => path.resolve(value) !== path.join(expectedDirectory, fileName)) ||
    !isWithin(canonicalExpectedDirectory, root) ||
    !(await isExactDirectory(accountDirectory, canonicalAccountDirectory)) ||
    !(await isExactDirectory(expectedDirectory, canonicalExpectedDirectory))
  ) {
    return;
  }
  await fs.rm(expectedDirectory, { recursive: true, force: true });
}

/** Resolve an owned report file for read access, failing closed on path drift. */
export async function resolveReportArtifact(input: {
  accountId: string;
  reportId: string;
  filePath?: string | null;
  kind: "html" | "pdf";
}): Promise<string | undefined> {
  if (!input.filePath || !UUID_RE.test(input.accountId) || !UUID_RE.test(input.reportId)) return undefined;
  const root = await realRoot(config.reportDir);
  const lexicalRoot = path.resolve(config.reportDir);
  const lexical = path.resolve(input.filePath);
  const accountDirectory = path.join(lexicalRoot, input.accountId);
  const expectedDirectory = path.join(accountDirectory, input.reportId);
  const expected = path.join(expectedDirectory, `report.${input.kind}`);
  if (lexical !== expected) return undefined;
  const canonicalAccountDirectory = path.join(root, input.accountId);
  const canonicalExpectedDirectory = path.join(root, input.accountId, input.reportId);
  const canonicalCandidate = path.join(canonicalExpectedDirectory, `report.${input.kind}`);
  if (
    !isWithin(canonicalCandidate, root) ||
    !(await isExactDirectory(accountDirectory, canonicalAccountDirectory)) ||
    !(await isExactDirectory(expectedDirectory, canonicalExpectedDirectory)) ||
    !(await isExactRegularFile(lexical, canonicalCandidate))
  ) {
    return undefined;
  }
  return canonicalCandidate;
}
