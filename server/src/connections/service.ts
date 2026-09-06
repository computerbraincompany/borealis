import path from "node:path";
import { config } from "../config.js";
import {
  callMcpTool,
  CONNECTION_TRANSPORT_TIMEOUT_MS,
  MCP_TOOL_CALL_TIMEOUT_MS,
  mcpTransportProvider,
  McpTransportAuthError,
} from "../mcp/client.js";
import type {
  McpToolCallRequest,
  McpToolDescriptor,
  McpToolCallOutcome,
  McpTransportProvider,
  McpTransportTarget,
} from "../mcp/client.js";
import {
  CONNECTION_AUTH_REFRESH_FAILED,
  ConnectionAuthRefreshFailedError,
  ConnectionAuthUnsupportedError,
  createConnectionOAuthManager,
  type ConnectionAuthorization,
  type ConnectionAuthorizationProvider,
  type ConnectionOAuthManager,
} from "../mcp/oauth.js";
import { closeOAuthCallbackListener } from "../mcp/oauthCallback.js";
import type { CatalogPageRequest, CatalogStorePage } from "../catalogPagination.js";
import { storageRuntime } from "../storageRuntime.js";
import {
  ConnectionNotFoundError,
  ConnectionStore,
  type Connection,
  type ConnectionTool,
  type CreateConnectionInput,
  type UpdateConnectionPatch,
} from "./store.js";
import {
  connectionAuthorizationReference,
  connectionSecrets,
  ConnectionCustodyUnavailableError,
  FileConnectionSecretStore,
  FileKeyCustody,
  type ConnectionSecrets,
  type ConnectionSecretStore,
} from "./secrets.js";

/**
 * Application service for Connected agents.
 *
 * It is the only place that meets the connection ledger, secret custody, and
 * the MCP transport seam. Public DTOs are assembled here and are structurally
 * incapable of carrying credential material: credentials cross only from the
 * request body into custody or from custody into a transport target.
 *
 * Discovery/test operations are bounded by a fixed deadline (the spec's
 * 15 seconds) and an abort signal; a timed-out probe records the bounded
 * status but never trusts a late transport result.
 */

export const DEFAULT_CONNECTION_OPERATION_TIMEOUT_MS = CONNECTION_TRANSPORT_TIMEOUT_MS;

export type CredentialState = "none" | "stored" | "unavailable";

export interface ConnectionDto {
  readonly id: string;
  readonly name: string;
  readonly kind: Connection["kind"];
  readonly revision: number;
  readonly discovery_revision: number;
  readonly enabled: boolean;
  readonly status: Connection["status"];
  readonly status_code: string | null;
  readonly config: Connection["config"];
  readonly credential_state: CredentialState;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ConnectionDetailDto extends ConnectionDto {
  readonly tools: readonly ConnectionTool[];
}

export class ConnectionDisabledError extends Error {
  readonly code = "CONNECTION_DISABLED";
  readonly statusCode = 409;

  constructor() {
    super("the connection is disabled");
    this.name = "ConnectionDisabledError";
  }
}

export class ConnectionOperationTimeoutError extends Error {
  readonly code = "CONNECTION_TIMEOUT";
  readonly statusCode = 504;

  constructor() {
    super("the connection operation timed out");
    this.name = "ConnectionOperationTimeoutError";
  }
}

/**
 * Stage-3 authorization composition. The seam interface (owned here since
 * stage 1) is now implemented by the real PKCE OAuth manager in
 * `server/src/mcp/oauth.ts`. `registerConnectionAuthorizationProvider`
 * remains the explicit override seam: tests register deterministic
 * providers, and stage-5 desktop composition registers the main-process
 * custody/callback variant. `undefined` restores the default: a
 * per-service `ConnectionOAuthManager` bound to this service's custody and
 * status stores.
 */
export type { ConnectionAuthorization, ConnectionAuthorizationProvider };
export { ConnectionAuthUnsupportedError };

let authorizationProvider: ConnectionAuthorizationProvider | undefined;

/** Explicit override seam; `undefined` restores the default OAuth manager. */
export function registerConnectionAuthorizationProvider(provider: ConnectionAuthorizationProvider | undefined): void {
  authorizationProvider = provider;
}

export interface ConnectionServiceOptions {
  /** Resolves the ledger store; defaults to the active storage runtime's. */
  readonly store?: () => ConnectionStore;
  /** Resolves secret custody; defaults to the browser-development file store. */
  readonly secrets?: () => ConnectionSecretStore;
  /** Resolves the transport provider; defaults to the `mcp/client` accessor. */
  readonly transport?: () => McpTransportProvider;
  readonly operationTimeoutMs?: number;
  /**
   * Test seam for the fixed one-use authorize session window; production
   * uses the spec's 5-minute default.
   */
  readonly authorizationSessionTtlMs?: number;
}

export interface ConnectionCreateInput extends CreateConnectionInput {
  readonly credentials?: unknown;
}

export interface ConnectionUpdateInput extends Partial<Omit<UpdateConnectionPatch, "expected_revision">> {
  readonly expected_revision: number;
  /** `null` explicitly removes stored credentials; an object replaces them. */
  readonly credentials?: unknown | null;
}

function defaultSecretsStore(): ConnectionSecretStore {
  const directory = path.resolve(config.connectionSecretsDir);
  return new FileConnectionSecretStore({
    directory,
    custody: new FileKeyCustody(path.resolve(config.connectionsKeyFile)),
  });
}

export class ConnectionService {
  constructor(private readonly options: ConnectionServiceOptions = {}) {}

  #defaultOAuth: ConnectionOAuthManager | undefined;

  private get store(): ConnectionStore {
    return this.options.store ? this.options.store() : storageRuntime().connections;
  }

  private get secrets(): ConnectionSecretStore {
    return this.options.secrets ? this.options.secrets() : defaultSecretsStore();
  }

  private get transport(): McpTransportProvider {
    return this.options.transport ? this.options.transport() : mcpTransportProvider();
  }

  /**
   * The active sign-in provider: an explicit registration always wins (test
   * determinism, desktop custody); otherwise a lazily built manager bound
   * to exactly this service's custody and durable-status stores.
   */
  private authorization(): ConnectionAuthorizationProvider {
    if (authorizationProvider) return authorizationProvider;
    this.#defaultOAuth ??= createConnectionOAuthManager({
      secrets: () => this.secrets,
      recordStatus: (accountId, connectionId, status, code) =>
        this.store.recordStatus(accountId, connectionId, status, code),
      sessionTtlMs: this.options.authorizationSessionTtlMs,
    });
    return this.#defaultOAuth;
  }

  /** Cancel pending sign-in sessions owned by this service (close path). */
  shutdownAuthorizations(): void {
    this.#defaultOAuth?.shutdown();
  }

  async list(accountId: string, page: CatalogPageRequest): Promise<CatalogStorePage<ConnectionDto>> {
    const ledger = await this.store.listConnections(accountId, page);
    const items: ConnectionDto[] = [];
    for (const connection of ledger.items) {
      items.push(await this.toDto(accountId, connection));
    }
    return { items, next: ledger.next };
  }

  async create(accountId: string, input: ConnectionCreateInput): Promise<ConnectionDetailDto> {
    const credentials = input.credentials === undefined ? undefined : connectionSecrets(input.credentials);
    const connection = await this.store.createConnection(accountId, {
      name: input.name,
      kind: input.kind,
      config: input.config,
      enabled: input.enabled,
    });
    if (credentials) {
      try {
        await this.secrets.put(accountId, connection.id, credentials);
      } catch (error) {
        // Compensation: a connection whose credentials could not reach
        // custody must not exist half-configured.
        await this.store.deleteConnection(accountId, connection.id).catch(() => false);
        throw error;
      }
    }
    return this.detail(accountId, connection);
  }

  async get(accountId: string, connectionId: string): Promise<ConnectionDetailDto> {
    return this.detail(accountId, await this.store.requireConnection(accountId, connectionId));
  }

  async update(accountId: string, connectionId: string, patch: ConnectionUpdateInput): Promise<ConnectionDetailDto> {
    const replacement =
      patch.credentials === null
        ? null
        : patch.credentials === undefined
          ? undefined
          : connectionSecrets(patch.credentials);
    const connection = await this.store.updateConnection(accountId, connectionId, {
      expected_revision: patch.expected_revision,
      name: patch.name,
      config: patch.config,
      enabled: patch.enabled,
    });
    // Credential mutations are applied only after the revision-checked edit
    // commits, so a stale edit never silently rewrites custody state.
    if (replacement === null) {
      await this.secrets.remove(accountId, connectionId);
    } else if (replacement) {
      await this.secrets.put(accountId, connectionId, replacement);
    }
    return this.detail(accountId, connection);
  }

  async remove(accountId: string, connectionId: string): Promise<void> {
    await this.store.requireConnection(accountId, connectionId);
    const deleted = await this.store.deleteConnection(accountId, connectionId);
    if (!deleted) throw new ConnectionNotFoundError();
    // Custody cleanup is post-commit best effort: a leaked ciphertext record
    // is never plaintext, and startup reconciliation (stage 3) sweeps orphans.
    await this.secrets.remove(accountId, connectionId).catch(() => undefined);
  }

  async test(accountId: string, connectionId: string): Promise<ConnectionDto> {
    await this.probe(accountId, connectionId);
    const connection = await this.store.requireConnection(accountId, connectionId);
    return this.toDto(accountId, connection);
  }

  async discover(accountId: string, connectionId: string): Promise<ConnectionDetailDto> {
    const tools = await this.probe(accountId, connectionId);
    try {
      await this.store.publishDiscovery(
        accountId,
        connectionId,
        tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema }))
      );
    } catch (error) {
      await this.store
        .recordStatus(
          accountId,
          connectionId,
          "error",
          error instanceof Error && typeof (error as unknown as { code?: unknown }).code === "string"
            ? String((error as unknown as { code: string }).code).slice(0, 64)
            : "CONNECTION_DISCOVERY_INVALID"
        )
        .catch(() => undefined);
      throw error;
    }
    return this.get(accountId, connectionId);
  }

  /**
   * Starts one expiring one-use sign-in session and returns the validated
   * sign-in URL. Discovery/registration failures surface as actionable
   * `CONNECTION_AUTH_UNSUPPORTED`/`CONNECTION_AUTH_DISCOVERY_FAILED` codes;
   * a fake success is impossible.
   */
  async authorize(accountId: string, connectionId: string): Promise<ConnectionAuthorization> {
    const connection = await this.store.requireConnection(accountId, connectionId);
    if (!connection.enabled) throw new ConnectionDisabledError();
    const provider = this.authorization();
    return this.withTimeout((signal) => provider.start(accountId, connection, signal));
  }

  /** Revokes local credentials and disconnects; provider revocation is best effort. */
  async revoke(accountId: string, connectionId: string): Promise<ConnectionDto> {
    const connection = await this.store.requireConnection(accountId, connectionId);
    let secretMaterial: ConnectionSecrets | undefined;
    try {
      const read = await this.secrets.read(accountId, connectionId);
      if (read.state === "available") secretMaterial = read.secrets;
    } catch {
      secretMaterial = undefined;
    }
    // Local-first: custody is removed before any provider round-trip.
    await this.secrets.remove(accountId, connectionId).catch(() => undefined);
    const provider = this.authorization();
    if (provider.revoke) {
      await this.withTimeout((signal) => provider.revoke!(accountId, connection, secretMaterial, signal)).catch(
        () => undefined
      );
    }
    await this.store.recordStatus(accountId, connectionId, "disconnected", null);
    return this.toDto(accountId, await this.store.requireConnection(accountId, connectionId));
  }

  /**
   * The non-secret custody authorization reference for one connection
   * (`absent` / `unavailable:*` / `oauth:<digest>` / `secret:<digest>`).
   * Turn acceptance records this value — never a token — and every MCP tool
   * dispatch re-derives it from live custody and refuses the call on drift.
   * A custody read failure reports the actionable unavailable reference
   * rather than throwing out of the acceptance path.
   */
  async authorizationReference(accountId: string, connectionId: string): Promise<string> {
    try {
      return connectionAuthorizationReference(await this.secrets.read(accountId, connectionId));
    } catch {
      return "unavailable:custody";
    }
  }

  /**
   * One durable-turn MCP tool dispatch (Connected agents stage 4). The
   * caller passes the frozen descriptor and the authorization reference
   * captured at acceptance; this is the enforcement point re-checked before
   * every call: the connection must still exist and be enabled, and live
   * custody must still yield the same non-secret grant identity. Revocation,
   * removal, or credential replacement therefore blocks the next call while
   * a serialized token refresh (volatile entries excluded from the
   * reference) keeps the same authorized grant working. Credential
   * attachment mirrors the probe exactly: static custody material plus a
   * fresh-or-renewed bearer for sign-in targets, bound to the validated
   * endpoint and never retargeted. Execution uses the frozen schema with the
   * 30-second deadline tightened to the caller's remaining run budget.
   */
  async callToolForTurn(
    call: {
      readonly accountId: string;
      readonly connectionId: string;
      readonly expectedAuthorizationReference: string;
      readonly toolName: string;
      readonly inputSchema: unknown;
      readonly arguments: Record<string, unknown>;
    },
    options: { readonly signal?: AbortSignal; readonly deadlineMs?: number } = {}
  ): Promise<McpToolCallOutcome> {
    const connection = await this.store.getConnection(call.accountId, call.connectionId);
    if (!connection) throw new ConnectionNotFoundError();
    if (!connection.enabled) throw new ConnectionDisabledError();
    let staticSecrets: ConnectionSecrets | undefined;
    try {
      const read = await this.secrets.read(call.accountId, call.connectionId);
      const current = connectionAuthorizationReference(read);
      if (current !== call.expectedAuthorizationReference) {
        // Any custody drift blocks this call fail-closed; the recorded code
        // names the actionable state for the connection panel.
        const driftCode = current.startsWith("unavailable:")
          ? "CONNECTION_CUSTODY_UNAVAILABLE"
          : current === "absent"
            ? "CONNECTION_AUTH_REQUIRED"
            : CONNECTION_AUTH_REFRESH_FAILED;
        await this.recordDisconnected(call.accountId, call.connectionId, driftCode).catch(() => undefined);
        if (driftCode === "CONNECTION_CUSTODY_UNAVAILABLE") throw new ConnectionCustodyUnavailableError();
        if (driftCode === "CONNECTION_AUTH_REQUIRED") throw new McpTransportAuthError();
        throw new ConnectionAuthRefreshFailedError();
      }
      if (read.state === "available") staticSecrets = read.secrets;
    } catch (error) {
      // A custody store that throws outright is an unavailable custody state.
      if (
        !(
          error instanceof ConnectionCustodyUnavailableError ||
          error instanceof McpTransportAuthError ||
          error instanceof ConnectionAuthRefreshFailedError
        )
      ) {
        await this.recordDisconnected(call.accountId, call.connectionId, "CONNECTION_CUSTODY_UNAVAILABLE").catch(
          () => undefined
        );
        throw new ConnectionCustodyUnavailableError();
      }
      throw error;
    }
    const request: McpToolCallRequest = {
      name: call.toolName,
      input_schema: call.inputSchema,
      arguments: call.arguments,
    };
    const signal = options.signal ?? new AbortController().signal;
    try {
      // Same rule as the probe: resolve a fresh-or-renewed bearer bound to
      // this exact endpoint before attaching it to the transport target.
      let secretsForTarget = staticSecrets;
      const bearer = await this.authorization().accessTokenFor?.({
        accountId: call.accountId,
        connection,
        secrets: secretsForTarget,
        signal,
      });
      if (bearer !== undefined) {
        secretsForTarget = Object.freeze({
          headers: Object.freeze({ ...(secretsForTarget?.headers ?? {}), authorization: `Bearer ${bearer}` }),
          env: Object.freeze({ ...(secretsForTarget?.env ?? {}) }),
        });
      }
      const target: McpTransportTarget = {
        accountId: call.accountId,
        connectionId: call.connectionId,
        kind: connection.kind,
        config: connection.config,
        secrets: secretsForTarget,
      };
      return await callMcpTool(target, request, {
        signal,
        deadlineMs: Math.max(1, Math.min(options.deadlineMs ?? MCP_TOOL_CALL_TIMEOUT_MS, MCP_TOOL_CALL_TIMEOUT_MS)),
      });
    } catch (error) {
      const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
      // A live 401 or an un-renewable sign-in is an actionable disconnected
      // state recorded exactly like the probe's evidence.
      if (code === "CONNECTION_AUTH_REQUIRED" || code === CONNECTION_AUTH_REFRESH_FAILED) {
        await this.recordDisconnected(call.accountId, call.connectionId, code).catch(() => undefined);
      }
      throw error;
    }
  }

  private async recordDisconnected(
    accountId: string,
    connectionId: string,
    code: "CONNECTION_AUTH_REQUIRED" | "CONNECTION_AUTH_REFRESH_FAILED" | "CONNECTION_CUSTODY_UNAVAILABLE"
  ): Promise<void> {
    await this.store.recordStatus(accountId, connectionId, "disconnected", code);
  }

  /**
   * One bounded initialize/list-tools probe. Test and discovery share it so
   * neither surface can issue a content-bearing call. No network work runs
   * inside a SQLite transaction; status updates happen after the probe.
   */
  private async probe(accountId: string, connectionId: string): Promise<McpToolDescriptor[]> {
    const connection = await this.store.requireConnection(accountId, connectionId);
    if (!connection.enabled) throw new ConnectionDisabledError();
    const read = await this.secrets.read(accountId, connectionId);
    if (read.state === "unavailable") {
      // Actionable disconnected state rather than a crash or a silent probe.
      await this.store.recordStatus(accountId, connectionId, "disconnected", "CONNECTION_CUSTODY_UNAVAILABLE");
      throw new ConnectionCustodyUnavailableError();
    }
    const staticSecrets = read.state === "available" ? read.secrets : undefined;
    try {
      const tools = await this.withTimeout(async (signal) => {
        // The sign-in provider (when this target carries sign-in material)
        // resolves a fresh-or-refreshed bearer bound to this exact endpoint;
        // it may renew the same authorized target but never retarget it.
        let secretsForTarget = staticSecrets;
        const bearer = await this.authorization().accessTokenFor?.({
          accountId,
          connection,
          secrets: secretsForTarget,
          signal,
        });
        if (bearer !== undefined) {
          secretsForTarget = Object.freeze({
            headers: Object.freeze({ ...(secretsForTarget?.headers ?? {}), authorization: `Bearer ${bearer}` }),
            env: Object.freeze({ ...(secretsForTarget?.env ?? {}) }),
          });
        }
        const target: McpTransportTarget = {
          accountId,
          connectionId,
          kind: connection.kind,
          config: connection.config,
          secrets: secretsForTarget,
        };
        const session = await this.transport.connect(target, signal);
        try {
          return await session.listTools(signal);
        } finally {
          await session.close().catch(() => undefined);
        }
      });
      await this.store.recordStatus(accountId, connectionId, "ready", null);
      return tools;
    } catch (error) {
      const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
      if (error instanceof ConnectionOperationTimeoutError) {
        await this.store.recordStatus(accountId, connectionId, "error", "CONNECTION_TIMEOUT").catch(() => undefined);
      } else if (code === "CONNECTION_TRANSPORT_UNAVAILABLE") {
        // Server-side wiring gap; it is not evidence about the endpoint.
      } else if (code === "CONNECTION_AUTH_REQUIRED" || code === CONNECTION_AUTH_REFRESH_FAILED) {
        // Either the endpoint demands sign-in this connection lacks, or the
        // stored sign-in could not be renewed (revocation, provider logout,
        // expiry, rotation reuse). Both are actionable disconnected states.
        await this.store.recordStatus(accountId, connectionId, "disconnected", String(code)).catch(() => undefined);
      } else {
        // Preserve the probe's own stable CONNECTION_* evidence (for example
        // an explicit over-limit discovery); anything anonymous remains a
        // generic handshake failure.
        const rawCode = error instanceof Error ? (error as { code?: unknown }).code : undefined;
        const statusCode =
          typeof rawCode === "string" && rawCode.startsWith("CONNECTION_")
            ? rawCode.slice(0, 64)
            : "CONNECTION_HANDSHAKE_FAILED";
        await this.store.recordStatus(accountId, connectionId, "error", statusCode).catch(() => undefined);
      }
      throw error;
    }
  }

  private withTimeout<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeoutMs = this.options.operationTimeoutMs ?? DEFAULT_CONNECTION_OPERATION_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ConnectionOperationTimeoutError());
      }, timeoutMs);
      timer.unref?.();
    });
    const running = work(controller.signal);
    return Promise.race([running, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
      // Abort after the race settles so a late transport result can never
      // outlive the caller's deadline.
      controller.abort();
    });
  }

  private async toDto(accountId: string, connection: Connection): Promise<ConnectionDto> {
    const credentialState = await this.credentialState(accountId, connection.id);
    return Object.freeze({ ...connection, credential_state: credentialState });
  }

  private async detail(accountId: string, connection: Connection): Promise<ConnectionDetailDto> {
    const tools = await this.store.listTools(accountId, connection.id);
    return Object.freeze({ ...(await this.toDto(accountId, connection)), tools });
  }

  private async credentialState(accountId: string, connectionId: string): Promise<CredentialState> {
    try {
      const read = await this.secrets.read(accountId, connectionId);
      return read.state === "absent" ? "none" : read.state === "available" ? "stored" : "unavailable";
    } catch {
      return "unavailable";
    }
  }
}

let configured: ConnectionServiceOptions = {};
let active: ConnectionService | undefined;

/**
 * Composition seam for tests and platform wiring (desktop key custody, the
 * stage-2 SDK transport default). Production browser development relies on
 * the lazy defaults, which touch durable paths only when a credential or
 * transport operation actually needs them.
 */
export function configureConnectionService(options: ConnectionServiceOptions = {}): void {
  configured = options;
  active = undefined;
}

export function connectionService(): ConnectionService {
  active ??= new ConnectionService(configured);
  return active;
}
/**
 * The shared connection credential custody surface. M14 WebDAV knowledge
 * connections reuse this exact store (keyed by account/connection); no
 * second secret mechanism may be introduced. Desktop custody overrides
 * registered through `configureConnectionService` apply to every surface.
 */
export function connectionSecretStore(): ConnectionSecretStore {
  return configured.secrets ? configured.secrets() : defaultSecretsStore();
}

/**
 * Drops the composed service, cancels its pending sign-in sessions, and
 * releases the loopback callback listener. Custody/transport singletons are
 * restored by their own seams.
 */
export function closeConnectionService(): void {
  active?.shutdownAuthorizations();
  active = undefined;
  configured = {};
  void closeOAuthCallbackListener().catch(() => undefined);
}
