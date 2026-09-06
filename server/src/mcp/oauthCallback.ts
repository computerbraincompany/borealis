import { createHash, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import http from "node:http";

/**
 * Backend-owned loopback OAuth callback listener (Connected agents stage 3).
 *
 * This is the browser-development callback transport for the MCP sign-in
 * flow. It is deliberately the narrowest possible HTTP surface:
 *
 * - binds `127.0.0.1` on an OS-assigned port (shared across flows so the
 *   dynamic-registration redirect URI is stable for the process lifetime;
 *   the server is unref'd and never keeps the process alive);
 * - answers exactly one route, `GET /callback`, and only for pending
 *   authorize flows: an unrecognized `state` is a content-free 404, not a
 *   resource lookup. It is not a general resource API and serves nothing
 *   else — unknown paths, methods other than GET/HEAD, and non-loopback
 *   `Host` headers (DNS-rebinding defence) are refused with static pages;
 * - one-use state: the first matching callback consumes the flow; any later
 *   callback with the same state is a replay rejection (410) that stays
 *   observable to the caller without ever re-running the token exchange;
 * - the flow itself enforces the spec's 5-minute expiry; the listener
 *   refuses expired callbacks independently of the manager-side timer;
 * - it accepts no workspace session credentials: requests are never
 *   authenticated, `Authorization`/`Cookie` headers are not even read, and
 *   no request data (state, code, path, query) is ever reflected into a
 *   response — every reply is a fixed notice document with `default-src
 *   'none'` and no scripting;
 * - the packaged desktop replaces this module's listener with the exact
 *   main-process-owned listener through the `OAuthCallbackHost` seam in
 *   `mcp/oauth.ts` (stage 5); nothing here ever runs in a renderer.
 */

/** Fixed lifetime of one pending authorize session (spec: 5 minutes). */
export const OAUTH_CALLBACK_SESSION_TTL_MS = 5 * 60_000;
/** How long consumed states stay remembered for replay detection. */
const REPLAY_MEMORY_MS = 15 * 60_000;
const CALLBACK_PATH = "/callback";
const MAX_QUERY_CHARS = 4_096;
const STATE_PATTERN = /^[A-Za-z0-9\-_]{16,512}$/;
const CODE_PATTERN = /^[A-Za-z0-9\-._~+/]{1,1024}={0,1024}$/;

export type OAuthCallbackOutcome =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" }
  | { readonly kind: "replay" };

/** Called exactly once per registered flow. A rejection is a flow failure. */
export type OAuthCallbackResolver = (outcome: OAuthCallbackOutcome) => Promise<void>;

export interface OAuthCallbackRegistration {
  readonly state: string;
  readonly expiresAtMs: number;
  readonly resolve: OAuthCallbackResolver;
}

export interface OAuthCallbackHandle {
  unregister(): void;
}

export interface OAuthCallbackHost {
  /** Start (or reuse) the listener and return the exact loopback redirect URI. */
  ensureRedirect(): Promise<{ readonly redirectUri: string }>;
  register(registration: OAuthCallbackRegistration): OAuthCallbackHandle;
  close(): Promise<void>;
}

interface FlowRecord extends OAuthCallbackRegistration {
  consumed: boolean;
}

const flows = new Map<string, FlowRecord>();
let listener: http.Server | undefined;
let listenerPort = 0;
let listenerOrigin = "";
let ensurePromise: Promise<{ readonly redirectUri: string }> | undefined;
let sweepTimer: ReturnType<typeof setInterval> | undefined;

function stateHash(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

/**
 * Static notice pages only: no request data (state, code, path, or query)
 * is ever reflected. CSP forbids all loading and scripting, and there is no
 * inline style or script to smuggle.
 */
function notice(response: ServerResponse, status: number, heading: string, body: string): void {
  if (response.headersSent) return;
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${heading}</title></head>` +
    `<body><h1>${heading}</h1><p>${body}</p><p>You may close this window.</p></body></html>`;
  const buffer = Buffer.from(html, "utf8");
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(buffer.length),
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(buffer);
}

async function handle(request: http.IncomingMessage, response: ServerResponse): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    notice(response, 405, "Method not allowed", "This endpoint only completes pending sign-in requests.");
    return;
  }
  // Never read or authenticate credentials; this surface is not a session
  // API. A body on a callback is refused outright.
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string" && contentLength !== "0") {
    notice(response, 400, "Bad request", "Sign-in callbacks carry no request body.");
    return;
  }
  // DNS-rebinding defence: the Host must name the exact loopback listener.
  if (!isLoopbackHost(request.headers.host, listenerPort)) {
    notice(response, 400, "Bad request", "This sign-in endpoint is loopback-only.");
    return;
  }
  const rawUrl = request.url ?? "/";
  const queryIndex = rawUrl.indexOf("?");
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? "" : rawUrl.slice(queryIndex + 1);
  if (path !== CALLBACK_PATH) {
    notice(response, 404, "Not found", "This endpoint only completes pending sign-in requests.");
    return;
  }
  if (rawQuery.length > MAX_QUERY_CHARS) {
    notice(response, 400, "Bad request", "The sign-in callback was malformed.");
    return;
  }
  const params = new URLSearchParams(rawQuery);
  const state = params.get("state");
  if (typeof state !== "string" || !STATE_PATTERN.test(state)) {
    notice(response, 404, "Not found", "This sign-in callback is not recognized.");
    return;
  }
  const flow = flows.get(stateHash(state));
  if (!flow) {
    // Unknown or forgotten state: no attribution, no durable change.
    notice(response, 404, "Not found", "This sign-in callback is not recognized.");
    return;
  }
  if (flow.consumed) {
    // Replay of an already-consumed state: rejected, observable, and the
    // exchange never re-runs. The record stays remembered briefly.
    await safeResolve(flow, { kind: "replay" });
    notice(
      response,
      410,
      "Sign-in already completed",
      "This sign-in callback was already used and cannot be replayed."
    );
    return;
  }
  // First delivery: the state is consumed no matter what happens next.
  flow.consumed = true;
  if (Date.now() > flow.expiresAtMs) {
    await safeResolve(flow, { kind: "expired" });
    notice(response, 410, "Sign-in expired", "This sign-in request expired. Start sign-in again.");
    return;
  }
  const error = params.get("error");
  if (typeof error === "string" && error.length > 0) {
    await safeResolve(flow, { kind: "denied" });
    notice(
      response,
      200,
      "Sign-in cancelled",
      "Sign-in was cancelled or denied at the identity provider. You can retry."
    );
    return;
  }
  const code = params.get("code");
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) {
    await safeResolve(flow, { kind: "denied" });
    notice(response, 400, "Sign-in failed", "The sign-in callback did not carry a usable authorization code.");
    return;
  }
  try {
    await flow.resolve({ kind: "code", code });
    notice(response, 200, "Sign-in complete", "Sign-in succeeded. Return to Borealis.");
  } catch {
    notice(response, 400, "Sign-in failed", "The sign-in could not be completed. Start sign-in again.");
  }
}

async function safeResolve(flow: FlowRecord, outcome: OAuthCallbackOutcome): Promise<void> {
  try {
    await flow.resolve(outcome);
  } catch {
    // The manager records its own failure states; the notice is generic.
  }
}

function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  let hostname = host;
  let portText = "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return false;
    hostname = host.slice(1, end);
    portText = host.slice(end + 1).replace(/^:/, "");
  } else {
    const colon = host.indexOf(":");
    if (colon > -1) {
      hostname = host.slice(0, colon);
      portText = host.slice(colon + 1);
    }
  }
  hostname = hostname.toLowerCase();
  if (portText !== "" && Number(portText) !== port) return false;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function sweep(): void {
  const now = Date.now();
  for (const [hash, flow] of flows) {
    const forgetAt = flow.consumed ? flow.expiresAtMs + REPLAY_MEMORY_MS : flow.expiresAtMs;
    if (now > forgetAt) flows.delete(hash);
  }
  if (flows.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

export const loopbackOAuthCallbackHost: OAuthCallbackHost = Object.freeze({
  async ensureRedirect(): Promise<{ readonly redirectUri: string }> {
    if (listener) return { redirectUri: `${listenerOrigin}${CALLBACK_PATH}` };
    ensurePromise ??= (async () => {
      const server = http.createServer((request, response) => {
        void handle(request, response).catch(() => {
          notice(response, 500, "Sign-in could not be completed", "The sign-in request could not be processed.");
        });
      });
      server.requestTimeout = 15_000;
      server.headersTimeout = 15_000;
      server.keepAliveTimeout = 1_000;
      // Socket-level noise is discarded; every operational failure above
      // answers with a generic static notice.
      server.on("clientError", (_error, socket) => {
        socket.destroy();
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        throw new Error("loopback callback listener did not bind");
      }
      server.unref();
      listener = server;
      listenerPort = address.port;
      listenerOrigin = `http://127.0.0.1:${listenerPort}`;
      return { redirectUri: `${listenerOrigin}${CALLBACK_PATH}` };
    })().finally(() => {
      ensurePromise = undefined;
    });
    return ensurePromise;
  },

  register(registration: OAuthCallbackRegistration): OAuthCallbackHandle {
    if (!listener) throw new Error("loopback callback listener is not running");
    const hash = stateHash(registration.state);
    if (flows.has(hash)) throw new Error("OAuth callback state collision");
    flows.set(hash, { ...registration, consumed: false });
    if (!sweepTimer) {
      sweepTimer = setInterval(sweep, 30_000);
      sweepTimer.unref?.();
    }
    let active = true;
    return {
      unregister(): void {
        if (!active) return;
        active = false;
        flows.delete(hash);
        sweep();
      },
    };
  },

  async close(): Promise<void> {
    for (const hash of [...flows.keys()]) flows.delete(hash);
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
    const server = listener;
    listener = undefined;
    listenerPort = 0;
    listenerOrigin = "";
    if (!server) return;
    // Drop live sockets so `close()` settles promptly; nothing else can hold
    // this loopback-only server open.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  },
});

/** Generate one expiring one-use state token for a new authorize flow. */
export function newOAuthState(): string {
  return randomBytes(32).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Desktop-mode seam (stage 5): a different host may own the listener. */
let callbackHost: OAuthCallbackHost = loopbackOAuthCallbackHost;

export function oauthCallbackHost(): OAuthCallbackHost {
  return callbackHost;
}

/** Test/platform seam. Returns the restore operation. */
export function setOAuthCallbackHost(host: OAuthCallbackHost | undefined): () => void {
  const previous = callbackHost;
  callbackHost = host ?? loopbackOAuthCallbackHost;
  return () => {
    callbackHost = previous;
  };
}

/** Close whatever the active host owns. Idempotent; used by shutdown/tests. */
export async function closeOAuthCallbackListener(): Promise<void> {
  await callbackHost.close();
}
