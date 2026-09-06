import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { isLoopbackAddress, type ResolvedAddress } from "../networkPolicy.js";
import {
  ConnectionConfigError,
  ConnectionDiscoveryInvalidError,
  ConnectionDiscoveryLimitError,
  MAX_DISCOVERY_TOOLS,
  MAX_DISCOVERY_TOTAL_BYTES,
  MAX_STDIO_ARG_CHARS,
  MAX_STDIO_ARGS,
  MAX_TOOL_DESCRIPTOR_BYTES,
  MAX_TOOL_DESCRIPTION_CHARS,
  MAX_TOOL_NAME_CHARS,
  connectionKindAdapter,
  isPlainHttpConnectionHost,
  type ConnectionConfig,
  type ConnectionKind,
} from "../connections/store.js";
import { OAUTH_ENV_PREFIX, type ConnectionSecrets } from "../connections/secrets.js";

/**
 * MCP transport provider (Connected agents stage 2).
 *
 * The official `@modelcontextprotocol/sdk` Streamable HTTP and stdio
 * transports implement the stage-1 seam in place: the connection service
 * reaches transports only through `mcpTransportProvider()`, and the SDK
 * provider is the production default. `setMcpTransportProvider()` remains the
 * swap seam for deterministic in-process fakes in unit tests.
 *
 * Transport invariants enforced here and proven by `mcpClient.test.ts`:
 * - Discovery is bounded `initialize` + paginated `tools/list` only; no
 *   content-bearing call runs on the discovery path. Over-budget catalogs
 *   raise the store's explicit `CONNECTION_DISCOVERY_OVER_LIMIT` rather than
 *   silently dropping tools.
 * - HTTP targets carry the full endpoint path (unlike the bare-origin model
 *   provider). HTTPS is required except explicitly configured loopback /
 *   `.local` development targets (the Settings locality boundary). Requests
 *   are DNS-address-pinned, never follow redirects, and credential headers are
 *   attached solely to the exact validated endpoint origin — a redirect (or
 *   any other URL) therefore can never carry them. Response bodies are
 *   byte-bounded and consumed under one deadline.
 * - stdio spawns the configured absolute executable directly without a
 *   shell, with an explicit argument vector and explicit environment entries
 *   (credential environment arrives only through the secret-custody seam).
 *   It never installs a package or runs `npx` from a descriptor. Protocol
 *   stdout goes only to the SDK parser; stderr is consumed and discarded.
 *   The child is owned: stdin close, then bounded TERM → KILL escalation on
 *   disconnect/cancel/shutdown, followed by a pid-gone proof.
 * - One client per operation. `quiesceMcpConnections()` drains every still
 *   live session (for example a test-owned child) and is hooked into the
 *   application runtime's shutdown drains.
 *
 * Nothing here logs protocol payloads, stderr text, endpoints with
 * credentials, or provider error bodies. Tool-call arguments and results are
 * untrusted context: validated against the captured schema snapshot before
 * dispatch and byte-bounded in both directions.
 */

export const CONNECTION_TRANSPORT_TIMEOUT_MS = 15_000;
export const MCP_TOOL_CALL_TIMEOUT_MS = 30_000;
export const MAX_TOOL_CALL_ARGUMENTS_BYTES = 32 * 1024;
export const MAX_TOOL_CALL_RESULT_BYTES = 64 * 1024;

/** Fixed client identity sent on initialize; never content-bearing. */
const MCP_CLIENT_INFO = Object.freeze({ name: "borealis", version: "0.1.0" });

/** Defensive page-loop cap; over it is an explicit over-limit discovery. */
const MAX_DISCOVERY_PAGES = 64;
/** Transport-level hostile-response ceiling for one HTTP message. */
const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;
/** SDK stdio read-buffer ceiling; above any legitimate bounded result. */
const STDIO_MAX_BUFFER_BYTES = 1024 * 1024;
/** Budget to prove an owned stdio child's pid is gone after escalation. */
const CHILD_GONE_BUDGET_MS = 6_000;

export interface McpToolDescriptor {
  /** Original server-side tool name (bounded by the connection store). */
  readonly name: string;
  readonly description: string;
  /** Validated JSON Schema object for tool input. */
  readonly input_schema: Record<string, unknown>;
}

export interface McpTransportTarget {
  readonly accountId: string;
  readonly connectionId: string;
  readonly kind: ConnectionKind;
  /** Kind-validated non-secret configuration from the ledger row. */
  readonly config: ConnectionConfig;
  /** Custody-decrypted credentials for this connection, if any were stored. */
  readonly secrets: ConnectionSecrets | undefined;
}

/** One normalized tool-call request against a captured snapshot schema. */
export interface McpToolCallRequest {
  readonly name: string;
  /** The schema from the published discovery snapshot. */
  readonly input_schema: unknown;
  readonly arguments: Record<string, unknown>;
}

/** Bounded, content-normalized tool outcome for stage-4 dispatch. */
export interface McpToolCallOutcome {
  /** False when the server reported `isError`; still a valid completed call. */
  readonly ok: boolean;
  /** Concatenated text content, bounded by `MAX_TOOL_CALL_RESULT_BYTES`. */
  readonly text: string;
  /**
   * Non-text content block types (image/audio/resource/resource_link) the
   * server returned. They are reported explicitly and never auto-fetched.
   */
  readonly unsupported_content: readonly string[];
}

export interface McpTransportSession {
  /**
   * Bounded initialize + tools/list. Implementations must reject
   * promptly on `signal` and release all transport resources before the
   * returned promise settles.
   */
  listTools(signal: AbortSignal): Promise<McpToolDescriptor[]>;
  /**
   * Stage-4 tool dispatch. Present on SDK-backed sessions; deterministic
   * fakes may omit it, in which case `callMcpTool` reports the transport as
   * unavailable rather than pretending the call happened.
   */
  callTool?(request: McpToolCallRequest, signal: AbortSignal): Promise<McpToolCallOutcome>;
  /** The owned stdio child's pid, when this session spawned one. */
  readonly childPid?: number | null;
  close(): Promise<void>;
}

export interface McpTransportProvider {
  /**
   * Establishes the transport for one bounded probe. The provider must bind
   * credentials to `target` and must not retain them beyond `close()`.
   */
  connect(target: McpTransportTarget, signal: AbortSignal): Promise<McpTransportSession>;
}

/** Stable wiring-gap signal; it is not evidence about any endpoint. */
export class McpTransportUnavailableError extends Error {
  readonly code = "CONNECTION_TRANSPORT_UNAVAILABLE";
  readonly statusCode = 503;

  constructor() {
    super("the MCP transport is unavailable");
    this.name = "McpTransportUnavailableError";
  }
}

/** The endpoint answered but requires credentials this connection lacks. */
export class McpTransportAuthError extends Error {
  readonly code = "CONNECTION_AUTH_REQUIRED";
  readonly statusCode = 409;

  constructor() {
    super("the connection requires sign-in");
    this.name = "McpTransportAuthError";
  }
}

/** Connect/initialize/list-tools failed at the protocol boundary. */
export class McpTransportHandshakeError extends Error {
  readonly code = "CONNECTION_HANDSHAKE_FAILED";
  readonly statusCode = 502;

  constructor() {
    super("the connection handshake failed");
    this.name = "McpTransportHandshakeError";
  }
}

/** The captured snapshot schema is a shape this client refuses to execute. */
export class McpToolSchemaUnsupportedError extends Error {
  readonly code = "CONNECTION_TOOL_SCHEMA_UNSUPPORTED";
  readonly statusCode = 400;

  constructor() {
    super("the captured tool schema is not supported");
    this.name = "McpToolSchemaUnsupportedError";
  }
}

/** Call arguments failed validation against the captured snapshot schema. */
export class McpToolArgumentsInvalidError extends Error {
  readonly code = "CONNECTION_TOOL_ARGS_INVALID";
  readonly statusCode = 400;

  constructor() {
    super("the tool arguments do not match the captured tool schema");
    this.name = "McpToolArgumentsInvalidError";
  }
}

/** Serialized call arguments exceeded the fixed argument budget. */
export class McpToolArgumentsOverLimitError extends Error {
  readonly code = "CONNECTION_TOOL_ARGS_OVER_LIMIT";
  readonly statusCode = 400;

  constructor() {
    super("the tool arguments exceed the supported size");
    this.name = "McpToolArgumentsOverLimitError";
  }
}

/** The tool result exceeded the fixed result budget (never truncated). */
export class McpToolResultOverLimitError extends Error {
  readonly code = "CONNECTION_TOOL_RESULT_OVER_LIMIT";
  readonly statusCode = 502;

  constructor() {
    super("the tool result exceeds the supported size");
    this.name = "McpToolResultOverLimitError";
  }
}

/** The tool call exceeded its own bounded deadline. */
export class McpToolTimeoutError extends Error {
  readonly code = "CONNECTION_TOOL_TIMEOUT";
  readonly statusCode = 504;

  constructor() {
    super("the tool call timed out");
    this.name = "McpToolTimeoutError";
  }
}

/** The tool call failed at the protocol boundary. */
export class McpToolCallFailedError extends Error {
  readonly code = "CONNECTION_TOOL_CALL_FAILED";
  readonly statusCode = 502;

  constructor() {
    super("the tool call failed");
    this.name = "McpToolCallFailedError";
  }
}

/**
 * Internal drain failure: an owned stdio child could not be proven gone.
 * It never crosses an HTTP boundary; it fails the shutdown close proof.
 */
export class McpConnectionDrainError extends Error {
  readonly code = "MCP_CONNECTION_DRAIN_FAILED";

  constructor() {
    super("an MCP connection resource could not be proven released");
    this.name = "McpConnectionDrainError";
  }
}

// ---------------------------------------------------------------------------
// Strict schema support via the SDK-resolved ajv.
// ---------------------------------------------------------------------------

/**
 * `ajv` is a dependency of the pinned MCP SDK, not of this package. It is
 * resolved through the SDK's own dependency tree (the exact version the
 * server already ships) via `createRequire` anchored at the SDK package —
 * no new manifest dependency is introduced.
 */
interface StrictAjv {
  compile(schema: unknown): (data: unknown) => boolean;
  errorsText(errors?: unknown): string;
}
type StrictAjvConstructor = new (options: Record<string, unknown>) => StrictAjv;

let strictAjvConstructor: StrictAjvConstructor | undefined;
let discoveryAjv: StrictAjv | undefined;

function loadStrictAjvConstructor(): StrictAjvConstructor {
  if (strictAjvConstructor) return strictAjvConstructor;
  // Anchor on this module's physical location with a native require, then
  // hop to the SDK's explicit subpath export and resolve `ajv` from the
  // SDK's own dependency tree. This works identically under Node, tsx, and
  // Vitest's transform environment (where `import.meta.resolve` is rewired).
  const fromModule = createRequire(import.meta.url);
  const sdkValidationEntry = fromModule.resolve("@modelcontextprotocol/sdk/validation/ajv");
  const requireFromSdk = createRequire(sdkValidationEntry);
  const resolved: unknown = requireFromSdk("ajv");
  const ctor: unknown = typeof resolved === "function" ? resolved : (resolved as { default?: unknown }).default;
  if (typeof ctor !== "function") throw new Error("the SDK-resolved ajv export is unusable");
  strictAjvConstructor = ctor as StrictAjvConstructor;
  return strictAjvConstructor;
}

function strictAjvInstance(): StrictAjv {
  if (!discoveryAjv) {
    const Ctor = loadStrictAjvConstructor();
    // Strict mode is the selection gate: unknown schema types/keywords and
    // contradictory shapes fail to compile and are refused, never executed.
    discoveryAjv = new Ctor({ strict: true, allErrors: true, validateFormats: false });
  }
  return discoveryAjv;
}

/**
 * True when the captured input schema is a shape this client will execute.
 * Stage-4 selection must refuse unsupported schemas rather than advertise a
 * tool it cannot safely validate arguments for.
 */
export function isMcpToolSchemaSupported(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  try {
    strictAjvInstance().compile(schema);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Connection-boundary address resolution and the pinned fetch transport.
// ---------------------------------------------------------------------------

async function lookupAllAbortAware(
  hostname: string,
  signal: AbortSignal
): Promise<Array<{ address: string; family: number }>> {
  return Promise.race([
    lookup(hostname, { all: true, verbatim: true }).catch(() => []),
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}

/**
 * Resolve an MCP connection endpoint according to the operator-approved
 * connection boundary, and return the addresses to pin:
 * - `https:` targets are intentional outbound capabilities: any hostname may
 *   resolve, but every socket uses the pinned first answer (the networkPolicy
 *   DNS-rebinding defence), and TLS keeps normal certificate validation.
 * - `http:` is legal only for explicitly configured loopback/`.local`
 *   development targets; exact loopback literals and `localhost` must resolve
 *   loopback-only, mirroring `resolveLoopbackDestination`. Everything else
 *   fails closed before any socket opens.
 */
export async function resolveConnectionDestination(url: URL, signal: AbortSignal): Promise<ResolvedAddress[]> {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  if (url.protocol === "https:") {
    if (literalFamily) return [{ address: hostname, family: literalFamily as 4 | 6 }];
    const answers = await lookupAllAbortAware(hostname, signal);
    if (!answers.length) throw new McpTransportHandshakeError();
    return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
  }
  if (url.protocol === "http:" && isPlainHttpConnectionHost(hostname)) {
    if (literalFamily) {
      if (!isLoopbackAddress(hostname)) throw new ConnectionConfigError("connection endpoint is invalid");
      return [{ address: hostname, family: literalFamily as 4 | 6 }];
    }
    const answers = await lookupAllAbortAware(hostname, signal);
    if (!answers.length) throw new McpTransportHandshakeError();
    if (hostname === "localhost" && answers.some(({ address }) => !isLoopbackAddress(address))) {
      throw new ConnectionConfigError("connection endpoint is invalid");
    }
    return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
  }
  throw new ConnectionConfigError("connection endpoint is invalid");
}

/**
 * One pinned Node request against a validated destination. Exported for the
 * OAuth module so issuer metadata/token endpoints reuse the exact same
 * DNS-pinning, idle-timeout, and abort semantics as MCP transport sockets.
 */
export function pinnedNodeRequest(
  target: URL,
  address: ResolvedAddress,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  signal: AbortSignal | undefined
): Promise<import("node:http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(
      target,
      {
        method,
        headers,
        signal,
        // Pin the validated DNS result so a second lookup cannot move the
        // socket (DNS-rebinding TOCTOU), per the networkPolicy pattern.
        lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
          else callback(null, address.address, address.family);
        }) as any,
      },
      resolve
    );
    request.setTimeout(CONNECTION_TRANSPORT_TIMEOUT_MS, () => {
      request.destroy(new Error("connection endpoint idle timeout"));
    });
    request.once("error", reject);
    if (body) request.end(body);
    else request.end();
  });
}

function cappedBodyStream(response: import("node:http").IncomingMessage, capBytes: number): ReadableStream<Uint8Array> {
  const reader = (Readable.toWeb(response) as ReadableStream<Uint8Array>).getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: { done?: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch (error) {
        controller.error(error);
        return;
      }
      if (chunk.done) {
        controller.close();
        return;
      }
      const value = chunk.value;
      if (!value) return;
      total += value.byteLength;
      if (total > capBytes) {
        response.destroy();
        controller.error(new Error("connection response exceeded the byte budget"));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => undefined);
      response.destroy();
    },
  });
}

/** Exported alongside `pinnedNodeRequest`: byte-bounded message → `Response`. */
export function toWebResponse(response: import("node:http").IncomingMessage): Response {
  const rawStatus = response.statusCode ?? 502;
  const status = rawStatus >= 200 && rawStatus <= 599 ? rawStatus : 502;
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (typeof value === "string") headers.append(name, value);
  }
  if (status === 204 || status === 205 || status === 304) {
    response.resume();
    return new Response(null, { status, headers });
  }
  return new Response(cappedBodyStream(response, MAX_HTTP_RESPONSE_BYTES), {
    status,
    statusText: response.statusMessage ?? "",
    headers,
  });
}

/**
 * Build the SDK `fetch` replacement for one endpoint. Credentials never enter
 * this closure's request path unless the request URL is byte-identical in
 * origin and path to the validated endpoint; the fetch never follows any
 * redirect, so a `3xx` target is reported to the SDK as an error response and
 * credentials can never be replayed after a redirect.
 */
function createEndpointFetch(endpoint: URL, credentialHeaders: Record<string, string>) {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = typeof url === "string" ? new URL(url) : url;
    if (
      target.origin !== endpoint.origin ||
      target.pathname !== endpoint.pathname ||
      target.search.length > 0 ||
      target.hash.length > 0
    ) {
      // Arbitrary redirects and cross-target drift are refused outright; the
      // credential binding below can therefore never be replayed elsewhere.
      throw new McpTransportHandshakeError();
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(credentialHeaders)) headers.set(name, value);
    let body: Buffer | undefined;
    if (typeof init?.body === "string") body = Buffer.from(init.body, "utf8");
    else if (init?.body === undefined || init.body === null) body = undefined;
    else throw new McpTransportHandshakeError();
    // The SDK transport always supplies its own abort signal; the fallback
    // controller is a never-aborted signal, never an immediate abort.
    const requestSignal = init?.signal ?? new AbortController().signal;
    const addresses = await resolveConnectionDestination(target, requestSignal);
    const response = await pinnedNodeRequest(
      target,
      addresses[0],
      method,
      Object.fromEntries(headers.entries()),
      body,
      requestSignal
    );
    return toWebResponse(response);
  };
}

// ---------------------------------------------------------------------------
// Error mapping.
// ---------------------------------------------------------------------------

function isAbortError(error: unknown): boolean {
  // AbortSignal.abort/controller.abort reason: AbortError.
  // AbortSignal.timeout reason: TimeoutError — both mean caller-side cancel.
  return (
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ABORT_ERR")
  );
}

function isRequestTimeout(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout;
}

/** Map an SDK/transport rejection onto the stable seam error surface. */
function mapTransportError(error: unknown): never {
  if (error instanceof McpTransportUnavailableError) throw error;
  if (error instanceof ConnectionConfigError) throw error;
  if (error instanceof ConnectionDiscoveryLimitError || error instanceof ConnectionDiscoveryInvalidError) throw error;
  if (isAbortError(error)) throw error;
  if (error instanceof StreamableHTTPError && error.code === 401) throw new McpTransportAuthError();
  if (isRequestTimeout(error)) throw new McpTransportHandshakeError();
  throw new McpTransportHandshakeError();
}

function mapToolCallError(error: unknown): never {
  if (error instanceof McpTransportUnavailableError) throw error;
  if (error instanceof McpTransportAuthError) throw error;
  if (error instanceof McpToolTimeoutError) throw error;
  if (error instanceof McpToolResultOverLimitError) throw error;
  if (error instanceof McpToolArgumentsInvalidError) throw error;
  if (error instanceof McpToolSchemaUnsupportedError) throw error;
  if (isAbortError(error)) throw error;
  if (isRequestTimeout(error)) throw new McpToolTimeoutError();
  throw new McpToolCallFailedError();
}

/**
 * Run transport work so a `signal` abort rejects promptly and the rejection
 * is mapped onto the stable seam errors. The abort listener is always
 * removed before settling.
 */
async function bounded<T>(
  work: (innerSignal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  map: (error: unknown) => never
): Promise<T> {
  if (signal.aborted) map(signal.reason);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      try {
        map(signal.reason);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    work(signal).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        try {
          map(error);
        } catch (mapped) {
          reject(mapped);
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Child-process ownership proofs.
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isPidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // ESRCH: reaped. EPERM: the pid is no longer ours (reused), so our
    // child cannot still be running under it.
    const code = (error as { code?: unknown }).code;
    return code === "ESRCH" || code === "EPERM";
  }
}

/** Prove the owned stdio child is gone within a bounded budget. */
async function proveChildGone(pid: number, budgetMs = CHILD_GONE_BUDGET_MS): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (isPidGone(pid)) return;
    if (Date.now() >= deadline) throw new McpConnectionDrainError();
    await delay(25);
  }
}

// ---------------------------------------------------------------------------
// Discovery canonicalization.
// ---------------------------------------------------------------------------

function canonicalTool(raw: unknown): McpToolDescriptor {
  const tool = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
  const name = tool?.name;
  if (typeof name !== "string" || name.length < 1 || name.length > MAX_TOOL_NAME_CHARS || /[\0\r\n]/.test(name)) {
    throw new ConnectionDiscoveryInvalidError();
  }
  const description = tool.description === undefined ? "" : tool.description;
  if (typeof description !== "string" || description.length > MAX_TOOL_DESCRIPTION_CHARS) {
    throw new ConnectionDiscoveryInvalidError();
  }
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new ConnectionDiscoveryInvalidError();
  }
  return Object.freeze({
    name,
    description,
    input_schema: Object.freeze({ ...(schema as Record<string, unknown>) }),
  });
}

/** Canonicalize + size-bound tool call arguments before schema validation. */
function validatedCallArguments(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value ?? {});
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_TOOL_CALL_ARGUMENTS_BYTES) {
    if (typeof serialized !== "string") throw new McpToolArgumentsInvalidError();
    throw new McpToolArgumentsOverLimitError();
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function descriptorBytes(tool: McpToolDescriptor): number {
  return Buffer.byteLength(
    JSON.stringify({ name: tool.name, description: tool.description, tool_input_schema: tool.input_schema }),
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// The SDK-backed session.
// ---------------------------------------------------------------------------

type SdkTransport = StreamableHTTPClientTransport | StdioClientTransport;

interface SdkTransportHandle {
  readonly client: Client;
  readonly transport: SdkTransport;
  /** Assigned once the transport has started; null for HTTP or spawn failure. */
  childPid: number | null;
}

class SdkMcpSession implements McpTransportSession {
  private closed = false;

  constructor(
    private readonly handle: SdkTransportHandle,
    private readonly release: (session: SdkMcpSession) => void
  ) {}

  get childPid(): number | null {
    return this.handle.childPid;
  }

  listTools(signal: AbortSignal): Promise<McpToolDescriptor[]> {
    return bounded(
      async (innerSignal) => {
        const tools: McpToolDescriptor[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        let pages = 0;
        let totalBytes = 0;
        for (;;) {
          pages += 1;
          if (pages > MAX_DISCOVERY_PAGES) throw new ConnectionDiscoveryLimitError();
          const page = await this.handle.client.listTools(cursor ? { cursor } : {}, {
            signal: innerSignal,
            timeout: CONNECTION_TRANSPORT_TIMEOUT_MS,
          });
          const rawTools = Array.isArray(page.tools) ? page.tools : [];
          for (const raw of rawTools) {
            if (tools.length >= MAX_DISCOVERY_TOOLS) {
              // Refuse explicitly rather than silently dropping the excess.
              throw new ConnectionDiscoveryLimitError();
            }
            const tool = canonicalTool(raw);
            const bytes = descriptorBytes(tool);
            if (bytes > MAX_TOOL_DESCRIPTOR_BYTES) throw new ConnectionDiscoveryLimitError();
            totalBytes += bytes;
            if (totalBytes > MAX_DISCOVERY_TOTAL_BYTES) throw new ConnectionDiscoveryLimitError();
            tools.push(tool);
          }
          const nextCursor =
            typeof page.nextCursor === "string" && page.nextCursor.length > 0 ? page.nextCursor : undefined;
          if (!nextCursor) break;
          if (seenCursors.has(nextCursor)) throw new McpTransportHandshakeError();
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
        return tools;
      },
      signal,
      mapTransportError
    );
  }

  async callTool(request: McpToolCallRequest, signal: AbortSignal): Promise<McpToolCallOutcome> {
    if (!isMcpToolSchemaSupported(request.input_schema)) throw new McpToolSchemaUnsupportedError();
    let compiled: (data: unknown) => boolean;
    try {
      compiled = strictAjvInstance().compile(request.input_schema);
    } catch {
      throw new McpToolSchemaUnsupportedError();
    }
    const args = validatedCallArguments(request.arguments);
    if (!compiled(args)) throw new McpToolArgumentsInvalidError();
    return bounded(
      async (innerSignal) => {
        const result = await this.handle.client.callTool({ name: request.name, arguments: args }, undefined, {
          signal: innerSignal,
          timeout: MCP_TOOL_CALL_TIMEOUT_MS,
        });
        return normalizeToolResult(result);
      },
      signal,
      mapToolCallError
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.release(this);
    // Protocol close closes the transport; the stdio transport then ends
    // stdin, escalates TERM after a bounded grace, and finally SIGKILLs.
    try {
      await this.handle.client.close();
    } catch {
      // Failures to talk to a dying peer are expected during teardown.
    }
    if (this.handle.childPid === null && this.handle.transport instanceof StdioClientTransport) {
      this.handle.childPid = this.handle.transport.pid ?? null;
    }
    if (this.handle.childPid !== null) {
      // The retained pid stays readable so ownership proofs (tests, the
      // shutdown drain) can observe the exact process they were issued.
      await proveChildGone(this.handle.childPid);
    }
  }
}

function normalizeToolResult(result: unknown): McpToolCallOutcome {
  const value = result as { content?: unknown; isError?: unknown };
  const blocks = Array.isArray(value?.content) ? value.content : [];
  const textParts: string[] = [];
  const unsupported = new Set<string>();
  let textBytes = 0;
  for (const raw of blocks) {
    const block = raw as { type?: unknown; text?: unknown };
    const type = typeof block?.type === "string" ? block.type : "unknown";
    if (type === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      textBytes += Buffer.byteLength(text, "utf8");
      // Fail explicitly over truncating or pretending a partial result is
      // the whole answer.
      if (textBytes > MAX_TOOL_CALL_RESULT_BYTES) throw new McpToolResultOverLimitError();
      textParts.push(text);
    } else {
      // Reported explicitly; media and resource links are never auto-fetched.
      unsupported.add(type);
    }
  }
  return Object.freeze({
    ok: value?.isError !== true,
    text: textParts.join("\n"),
    unsupported_content: Object.freeze([...unsupported]),
  });
}

// ---------------------------------------------------------------------------
// The SDK-backed provider and its lifecycle registry.
// ---------------------------------------------------------------------------

/** Sessions whose teardown has not yet been positively proven. */
const liveSessions = new Set<SdkMcpSession>();

function canonicalConfigInput(config: ConnectionConfig): Record<string, unknown> {
  return config.kind === "mcp_http"
    ? { url: config.url }
    : { command: config.command, args: [...config.args], cwd: config.cwd };
}

function stdioSpawnPlan(target: McpTransportTarget): {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string>;
} {
  const validated = connectionKindAdapter("mcp_stdio").validateConfig(canonicalConfigInput(target.config));
  if (validated.kind !== "mcp_stdio") throw new ConnectionConfigError("stdio connection configuration is invalid");
  // Independent re-check of the operator bounds; a stored row that drifted is
  // refused here even though the store validated it at write time.
  if (
    !validated.command.startsWith("/") ||
    validated.args.length > MAX_STDIO_ARGS ||
    validated.args.some((arg) => arg.length < 1 || arg.length > MAX_STDIO_ARG_CHARS)
  ) {
    throw new ConnectionConfigError("stdio connection configuration is invalid");
  }
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const [name, value] of Object.entries(target.secrets?.env ?? {})) {
    // Defense in depth: OAuth custody material belongs exclusively to the
    // browser-dev sign-in lifecycle of an HTTP target and must never ride
    // into an operator-owned stdio child, even if a record ever drifts.
    if (typeof value === "string" && !name.startsWith(OAUTH_ENV_PREFIX)) env[name] = value;
  }
  return { command: validated.command, args: [...validated.args], cwd: validated.cwd ?? undefined, env };
}

class SdkMcpTransportProvider implements McpTransportProvider {
  async connect(target: McpTransportTarget, signal: AbortSignal): Promise<McpTransportSession> {
    if (signal.aborted) throw signal.reason;

    const client = new Client(MCP_CLIENT_INFO, { capabilities: {} });
    let transport: SdkTransport;

    if (target.kind === "mcp_http") {
      const validated = connectionKindAdapter("mcp_http").validateConfig(canonicalConfigInput(target.config));
      if (validated.kind !== "mcp_http") throw new ConnectionConfigError("connection configuration is invalid");
      const endpoint = new URL(validated.url);
      const credentialHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(target.secrets?.headers ?? {})) {
        if (typeof value === "string") credentialHeaders[name] = value;
      }
      transport = new StreamableHTTPClientTransport(endpoint, {
        // Credentials bind to the exact validated endpoint: they are attached
        // inside the endpoint fetch only after the URL identity check, and the
        // fetch never follows redirects, so they can never ride a redirect.
        fetch: createEndpointFetch(endpoint, credentialHeaders),
        reconnectionOptions: {
          maxReconnectionDelay: 500,
          initialReconnectionDelay: 250,
          reconnectionDelayGrowFactor: 1,
          maxRetries: 0,
        },
      });
    } else {
      const plan = stdioSpawnPlan(target);
      // Direct spawn of the configured absolute executable without a shell;
      // the SDK StdioClientTransport never installs or runs `npx`.
      const stdioTransport = new StdioClientTransport({
        command: plan.command,
        args: plan.args,
        cwd: plan.cwd,
        env: plan.env,
        // stderr is piped so it can be consumed and discarded; protocol
        // stdout is owned exclusively by the SDK parser and never logged.
        stderr: "pipe",
        maxBufferSize: STDIO_MAX_BUFFER_BYTES,
      });
      const stderrStream = stdioTransport.stderr as Readable | null;
      if (stderrStream) {
        // Drained and discarded; never parsed, retained, or logged.
        stderrStream.on("error", () => undefined);
        stderrStream.resume();
      }
      transport = stdioTransport;
    }

    // A no-op transport error sink keeps SDK-internal async failures (for
    // example the optional SSE read stream torn down at close) off stderr;
    // operational failures still reject their awaited request.
    transport.onerror = () => undefined;

    const handle: SdkTransportHandle = { client, transport, childPid: null };
    const session = new SdkMcpSession(handle, (live) => {
      liveSessions.delete(live);
    });
    try {
      await bounded(
        async (innerSignal) => {
          await client.connect(transport, { signal: innerSignal, timeout: CONNECTION_TRANSPORT_TIMEOUT_MS });
          return undefined;
        },
        signal,
        mapTransportError
      );
    } catch (error) {
      // The child — if one ever spawned — is owned from here on: teardown
      // escalates to a proven kill before the failure reaches the caller.
      await session.close().catch(() => undefined);
      throw error;
    }
    handle.childPid = transport instanceof StdioClientTransport ? transport.pid : null;
    if (signal.aborted) {
      await session.close().catch(() => undefined);
      throw signal.reason;
    }
    liveSessions.add(session);
    return session;
  }
}

/**
 * Drain every still-live connection session (for example an explicitly
 * test-owned child). Called by the application runtime's shutdown drains.
 * Fails closed when an owned child cannot be proven gone, which poisons the
 * runtime close proof instead of risking an orphan.
 */
export async function quiesceMcpConnections(): Promise<void> {
  const sessions = [...liveSessions];
  if (sessions.length === 0) return;
  const results = await Promise.allSettled(sessions.map((session) => session.close()));
  if (results.some((result) => result.status === "rejected")) throw new McpConnectionDrainError();
}

/**
 * One-shot tool dispatch for stage 4: opens a fresh client for exactly one
 * call against a captured snapshot, enforces schema support, argument
 * validation, and both byte budgets, and proves child teardown before
 * settling. The caller's `signal` cancels the call (and the child);
 * `deadlineMs` defaults to the 30-second tool deadline and may only tighten
 * it to stay inside a parent run deadline.
 */
export async function callMcpTool(
  target: McpTransportTarget,
  request: McpToolCallRequest,
  options: { readonly signal?: AbortSignal; readonly deadlineMs?: number } = {}
): Promise<McpToolCallOutcome> {
  if (!isMcpToolSchemaSupported(request.input_schema)) throw new McpToolSchemaUnsupportedError();
  validatedCallArguments(request.arguments);
  const deadlineMs = Math.max(1, Math.min(options.deadlineMs ?? MCP_TOOL_CALL_TIMEOUT_MS, MCP_TOOL_CALL_TIMEOUT_MS));
  const callerSignal = options.signal;
  if (callerSignal?.aborted) throw callerSignal.reason;
  const timeoutSignal = AbortSignal.timeout(deadlineMs);
  const combined = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  const provider = activeProvider;
  let session: McpTransportSession | undefined;
  try {
    session = await provider.connect(target, combined);
    if (!session.callTool) throw new McpTransportUnavailableError();
    const outcome = await session.callTool(request, combined);
    return outcome;
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason;
    if (timeoutSignal.aborted || isRequestTimeout(error)) throw new McpToolTimeoutError();
    if (
      error instanceof McpToolResultOverLimitError ||
      error instanceof McpToolSchemaUnsupportedError ||
      error instanceof McpToolArgumentsInvalidError ||
      error instanceof McpToolArgumentsOverLimitError ||
      error instanceof McpTransportUnavailableError ||
      error instanceof McpTransportAuthError ||
      error instanceof McpToolTimeoutError ||
      error instanceof McpToolCallFailedError
    ) {
      throw error;
    }
    if (isAbortError(error)) throw error;
    throw new McpToolCallFailedError();
  } finally {
    if (session) await session.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Composition seam.
// ---------------------------------------------------------------------------

/**
 * Production default: the official-SDK transports. Stage 1's
 * deterministic-unavailable provider is replaced here; unit tests still swap
 * a deterministic in-process provider through `setMcpTransportProvider`.
 */
const SDK_MCP_TRANSPORT_PROVIDER: McpTransportProvider = Object.freeze(new SdkMcpTransportProvider());

let activeProvider: McpTransportProvider = SDK_MCP_TRANSPORT_PROVIDER;

export function mcpTransportProvider(): McpTransportProvider {
  return activeProvider;
}

/** Test/composition seam. Returns the restore operation; `undefined` restores the SDK default. */
export function setMcpTransportProvider(provider: McpTransportProvider | undefined): () => void {
  const previous = activeProvider;
  activeProvider = provider ?? SDK_MCP_TRANSPORT_PROVIDER;
  return () => {
    activeProvider = previous;
  };
}
