import type { ConnectionConfig, ConnectionKind } from "../connections/store.js";
import type { ConnectionSecrets } from "../connections/secrets.js";

/**
 * MCP transport-provider seam.
 *
 * Stage 2 implements the official-SDK Streamable HTTP and stdio transports
 * against this contract and makes the SDK provider the active default in this
 * module. The connection service only ever reaches transports through
 * `mcpTransportProvider()`, so route tests and later integration tests can
 * swap in a deterministic in-process provider with
 * `setMcpTransportProvider()` without touching route or service code.
 *
 * Transport invariants (enforced by the stage-2 implementation, proven by its
 * tests): bounded discovery via `listTools` only — no content-bearing tool
 * call may be issued here; HTTP targets are validated/pinned per the operator
 * connection boundary and never follow arbitrary redirects; stdio spawns the
 * configured absolute executable directly without a shell, owns its child,
 * and never logs protocol stdout/stderr. Credentials arrive already scoped to
 * this exact connection and are never echoed back through any result.
 */

export const CONNECTION_TRANSPORT_TIMEOUT_MS = 15_000;

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

export interface McpTransportSession {
  /**
   * Bounded initialize + tools/list. Implementations must reject
   * promptly on `signal` and release all transport resources before the
   * returned promise settles.
   */
  listTools(signal: AbortSignal): Promise<McpToolDescriptor[]>;
  close(): Promise<void>;
}

export interface McpTransportProvider {
  /**
   * Establishes the transport for one bounded probe. The provider must bind
   * credentials to `target` and must not retain them beyond `close()`.
   */
  connect(target: McpTransportTarget, signal: AbortSignal): Promise<McpTransportSession>;
}

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

/**
 * Stage-1 default until the SDK-backed provider lands in stage 2: a stable,
 * side-effect-free unavailable signal. It is not the shipped feature — the
 * real transports are required for completion, and stage 2 replaces this
 * default in place.
 */
const UNAVAILABLE_MCP_TRANSPORT_PROVIDER: McpTransportProvider = Object.freeze({
  connect: async (): Promise<McpTransportSession> => {
    throw new McpTransportUnavailableError();
  },
});

let activeProvider: McpTransportProvider = UNAVAILABLE_MCP_TRANSPORT_PROVIDER;

export function mcpTransportProvider(): McpTransportProvider {
  return activeProvider;
}

/** Test/composition seam. Returns the restore operation; `undefined` restores stage defaults. */
export function setMcpTransportProvider(provider: McpTransportProvider | undefined): () => void {
  const previous = activeProvider;
  activeProvider = provider ?? UNAVAILABLE_MCP_TRANSPORT_PROVIDER;
  return () => {
    activeProvider = previous;
  };
}
