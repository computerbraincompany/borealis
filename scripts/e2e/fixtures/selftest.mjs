#!/usr/bin/env node
/**
 * Fixture self-test: starts every standalone E2E fixture on loopback, drives
 * each happy path plus at least one failure mode with plain Node clients, and
 * proves clean, child-only teardown (every spawned PID is gone afterwards).
 *
 *   node scripts/e2e/fixtures/selftest.mjs            # all groups
 *   node scripts/e2e/fixtures/selftest.mjs provider   # one group
 *
 * Prints only content-free `ok <id>` lines plus a final summary. Exit 0 on
 * success. No token, credential, or body content is ever printed.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(FIXTURES_DIR, "..", "..", "..");
const only = process.argv[2] ?? "";

let checks = 0;
const failures = [];
const children = [];

function ok(label, condition) {
  checks += 1;
  if (condition) {
    process.stdout.write(`ok ${label}\n`);
  } else {
    failures.push(label);
    process.stdout.write(`FAIL ${label}\n`);
  }
}

function childEnv(extra) {
  return { PATH: process.env.PATH ?? "", ...extra };
}

/**
 * Spawn a fixture child, tracked for child-only cleanup. `readyKey` returns
 * when the single stdout ready line arrives (HTTP fixtures). stdio MCP has no
 * ready line; pass readyFromStdout:false and rely on protocol responses.
 */
function spawnFixture(name, script, env, { readyFromStdout = true } = {}) {
  const child = spawn(process.execPath, [join(FIXTURES_DIR, script)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv(env),
  });
  const entry = { name, child, pid: child.pid, stderrTail: [], exited: null };
  children.push(entry);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (piece) => {
    for (const line of String(piece).split("\n")) {
      if (line.trim()) entry.stderrTail.push(line.slice(0, 160));
    }
    if (entry.stderrTail.length > 20) entry.stderrTail.splice(0, entry.stderrTail.length - 20);
  });
  child.on("exit", (code, signal) => {
    entry.exited = { code, signal };
  });
  entry.ready = readyFromStdout
    ? new Promise((resolveReady, rejectReady) => {
        let buffer = "";
        const timer = setTimeout(() => rejectReady(new Error(`ready-timeout ${name}`)), 10_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (piece) => {
          buffer += piece;
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          clearTimeout(timer);
          try {
            resolveReady(JSON.parse(buffer.slice(0, newline)));
          } catch (error) {
            rejectReady(error);
          }
        });
      })
    : Promise.resolve(null);
  return entry;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

/** Request orderly stop (stdin close for stdio, else SIGTERM) and reap. */
async function stopFixture(entry, { viaStdinClose = false } = {}) {
  const { child } = entry;
  if (child.exitCode === null && child.signalCode === null) {
    if (viaStdinClose) child.stdin.end();
    else child.kill("SIGTERM");
  }
  const deadline = Date.now() + 4_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
  }
  return { exited: entry.exited, gone: !pidAlive(entry.pid), stderrTail: entry.stderrTail };
}

function b64url(buffer) {
  return buffer.toString("base64url");
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/* ------------------------------------------------------------------ SSE --- */

function parseSseFrames(raw) {
  const frames = [];
  for (const block of raw.split("\n\n")) {
    if (!block.startsWith("data: ")) continue;
    const payload = block.slice(6);
    if (payload === "[DONE]") continue;
    try {
      frames.push({ json: JSON.parse(payload), raw: payload });
    } catch {
      frames.push({ json: null, raw: payload });
    }
  }
  return frames;
}

/* ------------------------------------------------------ MCP stdio client --- */

function stdioRpc(child) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (piece) => {
    buffer += piece;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  return {
    request(method, params, timeoutMs = 15_000) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectRequest(new Error(`rpc-timeout ${method}`));
        }, timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolveRequest(message);
        });
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`);
    },
  };
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

async function mcpInitialize(endpoint, { token } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "borealis-e2e-selftest", version: "1" } },
    }),
  });
  const text = await response.text();
  return { status: response.status, sessionId: response.headers.get("mcp-session-id"), wwwAuth: response.headers.get("www-authenticate"), body: safeJson(text) };
}

async function mcpPost(endpoint, sessionId, body, { token } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-protocol-version": MCP_PROTOCOL_VERSION };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: safeJson(text) };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* =========================================================== fixture groups */

async function groupProvider() {
  const SECRET = "sekret-value-not-logged-9f2c";
  const script = JSON.stringify([
    { type: "tool_call", id: "call_1", name_pieces: ["echo", "_query"], argument_pieces: ['{"te', 'xt":"fixture', '"}'] },
    { type: "malformed" },
    { type: "text", pieces: ["Hel", "lo there"] },
    { type: "slow", delay_ms: 300, pieces: ["late"] },
    { type: "no_response" },
  ]);
  const fixture = spawnFixture("openai-provider", "openai-provider.mjs", { E2E_OPENAI_SCRIPT: script });
  const ready = await fixture.ready;
  ok("provider: ready line + loopback origin", ready.fixture === "openai-provider" && ready.origin.startsWith("http://127.0.0.1:"));

  const chat = async () => {
    const response = await fetch(`${ready.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ model: "fixture-chat-v1", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    return { response, raw: await response.text() };
  };

  const first = await chat();
  const frames = parseSseFrames(first.raw);
  let toolName = "";
  let toolArgs = "";
  for (const frame of frames) {
    const call = frame.json?.choices?.[0]?.delta?.tool_calls?.[0];
    if (call?.function?.name) toolName += call.function.name;
    if (call?.function?.arguments) toolArgs += call.function.arguments;
  }
  ok("provider: split tool-call frames reconstruct name+arguments", toolName === "echo_query" && JSON.parse(toolArgs).text === "fixture");

  const second = await chat();
  ok("provider: malformed frame passes through raw", second.raw.includes('data: {"choices": [ this is not json'));
  ok("provider: no secret value in streamed bytes", !second.raw.includes(SECRET));

  const third = await chat();
  const answer = parseSseFrames(third.raw)
    .map((frame) => frame.json?.choices?.[0]?.delta?.content ?? "")
    .join("");
  ok("provider: plain streamed answer reassembles", answer === "Hello there");

  const slowStart = Date.now();
  const fourth = await chat();
  const slowElapsed = Date.now() - slowStart;
  ok("provider: slow step delays first payload (bounded)", slowElapsed >= 200 && slowElapsed < 5_000 && fourth.raw.includes("late"));

  let aborted = false;
  try {
    await fetch(`${ready.origin}/v1/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(300),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [] }),
    });
  } catch (error) {
    aborted = error.name === "TimeoutError";
  }
  ok("provider: no-response step is client-timeout-abortable", aborted);

  const embed = await (await fetch(`${ready.origin}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "fixture-embed-v1", input: ["alpha", "alpha", "beta"], encoding_format: "float" }),
  })).json();
  const vector = embed.data[0].embedding;
  const sumSq = vector.reduce((sum, value) => sum + value * value, 0);
  ok(
    "provider: embeddings return float arrays, deterministic, unit-norm",
    Array.isArray(vector) && typeof vector[0] === "number" && vector.length === 64 && JSON.stringify(vector) === JSON.stringify(embed.data[1].embedding) && vector !== embed.data[2].embedding && Math.abs(sumSq - 1) < 1e-4
  );

  const b64 = await (await fetch(`${ready.origin}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "alpha", encoding_format: "base64" }),
  })).json();
  const packed = Buffer.from(b64.data[0].embedding, "base64");
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  ok("provider: encoding_format base64 matches float values", packed.length === 256 && view.getFloat32(0, true) === vector[0] && view.getFloat32(20, true) === vector[5]);

  const models = await (await fetch(`${ready.origin}/v1/models`)).json();
  ok("provider: /v1/models advertises chat+embed ids", models.data.some((m) => m.id === "fixture-chat-v1") && models.data.some((m) => m.id === "fixture-embed-v1"));

  // Runtime script install: replaces the script and resets the step pointer.
  const installed = await fetch(`${ready.origin}/fixture/script`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ steps: [{ type: "text", pieces: ["run", "time"] }, { type: "http_error", status: 418 }], on_exhausted: "fail" }),
  });
  const installedBody = await installed.json();
  ok("provider: runtime script install accepted", installed.status === 200 && installedBody.ok === true && installedBody.steps === 2);
  const replay = parseSseFrames((await chat()).raw)
    .map((frame) => frame.json?.choices?.[0]?.delta?.content ?? "")
    .join("");
  ok("provider: runtime script replays from reset pointer", replay === "runtime");
  const teapot = await chat();
  ok("provider: installed http_error step served after the text step", teapot.response.status === 418);
  const badScript = await fetch(`${ready.origin}/fixture/script`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ steps: [{ nope: true }] }),
  });
  ok("provider: invalid runtime script rejected 400", badScript.status === 400);

  ok("provider: unknown path is 404", (await fetch(`${ready.origin}/v1/completions`, { method: "POST", body: "{}" })).status === 404);

  const state = await (await fetch(`${ready.origin}/fixture/state`)).json();
  const chatAuth = state.auth.filter((record) => record.endpoint === "chat");
  ok("provider: auth headers recorded without values", chatAuth.length >= 2 && chatAuth[0].present === true && chatAuth[0].scheme === "bearer" && !JSON.stringify(state).includes(SECRET));

  const stopped = await stopFixture(fixture);
  ok("provider: SIGTERM exit 0 with PID gone", stopped.exited?.code === 0 && stopped.gone);
}

async function groupMcpStdio() {
  const fixture = spawnFixture("mcp-stdio-core", "mcp-server-stdio.mjs", {}, { readyFromStdout: false });
  const rpc = stdioRpc(fixture.child);
  const init = await rpc.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "selftest", version: "1" } });
  ok("mcp-stdio: initialize handshake", init.result?.serverInfo?.name === "borealis-e2e-mcp-stdio" && init.result?.protocolVersion === MCP_PROTOCOL_VERSION);
  rpc.notify("notifications/initialized", {});
  const list = await rpc.request("tools/list", {});
  const names = (list.result?.tools ?? []).map((tool) => tool.name);
  ok("mcp-stdio: six core tools listed", JSON.stringify(names) === JSON.stringify(["echo_query", "finance_sum", "record_note", "big_result", "weird_schema", "slow_snooze"]));
  const tools = list.result.tools;
  const weird = tools.find((tool) => tool.name === "weird_schema");
  ok("mcp-stdio: unsupported input-schema shape advertised", weird?.inputSchema?.properties?.matrix?.type === "hypercube");
  ok(
    "mcp-stdio: read-only vs write-flag annotations",
    tools.find((t) => t.name === "echo_query")?.annotations?.readOnlyHint === true && tools.find((t) => t.name === "record_note")?.annotations?.readOnlyHint === false
  );
  const sum = await rpc.request("tools/call", { name: "finance_sum", arguments: { x: 2, y: 40 } });
  ok("mcp-stdio: finance_sum(2,40)=42", sum.result?.content?.[0]?.text === "42");
  const big = await rpc.request("tools/call", { name: "big_result", arguments: {} });
  ok("mcp-stdio: big_result exceeds 64 KiB", (big.result?.content?.[0]?.text.length ?? 0) > 65_536);

  // Clean child exit proof: close stdin, expect exit 0 and ESRCH afterwards.
  const stdinStop = await stopFixture(fixture, { viaStdinClose: true });
  ok("mcp-stdio: stdin close => exit 0, no orphan PID", stdinStop.exited?.code === 0 && stdinStop.gone);

  // Bulk discovery + fast sleep override.
  const bulk = spawnFixture("mcp-stdio-bulk", "mcp-server-stdio.mjs", { E2E_MCP_BULK_TOOLS: "195", E2E_MCP_SLOW_MS: "120" }, { readyFromStdout: false });
  const bulkRpc = stdioRpc(bulk.child);
  await bulkRpc.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "selftest", version: "1" } });
  bulkRpc.notify("notifications/initialized", {});
  const bulkList = await bulkRpc.request("tools/list", {});
  ok("mcp-stdio: bulk toggle pushes tools/list over 200", (bulkList.result?.tools?.length ?? 0) === 201);
  const sleepStart = Date.now();
  const slept = await bulkRpc.request("tools/call", { name: "slow_snooze", arguments: {} }, 8_000);
  ok("mcp-stdio: slow path sleeps (overridden) then answers", slept.result?.content?.[0]?.text === "slept" && Date.now() - sleepStart >= 100);
  const bulkStop = await stopFixture(bulk);
  ok("mcp-stdio: SIGTERM exit 0 with PID gone", bulkStop.exited?.code === 0 && bulkStop.gone);
}

async function groupMcpHttp() {
  const fixture = spawnFixture("mcp-http", "mcp-server-http.mjs", { E2E_MCP_BEARER: "bearer-token-123" });
  const ready = await fixture.ready;
  ok("mcp-http: ready line advertises bearer", ready.fixture === "mcp-server-http" && ready.auth_required === "bearer" && ready.endpoint === `${ready.origin}/mcp`);

  const anonymous = await mcpInitialize(ready.endpoint);
  ok("mcp-http: 401 without token", anonymous.status === 401 && String(anonymous.wwwAuth).startsWith("Bearer"));
  const wrong = await mcpInitialize(ready.endpoint, { token: "wrong-token" });
  ok("mcp-http: 401 with wrong token", wrong.status === 401);

  const init = await mcpInitialize(ready.endpoint, { token: "bearer-token-123" });
  ok("mcp-http: initialize with token establishes session", init.status === 200 && !!init.sessionId && init.body?.result?.serverInfo?.name === "borealis-e2e-mcp-http");
  const notif = await mcpPost(ready.endpoint, init.sessionId, { jsonrpc: "2.0", method: "notifications/initialized" }, { token: "bearer-token-123" });
  ok("mcp-http: initialized notification accepted", notif.status === 202);
  const list = await mcpPost(ready.endpoint, init.sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { token: "bearer-token-123" });
  ok("mcp-http: same toolset as stdio", JSON.stringify((list.body?.result?.tools ?? []).map((t) => t.name)) === JSON.stringify(["echo_query", "finance_sum", "record_note", "big_result", "weird_schema", "slow_snooze"]));
  const call = await mcpPost(ready.endpoint, init.sessionId, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo_query", arguments: { text: "selftest" } } }, { token: "bearer-token-123" });
  ok("mcp-http: echo_query call round-trips", call.body?.result?.content?.[0]?.text === "result: selftest");
  const noSession = await mcpPost(ready.endpoint, null, { jsonrpc: "2.0", id: 4, method: "tools/list" }, { token: "bearer-token-123" });
  ok("mcp-http: non-initialize without session rejected", noSession.status === 400);

  const oauth = spawnFixture("mcp-http-oauth", "mcp-server-http.mjs", { E2E_MCP_OAUTH_CHALLENGE: "1", E2E_MCP_ISSUER_ORIGIN: "http://127.0.0.1:9" });
  const oauthReady = await oauth.ready;
  const challenge = await mcpInitialize(oauthReady.endpoint);
  ok("mcp-http: oauth mode 401 + resource_metadata challenge", challenge.status === 401 && String(challenge.wwwAuth).includes('resource_metadata="http://127.0.0.1:9/.well-known/oauth-authorization-server"'));
  const prm = await fetch(`${oauthReady.origin}/.well-known/oauth-protected-resource`);
  ok("mcp-http: protected-resource metadata served", prm.status === 200);

  // Full OAuth verification mode: only an active issuer-minted bearer token
  // serves MCP; everything else keeps receiving the OAuth challenge.
  const issuer = spawnFixture("oauth-issuer-for-mcp", "oauth-issuer.mjs", {});
  const issuerReady = await issuer.ready;
  const verify = spawnFixture("mcp-http-oauth-verify", "mcp-server-http.mjs", { E2E_MCP_OAUTH_VERIFY: "1", E2E_MCP_ISSUER_ORIGIN: issuerReady.origin });
  const verifyReady = await verify.ready;
  const unverified = await mcpInitialize(verifyReady.endpoint);
  ok("mcp-http: verify mode 401 + challenge without a bearer", unverified.status === 401 && String(unverified.wwwAuth).includes("resource_metadata="));
  const verifyRedirect = "http://127.0.0.1:1/callback";
  const vReg = await (await fetch(`${issuerReady.origin}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [verifyRedirect] }) })).json();
  const vVerifier = b64url(randomBytes(48));
  const vChallenge = b64url(createHash("sha256").update(vVerifier).digest());
  const vApproved = await fetch(`${issuerReady.origin}/authorize?response_type=code&client_id=${vReg.client_id}&redirect_uri=${encodeURIComponent(verifyRedirect)}&state=verify-state&code_challenge=${vChallenge}&code_challenge_method=S256`, { redirect: "manual" });
  const vCode = new URL(vApproved.headers.get("location")).searchParams.get("code");
  const vTokenRes = await fetch(`${issuerReady.origin}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: vCode, client_id: vReg.client_id, redirect_uri: verifyRedirect, code_verifier: vVerifier }) });
  const vTokens = await vTokenRes.json();
  const verifiedInit = await mcpInitialize(verifyReady.endpoint, { token: vTokens.access_token });
  ok("mcp-http: verify mode serves MCP with an active issuer token", verifiedInit.status === 200 && !!verifiedInit.sessionId);
  const inactiveInit = await mcpInitialize(verifyReady.endpoint, { token: "not-an-active-token" });
  ok("mcp-http: verify mode rejects an inactive token", inactiveInit.status === 401);

  const stopMain = await stopFixture(fixture);
  const stopOauth = await stopFixture(oauth);
  const stopIssuer = await stopFixture(issuer);
  const stopVerify = await stopFixture(verify);
  ok(
    "mcp-http: SIGTERM exit 0 with PIDs gone",
    stopMain.exited?.code === 0 && stopMain.gone && stopOauth.exited?.code === 0 && stopOauth.gone && stopIssuer.exited?.code === 0 && stopIssuer.gone && stopVerify.exited?.code === 0 && stopVerify.gone
  );
}

async function groupOauth() {
  const fixture = spawnFixture("oauth-issuer", "oauth-issuer.mjs", { E2E_OAUTH_ACCESS_TTL_SECONDS: "2" });
  const ready = await fixture.ready;
  const redirectUri = "http://127.0.0.1:1/callback";

  const discovery = await (await fetch(`${ready.origin}/.well-known/oauth-authorization-server`)).json();
  ok(
    "issuer: RFC8414 metadata",
    discovery.issuer === ready.origin && discovery.code_challenge_methods_supported?.includes("S256") && discovery.registration_endpoint?.endsWith("/register") && discovery.revocation_endpoint?.endsWith("/revoke")
  );

  const registration = await (await fetch(`${ready.origin}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri] }) })).json();
  ok("issuer: dynamic client registration", typeof registration.client_id === "string" && registration.client_id.length > 8);

  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const authorizeUrl = (clientId, state) =>
    `${ready.origin}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;

  const approved = await fetch(authorizeUrl(registration.client_id, "state-1"), { redirect: "manual" });
  const location = new URL(approved.headers.get("location"));
  ok("issuer: approve redirects with code + state", approved.status === 302 && !!location.searchParams.get("code") && location.searchParams.get("state") === "state-1");
  const code = location.searchParams.get("code");

  const unknownClient = await fetch(`${ready.origin}/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`);
  ok("issuer: unknown client rejected without redirect", unknownClient.status === 400 && !unknownClient.headers.get("location"));

  const exchange = (body) => fetch(`${ready.origin}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const badVerifier = await exchange({ grant_type: "authorization_code", code, client_id: registration.client_id, redirect_uri: redirectUri, code_verifier: "incorrect-verifier-value" });
  ok("issuer: wrong PKCE verifier rejected", badVerifier.status === 400 && (await badVerifier.json()).error === "invalid_grant");

  const approved2 = await fetch(authorizeUrl(registration.client_id, "state-2"), { redirect: "manual" });
  const code2 = new URL(approved2.headers.get("location")).searchParams.get("code");
  const tokens = await exchange({ grant_type: "authorization_code", code: code2, client_id: registration.client_id, redirect_uri: redirectUri, code_verifier: verifier });
  const tokenBody = await tokens.json();
  ok("issuer: code exchange issues short-lived tokens", tokens.status === 200 && !!tokenBody.access_token && tokenBody.token_type === "Bearer" && tokenBody.expires_in === 2);

  const introspect = async (token) =>
    (await fetch(`${ready.origin}/token/introspect`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) })).json();
  const active = (await introspect(tokenBody.access_token)).active;
  ok("issuer: fresh access token is active", active === true);

  const rotated = await (await exchange({ grant_type: "refresh_token", refresh_token: tokenBody.refresh_token })).json();
  const reused = await exchange({ grant_type: "refresh_token", refresh_token: tokenBody.refresh_token });
  ok("issuer: refresh rotates and old token is single-use", !!rotated.refresh_token && rotated.refresh_token !== tokenBody.refresh_token && reused.status === 400 && (await reused.json()).error === "invalid_grant");

  let expiredSeen = false;
  const expiryDeadline = Date.now() + 5_000;
  while (Date.now() < expiryDeadline && !expiredSeen) {
    expiredSeen = !(await introspect(rotated.access_token)).active;
    if (!expiredSeen) await new Promise((r) => setTimeout(r, 200));
  }
  ok("issuer: access token expires at configured TTL", expiredSeen);

  const revoked = await fetch(`${ready.origin}/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: rotated.refresh_token }) });
  const afterRevoke = await exchange({ grant_type: "refresh_token", refresh_token: rotated.refresh_token });
  ok("issuer: revocation endpoint invalidates refresh token", revoked.status === 200 && afterRevoke.status === 400);

  const denyFixture = spawnFixture("oauth-issuer-deny", "oauth-issuer.mjs", { E2E_OAUTH_AUTHORIZE_MODE: "deny" });
  const denyReady = await denyFixture.ready;
  const denyReg = await (await fetch(`${denyReady.origin}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri] }) })).json();
  const denied = await fetch(`${denyReady.origin}/authorize?response_type=code&client_id=${denyReg.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&state=deny-state&code_challenge=${challenge}&code_challenge_method=S256`, { redirect: "manual" });
  const deniedLocation = new URL(denied.headers.get("location"));
  ok("issuer: deny mode returns access_denied + state", denied.status === 302 && deniedLocation.searchParams.get("error") === "access_denied" && deniedLocation.searchParams.get("state") === "deny-state");

  const stopMain = await stopFixture(fixture);
  const stopDeny = await stopFixture(denyFixture);
  ok("issuer: SIGTERM exit 0 with PIDs gone", stopMain.exited?.code === 0 && stopMain.gone && stopDeny.exited?.code === 0 && stopDeny.gone);
}

async function groupWebdav() {
  const basic = "Basic " + Buffer.from("e2e-user:e2e-pass").toString("base64");
  const wrong = "Basic " + Buffer.from("e2e-user:nope").toString("base64");
  const fixture = spawnFixture("webdav", "webdav.mjs", {});
  const ready = await fixture.ready;
  const auth = { Authorization: basic };

  const anonymous = await fetch(`${ready.origin}/readme.md`);
  ok("webdav: 401 without credentials (Basic challenge)", anonymous.status === 401 && String(anonymous.headers.get("www-authenticate")).startsWith("Basic"));
  ok("webdav: 401 with wrong credentials", (await fetch(`${ready.origin}/readme.md`, { headers: { Authorization: wrong } })).status === 401);

  const get = await fetch(`${ready.origin}/readme.md`, { headers: auth });
  ok("webdav: authenticated GET serves bytes", get.status === 200 && (await get.text()).startsWith("# WebDAV"));

  const propfind = await fetch(`${ready.origin}/`, { method: "PROPFIND", headers: { ...auth, Depth: "1" } });
  const xml = await propfind.text();
  ok(
    "webdav: PROPFIND Depth 1 returns valid multistatus",
    propfind.status === 207 && xml.startsWith("<d:multistatus") && xml.endsWith("</d:multistatus>") && xml.includes("readme.md") && xml.includes("ledger.csv") && xml.includes("notes") && !xml.includes("gamma")
  );
  const depthRejected = await fetch(`${ready.origin}/`, { method: "PROPFIND", headers: { ...auth, Depth: "infinity" } });
  ok("webdav: unsupported Depth rejected", depthRejected.status === 400);

  const put = await fetch(`${ready.origin}/delta.md`, { method: "PUT", headers: { ...auth, "Content-Type": "text/plain" }, body: "delta content" });
  const found = (await (await fetch(`${ready.origin}/`, { method: "PROPFIND", headers: { ...auth, Depth: "1" } })).text()).includes("delta.md");
  const del = await fetch(`${ready.origin}/delta.md`, { method: "DELETE", headers: auth });
  const afterDelete = await fetch(`${ready.origin}/delta.md`, { headers: auth });
  ok("webdav: PUT/PROPFIND/DELETE/404 lifecycle", put.status === 201 && found && del.status === 204 && afterDelete.status === 404);

  const traversal = await fetch(`${ready.origin}/redirect/../%2e%2e/etc/passwd`, { headers: auth });
  ok("webdav: traversal rejected", traversal.status === 400 || traversal.status === 401 || traversal.status === 404);

  const redirect = await fetch(`${ready.origin}/redirect/readme.md`, { headers: auth, redirect: "manual" });
  const location = redirect.headers.get("location") ?? "";
  ok("webdav: 301 to second origin without credentials", redirect.status === 301 && location.startsWith(ready.redirect_origin) && !location.includes("@"));
  const followed = await fetch(location);
  ok("webdav: redirect target refuses credentialless follow", followed.status === 401);

  const malformed = spawnFixture("webdav-malformed", "webdav.mjs", { E2E_WEBDAV_XML_MODE: "malformed" });
  const malformedReady = await malformed.ready;
  const malformedXml = await (await fetch(`${malformedReady.origin}/`, { method: "PROPFIND", headers: { ...auth, Depth: "1" } })).text();
  ok("webdav: malformed-XML mode yields non-well-formed 207", !malformedXml.endsWith("</d:multistatus>"));

  const hostile = spawnFixture("webdav-hostile", "webdav.mjs", { E2E_WEBDAV_XML_MODE: "hostile" });
  const hostileReady = await hostile.ready;
  const hostileXml = await (await fetch(`${hostileReady.origin}/`, { method: "PROPFIND", headers: { ...auth, Depth: "1" } })).text();
  ok("webdav: hostile mode embeds ENTITY/DOCTYPE for client refusal", hostileXml.includes("<!DOCTYPE") && hostileXml.includes("&boom;"));

  const delayed = spawnFixture("webdav-delay", "webdav.mjs", { E2E_WEBDAV_DELAY_MS: "150" });
  const delayedReady = await delayed.ready;
  const delayStart = Date.now();
  await fetch(`${delayedReady.origin}/readme.md`, { headers: auth });
  ok("webdav: configurable response delay", Date.now() - delayStart >= 100);

  for (const entry of [fixture, malformed, hostile, delayed]) {
    const stopped = await stopFixture(entry);
    ok(`webdav: ${entry.name} SIGTERM exit 0 with PID gone`, stopped.exited?.code === 0 && stopped.gone);
  }
}

async function groupCorpus() {
  const committedDir = join(REPO_ROOT, "data", "e2e", "supplier-corpus");
  const manifest = JSON.parse(await readFile(join(committedDir, "manifest.json"), "utf8"));

  // Byte-stability: regenerate into a temp dir and compare every file.
  const tempDir = await mkdtemp(join(tmpdir(), "borealis-corpus-selftest-"));
  const generator = spawn(process.execPath, [join(REPO_ROOT, "data", "e2e", "generate_supplier_corpus.mjs"), "--out", tempDir], { stdio: ["ignore", "pipe", "pipe"] });
  const genCode = await new Promise((resolveExit) => generator.once("exit", resolveExit));
  const committedFiles = (await readdir(committedDir)).sort();
  const regenerated = (await readdir(tempDir)).sort();
  let byteIdentical = genCode === 0 && JSON.stringify(committedFiles) === JSON.stringify(regenerated);
  if (byteIdentical) {
    for (const file of committedFiles) {
      const [a, b] = await Promise.all([readFile(join(committedDir, file)), readFile(join(tempDir, file))]);
      if (!a.equals(b)) byteIdentical = false;
    }
  }
  await rm(tempDir, { recursive: true, force: true });
  ok("corpus: generator regenerates byte-identical outputs", byteIdentical);

  let hashMatches = manifest.documents.length === 10;
  for (const document of manifest.documents) {
    const actual = await sha256(join(committedDir, document.file));
    if (actual !== document.sha256) hashMatches = false;
  }
  ok("corpus: committed manifest hashes match on-disk bytes", hashMatches);

  const doc = (file) => manifest.documents.find((entry) => entry.file === file);
  const conflict = manifest.facts.conflicts[0];
  ok(
    "corpus: declared conflict + missing + image-only + unsupported facts",
    conflict?.supplier === "acme-logistics" && conflict?.field === "price" && conflict?.values.length === 2 && manifest.facts.missing_fields.length === 1 && manifest.facts.image_only.length === 1 && manifest.facts.unsupported.length === 1
  );
  ok("corpus: field values agree between manifest and documents", doc("01_acme_logistics_agreement.md").fields.price.value === 12000 && doc("02_acme_renewal_quote.md").fields.price.value === 13500 && doc("04_blueriver_change_order.md").fields.exceptions === null && doc("05_cedarcloud_hosting.pdf").fields.price.currency === "EUR");

  const textPdf = await readFile(join(committedDir, "03_blueriver_msa.pdf"));
  const imagePdf = await readFile(join(committedDir, "10_acme_scanned_invoice.pdf"));
  const rtf = await readFile(join(committedDir, "08_delta_renewal_memo.rtf"));
  ok(
    "corpus: PDF structure — text PDF shows glyphs, image-only PDF has raster + no text operators",
    textPdf.includes("BT") && textPdf.includes("(PRICE: 8750 USD) Tj") && imagePdf.includes("/Subtype /Image") && !imagePdf.includes("BT") && !imagePdf.includes("Tj") && imagePdf.subarray(0, 8).toString("binary").startsWith("%PDF-1.7")
  );
  ok("corpus: unsupported RTF carries the hidden price that extraction must never surface", rtf.includes("price: 4600 usd"));

  const financeDir = join(REPO_ROOT, "data", "e2e", "finance-brief-fixture");
  const financeManifest = JSON.parse(await readFile(join(financeDir, "manifest.json"), "utf8"));
  let financeHashes = true;
  for (const [file, meta] of Object.entries(financeManifest.files)) {
    if ((await sha256(join(financeDir, file))) !== meta.sha256) financeHashes = false;
  }
  const sumOf = async (file) =>
    (await readFile(join(financeDir, file), "utf8"))
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .reduce((sum, line) => sum + Number(line.split(",")[2]), 0);
  ok(
    "finance fixture: hashes stable, SUM 100 base / 125 changed",
    financeHashes && (await sumOf("brief_inputs.csv")) === financeManifest.expected.brief_inputs_csv_total && (await sumOf("brief_inputs_changed.csv")) === financeManifest.expected.brief_inputs_changed_csv_total
  );
}

async function groupFinanceAggregates() {
  const helper = await import("./lib/finance-expected.mjs");
  const transactions = await readFile(join(REPO_ROOT, "data", "sample", "transactions.csv"), "utf8");
  const mismatches = helper.verifyCommittedExpected(transactions);
  ok(
    "finance aggregates: runtime recomputation equals the committed expected values",
    mismatches.length === 0
  );
  const june = helper.expectedAnalysisRows(transactions, "2025-06");
  ok(
    "finance aggregates: June expected rows shape and probes",
    june.length === helper.COMMITTED_EXPECTED.june_keys &&
      june.every(
        ([month, , , , formulaProbe, quoteProbe]) =>
          month === "2025-06" && formulaProbe === `=${month}|Borealis-E2E` && quoteProbe === `"low, ${month}"`
      ) &&
      june[0][1] === "Dining out"
  );
  const marker = helper.withMarker(transactions);
  const changedJune = helper
    .expectedAnalysisRows(marker, "2025-06")
    .find(([month, category]) => month === "2025-06" && category === "Groceries");
  ok(
    "finance aggregates: deterministic marker applies exactly one group",
    changedJune[2] === helper.COMMITTED_EXPECTED.june_groceries_tx_count + helper.COMMITTED_EXPECTED.marker_delta_tx_count &&
      Math.abs(changedJune[3] - (helper.COMMITTED_EXPECTED.june_groceries_net + helper.COMMITTED_EXPECTED.marker_delta_net)) < 1e-9 &&
      helper.expectedAnalysisRows(marker, "2025-05").length === helper.COMMITTED_EXPECTED.may_keys
  );
}

/* ============================================================ orchestration */

const groups = [
  ["provider", groupProvider],
  ["mcp-stdio", groupMcpStdio],
  ["mcp-http", groupMcpHttp],
  ["issuer", groupOauth],
  ["webdav", groupWebdav],
  ["corpus", groupCorpus],
  ["finance", groupFinanceAggregates],
];

const watchdog = setTimeout(() => {
  process.stdout.write("FAIL selftest: watchdog timeout\n");
  process.exitCode = 1;
}, 90_000);

let crashed = null;
try {
  for (const [name, run] of groups) {
    if (only && only !== name) continue;
    await run();
  }
} catch (error) {
  crashed = error?.message ?? String(error);
} finally {
  clearTimeout(watchdog);
  // Child-only teardown: anything still running is one of our fixtures.
  for (const entry of children) {
    if (entry.child.exitCode === null && entry.child.signalCode === null) {
      try {
        entry.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  // Give SIGKILL a beat, then prove no tracked PID survives.
  await new Promise((r) => setTimeout(r, 300));
  const leaked = children.filter((entry) => pidAlive(entry.pid));
  if (leaked.length > 0) {
    process.stdout.write(`FAIL child-pid-cleanup leaked=${leaked.map((e) => e.name).join(",")}\n`);
    failures.push("child-pid-cleanup");
  }
}

if (crashed) {
  process.stdout.write(`FAIL run-crashed ${crashed.slice(0, 120)}\n`);
  process.exitCode = 1;
} else if (failures.length > 0) {
  process.stdout.write(`fixture selftest FAILED (${failures.length}/${checks})\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`fixture selftest PASS (${checks} checks)\n`);
}
