import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage } from "node:http";

import { config } from "../config.js";
import {
  combineSignals,
  parseHttpUrl,
  requestPinned,
  resolvePublicDestination,
  type ResolvedAddress,
  UrlPolicyError,
} from "../networkPolicy.js";

const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TABLE_RE = /^[a-z][a-z0-9_]{0,62}$/;
const VERSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CACHE_FILE_RE = /^[0-9a-f]{32}\.(?:csv|json)$/;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;
const DOWNLOAD_CHUNK_BYTES = 64 * 1024;

export type ConnectorFormat = "csv" | "json";

export class ConnectorFetchError extends Error {
  constructor(
    readonly status: number,
    message = "connector operation failed"
  ) {
    super(message);
    this.name = "ConnectorFetchError";
  }
}

export interface ConnectorFetchTransport {
  resolve(url: URL, signal: AbortSignal): Promise<ResolvedAddress[]>;
  request(
    url: URL,
    addresses: ResolvedAddress[],
    signal: AbortSignal,
    headers: Record<string, string>
  ): Promise<IncomingMessage>;
}

const defaultTransport: ConnectorFetchTransport = {
  resolve: resolvePublicDestination,
  request: requestPinned,
};

interface ConnectorIdentity {
  accountId: string;
  name: string;
}

interface ConnectorVersion extends ConnectorIdentity {
  version: string;
  expectedFormat: ConnectorFormat;
}

export interface DownloadConnectorVersionInput extends ConnectorVersion {
  url: string;
  signal?: AbortSignal;
  inspect(path: string): Promise<void>;
  transport?: ConnectorFetchTransport;
}

function validateIdentity({ accountId, name }: ConnectorIdentity): void {
  if (!ACCOUNT_RE.test(accountId) || !TABLE_RE.test(name)) {
    throw new ConnectorFetchError(400, "invalid dataset identity");
  }
}

function versionKey(version: string): string {
  if (!VERSION_RE.test(version)) {
    throw new ConnectorFetchError(400, "invalid connector version");
  }
  return version.replaceAll("-", "");
}

async function exactDirectory(parent: string, name: string, create: boolean): Promise<string> {
  const child = path.join(parent, name);
  if (create) {
    await fs.mkdir(child).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  const stat = await fs.lstat(child).catch((error: NodeJS.ErrnoException) => {
    if (!create && error.code === "ENOENT") {
      throw new ConnectorFetchError(404, "dataset cache not found");
    }
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ConnectorFetchError(400, "invalid storage namespace");
  }
  const resolved = await fs.realpath(child);
  if (resolved !== child) {
    throw new ConnectorFetchError(400, "invalid storage namespace");
  }
  return child;
}

async function storageRoot(): Promise<string> {
  await fs.mkdir(config.uploadDir, { recursive: true });
  return fs.realpath(config.uploadDir);
}

async function cacheDirectory(identity: ConnectorIdentity, create: boolean): Promise<string> {
  validateIdentity(identity);
  const root = await storageRoot();
  const cacheRoot = await exactDirectory(root, "url_cache", create);
  const accountKey = createHash("sha256").update(identity.accountId, "utf8").digest("hex").slice(0, 24);
  const accountDirectory = await exactDirectory(cacheRoot, accountKey, create);
  return exactDirectory(accountDirectory, identity.name, create);
}

function manifestPath(candidate: string): string {
  return path.join(path.dirname(candidate), `${path.basename(candidate, path.extname(candidate))}.meta`);
}

async function validateExistingFile(file: string): Promise<void> {
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new ConnectorFetchError(404, "dataset file not found");
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ConnectorFetchError(400, "invalid dataset cache version");
  }
  if ((await fs.realpath(file)) !== file) {
    throw new ConnectorFetchError(400, "invalid dataset cache version");
  }
}

export async function connectorVersionPath(
  input: ConnectorVersion,
  options: { createDirectory?: boolean; requireFile?: boolean } = {}
): Promise<string> {
  const directory = await cacheDirectory(input, options.createDirectory ?? true);
  const candidate = path.join(directory, `${versionKey(input.version)}.${input.expectedFormat}`);
  const stat = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat?.isSymbolicLink() || (stat && !stat.isFile())) {
    throw new ConnectorFetchError(400, "invalid dataset cache version");
  }
  if (stat && (await fs.realpath(candidate)) !== candidate) {
    throw new ConnectorFetchError(400, "invalid dataset cache version");
  }
  if (!stat && options.requireFile) {
    throw new ConnectorFetchError(404, "dataset candidate not found");
  }
  return candidate;
}

export async function resolveConnectorCacheFile(identity: ConnectorIdentity & { location: string }): Promise<string> {
  const directory = await cacheDirectory(identity, false);
  const candidate = path.resolve(identity.location);
  if (path.dirname(candidate) !== directory || !CACHE_FILE_RE.test(path.basename(candidate))) {
    throw new ConnectorFetchError(400, "invalid dataset cache version");
  }
  await validateExistingFile(candidate);
  return candidate;
}

function manifestDigest(url: string, expectedFormat: ConnectorFormat): Buffer {
  // Keep the historical canonical JSON shape: sorted keys and no whitespace.
  const canonical = JSON.stringify({ expected_format: expectedFormat, url });
  return Buffer.from(createHash("sha256").update(canonical, "utf8").digest("hex"));
}

export async function claimConnectorVersion(input: ConnectorVersion & { url: string }): Promise<string> {
  const candidate = await connectorVersionPath(input);
  const manifest = manifestPath(candidate);
  const digest = manifestDigest(input.url, input.expectedFormat);
  const temporary = path.join(path.dirname(manifest), `.${path.basename(manifest)}.staged-${randomUUID()}`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(digest);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fs.link(temporary, manifest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.lstat(manifest);
      if (!stat.isFile() || stat.isSymbolicLink() || (await fs.realpath(manifest)) !== manifest) {
        throw new ConnectorFetchError(400, "invalid dataset cache manifest");
      }
      const existing = await fs.readFile(manifest);
      if (existing.length !== digest.length || !timingSafeEqual(existing, digest)) {
        throw new ConnectorFetchError(409, "connector version is already bound to another request");
      }
    }
    return candidate;
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

function connectorRedirect(current: URL, location: string): URL {
  let target: URL;
  try {
    target = parseHttpUrl(new URL(location, current).toString(), {
      allowNonDefaultPort: true,
    });
  } catch {
    throw new ConnectorFetchError(400, "invalid connector redirect");
  }
  if (current.protocol === "https:" && target.protocol !== "https:") {
    throw new ConnectorFetchError(400, "connector redirects must not downgrade HTTPS");
  }
  return target;
}

function validateDownloadFormat(prefix: Buffer, contentType: string, expectedFormat: ConnectorFormat): void {
  const sniff = prefix
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    mediaType === "text/html" ||
    mediaType === "application/xhtml+xml" ||
    sniff.startsWith("<!doctype html") ||
    sniff.startsWith("<html")
  ) {
    throw new ConnectorFetchError(422, "URL returned HTML, not tabular data");
  }
  const looksJson = sniff.startsWith("{") || sniff.startsWith("[");
  const contentIsJson = mediaType === "application/json" || mediaType.endsWith("+json");
  const contentIsCsv = ["text/csv", "application/csv", "text/tab-separated-values"].includes(mediaType);
  if (
    (expectedFormat === "json" && (contentIsCsv || !looksJson)) ||
    (expectedFormat === "csv" && (contentIsJson || looksJson))
  ) {
    throw new ConnectorFetchError(422, "URL response does not match expected format");
  }
}

function abortError(): Error {
  const error = new Error("operation cancelled");
  error.name = "AbortError";
  return error;
}

async function downloadToTemporary(input: DownloadConnectorVersionInput, target: string): Promise<string> {
  const transport = input.transport ?? defaultTransport;
  const operationSignal = combineSignals(input.signal, DOWNLOAD_TIMEOUT_MS);
  let current: URL;
  try {
    current = parseHttpUrl(input.url, { allowNonDefaultPort: true });
  } catch {
    throw new ConnectorFetchError(400, "connector URL must use HTTP or HTTPS");
  }

  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.staged-${randomUUID()}`);
  let transferred = false;
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const addresses = await transport.resolve(current, operationSignal);
      const response = await transport.request(current, addresses, operationSignal, {
        "Accept-Encoding": "identity",
        "User-Agent": "Borealis-Connector/1",
      });
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        const location = response.headers.location;
        response.destroy();
        if (!location || redirects === MAX_REDIRECTS) {
          throw new ConnectorFetchError(502, "connector redirect limit exceeded");
        }
        current = connectorRedirect(current, location);
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        throw new ConnectorFetchError(502, "connector download failed");
      }

      const declared = response.headers["content-length"];
      if (typeof declared === "string" && Number(declared) > MAX_DOWNLOAD_BYTES) {
        response.destroy();
        throw new ConnectorFetchError(413, "connector response is too large");
      }
      const contentType = typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : "";
      const handle = await fs.open(temporary, "wx", 0o600);
      let total = 0;
      const prefixParts: Buffer[] = [];
      let prefixBytes = 0;
      try {
        for await (const rawChunk of response) {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          for (let offset = 0; offset < chunk.length; offset += DOWNLOAD_CHUNK_BYTES) {
            const part = chunk.subarray(offset, offset + DOWNLOAD_CHUNK_BYTES);
            total += part.length;
            if (total > MAX_DOWNLOAD_BYTES) {
              response.destroy();
              throw new ConnectorFetchError(413, "connector response is too large");
            }
            if (prefixBytes < 512) {
              const prefixPart = part.subarray(0, 512 - prefixBytes);
              prefixParts.push(prefixPart);
              prefixBytes += prefixPart.length;
            }
            await handle.write(part);
          }
        }
        if (total === 0) {
          throw new ConnectorFetchError(422, "URL returned an empty response");
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      validateDownloadFormat(Buffer.concat(prefixParts, prefixBytes), contentType, input.expectedFormat);
      transferred = true;
      return temporary;
    }
    throw new ConnectorFetchError(502, "connector redirect limit exceeded");
  } catch (error) {
    if (input.signal?.aborted) throw abortError();
    if (error instanceof UrlPolicyError) {
      throw new ConnectorFetchError(400, "connector URL is not permitted");
    }
    if (operationSignal.aborted && !(error instanceof ConnectorFetchError)) {
      throw new ConnectorFetchError(504, "connector download timed out");
    }
    if (error instanceof ConnectorFetchError) throw error;
    throw new ConnectorFetchError(
      operationSignal.aborted ? 504 : 502,
      operationSignal.aborted ? "connector download timed out" : "connector download failed"
    );
  } finally {
    // Kept only on the successful return path; the caller owns cleanup then.
    if (!transferred) await fs.unlink(temporary).catch(() => {});
  }
}

export async function downloadConnectorVersion(input: DownloadConnectorVersionInput): Promise<string> {
  const target = await claimConnectorVersion(input);
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    await validateExistingFile(target);
    await input.inspect(target);
    return target;
  }

  const temporary = await downloadToTemporary(input, target);
  try {
    await input.inspect(temporary);
    try {
      await fs.link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await validateExistingFile(target);
    // A concurrent process may have won publication. Inspect the exact file
    // returned to the caller, not merely our private staged download.
    await input.inspect(target);
    return target;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function provenVersionFromLocation(
  identity: ConnectorIdentity & { location: string }
): Promise<{ candidate: string; manifest: string }> {
  const directory = await cacheDirectory(identity, false);
  const candidate = path.resolve(identity.location);
  if (path.dirname(candidate) !== directory || !CACHE_FILE_RE.test(path.basename(candidate))) {
    throw new ConnectorFetchError(400, "invalid dataset cache version");
  }
  const stat = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat && (stat.isSymbolicLink() || !stat.isFile() || (await fs.realpath(candidate)) !== candidate)) {
    throw new ConnectorFetchError(400, "invalid dataset cache version");
  }
  return { candidate, manifest: manifestPath(candidate) };
}

export async function cleanupConnectorVersion(input: ConnectorIdentity & { location: string }): Promise<boolean> {
  let proven: { candidate: string; manifest: string };
  try {
    proven = await provenVersionFromLocation(input);
  } catch (error) {
    if (error instanceof ConnectorFetchError && error.status === 404) return false;
    throw error;
  }
  const existed = Boolean(
    (await fs.lstat(proven.candidate).catch(() => undefined)) ||
    (await fs.lstat(proven.manifest).catch(() => undefined))
  );
  for (const file of [proven.candidate, proven.manifest]) {
    const stat = await fs.lstat(file).catch(() => undefined);
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) {
      throw new ConnectorFetchError(400, "invalid dataset cache version");
    }
    if (stat) await fs.unlink(file);
  }
  await fs.rmdir(path.dirname(proven.candidate)).catch(() => {});
  return existed;
}
