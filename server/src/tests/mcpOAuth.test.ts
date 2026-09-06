import Fastify, { type FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signToken } from "../auth.js";
import { closeConnectionService, configureConnectionService } from "../connections/service.js";
import { FileConnectionSecretStore, FileKeyCustody, type ConnectionSecrets } from "../connections/secrets.js";
import { installHttpBoundary } from "../httpErrors.js";
import { quiesceMcpConnections } from "../mcp/client.js";
import { OAUTH_ENV } from "../mcp/oauth.js";
import {
  OAUTH_CALLBACK_SESSION_TTL_MS,
  closeOAuthCallbackListener,
  loopbackOAuthCallbackHost,
} from "../mcp/oauthCallback.js";
import { connectionRoutes } from "../routes/connections.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";

/**
 * Stage-3 OAuth integration: the real PKCE authorization-code flow, the
 * backend-owned loopback callback listener, serialized refresh, and the
 * durable sign-in state machine, all driven over real sockets against the
 * committed protocol fixtures (`oauth-issuer.mjs`, and `mcp-server-http.mjs`
 * in its issuer-introspecting `E2E_MCP_OAUTH_VERIFY=1` mode). No OAuth
 * mocking: discovery, dynamic registration, one-use state, PKCE, code
 * exchange, rotation-once refresh, expiry, denial, replay, revocation
 * (both sides), and the never-retarget boundary are proven end to end.
 */

const REPO_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const FIXTURES = path.join(REPO_ROOT, "scripts/e2e/fixtures");
const ISSUER_FIXTURE = path.join(FIXTURES, "oauth-issuer.mjs");
const HTTP_FIXTURE = path.join(FIXTURES, "mcp-server-http.mjs");
const STDIO_FIXTURE = path.join(FIXTURES, "mcp-server-stdio.mjs");

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}` };
const foreignAuth = { authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}` };

interface RunningFixture {
  readonly info: Record<string, string>;
  readonly pid: number;
  stop(): Promise<void>;
}

const spawnedPids: number[] = [];
const cleanups: Array<() => Promise<void>> = [];

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return !(code === "ESRCH" || code === "EPERM");
  }
}

async function expectGone(pid: number, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!pidAlive(pid)) return;
    if (Date.now() >= deadline) throw new Error(`pid ${pid} survived the test (leaked process)`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function stopAllSpawned(): Promise<void> {
  const pids = spawnedPids.splice(0);
  for (const pid of pids) await expectGone(pid);
}

function startFixture(file: string, env: Record<string, string> = {}): Promise<RunningFixture> {
  const child = spawn(process.execPath, [file], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("fixture spawn has no pid");
  spawnedPids.push(pid);
  child.stderr?.resume();
  const ready = new Promise<Record<string, string>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture ready timeout: ${file}`)), 15_000);
    timer.unref?.();
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (piece: string) => {
      buffer += piece;
      const line = buffer.split("\n").find((candidate) => candidate.trim().length > 0);
      if (!line) return;
      try {
        clearTimeout(timer);
        resolve(JSON.parse(line) as Record<string, string>);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited early: ${String(code)}`));
    });
  });
  return ready.then((info) => ({
    info,
    pid,
    async stop() {
      child.kill("SIGTERM");
      await expectGone(pid);
    },
  }));
}

async function startIssuer(env: Record<string, string> = {}): Promise<RunningFixture & { origin: string }> {
  const fixture = await startFixture(ISSUER_FIXTURE, env);
  return { ...fixture, origin: fixture.info.origin as string };
}

async function startOAuthMcp(issuerOrigin: string): Promise<RunningFixture & { endpoint: string }> {
  const fixture = await startFixture(HTTP_FIXTURE, {
    E2E_MCP_OAUTH_VERIFY: "1",
    E2E_MCP_ISSUER_ORIGIN: issuerOrigin,
  });
  return { ...fixture, endpoint: fixture.info.endpoint as string };
}

async function startPlainHttpMcp(env: Record<string, string> = {}): Promise<RunningFixture & { endpoint: string }> {
  const fixture = await startFixture(HTTP_FIXTURE, env);
  return { ...fixture, endpoint: fixture.info.endpoint as string };
}

async function introspect(issuerOrigin: string, token: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${issuerOrigin}/token/introspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as Record<string, unknown>;
}

async function providerRevoke(issuerOrigin: string, token: string): Promise<void> {
  const response = await fetch(`${issuerOrigin}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(response.status).toBe(200);
}

let sqlitePath = "";

interface AppHarness {
  readonly app: FastifyInstance;
  readonly secrets: FileConnectionSecretStore;
}

async function buildApp(options: { authorizationSessionTtlMs?: number } = {}): Promise<AppHarness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-mcp-oauth-"));
  cleanups.push(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  sqlitePath = path.join(root, "ledger.sqlite");
  const runtime = await initializeStorageRuntime({
    sqlitePath,
    lanceDirectory: path.join(root, "lancedb"),
    embeddingDimension: 3,
  });
  for (const [id, email] of [
    [OWNER, "owner@example.test"],
    [FOREIGN, "foreign@example.test"],
  ] as const) {
    await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, email, "hash"]);
  }
  const secrets = new FileConnectionSecretStore({
    directory: path.join(root, "secrets"),
    custody: new FileKeyCustody(path.join(root, "connections.key")),
  });
  configureConnectionService({
    secrets: () => secrets,
    ...(options.authorizationSessionTtlMs ? { authorizationSessionTtlMs: options.authorizationSessionTtlMs } : {}),
  });
  const app = Fastify();
  installHttpBoundary(app);
  await app.register(connectionRoutes);
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    closeConnectionService();
    await closeOAuthCallbackListener();
    await closeStorageRuntime();
  });
  return { app, secrets };
}

async function readCustody(harness: AppHarness, connectionId: string): Promise<ConnectionSecrets | undefined> {
  const read = await harness.secrets.read(OWNER, connectionId);
  return read.state === "available" ? read.secrets : undefined;
}

async function createConnection(harness: AppHarness, body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await harness.app.inject({ method: "POST", url: "/api/connections", headers: ownerAuth, body });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Record<string, any>;
}

async function detail(harness: AppHarness, id: string): Promise<Record<string, any>> {
  const response = await harness.app.inject({ method: "GET", url: `/api/connections/${id}`, headers: ownerAuth });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, any>;
}

async function postJson(
  harness: AppHarness,
  url: string,
  method: "POST" | "DELETE" = "POST"
): Promise<{ statusCode: number; body: Record<string, any> }> {
  const response = await harness.app.inject({ method, url, headers: ownerAuth });
  return { statusCode: response.statusCode, body: response.json() as Record<string, any> };
}

interface SignInResult {
  authorizeUrl: string;
  authorizeBody: Record<string, any>;
  state: string;
  callbackLocation: string;
  callbackStatus: number;
  callbackText: string;
}

/**
 * POST authorize, then drive the returned URL exactly as a browser would:
 * follow the issuer's 302 manually and deliver the callback to the backend
 * loopback listener.
 */
async function signIn(harness: AppHarness, connectionId: string): Promise<SignInResult> {
  const authorize = await postJson(harness, `/api/connections/${connectionId}/authorize`);
  expect(authorize.statusCode, JSON.stringify(authorize.body)).toBe(200);
  const authorizeUrl = authorize.body.authorize_url as string;
  const parsed = new URL(authorizeUrl);
  const redirect = await fetch(authorizeUrl, { redirect: "manual" });
  expect(redirect.status).toBe(302);
  const location = redirect.headers.get("location") ?? "";
  const callback = await fetch(location, { redirect: "manual" });
  const text = await callback.text();
  return {
    authorizeUrl,
    authorizeBody: authorize.body,
    state: parsed.searchParams.get("state") ?? "",
    callbackLocation: location,
    callbackStatus: callback.status,
    callbackText: text,
  };
}

/** Raw loopback request against the callback listener with header control. */
function rawCallbackRequest(options: {
  origin: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; text: string }> {
  const url = new URL(options.origin);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (piece) => (text += piece));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      }
    );
    request.on("error", reject);
    if (options.body) request.end(options.body);
    else request.end();
  });
}

afterEach(async () => {
  await quiesceMcpConnections();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await stopAllSpawned();
});

describe("MCP OAuth browser-development flow", () => {
  it("signs in end to end, serves discovery/test through the OAuth-verified MCP server, and revokes on both sides", async () => {
    const issuer = await startIssuer();
    cleanups.push(() => issuer.stop());
    const mcp = await startOAuthMcp(issuer.origin);
    cleanups.push(() => mcp.stop());
    const harness = await buildApp();

    const created = await createConnection(harness, {
      name: "OAuth MCP",
      kind: "mcp_http",
      config: { url: mcp.endpoint },
    });
    expect(created).toMatchObject({ credential_state: "none", status: "untested" });

    // Start the one-use expiring session.
    const authorize = await postJson(harness, `/api/connections/${created.id}/authorize`);
    expect(authorize.statusCode, JSON.stringify(authorize.body)).toBe(200);
    const authorizeUrl = new URL(authorize.body.authorize_url as string);
    expect(authorizeUrl.origin).toBe(issuer.origin);
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect((authorizeUrl.searchParams.get("code_challenge") ?? "").length).toBeGreaterThan(40);
    expect((authorizeUrl.searchParams.get("state") ?? "").length).toBeGreaterThanOrEqual(43);
    // RFC 8707 resource binding to the exact MCP endpoint.
    expect(authorizeUrl.searchParams.get("resource")).toBe(mcp.endpoint);
    const expiresAt = Date.parse(authorize.body.expires_at as string);
    expect(expiresAt - Date.now()).toBeGreaterThan(OAUTH_CALLBACK_SESSION_TTL_MS - 60_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(OAUTH_CALLBACK_SESSION_TTL_MS + 10_000);

    // Discovery + dynamic registration reached custody, not the ledger,
    // and no token exists yet (the callback has not been delivered).
    const beforeTokens = await readCustody(harness, created.id);
    expect(beforeTokens?.env[OAUTH_ENV.clientSource]).toBe("dcr");
    expect(beforeTokens?.env[OAUTH_ENV.issuer]).toBe(issuer.origin);
    expect(beforeTokens?.env[OAUTH_ENV.resource]).toBe(mcp.endpoint);
    expect(beforeTokens?.env[OAUTH_ENV.redirectUri]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(beforeTokens?.env[OAUTH_ENV.accessToken]).toBeUndefined();
    expect(authorizeUrl.searchParams.get("client_id")).toBe(beforeTokens?.env[OAUTH_ENV.clientId]);

    // The browser-side redirect carried code + state to the loopback port.
    const redirect = await fetch(authorize.body.authorize_url as string, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    const callbackLocation = redirect.headers.get("location") ?? "";
    expect(callbackLocation.startsWith(beforeTokens?.env[OAUTH_ENV.redirectUri] ?? "http://127.0.0.1:1/callback")).toBe(
      true
    );
    const callback = await fetch(callbackLocation);
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Sign-in complete");

    const custody = await readCustody(harness, created.id);
    const accessToken = custody?.env[OAUTH_ENV.accessToken] as string;
    const refreshToken = custody?.env[OAUTH_ENV.refreshToken] as string;
    expect(typeof accessToken).toBe("string");
    expect(typeof refreshToken).toBe("string");
    expect(custody?.env[OAUTH_ENV.accessExpiresAt]).toBeDefined();
    expect((await introspect(issuer.origin, accessToken)).active).toBe(true);

    let body = await detail(harness, created.id);
    expect(body).toMatchObject({ status: "untested", status_code: null, credential_state: "stored" });

    // The HTTP transport attaches the fresh bearer bound to this endpoint;
    // the MCP fixture introspects it against the issuer before serving.
    const tested = await postJson(harness, `/api/connections/${created.id}/test`);
    expect(tested.statusCode, JSON.stringify(tested.body)).toBe(200);
    expect(tested.body).toMatchObject({ status: "ready", status_code: null });
    const discovered = await postJson(harness, `/api/connections/${created.id}/discover`);
    expect(discovered.statusCode).toBe(200);
    expect(discovered.body.discovery_revision).toBe(1);
    expect((discovered.body.tools as Array<{ name: string }>).map((tool) => tool.name)).toContain("echo_query");

    // Secret-store custody assertions: no token material in DTOs, and no
    // token/client material in the SQLite ledger (store read + PRAGMA +
    // redaction scans). The DCR client id is public in the redirect by
    // design, so it is excluded from the DTO scan but not from the ledger
    // scan; the client secret (had one been issued) is a token-grade secret.
    const listBodies = await harness.app.inject({ method: "GET", url: "/api/connections", headers: ownerAuth });
    const allBodies: string[] = [
      JSON.stringify(created),
      JSON.stringify(authorize.body),
      JSON.stringify(body),
      JSON.stringify(tested.body),
      JSON.stringify(discovered.body),
      listBodies.body,
    ];
    const clientId = beforeTokens?.env[OAUTH_ENV.clientId] ?? "";
    expect(clientId.length).toBeGreaterThan(3);
    for (const candidate of [accessToken, refreshToken]) {
      expect(candidate.length).toBeGreaterThan(3);
      for (const text of allBodies) expect(text).not.toContain(candidate);
    }
    expect(JSON.stringify(body)).not.toContain("Bearer");
    const columns = (await storageRuntime().ledger.all("PRAGMA table_info(connections)")) as Array<{
      name: string;
    }>;
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(column.name.toLowerCase()).not.toMatch(/token|secret|oauth|credential/);
    }
    const ledgerBytes = [
      await fs.readFile(sqlitePath, "latin1").catch(() => ""),
      await fs.readFile(`${sqlitePath}-wal`, "latin1").catch(() => ""),
    ].join("");
    expect(ledgerBytes).not.toContain(accessToken);
    expect(ledgerBytes).not.toContain(refreshToken);
    expect(ledgerBytes).not.toContain(clientId);

    // Local-first revoke with best-effort provider-side revocation.
    const revoked = await postJson(harness, `/api/connections/${created.id}/authorization`, "DELETE");
    expect(revoked.statusCode).toBe(200);
    expect(revoked.body).toMatchObject({ status: "disconnected", credential_state: "none" });
    await expect(harness.secrets.read(OWNER, created.id)).resolves.toMatchObject({ state: "absent" });
    expect((await introspect(issuer.origin, refreshToken)).active).toBe(false);
    expect((await introspect(issuer.origin, accessToken)).active).toBe(false);

    const afterRevoke = await postJson(harness, `/api/connections/${created.id}/test`);
    expect(afterRevoke.statusCode).toBe(409);
    expect(afterRevoke.body).toMatchObject({ code: "CONNECTION_AUTH_REQUIRED" });
    body = await detail(harness, created.id);
    expect(body).toMatchObject({ status: "disconnected", status_code: "CONNECTION_AUTH_REQUIRED" });
  }, 120_000);

  it("serializes refresh per connection (rotation is single-use), reports provider logout as disconnected, and reconnects", async () => {
    const issuer = await startIssuer({ E2E_OAUTH_ACCESS_TTL_SECONDS: "2" });
    cleanups.push(() => issuer.stop());
    const mcp = await startOAuthMcp(issuer.origin);
    cleanups.push(() => mcp.stop());
    const harness = await buildApp();
    const created = await createConnection(harness, {
      name: "Short TTL",
      kind: "mcp_http",
      config: { url: mcp.endpoint },
    });

    const flow = await signIn(harness, created.id);
    expect(flow.callbackText).toContain("Sign-in complete");
    const issued = await readCustody(harness, created.id);
    const refresh0 = issued?.env[OAUTH_ENV.refreshToken] as string;

    // The 30-second refresh leeway treats the 2-second token as due at the
    // very first probe: this connect must therefore ride a rotated token.
    const first = await postJson(harness, `/api/connections/${created.id}/test`);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    const rotated = await readCustody(harness, created.id);
    const refresh1 = rotated?.env[OAUTH_ENV.refreshToken] as string;
    expect(refresh1).not.toBe(refresh0);
    // The fixture marks the rotated-out refresh token used, and a replay
    // of it must fail closed at the issuer itself.
    expect((await introspect(issuer.origin, refresh0)).active).toBe(false);
    const reuse = await fetch(`${issuer.origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh0 }),
    });
    expect(reuse.status).toBe(400);

    // Concurrent probes must serialize: each refresh sees the previous
    // rotation, so both succeed (an unsynchronized double-spend of the
    // single-use token would surface as 409 CONNECTION_AUTH_REFRESH_FAILED).
    const [probeA, probeB] = await Promise.all([
      postJson(harness, `/api/connections/${created.id}/test`),
      postJson(harness, `/api/connections/${created.id}/test`),
    ]);
    expect([probeA.statusCode, probeB.statusCode].sort()).toEqual([200, 200]);
    const rotated2 = await readCustody(harness, created.id);
    const refresh2 = rotated2?.env[OAUTH_ENV.refreshToken] as string;
    expect(refresh2).not.toBe(refresh1);
    expect((await introspect(issuer.origin, refresh1)).active).toBe(false);
    expect((await introspect(issuer.origin, refresh2)).active).toBe(true);

    // Provider logout: revoking the stored refresh token at the issuer
    // makes the next renewal fail; the state is observable and actionable.
    await providerRevoke(issuer.origin, refresh2);
    const failed = await postJson(harness, `/api/connections/${created.id}/test`);
    expect(failed.statusCode).toBe(409);
    expect(failed.body).toMatchObject({ code: "CONNECTION_AUTH_REFRESH_FAILED" });
    let body = await detail(harness, created.id);
    expect(body).toMatchObject({ status: "disconnected", status_code: "CONNECTION_AUTH_REFRESH_FAILED" });
    const cleared = await readCustody(harness, created.id);
    expect(cleared?.env[OAUTH_ENV.accessToken]).toBeUndefined();
    expect(cleared?.env[OAUTH_ENV.refreshToken]).toBeUndefined();
    expect(cleared?.env[OAUTH_ENV.accessExpiresAt]).toBeUndefined();
    // The client registration survives so reconnect does not re-register.
    expect(cleared?.env[OAUTH_ENV.clientId]).toBe(rotated2?.env[OAUTH_ENV.clientId]);
    expect(body.credential_state).toBe("stored");

    // Reconnect through a fresh sign-in restores readiness.
    const reflow = await signIn(harness, created.id);
    expect(reflow.callbackText).toContain("Sign-in complete");
    const renewed = await readCustody(harness, created.id);
    expect(renewed?.env[OAUTH_ENV.clientId]).toBe(cleared?.env[OAUTH_ENV.clientId]);
    expect(renewed?.env[OAUTH_ENV.refreshToken]).toBeDefined();
    const recovery = await postJson(harness, `/api/connections/${created.id}/test`);
    expect(recovery.statusCode).toBe(200);
    body = await detail(harness, created.id);
    expect(body).toMatchObject({ status: "ready", status_code: null });
  }, 120_000);

  it("records user denial as an actionable disconnected state", async () => {
    const issuer = await startIssuer({ E2E_OAUTH_AUTHORIZE_MODE: "deny" });
    cleanups.push(() => issuer.stop());
    const mcp = await startOAuthMcp(issuer.origin);
    cleanups.push(() => mcp.stop());
    const harness = await buildApp();
    const created = await createConnection(harness, {
      name: "Deny",
      kind: "mcp_http",
      config: { url: mcp.endpoint },
    });

    const authorize = await postJson(harness, `/api/connections/${created.id}/authorize`);
    expect(authorize.statusCode).toBe(200);
    const redirect = await fetch(authorize.body.authorize_url as string, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).not.toBe("");
    const callback = await fetch(location.toString());
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Sign-in cancelled");

    const body = await detail(harness, created.id);
    expect(body).toMatchObject({ status: "disconnected", status_code: "CONNECTION_AUTH_DENIED" });
    const custody = await readCustody(harness, created.id);
    expect(custody?.env[OAUTH_ENV.accessToken]).toBeUndefined();
  }, 60_000);

  it("expires the one-use authorize session and rejects its late callback", async () => {
    const issuer = await startIssuer();
    cleanups.push(() => issuer.stop());
    const mcp = await startOAuthMcp(issuer.origin);
    cleanups.push(() => mcp.stop());
    const harness = await buildApp({ authorizationSessionTtlMs: 900 });
    const created = await createConnection(harness, {
      name: "Expiry",
      kind: "mcp_http",
      config: { url: mcp.endpoint },
    });

    const authorize = await postJson(harness, `/api/connections/${created.id}/authorize`);
    expect(authorize.statusCode).toBe(200);
    expect(Date.parse(authorize.body.expires_at) - Date.now()).toBeLessThanOrEqual(900 + 10_000);
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    let body = await detail(harness, created.id);
    expect(body).toMatchObject({ status: "disconnected", status_code: "CONNECTION_AUTH_SESSION_EXPIRED" });

    // The issuer still hands out a code; the listener must refuse it and no
    // tokens may be persisted for the expired session.
    const redirect = await fetch(authorize.body.authorize_url as string, { redirect: "manual" });
    const callback = await fetch(redirect.headers.get("location") ?? "http://127.0.0.1/");
    expect(callback.status).toBe(410);
    expect(await callback.text()).toContain("expired");
    body = await detail(harness, created.id);
    expect(body).toMatchObject({ status_code: "CONNECTION_AUTH_SESSION_EXPIRED" });
    const custody = await readCustody(harness, created.id);
    expect(custody?.env[OAUTH_ENV.accessToken]).toBeUndefined();
  }, 60_000);

  it("rejects callback replay durably and leaves credentials recoverable", async () => {
    const issuer = await startIssuer();
    cleanups.push(() => issuer.stop());
    const mcp = await startOAuthMcp(issuer.origin);
    cleanups.push(() => mcp.stop());
    const harness = await buildApp();
    const created = await createConnection(harness, {
      name: "Replay",
      kind: "mcp_http",
      config: { url: mcp.endpoint },
    });
    const flow = await signIn(harness, created.id);
    expect(flow.callbackText).toContain("Sign-in complete");
    const ready = await postJson(harness, `/api/connections/${created.id}/test`);
    expect(ready.statusCode).toBe(200);

    // Second delivery of the same consumed callback: rejected, observable,
    // and the exchange never re-runs.
    const replay = await fetch(flow.callbackLocation);
    expect(replay.status).toBe(410);
    expect(await replay.text()).toContain("already used");
    let body = await detail(harness, created.id);
    expect(body).toMatchObject({
      status: "disconnected",
      status_code: "CONNECTION_AUTH_REPLAY_DETECTED",
      credential_state: "stored",
    });
    const custody = await readCustody(harness, created.id);
    expect((await introspect(issuer.origin, custody?.env[OAUTH_ENV.accessToken] as string)).active).toBe(true);

    // The recorded state recovers through the next successful probe.
    const recover = await postJson(harness, `/api/connections/${created.id}/test`);
    expect(recover.statusCode).toBe(200);
    body = await detail(harness, created.id);
    expect(body).toMatchObject({ status: "ready", status_code: null });

    // An unknown state belongs to no flow: 404 with no durable change.
    const { redirectUri } = await loopbackOAuthCallbackHost.ensureRedirect();
    const unknown = await fetch(`${redirectUri}?state=${"a".repeat(64)}`);
    expect(unknown.status).toBe(404);
    body = await detail(harness, created.id);
    expect(body).toMatchObject({ status: "ready" });
  }, 90_000);
});

describe("OAuth issuer support boundaries", () => {
  /** Loopback static JSON server whose routes may depend on its own origin. */
  async function withStaticServer(
    buildRoutes: (origin: string) => Record<string, { status?: number; json?: unknown }>
  ): Promise<string> {
    let routes: Record<string, { status?: number; json?: unknown }> = {};
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const entry = routes[url.pathname];
      if (entry) {
        const body = Buffer.from(JSON.stringify(entry.json ?? {}));
        response.writeHead(entry.status ?? 200, { "content-type": "application/json" });
        response.end(body);
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as import("node:net").AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    routes = buildRoutes(origin);
    cleanups.push(
      () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    );
    return origin;
  }

  it("gives actionable setup errors for unsupported issuers and never a fake success", async () => {
    const harness = await buildApp();

    // (a) An endpoint that advertises no OAuth at all (plain bearer MCP).
    const plain = await startPlainHttpMcp({ E2E_MCP_BEARER: "static" });
    cleanups.push(() => plain.stop());
    const noOAuth = await createConnection(harness, {
      name: "No OAuth",
      kind: "mcp_http",
      config: { url: plain.endpoint },
    });
    const noOAuthAuthorize = await postJson(harness, `/api/connections/${noOAuth.id}/authorize`);
    expect(noOAuthAuthorize.statusCode).toBe(501);
    expect(noOAuthAuthorize.body).toMatchObject({ code: "CONNECTION_AUTH_UNSUPPORTED" });
    expect(await detail(harness, noOAuth.id)).toMatchObject({ status: "untested", status_code: null });

    // (b) A co-located issuer without dynamic registration and no
    //     configured client: setup instructions, not discovery.
    const noRegisterOrigin = await withStaticServer((origin) => ({
      "/.well-known/oauth-authorization-server": {
        json: {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        },
      },
    }));
    const noRegisterConnection = await createConnection(harness, {
      name: "No Register",
      kind: "mcp_http",
      config: { url: `${noRegisterOrigin}/mcp` },
    });
    const noRegisterAuthorize = await postJson(harness, `/api/connections/${noRegisterConnection.id}/authorize`);
    expect(noRegisterAuthorize.statusCode).toBe(501);
    expect(noRegisterAuthorize.body).toMatchObject({ code: "CONNECTION_AUTH_UNSUPPORTED" });

    // (c) A refresh-incapable issuer is refused: this flow guarantees
    //     renewability and treats its absence as unsupported.
    const noRefreshOrigin = await withStaticServer((origin) => ({
      "/.well-known/oauth-authorization-server": {
        json: {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          registration_endpoint: `${origin}/register`,
        },
      },
    }));
    const noRefreshConnection = await createConnection(harness, {
      name: "No Refresh",
      kind: "mcp_http",
      config: { url: `${noRefreshOrigin}/mcp` },
    });
    const noRefreshAuthorize = await postJson(harness, `/api/connections/${noRefreshConnection.id}/authorize`);
    expect(noRefreshAuthorize.statusCode).toBe(501);
    expect(noRefreshAuthorize.body).toMatchObject({ code: "CONNECTION_AUTH_UNSUPPORTED" });

    // (d) No PKCE S256 support is refused.
    const noPkceOrigin = await withStaticServer((origin) => ({
      "/.well-known/oauth-authorization-server": {
        json: {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["plain"],
          registration_endpoint: `${origin}/register`,
        },
      },
    }));
    const noPkceConnection = await createConnection(harness, {
      name: "No PKCE",
      kind: "mcp_http",
      config: { url: `${noPkceOrigin}/mcp` },
    });
    const noPkceAuthorize = await postJson(harness, `/api/connections/${noPkceConnection.id}/authorize`);
    expect(noPkceAuthorize.statusCode).toBe(501);
    expect(noPkceAuthorize.body).toMatchObject({ code: "CONNECTION_AUTH_UNSUPPORTED" });

    // (e) A protected-resource document pointing at an unreachable
    //     authorization server is a bounded discovery failure, not denial.
    const deadOrigin = await withStaticServer((origin) => ({
      "/.well-known/oauth-protected-resource": {
        json: { resource: `${origin}/mcp`, authorization_servers: ["http://127.0.0.1:1"] },
      },
    }));
    const deadConnection = await createConnection(harness, {
      name: "Dead Issuer",
      kind: "mcp_http",
      config: { url: `${deadOrigin}/mcp` },
    });
    const deadAuthorize = await postJson(harness, `/api/connections/${deadConnection.id}/authorize`);
    expect(deadAuthorize.statusCode).toBe(502);
    expect(deadAuthorize.body).toMatchObject({ code: "CONNECTION_AUTH_DISCOVERY_FAILED" });

    // (f) Configured client registration (id/secret via custody) is used
    //     as-is instead of dynamic registration.
    const issuer = await startIssuer();
    cleanups.push(() => issuer.stop());
    const mcp = await startOAuthMcp(issuer.origin);
    cleanups.push(() => mcp.stop());
    const configured = await createConnection(harness, {
      name: "Configured Client",
      kind: "mcp_http",
      config: { url: mcp.endpoint },
      credentials: {
        env: { MCP_OAUTH_CLIENT_ID: "operator-client", MCP_OAUTH_CLIENT_SECRET: "operator-secret-1" },
      },
    });
    const configuredAuthorize = await postJson(harness, `/api/connections/${configured.id}/authorize`);
    expect(configuredAuthorize.statusCode, JSON.stringify(configuredAuthorize.body)).toBe(200);
    const parsed = new URL(configuredAuthorize.body.authorize_url as string);
    expect(parsed.searchParams.get("client_id")).toBe("operator-client");
    const custody = await readCustody(harness, configured.id);
    expect(custody?.env[OAUTH_ENV.clientSource]).toBe("configured");
    expect(custody?.env[OAUTH_ENV.clientId]).toBe("operator-client");
    expect(JSON.stringify(configuredAuthorize.body)).not.toContain("operator-secret-1");

    // (g) stdio connections never sign in; guards stay in place.
    const stdio = await createConnection(harness, {
      name: "Stdio OAuth",
      kind: "mcp_stdio",
      config: { command: process.execPath, args: [STDIO_FIXTURE], cwd: null },
    });
    const stdioAuthorize = await postJson(harness, `/api/connections/${stdio.id}/authorize`);
    expect(stdioAuthorize.statusCode).toBe(501);
    expect(stdioAuthorize.body).toMatchObject({ code: "CONNECTION_AUTH_UNSUPPORTED" });

    const disabled = await harness.app.inject({
      method: "PATCH",
      url: `/api/connections/${stdio.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1, enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    const disabledAuthorize = await postJson(harness, `/api/connections/${stdio.id}/authorize`);
    expect(disabledAuthorize.statusCode).toBe(409);
    expect(disabledAuthorize.body).toMatchObject({ code: "CONNECTION_DISABLED" });

    // Route guards: unauthenticated and foreign-account requests never
    // reach discovery work.
    expect(
      (await harness.app.inject({ method: "POST", url: `/api/connections/${stdio.id}/authorize` })).statusCode
    ).toBe(401);
    expect(
      (
        await harness.app.inject({
          method: "POST",
          url: `/api/connections/${stdio.id}/authorize`,
          headers: foreignAuth,
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await harness.app.inject({
          method: "DELETE",
          url: `/api/connections/${stdio.id}/authorization`,
          headers: foreignAuth,
        })
      ).statusCode
    ).toBe(404);
  }, 120_000);

  it("never retargets: a config edit cannot inherit the old endpoint's grant", async () => {
    const issuer = await startIssuer();
    cleanups.push(() => issuer.stop());
    const verified = await startOAuthMcp(issuer.origin);
    cleanups.push(() => verified.stop());
    const other = await startPlainHttpMcp({ E2E_MCP_BEARER: "different-static" });
    cleanups.push(() => other.stop());
    const harness = await buildApp();
    const created = await createConnection(harness, {
      name: "Bound Target",
      kind: "mcp_http",
      config: { url: verified.endpoint },
    });
    const flow = await signIn(harness, created.id);
    expect(flow.callbackText).toContain("Sign-in complete");
    const ready = await postJson(harness, `/api/connections/${created.id}/test`);
    expect(ready.statusCode).toBe(200);

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/connections/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1, config: { url: other.endpoint } },
    });
    expect(patched.statusCode).toBe(200);

    // The old grant is bound to the old resource: it can never be attached
    // to the new endpoint, which therefore challenges for sign-in.
    const tested = await postJson(harness, `/api/connections/${created.id}/test`);
    expect(tested.statusCode).toBe(409);
    expect(tested.body).toMatchObject({ code: "CONNECTION_AUTH_REQUIRED" });
    const body = await detail(harness, created.id);
    expect(body).toMatchObject({ status: "disconnected", status_code: "CONNECTION_AUTH_REQUIRED" });

    // The old access token was neither revoked nor reused at the issuer.
    const custody = await readCustody(harness, created.id);
    expect(custody?.env[OAUTH_ENV.resource]).toBe(verified.endpoint);
    const oldAccess = custody?.env[OAUTH_ENV.accessToken] as string;
    expect(typeof oldAccess).toBe("string");
    expect((await introspect(issuer.origin, oldAccess)).token_type).toBe("access_token");
  }, 120_000);
});

describe("loopback OAuth callback listener surface", () => {
  it("is not a general resource API and accepts no workspace credentials", async () => {
    const issuer = await startIssuer();
    cleanups.push(() => issuer.stop());
    const mcp = await startOAuthMcp(issuer.origin);
    cleanups.push(() => mcp.stop());
    const harness = await buildApp();
    const created = await createConnection(harness, {
      name: "Listener",
      kind: "mcp_http",
      config: { url: mcp.endpoint },
    });

    const authorize = await postJson(harness, `/api/connections/${created.id}/authorize`);
    expect(authorize.statusCode).toBe(200);
    const { redirectUri } = await loopbackOAuthCallbackHost.ensureRedirect();
    const origin = new URL(redirectUri).origin;

    // Only the callback route answers; everything else is a static 404.
    expect((await fetch(`${origin}/`)).status).toBe(404);
    expect((await fetch(`${origin}/anything-else`)).status).toBe(404);
    expect((await fetch(`${origin}/callback`)).status).toBe(404); // no state

    // Non-GET methods are refused.
    const post = await fetch(`${redirectUri}?state=${encodeURIComponent("x".repeat(32))}`, { method: "POST" });
    expect(post.status).toBe(405);

    // A Host that is not the loopback listener is refused (rebinding defence).
    const rebinding = await rawCallbackRequest({ origin, path: "/callback", headers: { Host: "attacker.example" } });
    expect(rebinding.status).toBe(400);

    // Bodies are refused outright.
    const withBody = await rawCallbackRequest({
      origin,
      path: "/callback",
      headers: { "content-length": "5", "content-type": "text/plain" },
      body: "hello",
    });
    expect(withBody.status).toBe(400);

    // Oversized/invalid state is not a resource lookup.
    const forged = await fetch(`${redirectUri}?state=${"a".repeat(600)}`);
    expect(forged.status).toBe(404);

    // The flow itself is untouched by the probing above; completing it is
    // allowed with an unrelated Authorization header present: the listener
    // authenticates nothing and requires nothing.
    const redirect = await fetch(authorize.body.authorize_url as string, { redirect: "manual" });
    const location = redirect.headers.get("location") ?? "";
    const callback = await fetch(location, {
      headers: { authorization: "Bearer some-workspace-session-jwt" },
    });
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Sign-in complete");
    const body = await detail(harness, created.id);
    expect(body).toMatchObject({ credential_state: "stored", status: "untested" });
  }, 90_000);
});
