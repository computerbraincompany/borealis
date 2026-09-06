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

/** Distinguish a missing exact upload location from an unsafe location. */
export async function isMissingOwnedSourceArtifact(input: {
  accountId: string;
  sourceId: string;
  filePath: string;
}): Promise<boolean> {
  if (!UUID_RE.test(input.accountId) || !UUID_RE.test(input.sourceId)) return false;
  const root = await realRoot(config.uploadDir);
  const lexicalCandidate = path.resolve(input.filePath);
  const lexicalRoot = [path.resolve(config.uploadDir), root].find(
    (candidateRoot) => path.dirname(lexicalCandidate) === path.join(candidateRoot, input.accountId, input.sourceId)
  );
  if (!lexicalRoot) return false;

  const accountDirectory = path.join(lexicalRoot, input.accountId);
  const sourceDirectory = path.join(accountDirectory, input.sourceId);
  const canonicalAccountDirectory = path.join(root, input.accountId);
  const canonicalSourceDirectory = path.join(canonicalAccountDirectory, input.sourceId);
  const accountStat = await fs.lstat(accountDirectory).catch(() => undefined);
  if (!accountStat) return true;
  if (
    accountStat.isSymbolicLink() ||
    !accountStat.isDirectory() ||
    (await fs.realpath(accountDirectory).catch(() => undefined)) !== canonicalAccountDirectory
  ) {
    return false;
  }
  const sourceStat = await fs.lstat(sourceDirectory).catch(() => undefined);
  if (!sourceStat) return true;
  if (
    sourceStat.isSymbolicLink() ||
    !sourceStat.isDirectory() ||
    (await fs.realpath(sourceDirectory).catch(() => undefined)) !== canonicalSourceDirectory
  ) {
    return false;
  }
  return !(await fs.lstat(lexicalCandidate).catch(() => undefined));
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

  // Connector caches are scoped under a deterministic hash of the full
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
}): Promise<boolean> {
  if (!UUID_RE.test(input.accountId) || !UUID_RE.test(input.reportId)) return false;
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
    !isWithin(canonicalExpectedDirectory, root)
  ) {
    return false;
  }
  const accountStat = await fs.lstat(accountDirectory).catch(() => undefined);
  if (!accountStat) return true;
  if (!(await isExactDirectory(accountDirectory, canonicalAccountDirectory))) return false;
  const reportStat = await fs.lstat(expectedDirectory).catch(() => undefined);
  if (!reportStat) return true;
  if (!(await isExactDirectory(expectedDirectory, canonicalExpectedDirectory))) return false;
  await fs.rm(expectedDirectory, { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------------------
// Document publications (M13): exact account/document/publication scoping
// under the report directory's private `documents` namespace.
// ---------------------------------------------------------------------------

function documentArtifactsRoot(): string {
  return path.join(config.reportDir, "documents");
}

/** Lexical publication directory for one render attempt (never created here). */
export function documentPublicationDirectory(accountId: string, documentId: string, publicationId: string): string {
  if (!UUID_RE.test(accountId) || !UUID_RE.test(documentId) || !UUID_RE.test(publicationId)) {
    throw new Error("invalid document artifact identity");
  }
  return path.join(documentArtifactsRoot(), accountId, documentId, publicationId);
}

/** Create the exact three-level account/document/publication directory. */
export async function createDocumentPublicationDirectory(
  accountId: string,
  documentId: string,
  publicationId: string
): Promise<string> {
  const expected = documentPublicationDirectory(accountId, documentId, publicationId);
  const root = await realRoot(documentArtifactsRoot());
  const accountDirectory = path.join(root, accountId);
  const documentDirectory = path.join(accountDirectory, documentId);
  const publicationDirectory = path.join(documentDirectory, publicationId);
  await fs.mkdir(accountDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await isExactDirectory(accountDirectory, accountDirectory))) throw new Error("unsafe storage namespace");
  await fs.mkdir(documentDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await isExactDirectory(documentDirectory, documentDirectory))) throw new Error("unsafe storage namespace");
  await fs.mkdir(publicationDirectory);
  if (!(await isExactDirectory(publicationDirectory, publicationDirectory)))
    throw new Error("unsafe storage namespace");
  if (publicationDirectory !== expected) throw new Error("document publication path drifted");
  return publicationDirectory;
}

/** Remove only an exact UUID-scoped document directory after canonical proof. */
export async function removeDocumentArtifacts(input: { accountId: string; documentId: string }): Promise<boolean> {
  if (!UUID_RE.test(input.accountId) || !UUID_RE.test(input.documentId)) return false;
  const root = await realRoot(documentArtifactsRoot());
  const lexicalRoot = path.resolve(documentArtifactsRoot());
  const accountDirectory = path.join(lexicalRoot, input.accountId);
  const expectedDirectory = path.join(accountDirectory, input.documentId);
  const canonicalAccountDirectory = path.join(root, input.accountId);
  const canonicalExpectedDirectory = path.join(root, input.accountId, input.documentId);
  if (!isWithin(canonicalExpectedDirectory, root)) return false;
  const accountStat = await fs.lstat(accountDirectory).catch(() => undefined);
  if (!accountStat) return true;
  if (!(await isExactDirectory(accountDirectory, canonicalAccountDirectory))) return false;
  const documentStat = await fs.lstat(expectedDirectory).catch(() => undefined);
  if (!documentStat) return true;
  if (!(await isExactDirectory(expectedDirectory, canonicalExpectedDirectory))) return false;
  await fs.rm(expectedDirectory, { recursive: true, force: true });
  return true;
}

/** Remove only the exact publication directory recorded by a cleanup intent. */
export async function removeDocumentPublicationArtifacts(input: {
  accountId: string;
  documentId: string;
  publicationId: string;
  directory: string;
}): Promise<boolean> {
  if (!UUID_RE.test(input.accountId) || !UUID_RE.test(input.documentId) || !UUID_RE.test(input.publicationId)) {
    return false;
  }
  const root = await realRoot(documentArtifactsRoot());
  const lexicalRoot = path.resolve(documentArtifactsRoot());
  const expectedDirectory = path.join(lexicalRoot, input.accountId, input.documentId, input.publicationId);
  if (path.resolve(input.directory) !== expectedDirectory) return false;
  const canonicalExpectedDirectory = path.join(root, input.accountId, input.documentId, input.publicationId);
  const accountDirectory = path.join(lexicalRoot, input.accountId);
  const documentDirectory = path.join(accountDirectory, input.documentId);
  if (!isWithin(canonicalExpectedDirectory, root)) return false;
  const publicationStat = await fs.lstat(expectedDirectory).catch(() => undefined);
  if (!publicationStat) return true;
  if (
    !(await isExactDirectory(accountDirectory, path.join(root, input.accountId))) ||
    !(await isExactDirectory(documentDirectory, path.join(root, input.accountId, input.documentId))) ||
    !(await isExactDirectory(expectedDirectory, canonicalExpectedDirectory))
  ) {
    return false;
  }
  await fs.rm(expectedDirectory, { recursive: true, force: true });
  await fs.rmdir(documentDirectory).catch(() => {});
  await fs.rmdir(accountDirectory).catch(() => {});
  return true;
}

/**
 * Resolve one owned publication artifact file for read access. The immutable
 * publication row records `html_path` inside the exact attempt directory
 * (keyed by the publication-intent UUID); the resolver anchors on that stored
 * path and returns a sibling file of the same directory only after proving
 * the exact account/document containment and regular-file identity.
 */
export async function resolveDocumentPublicationFile(input: {
  accountId: string;
  documentId: string;
  recordedHtmlPath: string | null | undefined;
  fileName: string;
}): Promise<string | undefined> {
  if (
    !UUID_RE.test(input.accountId) ||
    !UUID_RE.test(input.documentId) ||
    !/^document\.(?:html|pdf|zip|docx)$/.test(input.fileName) ||
    !input.recordedHtmlPath
  ) {
    return undefined;
  }
  const root = await realRoot(documentArtifactsRoot());
  const lexicalRoot = path.resolve(documentArtifactsRoot());
  const recorded = path.resolve(input.recordedHtmlPath);
  if (path.basename(recorded) !== "document.html") return undefined;
  const attemptDirectory = path.dirname(recorded);
  const attemptName = path.basename(attemptDirectory);
  if (!UUID_RE.test(attemptName)) return undefined;
  const accountDirectory = path.join(lexicalRoot, input.accountId);
  const documentDirectory = path.join(accountDirectory, input.documentId);
  if (path.dirname(attemptDirectory) !== documentDirectory) return undefined;
  const canonicalAccountDirectory = path.join(root, input.accountId);
  const canonicalDocumentDirectory = path.join(canonicalAccountDirectory, input.documentId);
  const canonicalAttemptDirectory = path.join(canonicalDocumentDirectory, attemptName);
  const canonicalCandidate = path.join(canonicalAttemptDirectory, input.fileName);
  const lexical = path.join(attemptDirectory, input.fileName);
  if (!isWithin(canonicalCandidate, root)) return undefined;
  const stat = await fs.lstat(lexical).catch(() => undefined);
  if (!stat) return undefined;
  if (
    !(await isExactDirectory(accountDirectory, canonicalAccountDirectory)) ||
    !(await isExactDirectory(documentDirectory, canonicalDocumentDirectory)) ||
    !(await isExactDirectory(attemptDirectory, canonicalAttemptDirectory)) ||
    !(await isExactRegularFile(lexical, canonicalCandidate))
  ) {
    return undefined;
  }
  return canonicalCandidate;
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
