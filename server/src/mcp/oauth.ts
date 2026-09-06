import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ConnectionCustodyUnavailableError,
  OAUTH_ENV_PREFIX,
  connectionSecrets,
  type ConnectionSecrets,
  type ConnectionSecretStore,
} from "../connections/secrets.js";
import { ConnectionConfigError, type Connection, type ConnectionStatus } from "../connections/store.js";
import { pinnedNodeRequest, resolveConnectionDestination, toWebResponse } from "./client.js";
import {
  OAUTH_CALLBACK_SESSION_TTL_MS,
  newOAuthState,
  oauthCallbackHost,
  type OAuthCallbackHandle,
  type OAuthCallbackOutcome,
} from "./oauthCallback.js";

/**
 * MCP connection sign-in: authorization-code flow with PKCE (stage 3).
 *
 * Built on the pinned `@modelcontextprotocol/sdk` (1.30.0) client auth layer
 * — the `client/auth.js` primitives `discoverOAuthProtectedResourceMetadata`,
 * `discoverAuthorizationServerMetadata`, `registerClient`,
 * `startAuthorization`, `exchangeAuthorization`, and `refreshAuthorization`.
 * The SDK's interactive `auth()` orchestrator assumes the application
 * redirect-loops through its transport; Borealis instead owns an expiring
 * one-use state and a backend loopback listener (`mcp/oauthCallback.ts`), so
 * the primitives are driven directly and every token crosses only custody.
 *
 * Invariants proven by `mcpOAuth.test.ts` against the committed issuer
 * fixture (`scripts/e2e/fixtures/oauth-issuer.mjs`):
 * - one-use, expiring state (5 minutes) and S256 PKCE on every flow;
 * - RFC 8707 resource binding: the sign-in and every token request name the
 *   exact MCP endpoint, and stored material is bound to the issuer, client,
 *   redirect, and resource that minted it. Credential refresh may renew the
 *   same authorized target — it can never retarget: material whose stored
 *   resource differs from the connection's current endpoint is never
 *   attached or refreshed against the new endpoint.
 * - configured client registration (client id/secret already in custody) is
 *   honored first; otherwise RFC 7591 dynamic registration is used when the
 *   issuer advertises it. An issuer that supports neither, that lacks S256
 *   or the code/refresh grants, or whose metadata is unreachable, yields an
 *   actionable `CONNECTION_AUTH_UNSUPPORTED`/`CONNECTION_AUTH_DISCOVERY_FAILED`
 *   error — never a fake success.
 * - refresh is serialized per connection (exactly one rotation in flight);
 *   a failed refresh (revocation, provider logout, rotation reuse, expiry)
 *   clears the dead token material and records the actionable disconnected
 *   state. Expired tokens are never (re)persisted.
 * - Tokens, client secrets, and every other credential live only in the
 *   account/connection-scoped secret store. They never enter SQLite rows,
 *   agent revisions, or run metadata.
 *
 * Durable observable states recorded through the service-supplied status
 * sink (`connections.status`/`status_code`):
 *
 * | event                            | status       | status_code                     |
 * | authorize session expires        | disconnected | CONNECTION_AUTH_SESSION_EXPIRED |
 * | user denies at the issuer        | disconnected | CONNECTION_AUTH_DENIED          |
 * | callback replay of a used state  | disconnected | CONNECTION_AUTH_REPLAY_DETECTED |
 * | code exchange fails              | disconnected | CONNECTION_AUTH_FAILED          |
 * | tokens issued (sign-in complete) | untested     | null                            |
 * | refresh fails / provider logout  | disconnected | CONNECTION_AUTH_REFRESH_FAILED  |
 */

/** Refresh this many seconds before the stored absolute expiry. */
const REFRESH_LEEWAY_SECONDS = 30;
/** Per-request bound for every issuer metadata/token/registration call. */
const OAUTH_REQUEST_TIMEOUT_MS = 10_000;

export const OAUTH_ENV = Object.freeze({
  clientId: `${OAUTH_ENV_PREFIX}CLIENT_ID`,
  clientSecret: `${OAUTH_ENV_PREFIX}CLIENT_SECRET`,
  clientSource: `${OAUTH_ENV_PREFIX}CLIENT_SOURCE`,
  redirectUri: `${OAUTH_ENV_PREFIX}REDIRECT_URI`,
  issuer: `${OAUTH_ENV_PREFIX}ISSUER`,
  resource: `${OAUTH_ENV_PREFIX}RESOURCE`,
  accessToken: `${OAUTH_ENV_PREFIX}ACCESS_TOKEN`,
  refreshToken: `${OAUTH_ENV_PREFIX}REFRESH_TOKEN`,
  accessExpiresAt: `${OAUTH_ENV_PREFIX}ACCESS_EXPIRES_AT`,
});

/** Durable status codes owned by the sign-in lifecycle. */
export const CONNECTION_AUTH_SESSION_EXPIRED = "CONNECTION_AUTH_SESSION_EXPIRED";
export const CONNECTION_AUTH_DENIED = "CONNECTION_AUTH_DENIED";
export const CONNECTION_AUTH_REPLAY_DETECTED = "CONNECTION_AUTH_REPLAY_DETECTED";
export const CONNECTION_AUTH_FAILED = "CONNECTION_AUTH_FAILED";
export const CONNECTION_AUTH_REFRESH_FAILED = "CONNECTION_AUTH_REFRESH_FAILED";

/** Sign-in is not available for this connection (stdio kind, unsupported issuer). */
export class ConnectionAuthUnsupportedError extends Error {
  readonly code = "CONNECTION_AUTH_UNSUPPORTED";
  readonly statusCode = 501;

  constructor(message = "connection sign-in is not available for this connection") {
    super(message);
    this.name = "ConnectionAuthUnsupportedError";
  }
}

/** The authorization server metadata could not be reached or parsed. */
export class ConnectionAuthDiscoveryError extends Error {
  readonly code = "CONNECTION_AUTH_DISCOVERY_FAILED";
  readonly statusCode = 502;

  constructor() {
    super("the connection's authorization server could not be reached");
    this.name = "ConnectionAuthDiscoveryError";
  }
}

/** A required token refresh failed; sign-in is needed again. */
export class ConnectionAuthRefreshFailedError extends Error {
  readonly code = CONNECTION_AUTH_REFRESH_FAILED;
  readonly statusCode = 409;

  constructor() {
    super("the connection's stored sign-in could not be renewed");
    this.name = "ConnectionAuthRefreshFailedError";
  }
}

/** Internal: transport-level failure while talking to an issuer endpoint. */
class OAuthTransportError extends Error {
  constructor(cause: unknown) {
    super(`oauth issuer unreachable: ${cause instanceof Error ? cause.name : "error"}`);
    this.name = "OAuthTransportError";
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ABORT_ERR")
  );
}

/** Origin+path identity (query/fragment excluded) for resource binding. */
function sameEndpoint(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return (
      left.protocol === right.protocol &&
      left.hostname === right.hostname &&
      left.port === right.port &&
      left.pathname === right.pathname &&
      left.search === "" &&
      left.hash === "" &&
      right.search === "" &&
      right.hash === ""
    );
  } catch {
    return false;
  }
}

/**
 * The connection-boundary fetch for issuer endpoints: every socket is pinned
 * to the first validated DNS answer through the same resolver the MCP
 * transport uses (HTTPS anywhere as an intentional outbound capability,
 * plain HTTP only for loopback/`.local` development targets), redirects are
 * never followed, response bodies reuse the transport byte cap, and every
 * request is deadline bounded. A `3xx` therefore surfaces to the SDK
 * primitives as a failed token/metadata request instead of a silent
 * destination change.
 */
export function createOAuthFetch(signal?: AbortSignal): FetchLike {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    let target: URL;
    try {
      target = typeof url === "string" ? new URL(url) : url;
    } catch {
      throw new ConnectionAuthDiscoveryError();
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") throw new ConnectionAuthDiscoveryError();
    const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) init.headers.forEach((value, name) => (headers[name] = value));
      else if (Array.isArray(init.headers)) init.headers.forEach(([name, value]) => (headers[name] = value));
      else Object.assign(headers, init.headers);
    }
    let body: Buffer | undefined;
    const rawBody = init?.body;
    if (typeof rawBody === "string") body = Buffer.from(rawBody, "utf8");
    else if (rawBody instanceof URLSearchParams) {
      body = Buffer.from(rawBody.toString(), "utf8");
      if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/x-www-form-urlencoded";
      }
    } else if (rawBody !== undefined && rawBody !== null) {
      throw new ConnectionAuthDiscoveryError();
    }
    const method = (init?.method ?? "GET").toUpperCase();
    let addresses;
    try {
      addresses = await resolveConnectionDestination(target, requestSignal);
    } catch (error) {
      if (error instanceof ConnectionConfigError || isAbortError(error)) throw error;
      throw new ConnectionAuthDiscoveryError();
    }
    try {
      const message = await pinnedNodeRequest(target, addresses[0], method, headers, body, requestSignal);
      return toWebResponse(message);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new OAuthTransportError(error);
    }
  };
}

interface IssuerContext {
  readonly issuer: string;
  readonly metadata: AuthorizationServerMetadata;
  readonly resource: string;
  readonly registrationEndpoint?: string;
  readonly revocationEndpoint?: string;
}

function hasList(value: readonly string[] | undefined, wanted: string): boolean {
  return Array.isArray(value) && value.includes(wanted);
}

/**
 * Fail-closed issuer validation: only authorization-code + S256 PKCE +
 * refresh-capable issuers are sign-in-capable, and an unsupported shape must
 * read as an actionable setup problem, never as a partial success.
 */
function validatedIssuerContext(
  issuer: string,
  metadata: AuthorizationServerMetadata | undefined,
  resource: string
): IssuerContext {
  if (!metadata || typeof metadata.issuer !== "string") throw new ConnectionAuthUnsupportedError();
  if (!hasList(metadata.response_types_supported, "code")) throw new ConnectionAuthUnsupportedError();
  if (!hasList(metadata.code_challenge_methods_supported, "S256")) throw new ConnectionAuthUnsupportedError();
  if (
    metadata.grant_types_supported !== undefined &&
    (!hasList(metadata.grant_types_supported, "authorization_code") ||
      !hasList(metadata.grant_types_supported, "refresh_token"))
  ) {
    throw new ConnectionAuthUnsupportedError();
  }
  if (typeof metadata.authorization_endpoint !== "string" || typeof metadata.token_endpoint !== "string") {
    throw new ConnectionAuthUnsupportedError();
  }
  try {
    new URL(issuer);
    new URL(metadata.issuer);
    new URL(metadata.authorization_endpoint);
    new URL(metadata.token_endpoint);
  } catch {
    throw new ConnectionAuthUnsupportedError();
  }
  if (!sameEndpoint(metadata.issuer, issuer)) throw new ConnectionAuthUnsupportedError();
  // RFC 8414 carries `revocation_endpoint`; the OIDC-discovery variant of
  // the SDK metadata union never declares it, so it is read defensively.
  const revocation = (metadata as { revocation_endpoint?: unknown }).revocation_endpoint;
  return {
    issuer: metadata.issuer,
    metadata,
    resource,
    registrationEndpoint:
      typeof metadata.registration_endpoint === "string" ? metadata.registration_endpoint : undefined,
    revocationEndpoint: typeof revocation === "string" ? revocation : undefined,
  };
}

/**
 * RFC 9728 → RFC 8414 discovery for an MCP endpoint. A protected-resource
 * document naming an authorization server is authoritative; with none, the
 * endpoint origin is probed once as a legacy co-located authorization
 * server. Unreachable endpoints and unsupported shapes are distinguished so
 * the caller records the right actionable code.
 */
async function discoverIssuer(endpoint: string, fetchFn: FetchLike): Promise<IssuerContext> {
  const endpointUrl = new URL(endpoint);
  const canonicalResource = `${endpointUrl.origin}${endpointUrl.pathname}`;
  let issuerCandidate: string | undefined;
  let resource = canonicalResource;
  try {
    const prm = await discoverOAuthProtectedResourceMetadata(endpointUrl, {}, fetchFn);
    if (prm.resource) {
      // A mismatched audience advertisement is refused rather than guessed.
      if (!sameEndpoint(prm.resource, endpoint)) throw new ConnectionAuthUnsupportedError();
      const resourceUrl = new URL(prm.resource);
      resource = `${resourceUrl.origin}${resourceUrl.pathname}`;
    }
    const servers = Array.isArray(prm.authorization_servers) ? prm.authorization_servers : [];
    if (servers.length === 0) throw new ConnectionAuthUnsupportedError();
    issuerCandidate = servers[0];
  } catch (error) {
    if (error instanceof ConnectionAuthUnsupportedError) throw error;
    if (error instanceof OAuthTransportError || isAbortError(error) || error instanceof ConnectionConfigError) {
      throw new ConnectionAuthDiscoveryError();
    }
    // No (usable) protected-resource metadata: legacy fallback — treat the
    // endpoint origin itself as a co-located authorization server.
    issuerCandidate = `${endpointUrl.origin}/`;
  }
  let metadata: AuthorizationServerMetadata | undefined;
  try {
    metadata = await discoverAuthorizationServerMetadata(new URL(issuerCandidate), { fetchFn });
  } catch (error) {
    if (error instanceof OAuthTransportError || isAbortError(error)) throw new ConnectionAuthDiscoveryError();
    // A non-4xx metadata failure is an unreachable/broken issuer.
    throw new ConnectionAuthDiscoveryError();
  }
  if (!metadata) throw new ConnectionAuthUnsupportedError();
  return validatedIssuerContext(issuerCandidate, metadata, resource);
}

interface PendingFlow {
  readonly accountId: string;
  readonly connectionId: string;
  readonly state: string;
  readonly verifier: string;
  readonly ctx: IssuerContext;
  readonly clientInformation: OAuthClientInformationMixed;
  readonly redirectUri: string;
  readonly expiresAtMs: number;
  handle: OAuthCallbackHandle | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
}

/** Returned by `POST /api/connections/:id/authorize`. */
export interface ConnectionAuthorization {
  readonly authorize_url: string;
  readonly expires_at: string;
}

/** The stage-1 seam implemented by `ConnectionOAuthManager`. */
export interface ConnectionAuthorizationProvider {
  start(accountId: string, connection: Connection, signal: AbortSignal): Promise<ConnectionAuthorization>;
  revoke?(
    accountId: string,
    connection: Connection,
    secrets: ConnectionSecrets | undefined,
    signal: AbortSignal
  ): Promise<void>;
  /**
   * Transport-side attachment: a fresh-or-refreshed bearer bound to the
   * exact authorized target, or `undefined` when this connection carries no
   * usable sign-in material for that endpoint.
   */
  accessTokenFor?(context: {
    accountId: string;
    connection: Connection;
    secrets: ConnectionSecrets | undefined;
    signal?: AbortSignal;
  }): Promise<string | undefined>;
}

export interface ConnectionOAuthManagerOptions {
  readonly secrets: () => ConnectionSecretStore;
  /** Durable bounded-status sink (wired to the connection store). */
  readonly recordStatus?: (
    accountId: string,
    connectionId: string,
    status: ConnectionStatus,
    code: string | null
  ) => Promise<void>;
  /** Test seam for the fixed 5-minute one-use session window. */
  readonly sessionTtlMs?: number;
  /** Test seam for issuer-endpoint fetch semantics. */
  readonly fetchFn?: FetchLike;
}

function oauthEnv(secrets: ConnectionSecrets | undefined, key: string): string | undefined {
  const value = secrets?.env?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clientInformationFrom(env: (key: string) => string | undefined): OAuthClientInformationMixed {
  const clientId = env(OAUTH_ENV.clientId);
  if (!clientId) throw new ConnectionAuthUnsupportedError();
  const secret = env(OAUTH_ENV.clientSecret);
  return secret ? { client_id: clientId, client_secret: secret } : { client_id: clientId };
}

export class ConnectionOAuthManager implements ConnectionAuthorizationProvider {
  private readonly sessionTtlMs: number;
  private readonly flows = new Map<string, PendingFlow>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ConnectionOAuthManagerOptions) {
    this.sessionTtlMs =
      options.sessionTtlMs && options.sessionTtlMs > 0 ? options.sessionTtlMs : OAUTH_CALLBACK_SESSION_TTL_MS;
  }

  private fetch(signal?: AbortSignal): FetchLike {
    return this.options.fetchFn ?? createOAuthFetch(signal);
  }

  private async record(
    accountId: string,
    connectionId: string,
    status: ConnectionStatus,
    code: string | null
  ): Promise<void> {
    await this.options.recordStatus?.(accountId, connectionId, status, code).catch(() => undefined);
  }

  async start(accountId: string, connection: Connection, signal: AbortSignal): Promise<ConnectionAuthorization> {
    if (connection.config.kind !== "mcp_http") throw new ConnectionAuthUnsupportedError();
    const read = await this.options.secrets().read(accountId, connection.id);
    if (read.state === "unavailable") throw new ConnectionCustodyUnavailableError();
    const material = read.state === "available" ? read.secrets : undefined;
    const env = (key: string) => oauthEnv(material, key);

    const ctx = await discoverIssuer(connection.config.url, this.fetch(signal));
    const { redirectUri } = await oauthCallbackHost().ensureRedirect();

    const storedClientId = env(OAUTH_ENV.clientId);
    const storedSource = env(OAUTH_ENV.clientSource);
    const storedIssuer = env(OAUTH_ENV.issuer);
    if (storedClientId && storedSource === "configured" && storedIssuer && storedIssuer !== ctx.issuer) {
      throw new ConnectionAuthUnsupportedError(
        "the configured sign-in client does not match this issuer; reconfigure the connection credentials"
      );
    }
    let clientInformation: OAuthClientInformationMixed;
    if (storedClientId && storedSource !== "dcr" && (storedIssuer === undefined || storedIssuer === ctx.issuer)) {
      // Configured client (operator-provided id/secret in custody), or a
      // first binding for a client with no recorded issuer yet.
      clientInformation = clientInformationFrom(env);
      if (storedSource === undefined || storedIssuer === undefined) {
        await this.patchCustody(accountId, connection.id, (entries) => {
          entries[OAUTH_ENV.clientSource] = "configured";
          entries[OAUTH_ENV.issuer] = ctx.issuer;
          entries[OAUTH_ENV.resource] = ctx.resource;
        });
      }
    } else if (
      storedClientId &&
      storedSource === "dcr" &&
      storedIssuer === ctx.issuer &&
      env(OAUTH_ENV.redirectUri) === redirectUri
    ) {
      clientInformation = clientInformationFrom(env);
    } else if (ctx.registrationEndpoint) {
      const registered = await this.registerClient(ctx, redirectUri, signal);
      clientInformation = { client_id: registered.client_id, client_secret: registered.client_secret };
      await this.patchCustody(accountId, connection.id, (entries) => {
        entries[OAUTH_ENV.clientId] = registered.client_id;
        if (registered.client_secret) entries[OAUTH_ENV.clientSecret] = registered.client_secret;
        else delete entries[OAUTH_ENV.clientSecret];
        entries[OAUTH_ENV.clientSource] = "dcr";
        entries[OAUTH_ENV.redirectUri] = redirectUri;
        entries[OAUTH_ENV.issuer] = ctx.issuer;
        entries[OAUTH_ENV.resource] = ctx.resource;
      });
    } else {
      throw new ConnectionAuthUnsupportedError(
        storedClientId
          ? "the dynamic sign-in client no longer matches this issuer or callback; re-authorize or configure client credentials"
          : "the issuer supports no client registration; configure a client id (and secret) in the connection credentials"
      );
    }

    const state = newOAuthState();
    let started: Awaited<ReturnType<typeof startAuthorization>>;
    try {
      started = await startAuthorization(new URL(ctx.issuer), {
        metadata: ctx.metadata,
        clientInformation,
        redirectUrl: redirectUri,
        state,
        resource: new URL(ctx.resource),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ConnectionAuthUnsupportedError();
    }
    const authorizeUrl = started.authorizationUrl;
    if (
      (authorizeUrl.protocol !== "https:" && authorizeUrl.protocol !== "http:") ||
      authorizeUrl.searchParams.get("state") !== state ||
      authorizeUrl.searchParams.get("client_id") !== clientInformation.client_id ||
      authorizeUrl.searchParams.get("code_challenge_method") !== "S256" ||
      authorizeUrl.searchParams.get("resource") !== ctx.resource
    ) {
      throw new ConnectionAuthDiscoveryError();
    }

    if (signal.aborted) throw signal.reason;
    const key = `${accountId}:${connection.id}`;
    this.cancelFlow(key);
    const flow: PendingFlow = {
      accountId,
      connectionId: connection.id,
      state,
      verifier: started.codeVerifier,
      ctx,
      clientInformation,
      redirectUri,
      expiresAtMs: Date.now() + this.sessionTtlMs,
      handle: undefined,
      timer: undefined,
      settled: false,
    };
    flow.handle = oauthCallbackHost().register({
      state,
      expiresAtMs: flow.expiresAtMs,
      resolve: (outcome) => this.resolveFlow(flow, outcome),
    });
    flow.timer = setTimeout(() => {
      flow.timer = undefined;
      if (flow.settled) return;
      flow.settled = true;
      void this.record(accountId, connection.id, "disconnected", CONNECTION_AUTH_SESSION_EXPIRED);
    }, this.sessionTtlMs);
    flow.timer.unref?.();
    this.flows.set(key, flow);
    return { authorize_url: authorizeUrl.toString(), expires_at: new Date(flow.expiresAtMs).toISOString() };
  }

  private async registerClient(
    ctx: IssuerContext,
    redirectUri: string,
    signal: AbortSignal
  ): Promise<OAuthClientInformationMixed> {
    try {
      return await registerClient(new URL(ctx.issuer), {
        metadata: ctx.metadata,
        clientMetadata: {
          client_name: "Borealis",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        fetchFn: this.fetch(signal),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      // A rejected registration is a setup problem the operator can act on
      // (register a client manually), not a transient transport failure.
      throw new ConnectionAuthUnsupportedError(
        "the issuer rejected client registration; configure a client id (and secret) in the connection credentials"
      );
    }
  }

  /** Read the current custody record, apply an env patch, and replace it. */
  private async patchCustody(accountId: string, connectionId: string, patch: (env: Record<string, string>) => void) {
    const read = await this.options.secrets().read(accountId, connectionId);
    if (read.state === "unavailable") throw new ConnectionCustodyUnavailableError();
    const material = read.state === "available" ? read.secrets : undefined;
    const env: Record<string, string> = { ...(material?.env ?? {}) };
    patch(env);
    const headers: Record<string, string> = { ...(material?.headers ?? {}) };
    await this.options.secrets().put(accountId, connectionId, connectionSecrets({ headers, env }));
  }

  private async resolveFlow(flow: PendingFlow, outcome: OAuthCallbackOutcome): Promise<void> {
    if (outcome.kind === "replay") {
      // Replay of a consumed state stays observable even when the original
      // flow already completed; credentials are untouched and the next
      // successful probe restores readiness.
      await this.record(flow.accountId, flow.connectionId, "disconnected", CONNECTION_AUTH_REPLAY_DETECTED);
      return;
    }
    if (flow.settled) return;
    flow.settled = true;
    if (outcome.kind === "expired") {
      await this.record(flow.accountId, flow.connectionId, "disconnected", CONNECTION_AUTH_SESSION_EXPIRED);
      return;
    }
    if (outcome.kind === "denied") {
      await this.record(flow.accountId, flow.connectionId, "disconnected", CONNECTION_AUTH_DENIED);
      return;
    }
    try {
      const tokens = await exchangeAuthorization(new URL(flow.ctx.issuer), {
        metadata: flow.ctx.metadata,
        clientInformation: flow.clientInformation,
        authorizationCode: outcome.code,
        codeVerifier: flow.verifier,
        redirectUri: flow.redirectUri,
        resource: new URL(flow.ctx.resource),
        fetchFn: this.fetch(),
      });
      await this.storeTokens(flow.accountId, flow.connectionId, flow.ctx, tokens);
      await this.record(flow.accountId, flow.connectionId, "untested", null);
    } catch (error) {
      if (isAbortError(error)) throw error;
      await this.record(flow.accountId, flow.connectionId, "disconnected", CONNECTION_AUTH_FAILED);
      throw error;
    }
  }

  private async storeTokens(
    accountId: string,
    connectionId: string,
    ctx: IssuerContext,
    tokens: OAuthTokens
  ): Promise<void> {
    const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : undefined;
    if (!accessToken) throw new Error("authorization server returned an unusable token");
    const expiresIn = typeof tokens.expires_in === "number" && tokens.expires_in > 0 ? tokens.expires_in : undefined;
    await this.patchCustody(accountId, connectionId, (entries) => {
      entries[OAUTH_ENV.issuer] = ctx.issuer;
      entries[OAUTH_ENV.resource] = ctx.resource;
      entries[OAUTH_ENV.accessToken] = accessToken;
      // An explicit short lifetime is recorded as an absolute expiry; a
      // server that advertised none stores no expiry claim at all (and the
      // endpoint's own 401 then drives re-sign-in). An already-expired
      // token is never persisted.
      if (expiresIn !== undefined) {
        entries[OAUTH_ENV.accessExpiresAt] = String(Math.floor(Date.now() / 1000) + expiresIn);
      } else {
        delete entries[OAUTH_ENV.accessExpiresAt];
      }
      if (typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0) {
        entries[OAUTH_ENV.refreshToken] = tokens.refresh_token;
      }
    });
  }

  /**
   * Fresh-or-refreshed bearer for a probe against `connection`. Returns
   * `undefined` (attach nothing) when no sign-in material exists or when the
   * stored material is bound to a different target — refresh can renew the
   * same authorized target but can never retarget an endpoint.
   */
  async accessTokenFor(context: {
    accountId: string;
    connection: Connection;
    secrets: ConnectionSecrets | undefined;
    signal?: AbortSignal;
  }): Promise<string | undefined> {
    const { accountId, connection, signal } = context;
    if (connection.config.kind !== "mcp_http") return undefined;
    const endpoint = connection.config.url;
    const envOf = (secrets: ConnectionSecrets | undefined) => (key: string) => oauthEnv(secrets, key);
    const hasAnyMaterial =
      oauthEnv(context.secrets, OAUTH_ENV.accessToken) !== undefined ||
      oauthEnv(context.secrets, OAUTH_ENV.refreshToken) !== undefined;
    if (!hasAnyMaterial) return undefined;
    const key = `${accountId}:${connection.id}`;
    return this.runExclusive(key, async () => {
      const read = await this.options.secrets().read(accountId, connection.id);
      if (read.state !== "available") return undefined;
      const current = envOf(read.secrets);
      const issuer = current(OAUTH_ENV.issuer);
      const resource = current(OAUTH_ENV.resource);
      if (
        issuer === undefined ||
        resource === undefined ||
        current(OAUTH_ENV.clientId) === undefined ||
        !sameEndpoint(resource, endpoint)
      ) {
        // Fail closed: never attach or renew credentials bound to another
        // issuer/resource (a config edit can never inherit an old grant).
        return undefined;
      }
      const access = current(OAUTH_ENV.accessToken);
      const expiresAtRaw = current(OAUTH_ENV.accessExpiresAt);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const fresh =
        access !== undefined &&
        (expiresAtRaw === undefined || Number(expiresAtRaw) > nowSeconds + REFRESH_LEEWAY_SECONDS);
      if (fresh) return access;
      const refreshToken = current(OAUTH_ENV.refreshToken);
      if (!refreshToken) {
        if (access) {
          // Expired access material with no refresh grant is dead weight:
          // expired tokens are never persisted.
          await this.patchCustody(accountId, connection.id, (entries) => {
            delete entries[OAUTH_ENV.accessToken];
            delete entries[OAUTH_ENV.accessExpiresAt];
          }).catch(() => undefined);
        }
        return undefined;
      }
      try {
        let metadata: AuthorizationServerMetadata | undefined;
        try {
          metadata = await discoverAuthorizationServerMetadata(new URL(issuer), { fetchFn: this.fetch(signal) });
        } catch (error) {
          if (isAbortError(error)) throw error;
          throw new ConnectionAuthRefreshFailedError();
        }
        // Identity must match exactly: a drifting issuer can never be
        // refreshed with this connection's material (no retargeting).
        if (!metadata || metadata.issuer !== issuer) throw new ConnectionAuthRefreshFailedError();
        const tokens = await refreshAuthorization(new URL(issuer), {
          metadata,
          clientInformation: clientInformationFrom(current),
          refreshToken,
          resource: new URL(resource),
          fetchFn: this.fetch(signal),
        });
        await this.storeTokens(accountId, connection.id, { issuer, metadata, resource }, tokens);
        return typeof tokens.access_token === "string" ? tokens.access_token : undefined;
      } catch (error) {
        if (isAbortError(error)) throw error;
        await this.clearTokenMaterial(accountId, connection.id).catch(() => undefined);
        await this.record(accountId, connection.id, "disconnected", CONNECTION_AUTH_REFRESH_FAILED);
        if (error instanceof ConnectionAuthRefreshFailedError) throw error;
        throw new ConnectionAuthRefreshFailedError();
      }
    });
  }

  /** Remove only the token material; the client registration stays usable. */
  private async clearTokenMaterial(accountId: string, connectionId: string): Promise<void> {
    await this.patchCustody(accountId, connectionId, (entries) => {
      delete entries[OAUTH_ENV.accessToken];
      delete entries[OAUTH_ENV.accessExpiresAt];
      delete entries[OAUTH_ENV.refreshToken];
    });
  }

  /** Local-first revoke: cancel flows, then best-effort provider revocation. */
  async revoke(
    accountId: string,
    connection: Connection,
    secrets: ConnectionSecrets | undefined,
    signal: AbortSignal
  ): Promise<void> {
    this.cancelFlow(`${accountId}:${connection.id}`);
    if (connection.config.kind !== "mcp_http" || !secrets) return;
    const env = (key: string) => oauthEnv(secrets, key);
    const issuer = env(OAUTH_ENV.issuer);
    if (!issuer) return;
    try {
      const metadata = await discoverAuthorizationServerMetadata(new URL(issuer), { fetchFn: this.fetch(signal) });
      const revocation = metadata ? (metadata as { revocation_endpoint?: unknown }).revocation_endpoint : undefined;
      const endpoint = typeof revocation === "string" ? revocation : undefined;
      if (!endpoint || metadata?.issuer !== issuer) return;
      const clientId = env(OAUTH_ENV.clientId);
      for (const token of [env(OAUTH_ENV.refreshToken), env(OAUTH_ENV.accessToken)]) {
        if (!token) continue;
        const params = new URLSearchParams({ token });
        if (clientId) params.set("client_id", clientId);
        await this.fetch(signal)(new URL(endpoint), { method: "POST", body: params });
      }
    } catch {
      // Provider-side revocation is best effort by contract.
    }
  }

  /** Cancel any pending sign-in session for one connection. */
  cancelFlow(key: string): void {
    const flow = this.flows.get(key);
    if (!flow) return;
    this.flows.delete(key);
    flow.settled = true;
    if (flow.timer) clearTimeout(flow.timer);
    flow.handle?.unregister();
  }

  /** Cancel all pending sessions (service close). */
  shutdown(): void {
    for (const key of [...this.flows.keys()]) this.cancelFlow(key);
  }

  /** Serialized per connection: exactly one refresh rotation in flight. */
  private runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }
}

/** Build the default sign-in provider for the connection service. */
export function createConnectionOAuthManager(options: ConnectionOAuthManagerOptions): ConnectionOAuthManager {
  return new ConnectionOAuthManager(options);
}

/** True when stored custody carries sign-in material of this module. */
export function hasConnectionOAuthMaterial(secrets: ConnectionSecrets | undefined): boolean {
  if (!secrets) return false;
  return Object.keys(secrets.env).some((name) => name.startsWith(OAUTH_ENV_PREFIX));
}
