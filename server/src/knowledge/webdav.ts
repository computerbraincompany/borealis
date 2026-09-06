import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { config } from "../config.js";
import { isPlainHttpConnectionHost } from "../connections/store.js";
import type { ConnectionSecrets } from "../connections/secrets.js";
import {
  combineSignals,
  resolveLoopbackDestination,
  resolvePublicDestination,
  type ResolvedAddress,
  UrlPolicyError,
} from "../networkPolicy.js";
import {
  KnowledgeConnectionConfigError,
  normalizeKnowledgeRelativePath,
  type KnowledgeConnectionRecord,
  type KnowledgeItemRecord,
  type KnowledgeScanBounds,
  type WebDavConfig,
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
import { ensureUploadResourceDirectory, stagedFileBase, writeStagedFile } from "./uploadStaging.js";

/**
 * Read-only WebDAV knowledge transport (M14 stage 2).
 *
 * Application-password Basic auth; the password lives only in the shared
 * connection secret store (MCP-era custody keyed by account/connection) and
 * never crosses into a DTO. HTTPS is required except the operator-supported
 * loopback/.local network policy (the same policy that validates the stored
 * endpoint). Every request DNS-pins its validated resolution (public hosts
 * via `resolvePublicDestination`, the local-network policy via
 * `resolveLoopbackDestination`) and refuses redirects outright — a redirect
 * can therefore never carry credentials to another origin.
 *
 * Traversal is bounded `PROPFIND Depth: 1` per directory, exactly as the
 * folder scan walks: the same entry/depth/visited/aggregate bounds, the same
 * hidden-skip and managed-identity rules. `multistatus` bodies are parsed by
 * the strict hand-rolled parser below: DTD/entity constructs are refused
 * before parsing, only the five predefined character references plus numeric
 * references expand, the document must be well-formed, and byte/element
 * counts are bounded. No XML dependency is added.
 *
 * Each request has its own bounded ceiling (30 s by default, injectable for
 * tests); the enclosing refresh deadline and the exact-one-active-refresh
 * rule belong to the durable service. Downloads run through a two-slot
 * semaphore; content hashes are computed over GET bytes — ETag/mtime are
 * hints only. Partial failures surface as per-item stable codes or
 * `unauthorized`/`missing` inspections; nothing here deletes or rewrites
 * managed state.
 */

export const WEBDAV_REQUEST_TIMEOUT_MS = 30_000;
export const WEBDAV_DOWNLOAD_SLOTS = 2;
export const MAX_WEBDAV_PROPFIND_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_WEBDAV_XML_CHARACTERS = 2 * 1024 * 1024;
export const MAX_WEBDAV_XML_ELEMENTS = 20_000;
export const WEBDAV_APPLICATION_PASSWORD_ENV_KEY = "WEBDAV_APPLICATION_PASSWORD";

const UNAUTHORIZED = "KNOWLEDGE_UPSTREAM_UNAUTHORIZED";
const CREDENTIALS_MISSING = "KNOWLEDGE_CREDENTIALS_MISSING";
const REDIRECT_REFUSED = "KNOWLEDGE_UPSTREAM_REDIRECT_REFUSED";
const XML_INVALID = "KNOWLEDGE_UPSTREAM_XML_INVALID";
const NOT_FOUND = "KNOWLEDGE_UPSTREAM_NOT_FOUND";
const UPSTREAM_UNAVAILABLE = "KNOWLEDGE_UPSTREAM_UNAVAILABLE";
const TIMEOUT = "KNOWLEDGE_UPSTREAM_TIMEOUT";
const SCAN_LIMIT = "KNOWLEDGE_SCAN_LIMIT";
const TOO_LARGE = "KNOWLEDGE_FILE_TOO_LARGE";
const PATH_INVALID = "KNOWLEDGE_RELATIVE_PATH_INVALID";
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>';

// ---------------------------------------------------------------- credentials

function authorizationHeader(connection: KnowledgeConnectionRecord, secrets: ConnectionSecrets | undefined): string {
  if (connection.kind !== "webdav" || connection.config.kind !== "webdav") {
    throw new KnowledgeConnectionConfigError("the WebDAV transport only serves webdav connections");
  }
  const direct = secrets?.headers?.authorization;
  if (typeof direct === "string" && /^Basic\s+[A-Za-z0-9+/=]+$/.test(direct)) return direct;
  const password = secrets?.env?.[WEBDAV_APPLICATION_PASSWORD_ENV_KEY];
  if (typeof password !== "string" || password.length < 1 || password.length > 4_096) {
    throw new KnowledgeScanFailureError(CREDENTIALS_MISSING, "the connection has no usable application password");
  }
  return `Basic ${Buffer.from(`${connection.config.username}:${password}`, "utf8").toString("base64")}`;
}

// ------------------------------------------------------------- XML (strict)

export interface DavPropEntry {
  readonly href: string;
  readonly collection: boolean;
  readonly contentLength: number | null;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

const BUILTIN_REFS: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
});

/**
 * Expand text with entity/DTD expansion disabled: only `&amp; &lt; &gt;
 * &quot; &apos;` and numeric references expand; every other `&` reference is
 * a hard refusal. The caller refuses every `<!` construct (DOCTYPE, ENTITY,
 * CDATA, comment) before text ever reaches this decoder, so expansion of
 * hostile declarations is structurally impossible rather than merely bounded.
 */
function decodeDavText(text: string): string | null {
  if (!text.includes("&")) return text;
  let result = "";
  let cursor = 0;
  for (;;) {
    const amp = text.indexOf("&", cursor);
    if (amp < 0) {
      result += text.slice(cursor);
      break;
    }
    result += text.slice(cursor, amp);
    const end = text.indexOf(";", amp + 1);
    if (end < 0 || end - amp > 12) return null;
    const entity = text.slice(amp + 1, end);
    let codePoint: number | null = null;
    if (entity.startsWith("#x") || entity.startsWith("#X")) codePoint = Number.parseInt(entity.slice(2), 16);
    else if (entity.startsWith("#")) codePoint = Number.parseInt(entity.slice(1), 10);
    if (codePoint !== null) {
      if (!Number.isSafeInteger(codePoint) || codePoint < 0x20 || codePoint > 0x10ffff) return null;
      result += String.fromCodePoint(codePoint);
      cursor = end + 1;
      continue;
    }
    const builtin = BUILTIN_REFS[entity];
    if (builtin === undefined) return null;
    result += builtin;
    cursor = end + 1;
  }
  return result;
}

/** Local (unprefixed) name; the parser is namespace-lenient, structure-strict. */
function localName(tag: string): string {
  const colon = tag.indexOf(":");
  return colon < 0 ? tag : tag.slice(colon + 1);
}

type DavTextTarget = "href" | "getcontentlength" | "getcontenttype" | "getetag" | "getlastmodified" | null;

interface MutableEntry {
  href: string;
  collection: boolean;
  contentLength: number | null;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
}

/**
 * Parse a DAV:1 `multistatus` body with a strict structural subset:
 * single root named `multistatus`, balanced nesting, `response` only as a
 * direct root child, bounded elements, and the expansion-free decoder above.
 * Anything outside the subset — including the fixture's deliberately
 * truncated (malformed) or DOCTYPE-bearing (hostile) bodies — returns null
 * and the caller refuses the whole scan.
 */
export function parseDavMultistatus(xml: string): DavPropEntry[] | null {
  if (typeof xml !== "string" || xml.length < 1 || xml.length > MAX_WEBDAV_XML_CHARACTERS) return null;
  if (xml.includes("<!")) return null;
  const pattern =
    /<\?[^>]*\?>|<(\/?)([A-Za-z_][A-Za-z0-9:_.-]*)((?:\s+[A-Za-z_][A-Za-z0-9:_.-]*\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  const entries: DavPropEntry[] = [];
  const stack: string[] = [];
  let rootSeen = false;
  let elements = 0;
  let response: MutableEntry | null = null;
  let textTarget: DavTextTarget = null;
  const flushText = (text: string): boolean => {
    if (textTarget === null || !response) return true;
    if (!text) return true;
    const decoded = decodeDavText(text);
    if (decoded === null) return false;
    switch (textTarget) {
      case "href":
        response.href += decoded;
        break;
      case "getcontentlength": {
        const value = Number.parseInt(decoded, 10);
        response.contentLength = Number.isSafeInteger(value) && value >= 0 ? value : null;
        break;
      }
      case "getcontenttype":
        response.contentType = decoded.trim().slice(0, 256);
        break;
      case "getetag":
        response.etag = decoded.trim().slice(0, 256);
        break;
      case "getlastmodified":
        response.lastModified = decoded.trim().slice(0, 128);
        break;
    }
    return true;
  };
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    if (!flushText(xml.slice(lastIndex, match.index))) return null;
    lastIndex = pattern.lastIndex;
    if (match[0].startsWith("<?")) continue; // processing instruction (prolog) only
    const closing = match[1] === "/";
    const name = localName(match[2] ?? "");
    const selfClosing = match[4] === "/";
    elements += 1;
    if (elements > MAX_WEBDAV_XML_ELEMENTS) return null;
    if (closing) {
      if (stack.length < 1 || stack.pop() !== name) return null;
      if (name === "response" && stack.length === 1) {
        if (response?.href) {
          entries.push(
            Object.freeze({
              href: response.href,
              collection: response.collection,
              contentLength: response.contentLength,
              contentType: response.contentType,
              etag: response.etag,
              lastModified: response.lastModified,
            })
          );
        }
        response = null;
      }
      textTarget = null;
      continue;
    }
    if (!rootSeen) {
      if (stack.length !== 0 || name !== "multistatus") return null;
      rootSeen = true;
    }
    stack.push(name);
    if (name === "response") {
      if (stack.length !== 2) return null; // `response` only as a direct root child
      response = {
        href: "",
        collection: false,
        contentLength: null,
        contentType: null,
        etag: null,
        lastModified: null,
      };
    }
    textTarget =
      response === null
        ? null
        : name === "href"
          ? "href"
          : name === "getcontentlength"
            ? "getcontentlength"
            : name === "getcontenttype"
              ? "getcontenttype"
              : name === "getetag"
                ? "getetag"
                : name === "getlastmodified"
                  ? "getlastmodified"
                  : null;
    if (selfClosing) {
      if (stack.pop() !== name) return null;
      if (name === "collection" && response) response.collection = true;
      textTarget = null;
    }
  }
  if (!flushText(xml.slice(lastIndex))) return null;
  if (!rootSeen || stack.length !== 0) return null;
  return entries;
}

// ----------------------------------------------------------- transport core

export interface WebDavRequestOptions {
  readonly method: "GET" | "PROPFIND";
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly body?: string;
}

export interface WebDavTransport {
  resolve(url: URL, signal: AbortSignal): Promise<ResolvedAddress[]>;
  request(url: URL, addresses: readonly ResolvedAddress[], options: WebDavRequestOptions): Promise<IncomingMessage>;
}

/**
 * Socket-pinned request mirroring `networkPolicy.requestPinned`: the validated
 * DNS answer is the only lookup the socket may use (DNS-rebinding TOCTOU),
 * extended with the method/headers/body the DAV verbs need. TLS keeps normal
 * SNI hostname verification through the URL host.
 */
async function pinnedWebDavRequest(
  url: URL,
  addresses: readonly ResolvedAddress[],
  options: WebDavRequestOptions
): Promise<IncomingMessage> {
  const selected = addresses[0];
  if (!selected) throw new UrlPolicyError();
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<IncomingMessage>((resolve, reject) => {
    const outbound = request(
      url,
      {
        method: options.method,
        signal: options.signal,
        headers: options.headers,
        lookup: ((_hostname: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (lookupOptions?.all) {
            callback(null, [{ address: selected.address, family: selected.family }]);
          } else {
            callback(null, selected.address, selected.family);
          }
        }) as never,
      },
      resolve
    );
    outbound.once("error", reject);
    if (options.body !== undefined) outbound.write(options.body, "utf8");
    outbound.end();
  });
}

const defaultWebDavTransport: WebDavTransport = {
  async resolve(url, signal) {
    // The stored endpoint already passed the HTTPS-except-loopback policy;
    // the transport keeps the two address policies separate and pins
    // whichever applies: loopback-only for the explicit local-network
    // policy, public-only for everything else.
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (url.protocol === "http:" && isPlainHttpConnectionHost(hostname)) {
      return resolveLoopbackDestination(url, signal);
    }
    return resolvePublicDestination(url, signal);
  },
  request: (url, addresses, options) => pinnedWebDavRequest(url, addresses, options),
};

async function readCappedResponse(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of response) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > maxBytes) {
      response.destroy();
      throw new KnowledgeScanFailureError(XML_INVALID, "the PROPFIND response exceeded its byte budget");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/** Two-slot semaphore; abort rejects waiters, holders release via callback. */
class DownloadSlots {
  private available: number;
  private readonly waiters: Array<{ resolve: () => void; cleanup: () => void }> = [];

  constructor(private readonly permits: number) {
    this.available = permits;
  }

  get permitsCount(): number {
    return this.permits;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.release);
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      const waiter = {
        resolve: () => resolve(this.release),
        cleanup: () => signal.removeEventListener("abort", onAbort),
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private readonly release = (): void => {
    const next = this.waiters.shift();
    if (next) {
      next.cleanup();
      next.resolve();
      return;
    }
    this.available = Math.min(this.permits, this.available + 1);
  };
}

// ------------------------------------------------------------------- adapter

export interface WebDavKnowledgeAdapterOptions {
  readonly requestTimeoutMs?: number;
  readonly downloadSlots?: number;
  readonly transport?: WebDavTransport;
}

function collectionPath(url: URL): string {
  return url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
}

interface RelativeMapping {
  readonly kind: "self" | "hidden" | "foreign" | "path";
  readonly relative: string | null;
}

/**
 * Map a PROPFIND href to managed identity relative to the collection. Hrefs
 * that resolve to hidden segments, traversal, or outside the collection never
 * become paths; the caller reports them as skips.
 */
export function mapHrefToRelative(href: string, collection: string): RelativeMapping {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    return { kind: "foreign", relative: null };
  }
  if (!decoded.startsWith("/")) return { kind: "foreign", relative: null };
  if (collection.length > 0) {
    if (decoded === collection || decoded === `${collection}/`) return { kind: "self", relative: null };
    if (!decoded.startsWith(`${collection}/`)) return { kind: "foreign", relative: null };
  } else if (decoded === "/") {
    return { kind: "self", relative: null };
  }
  const tail = decoded.slice(collection.length);
  const trimmed = tail.startsWith("/") ? tail.slice(1) : tail;
  const withoutTrailing = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  if (withoutTrailing.length < 1) return { kind: "self", relative: null };
  const normalized = normalizeKnowledgeRelativePath(withoutTrailing);
  if (normalized === null) {
    const segments = withoutTrailing.split("/");
    const hidden = segments.some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
    const traversal = segments.some((segment) => segment === "." || segment === "..");
    return { kind: !traversal && hidden ? "hidden" : "foreign", relative: null };
  }
  return { kind: "path", relative: normalized };
}

export class WebDavKnowledgeAdapter implements KnowledgeTransportAdapter {
  readonly kind = "webdav" as const;
  private readonly requestTimeoutMs: number;
  private readonly slots: DownloadSlots;
  private readonly transport: WebDavTransport;

  constructor(options: WebDavKnowledgeAdapterOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? WEBDAV_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
      throw new RangeError("requestTimeoutMs is invalid");
    }
    const slots = options.downloadSlots ?? WEBDAV_DOWNLOAD_SLOTS;
    if (!Number.isSafeInteger(slots) || slots < 1 || slots > WEBDAV_DOWNLOAD_SLOTS) {
      throw new RangeError("downloadSlots is invalid");
    }
    this.slots = new DownloadSlots(slots);
    this.transport = options.transport ?? defaultWebDavTransport;
  }

  async scan(
    context: KnowledgeTransportContext,
    bounds: KnowledgeScanBounds,
    managed: readonly KnowledgeItemRecord[],
    signal: AbortSignal
  ): Promise<KnowledgeScanOutcome> {
    void managed;
    const connection = requireWebDavConnection(context.connection);
    const base = new URL(connection.url);
    const collection = collectionPath(base);
    const auth = authorizationHeader(context.connection, context.secrets);
    const files: KnowledgeScanFileEntry[] = [];
    const unsupported: KnowledgeScanUnsupportedEntry[] = [];
    const skipped: KnowledgeScanSkipEntry[] = [];
    let visited = 0;
    let directories = 0;
    let aggregate = 0;
    const queue: Array<{ relative: string; depth: number }> = [{ relative: "", depth: 0 }];
    while (queue.length > 0) {
      const { relative: dirRelative, depth } = queue.shift()!;
      const entries = await this.propfind(base, collection, auth, dirRelative, signal);
      let sawSelf = false;
      const pending: KnowledgeScanFileEntry[] = [];
      for (const entry of entries) {
        visited += 1;
        if (visited > bounds.maxVisited) {
          throw new KnowledgeScanFailureError(SCAN_LIMIT, "the scan visited too many entries");
        }
        const mapped = mapHrefToRelative(entry.href, collection);
        const isSelf =
          mapped.kind === "self" || (mapped.kind === "path" && mapped.relative === dirRelative && entry.collection);
        if (isSelf) {
          if (dirRelative.length === 0) sawSelf = true;
          continue;
        }
        if (mapped.kind === "hidden") {
          skipped.push({ relative_path: boundedSkipPath(entry.href), reason: "hidden" });
          continue;
        }
        if (mapped.kind === "foreign") {
          skipped.push({ relative_path: boundedSkipPath(entry.href), reason: "excluded" });
          continue;
        }
        const relative = mapped.relative!;
        if (entry.collection) {
          if (depth + 1 > bounds.maxDepth) {
            skipped.push({ relative_path: relative, reason: "depth" });
            continue;
          }
          // Maximum directory level reached (the preview ledger validates it
          // against the depth bound).
          directories = Math.max(directories, depth + 1);
          queue.push({ relative, depth: depth + 1 });
          continue;
        }
        const name = relative.split("/").at(-1)!;
        if (!isSupportedSourcePath(name)) {
          unsupported.push({ relative_path: relative, size_bytes: entry.contentLength });
          continue;
        }
        if (entry.contentLength !== null && entry.contentLength > config.maxUploadBytes) {
          unsupported.push({ relative_path: relative, size_bytes: entry.contentLength });
          continue;
        }
        if (files.length + pending.length + 1 > bounds.maxEntries) {
          throw new KnowledgeScanFailureError(SCAN_LIMIT, "the scan exceeded its managed-entry budget");
        }
        if (entry.contentLength !== null) {
          aggregate += entry.contentLength;
          if (aggregate > bounds.maxAggregateBytes) {
            throw new KnowledgeScanFailureError(SCAN_LIMIT, "the scan exceeded its aggregate byte budget");
          }
        }
        pending.push({
          relative_path: relative,
          content_hash: "",
          size_bytes: entry.contentLength ?? 0,
          mtime_hint: entry.lastModified,
          etag_hint: entry.etag,
        });
      }
      if (dirRelative.length === 0 && !sawSelf) {
        throw new KnowledgeScanFailureError(XML_INVALID, "the collection PROPFIND omitted the collection entry");
      }
      for (const file of await this.hashFiles(base, collection, auth, pending, signal)) files.push(file);
    }
    // The scan-bound check above uses the declared-size hint for an early
    // refusal; the reported aggregate is the honestly downloaded byte total.
    const actualAggregate = files.reduce((total, file) => total + file.size_bytes, 0);
    if (actualAggregate > bounds.maxAggregateBytes) {
      throw new KnowledgeScanFailureError(SCAN_LIMIT, "the scan exceeded its aggregate byte budget");
    }
    return Object.freeze({
      files: Object.freeze(files),
      unsupported: Object.freeze(unsupported),
      skipped: Object.freeze(skipped),
      visited_entries: visited,
      directories,
      aggregate_bytes: actualAggregate,
    });
  }

  async inspect(
    context: KnowledgeTransportContext,
    request: { relative_path: string; source_id: string; source_file_path: string | null },
    signal: AbortSignal
  ): Promise<KnowledgeInspection> {
    const connection = requireWebDavConnection(context.connection);
    const base = new URL(connection.url);
    const collection = collectionPath(base);
    const auth = authorizationHeader(context.connection, context.secrets);
    const normalized = normalizeKnowledgeRelativePath(request.relative_path);
    if (normalized === null) return { state: "missing" };
    let entries: DavPropEntry[];
    try {
      entries = await this.propfind(base, collection, auth, normalized, signal, "0");
    } catch (error) {
      if (error instanceof KnowledgeScanFailureError && error.code === NOT_FOUND) return { state: "missing" };
      throw error;
    }
    const self = entries.find(
      (entry) => mapHrefToRelative(entry.href, collection).relative === normalized && !entry.collection
    );
    if (!self) return { state: "missing" };
    // Content identity requires the bytes; ETag/last-modified are hints only.
    const release = await this.slots.acquire(signal);
    try {
      const downloaded = await this.download(base, collection, auth, normalized, signal, true);
      return Object.freeze({
        state: "present",
        content_hash: downloaded.content_hash,
        size_bytes: downloaded.size_bytes,
        mtime_hint: self.lastModified,
        etag_hint: self.etag,
      });
    } finally {
      release();
    }
  }

  async stage(
    context: KnowledgeTransportContext,
    request: KnowledgeStageRequest,
    signal: AbortSignal
  ): Promise<KnowledgeStagedEntry> {
    const connection = requireWebDavConnection(context.connection);
    const base = new URL(connection.url);
    const collection = collectionPath(base);
    const auth = authorizationHeader(context.connection, context.secrets);
    const normalized = normalizeKnowledgeRelativePath(request.relative_path);
    if (normalized === null) throw new KnowledgeScanFailureError(PATH_INVALID, "the managed relative path is invalid");
    const sourceId = request.source_id ?? request.proposed_source_id ?? null;
    if (!sourceId) throw new KnowledgeScanFailureError(PATH_INVALID, "staging requires the owning source identity");
    const release = await this.slots.acquire(signal);
    try {
      const downloaded = await this.download(base, collection, auth, normalized, signal, false);
      const directory = await ensureUploadResourceDirectory(context.accountId, sourceId);
      const staged = await writeStagedFile(
        directory,
        stagedFileBase(downloaded.content_hash, normalized.split("/").at(-1)!),
        downloaded.chunks ?? [],
        { signal, maxBytes: config.maxUploadBytes }
      );
      if (staged.content_hash !== downloaded.content_hash || staged.size_bytes !== downloaded.size_bytes) {
        await fs.rm(staged.file_path, { force: true }).catch(() => {});
        throw new KnowledgeScanFailureError("KNOWLEDGE_STAGED_HASH_MISMATCH", "the staged copy drifted from upstream");
      }
      return Object.freeze({
        file_path: staged.file_path,
        content_hash: staged.content_hash,
        size_bytes: staged.size_bytes,
        mime: sourceMimeForPath(normalized),
        kind: sourceKindForPath(normalized),
      });
    } finally {
      release();
    }
  }

  private urlFor(base: URL, collection: string, relative: string): URL {
    const tail = relative
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return new URL(
      `${base.origin}${collection}${tail ? `/${tail}` : tail.length === 0 && collection.length === 0 ? "/" : ""}`
    );
  }

  private async send(url: URL, options: WebDavRequestOptions, callerSignal: AbortSignal): Promise<IncomingMessage> {
    const requestSignal = combineSignals(callerSignal, this.requestTimeoutMs);
    try {
      const addresses = await this.transport.resolve(url, requestSignal);
      return await this.transport.request(url, addresses, { ...options, signal: requestSignal });
    } catch (error) {
      // A caller cancellation always rethrows its own reason so the durable
      // service keeps its honest cancel/timeout taxonomy; only the
      // per-request timer becomes an upstream-timeout code.
      if (callerSignal.aborted) throw callerSignal.reason ?? error;
      if (error instanceof KnowledgeScanFailureError) throw error;
      if (requestSignal.aborted)
        throw new KnowledgeScanFailureError(TIMEOUT, "the WebDAV request exceeded its time budget");
      if (error instanceof UrlPolicyError) {
        throw new KnowledgeScanFailureError(UPSTREAM_UNAVAILABLE, "the WebDAV endpoint is not permitted");
      }
      throw new KnowledgeScanFailureError(UPSTREAM_UNAVAILABLE, "the WebDAV request failed");
    }
  }

  private statusOutcome(response: IncomingMessage): "ok" | "unauthorized" | "not_found" | "redirect" | "error" {
    const status = response.statusCode ?? 0;
    if (status >= 200 && status < 300) return "ok";
    if (status === 401 || status === 403) return "unauthorized";
    if (status === 404) return "not_found";
    if (status >= 300 && status < 400) return "redirect";
    return "error";
  }

  private refusal(status: "unauthorized" | "not_found" | "redirect" | "error", response: IncomingMessage): never {
    response.destroy();
    if (status === "unauthorized") {
      throw new KnowledgeScanFailureError(UNAUTHORIZED, "the WebDAV collection rejected the credentials");
    }
    if (status === "not_found") throw new KnowledgeScanFailureError(NOT_FOUND, "the WebDAV path does not exist");
    if (status === "redirect") {
      throw new KnowledgeScanFailureError(REDIRECT_REFUSED, "the WebDAV endpoint issued a redirect");
    }
    throw new KnowledgeScanFailureError(UPSTREAM_UNAVAILABLE, "the WebDAV request failed");
  }

  private async propfind(
    base: URL,
    collection: string,
    auth: string,
    relative: string,
    callerSignal: AbortSignal,
    depth: "0" | "1" = "1"
  ): Promise<DavPropEntry[]> {
    const url = this.urlFor(base, collection, relative);
    const response = await this.send(
      url,
      {
        method: "PROPFIND",
        signal: callerSignal,
        body: PROPFIND_BODY,
        headers: {
          "Content-Type": 'application/xml; charset="utf-8"',
          "Content-Length": String(Buffer.byteLength(PROPFIND_BODY, "utf8")),
          Depth: depth,
          Accept: "application/xml",
          "Accept-Encoding": "identity",
          Authorization: auth,
          "User-Agent": "Borealis-Knowledge/1",
        },
      },
      callerSignal
    );
    const outcome = this.statusOutcome(response);
    if (outcome !== "ok") this.refusal(outcome, response);
    const buffer = await readCappedResponse(response, MAX_WEBDAV_PROPFIND_RESPONSE_BYTES);
    const parsed = parseDavMultistatus(buffer.toString("utf8"));
    if (!parsed) throw new KnowledgeScanFailureError(XML_INVALID, "the WebDAV collection returned invalid XML");
    return parsed;
  }

  private async hashFiles(
    base: URL,
    collection: string,
    auth: string,
    pending: readonly KnowledgeScanFileEntry[],
    callerSignal: AbortSignal
  ): Promise<KnowledgeScanFileEntry[]> {
    if (pending.length === 0) return [];
    const results: KnowledgeScanFileEntry[] = new Array(pending.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= pending.length) return;
        const item = pending[index]!;
        const release = await this.slots.acquire(callerSignal);
        try {
          const downloaded = await this.download(base, collection, auth, item.relative_path, callerSignal, true);
          results[index] = Object.freeze({
            ...item,
            content_hash: downloaded.content_hash,
            size_bytes: downloaded.size_bytes,
          });
        } finally {
          release();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.slots.permitsCount, pending.length) }, () => worker()));
    return results;
  }

  private async download(
    base: URL,
    collection: string,
    auth: string,
    relative: string,
    callerSignal: AbortSignal,
    hashOnly: boolean
  ): Promise<{ content_hash: string; size_bytes: number; chunks?: Buffer[] }> {
    const url = this.urlFor(base, collection, relative);
    const response = await this.send(
      url,
      {
        method: "GET",
        signal: callerSignal,
        headers: {
          Accept: "*/*",
          "Accept-Encoding": "identity",
          Authorization: auth,
          "User-Agent": "Borealis-Knowledge/1",
        },
      },
      callerSignal
    );
    const outcome = this.statusOutcome(response);
    if (outcome !== "ok") this.refusal(outcome, response);
    const declared = response.headers["content-length"];
    if (typeof declared === "string" && Number(declared) > config.maxUploadBytes) {
      response.destroy();
      throw new KnowledgeScanFailureError(TOO_LARGE, "the WebDAV file exceeds the per-file upload budget");
    }
    const hash = createHash("sha256");
    const chunks: Buffer[] | undefined = hashOnly ? undefined : [];
    let total = 0;
    try {
      for await (const raw of response) {
        callerSignal.throwIfAborted();
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        total += chunk.length;
        if (total > config.maxUploadBytes) {
          response.destroy();
          throw new KnowledgeScanFailureError(TOO_LARGE, "the WebDAV file exceeds the per-file upload budget");
        }
        hash.update(chunk);
        chunks?.push(chunk);
      }
    } catch (error) {
      if (error instanceof KnowledgeScanFailureError) throw error;
      if (callerSignal.aborted) throw callerSignal.reason ?? error;
      throw new KnowledgeScanFailureError(UPSTREAM_UNAVAILABLE, "the WebDAV download failed");
    }
    return Object.freeze({ content_hash: hash.digest("hex"), size_bytes: total, chunks });
  }
}

function requireWebDavConnection(connection: KnowledgeConnectionRecord): WebDavConfig {
  if (connection.kind !== "webdav" || connection.config.kind !== "webdav") {
    throw new KnowledgeConnectionConfigError("the WebDAV transport only serves webdav connections");
  }
  return connection.config;
}

function boundedSkipPath(href: string): string {
  return href.slice(0, 1_024);
}

export const webDavKnowledgeAdapter: KnowledgeTransportAdapter = new WebDavKnowledgeAdapter();
