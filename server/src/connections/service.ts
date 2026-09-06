import path from "node:path";
import { config } from "../config.js";
import { CONNECTION_TRANSPORT_TIMEOUT_MS, mcpTransportProvider } from "../mcp/client.js";
import type { McpToolDescriptor, McpTransportProvider, McpTransportTarget } from "../mcp/client.js";
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
 * Stage-3 OAuth seam. Until the authorization provider lands, `authorize`
 * reports an actionable unsupported state; it is never a fake success.
 * Revoke is fully local in stage 1 (remove custody material + disconnect)
 * and gains best-effort provider-side revocation when stage 3 injects the
 * optional `revoke` hook.
 */
export interface ConnectionAuthorization {
  readonly authorize_url: string;
  readonly expires_at: string;
}

export interface ConnectionAuthorizationProvider {
  start(accountId: string, connection: Connection, signal: AbortSignal): Promise<ConnectionAuthorization>;
  revoke?(
    accountId: string,
    connection: Connection,
    secrets: ConnectionSecrets | undefined,
    signal: AbortSignal
  ): Promise<void>;
}

export class ConnectionAuthUnsupportedError extends Error {
  readonly code = "CONNECTION_AUTH_UNSUPPORTED";
  readonly statusCode = 501;

  constructor() {
    super("connection sign-in is not available for this connection");
    this.name = "ConnectionAuthUnsupportedError";
  }
}

const UNSUPPORTED_AUTHORIZATION: ConnectionAuthorizationProvider = Object.freeze({
  start: async (): Promise<ConnectionAuthorization> => {
    throw new ConnectionAuthUnsupportedError();
  },
});

let authorizationProvider: ConnectionAuthorizationProvider | undefined;

/** Stage-3 composition seam; production wiring registers the OAuth provider. */
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

  private get store(): ConnectionStore {
    return this.options.store ? this.options.store() : storageRuntime().connections;
  }

  private get secrets(): ConnectionSecretStore {
    return this.options.secrets ? this.options.secrets() : defaultSecretsStore();
  }

  private get transport(): McpTransportProvider {
    return this.options.transport ? this.options.transport() : mcpTransportProvider();
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

  async authorize(accountId: string, connectionId: string): Promise<ConnectionAuthorization> {
    const connection = await this.store.requireConnection(accountId, connectionId);
    if (!connection.enabled) throw new ConnectionDisabledError();
    const provider = authorizationProvider ?? UNSUPPORTED_AUTHORIZATION;
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
    await this.secrets.remove(accountId, connectionId).catch(() => undefined);
    if (authorizationProvider?.revoke) {
      await this.withTimeout((signal) =>
        authorizationProvider!.revoke!(accountId, connection, secretMaterial, signal)
      ).catch(() => undefined);
    }
    await this.store.recordStatus(accountId, connectionId, "disconnected", null);
    return this.toDto(accountId, await this.store.requireConnection(accountId, connectionId));
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
    const target: McpTransportTarget = {
      accountId,
      connectionId,
      kind: connection.kind,
      config: connection.config,
      secrets: read.state === "available" ? read.secrets : undefined,
    };
    try {
      const tools = await this.withTimeout(async (signal) => {
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
      if (error instanceof ConnectionOperationTimeoutError) {
        await this.store.recordStatus(accountId, connectionId, "error", "CONNECTION_TIMEOUT").catch(() => undefined);
      } else if (error instanceof Error && (error as { code?: unknown }).code === "CONNECTION_TRANSPORT_UNAVAILABLE") {
        // Server-side wiring gap; it is not evidence about the endpoint.
      } else if (error instanceof Error && (error as { code?: unknown }).code === "CONNECTION_AUTH_REQUIRED") {
        await this.store
          .recordStatus(accountId, connectionId, "disconnected", "CONNECTION_AUTH_REQUIRED")
          .catch(() => undefined);
      } else {
        await this.store
          .recordStatus(accountId, connectionId, "error", "CONNECTION_HANDSHAKE_FAILED")
          .catch(() => undefined);
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

/** Drops the composed service; custody/transport singletons are restored by their own seams. */
export function closeConnectionService(): void {
  active = undefined;
  configured = {};
}
