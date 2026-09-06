import Fastify, { type FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signToken } from "../auth.js";
import { closeConnectionService, configureConnectionService } from "../connections/service.js";
import { FileConnectionSecretStore, FileKeyCustody } from "../connections/secrets.js";
import { installHttpBoundary } from "../httpErrors.js";
import {
  McpToolArgumentsInvalidError,
  McpToolSchemaUnsupportedError,
  McpToolTimeoutError,
  callMcpTool,
  isMcpToolSchemaSupported,
  mcpTransportProvider,
  quiesceMcpConnections,
  type McpTransportSession,
  type McpTransportTarget,
} from "../mcp/client.js";
import { connectionRoutes } from "../routes/connections.js";
import { closeStorageRuntime, initializeStorageRuntime } from "../storageRuntime.js";

/**
 * Stage-2 MCP transport integration: real `@modelcontextprotocol/sdk`
 * transports driven against the committed standalone protocol fixtures
 * (`scripts/e2e/fixtures/mcp-server-{stdio,http}.mjs`). No SDK mocking:
 * discovery, calls, timeouts, cancellation, over-limit catalogs, malformed
 * results, credential binding, redirect refusal, and stdio child ownership
 * all run over real sockets and real spawned children. Every pid this file
 * learns about (fixture or MCP child) is asserted gone.
 */

const REPO_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const FIXTURES = path.join(REPO_ROOT, "scripts/e2e/fixtures");
const STDIO_FIXTURE = path.join(FIXTURES, "mcp-server-stdio.mjs");
const HTTP_FIXTURE = path.join(FIXTURES, "mcp-server-http.mjs");
const SDK_ESM = path.join(REPO_ROOT, "server/node_modules/@modelcontextprotocol/sdk/dist/esm");

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const ECHO_SCHEMA = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const SUM_SCHEMA = {
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
};
const EMPTY_SCHEMA = { type: "object", properties: {} };

const spawnedPids: number[] = [];
const cleanups: Array<() => Promise<void>> = [];
const tempDirectories: string[] = [];

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
    if (Date.now() >= deadline) {
      throw new Error(`pid ${pid} survived the test (leaked process)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function expectAllSpawnedGone(): Promise<void> {
  const pids = spawnedPids.splice(0);
  for (const pid of pids) await expectGone(pid);
}

function httpTarget(url: string, bearer?: string): McpTransportTarget {
  return {
    accountId: ACCOUNT_ID,
    connectionId: CONNECTION_ID,
    kind: "mcp_http",
    config: { kind: "mcp_http", url },
    secrets: bearer === undefined ? undefined : { headers: { authorization: `Bearer ${bearer}` }, env: {} },
  };
}

function stdioTarget(
  env: Record<string, string> = {},
  overrides: Partial<McpTransportTarget> = {}
): McpTransportTarget {
  return {
    accountId: ACCOUNT_ID,
    connectionId: CONNECTION_ID,
    kind: "mcp_stdio",
    config: { kind: "mcp_stdio", command: process.execPath, args: [STDIO_FIXTURE], cwd: null },
    secrets: Object.keys(env).length === 0 ? undefined : { headers: {}, env },
    ...overrides,
  };
}

interface RunningHttpFixture {
  readonly url: string;
  readonly port: number;
  readonly pid: number;
  stop(): Promise<void>;
}

function startHttpFixture(env: Record<string, string> = {}): Promise<RunningHttpFixture> {
  const child = spawn(process.execPath, [HTTP_FIXTURE], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("fixture spawn has no pid");
  spawnedPids.push(pid);
  child.stderr?.resume();
  const stop = async (): Promise<void> => {
    child.kill("SIGTERM");
    await expectGone(pid);
  };
  const ready = new Promise<{ endpoint: string; port: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture ready timeout")), 15_000);
    timer.unref?.();
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (piece: string) => {
      buffer += piece;
      const line = buffer.split("\n").find((candidate) => candidate.trim().length > 0);
      if (!line) return;
      try {
        const parsed = JSON.parse(line) as { endpoint: string };
        const url = new URL(parsed.endpoint);
        clearTimeout(timer);
        resolve({ endpoint: parsed.endpoint, port: url.port ? Number(url.port) : 80 });
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
  return ready.then((info) => ({ url: info.endpoint, port: info.port, pid, stop }));
}

async function withSession<T>(
  target: McpTransportTarget,
  run: (session: McpTransportSession) => Promise<T>
): Promise<T> {
  const session = await mcpTransportProvider().connect(target, AbortSignal.timeout(15_000));
  try {
    return await run(session);
  } finally {
    await session.close().catch(() => undefined);
  }
}

/** Write a small SDK-backed stdio server used for pagination/malformed tests. */
async function writeCustomStdioServer(body: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-mcp-custom-"));
  tempDirectories.push(directory);
  const file = path.join(directory, "server.mjs");
  const esm = (rel: string) => `file://${path.join(SDK_ESM, rel)}`;
  await fs.writeFile(
    file,
    `import { Server } from "${esm("server/index.js")}";
import { StdioServerTransport } from "${esm("server/stdio.js")}";
import { ListToolsRequestSchema, CallToolRequestSchema } from "${esm("types.js")}";
${body}
const server = new Server({ name: "borealis-test", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, listHandler);
server.setRequestHandler(CallToolRequestSchema, callHandler);
const transport = new StdioServerTransport();
transport.onclose = () => process.exit(0);
await server.connect(transport);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`,
    "utf8"
  );
  return file;
}

const PAGINATED_BODY = `
const listHandler = async (request) =>
  request.params?.cursor === "page-2"
    ? { tools: [
        { name: "gamma", description: "g", inputSchema: { type: "object", properties: {} } },
        { name: "delta", description: "d", inputSchema: { type: "object", properties: {} } },
      ] }
    : { tools: [
        { name: "alpha", description: "a", inputSchema: { type: "object", properties: {} } },
        { name: "beta", description: "b", inputSchema: { type: "object", properties: {} } },
      ], nextCursor: "page-2" };
const callHandler = async () => ({ content: [{ type: "text", text: "unused" }] });
`;

const MALFORMED_BODY = `
const listHandler = async () => ({
  tools: [
    { name: "malformed", description: "m", inputSchema: { type: "object", properties: {} } },
    { name: "flagged", description: "f", inputSchema: { type: "object", properties: {} } },
  ],
});
const callHandler = async (request) =>
  request.params?.name === "flagged"
    ? { isError: true, content: [{ type: "text", text: "flagged failure" }] }
    : { content: [{ type: "totally-unknown-block" }] };
`;

afterEach(async () => {
  await quiesceMcpConnections();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await expectAllSpawnedGone();
  const directories = tempDirectories.splice(0);
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
});

describe("MCP Streamable HTTP transport", () => {
  it("initializes, lists, and calls over the real fixture with a bearer token", async () => {
    const bearer = "integration-bearer-token";
    const fixture = await startHttpFixture({ E2E_MCP_BEARER: bearer });
    cleanups.push(() => fixture.stop());

    const tools = await withSession(httpTarget(fixture.url, bearer), (session) =>
      session.listTools(AbortSignal.timeout(15_000))
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      "echo_query",
      "finance_sum",
      "record_note",
      "big_result",
      "weird_schema",
      "slow_snooze",
    ]);
    expect(tools[0]?.input_schema).toMatchObject({ type: "object", required: ["text"] });

    const outcome = await callMcpTool(
      httpTarget(fixture.url, bearer),
      { name: "echo_query", input_schema: ECHO_SCHEMA, arguments: { text: "stage 2" } },
      { deadlineMs: 20_000 }
    );
    expect(outcome).toMatchObject({ ok: true, text: "result: stage 2", unsupported_content: [] });
  }, 40_000);

  it("maps a 401 endpoint to the actionable auth error", async () => {
    const fixture = await startHttpFixture({ E2E_MCP_BEARER: "correct-token" });
    cleanups.push(() => fixture.stop());
    // Wrong bearer and no bearer both end in the stable auth signal.
    for (const target of [httpTarget(fixture.url, "wrong-token"), httpTarget(fixture.url)]) {
      const session = await mcpTransportProvider()
        .connect(target, AbortSignal.timeout(15_000))
        .then(
          (opened) => {
            void opened.close().catch(() => undefined);
            return null;
          },
          (error: unknown) => error as Error & { code?: string }
        );
      expect(session, "expected an unauthenticated connect to reject").not.toBeNull();
      expect((session as Error & { code?: string }).code).toBe("CONNECTION_AUTH_REQUIRED");
    }
  }, 40_000);

  it("never follows redirects and never replays credentials to the redirect target", async () => {
    const finalHits: Array<{ authorization: string | undefined }> = [];
    const redirectHits: Array<{ authorization: string | undefined }> = [];
    const finalServer = http.createServer((request, response) => {
      finalHits.push({ authorization: request.headers.authorization });
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => finalServer.listen(0, "127.0.0.1", () => resolve()));
    const finalPort = (finalServer.address() as net.AddressInfo).port;
    const redirector = http.createServer((request, response) => {
      redirectHits.push({ authorization: request.headers.authorization });
      response.writeHead(302, { Location: `http://127.0.0.1:${finalPort}/mcp` });
      response.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(
      () => new Promise<void>((resolve, reject) => redirector.close((error) => (error ? reject(error) : resolve())))
    );
    cleanups.push(
      () => new Promise<void>((resolve, reject) => finalServer.close((error) => (error ? reject(error) : resolve())))
    );

    const redirectPort = (redirector.address() as net.AddressInfo).port;
    await expect(
      withSession(httpTarget(`http://127.0.0.1:${redirectPort}/mcp`, "bound-secret"), (session) =>
        session.listTools(AbortSignal.timeout(10_000))
      )
    ).rejects.toMatchObject({ code: "CONNECTION_HANDSHAKE_FAILED" });
    expect(redirectHits.length).toBeGreaterThan(0);
    expect(redirectHits[0]?.authorization).toBe("Bearer bound-secret");
    // The credential never rides the redirect.
    expect(finalHits).toHaveLength(0);
  }, 40_000);

  it("enforces the loopback-vs-HTTPS connection boundary", async () => {
    // Plain HTTP is refused for non-development hosts before any socket.
    await expect(
      withSession(httpTarget("http://203.0.113.10/mcp"), (session) => session.listTools(AbortSignal.abort()))
    ).rejects.toMatchObject({ code: "CONNECTION_CONFIG_INVALID" });
    // HTTPS is scheme-legal even to loopback: a TLS handshake against the
    // plain-HTTP fixture must fail closed (certificate validation intact).
    const fixture = await startHttpFixture();
    cleanups.push(() => fixture.stop());
    const httpsUrl = fixture.url.replace("http://", "https://");
    await expect(
      withSession(httpTarget(httpsUrl), (session) => session.listTools(AbortSignal.timeout(15_000)))
    ).rejects.toMatchObject({ code: "CONNECTION_HANDSHAKE_FAILED" });
  }, 40_000);

  it("honors caller abort during connect against a silent endpoint", async () => {
    const blackhole = net.createServer();
    const sockets = new Set<net.Socket>();
    blackhole.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      /* accept and never answer: only the caller's abort can end this */
    });
    await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", () => resolve()));
    const port = (blackhole.address() as net.AddressInfo).port;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          blackhole.close(() => resolve());
        })
    );
    await expect(
      mcpTransportProvider().connect(httpTarget(`http://127.0.0.1:${port}/mcp`), AbortSignal.timeout(400))
    ).rejects.toSatisfy(
      (error: unknown) =>
        (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) ||
        (error as { code?: string }).code === "CONNECTION_HANDSHAKE_FAILED"
    );
  }, 20_000);

  it("paginates tools/list through cursor continuation", async () => {
    const serverFile = await writeCustomStdioServer(PAGINATED_BODY);
    const target = stdioTarget(
      {},
      {
        config: { kind: "mcp_stdio", command: process.execPath, args: [serverFile], cwd: null },
      }
    );
    const tools = await withSession(target, (session) => session.listTools(AbortSignal.timeout(15_000)));
    expect(tools.map((tool) => tool.name)).toEqual(["alpha", "beta", "gamma", "delta"]);
  }, 40_000);

  it("reports bulk 201-tool catalogs as an explicit over-limit discovery", async () => {
    const target = stdioTarget({ E2E_MCP_BULK_TOOLS: "195" });
    await expect(
      withSession(target, (session) => session.listTools(AbortSignal.timeout(15_000)))
    ).rejects.toMatchObject({ code: "CONNECTION_DISCOVERY_OVER_LIMIT" });
  }, 40_000);
});

describe("MCP stdio transport", () => {
  it("spawns, calls, and proves child exit on disconnect", async () => {
    const session = await mcpTransportProvider().connect(stdioTarget(), AbortSignal.timeout(15_000));
    const pid = session.childPid;
    expect(pid).toBeTypeOf("number");
    expect(pidAlive(pid as number)).toBe(true);
    try {
      const tools = await session.listTools(AbortSignal.timeout(15_000));
      expect(tools).toHaveLength(6);
      const sum = await session.callTool!(
        { name: "finance_sum", input_schema: SUM_SCHEMA, arguments: { x: 2, y: 5 } },
        AbortSignal.timeout(15_000)
      );
      expect(sum).toMatchObject({ ok: true, text: "7", unsupported_content: [] });
      // Argument validation happens client-side against the snapshot.
      await expect(
        session.callTool!(
          { name: "finance_sum", input_schema: SUM_SCHEMA, arguments: { x: "two", y: 5 } },
          AbortSignal.timeout(15_000)
        )
      ).rejects.toBeInstanceOf(McpToolArgumentsInvalidError);
    } finally {
      await session.close();
    }
    await expectGone(pid as number);
  }, 40_000);

  it("enforces stdio argument and environment bounds and passes explicit env", async () => {
    const tooManyArgs = stdioTarget(
      {},
      {
        config: {
          kind: "mcp_stdio",
          command: process.execPath,
          args: Array.from({ length: 33 }, () => STDIO_FIXTURE),
          cwd: null,
        },
      }
    );
    await expect(mcpTransportProvider().connect(tooManyArgs, AbortSignal.timeout(10_000))).rejects.toMatchObject({
      code: "CONNECTION_CONFIG_INVALID",
    });
    const tooLongArg = stdioTarget(
      {},
      {
        config: {
          kind: "mcp_stdio",
          command: process.execPath,
          args: ["x".repeat(201)],
          cwd: null,
        },
      }
    );
    await expect(mcpTransportProvider().connect(tooLongArg, AbortSignal.timeout(10_000))).rejects.toMatchObject({
      code: "CONNECTION_CONFIG_INVALID",
    });
    const relativeCommand = stdioTarget(
      {},
      {
        config: { kind: "mcp_stdio", command: "npx", args: ["some-mcp"], cwd: null },
      }
    );
    await expect(mcpTransportProvider().connect(relativeCommand, AbortSignal.timeout(10_000))).rejects.toMatchObject({
      code: "CONNECTION_CONFIG_INVALID",
    });
    await expectAllSpawnedGone();

    // Explicit environment entries reach the child (no shell, no ambient
    // inheritance beyond the SDK allowlist): the toggle changes the tool
    // catalog the child serves.
    const envTarget = stdioTarget({ E2E_MCP_BULK_TOOLS: "3" });
    const tools = await withSession(envTarget, (session) => session.listTools(AbortSignal.timeout(15_000)));
    expect(tools.map((tool) => tool.name)).toContain("bulk_tool_002");
    expect(tools).toHaveLength(9);
  }, 60_000);

  it("bounds slow tool calls with an explicit timeout error", async () => {
    const target = stdioTarget({ E2E_MCP_SLOW_MS: "800" });
    await expect(
      callMcpTool(target, { name: "slow_snooze", input_schema: EMPTY_SCHEMA, arguments: {} }, { deadlineMs: 150 })
    ).rejects.toBeInstanceOf(McpToolTimeoutError);
    await expectAllSpawnedGone();
  }, 40_000);

  it("cancels an in-flight call and owns the child through cancellation", async () => {
    const target = stdioTarget({ E2E_MCP_SLOW_MS: "30000" });
    const session = await mcpTransportProvider().connect(target, AbortSignal.timeout(15_000));
    const pid = session.childPid as number;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300).unref?.();
    await expect(
      session.callTool!({ name: "slow_snooze", input_schema: EMPTY_SCHEMA, arguments: {} }, controller.signal)
    ).rejects.toBeTruthy();
    await session.close();
    await expectGone(pid);
  }, 40_000);

  it("rejects oversized tool results without truncation", async () => {
    await expect(
      callMcpTool(
        stdioTarget(),
        { name: "big_result", input_schema: EMPTY_SCHEMA, arguments: {} },
        { deadlineMs: 20_000 }
      )
    ).rejects.toMatchObject({ code: "CONNECTION_TOOL_RESULT_OVER_LIMIT" });
  }, 40_000);

  it("refuses unsupported snapshot schemas at selection and dispatch", async () => {
    const tools = await withSession(stdioTarget(), (session) => session.listTools(AbortSignal.timeout(15_000)));
    const weird = tools.find((tool) => tool.name === "weird_schema");
    expect(weird).toBeDefined();
    // Captured, but not selectable/callable.
    expect(isMcpToolSchemaSupported(weird!.input_schema)).toBe(false);
    expect(isMcpToolSchemaSupported(tools.find((tool) => tool.name === "echo_query")!.input_schema)).toBe(true);
    await expect(
      callMcpTool(
        stdioTarget(),
        { name: "weird_schema", input_schema: weird!.input_schema, arguments: { matrix: {} } },
        { deadlineMs: 10_000 }
      )
    ).rejects.toBeInstanceOf(McpToolSchemaUnsupportedError);
  }, 40_000);

  it("fails explicitly on malformed tool results and passes server-reported errors through", async () => {
    const serverFile = await writeCustomStdioServer(MALFORMED_BODY);
    const target = stdioTarget(
      {},
      {
        config: { kind: "mcp_stdio", command: process.execPath, args: [serverFile], cwd: null },
      }
    );
    await expect(
      callMcpTool(target, { name: "malformed", input_schema: EMPTY_SCHEMA, arguments: {} }, { deadlineMs: 15_000 })
    ).rejects.toMatchObject({ code: "CONNECTION_TOOL_CALL_FAILED" });
    const flagged = await callMcpTool(
      target,
      { name: "flagged", input_schema: EMPTY_SCHEMA, arguments: {} },
      { deadlineMs: 15_000 }
    );
    expect(flagged).toMatchObject({ ok: false, text: "flagged failure" });
  }, 60_000);

  it("quiesceMcpConnections drains a test-owned stdio child", async () => {
    const session = await mcpTransportProvider().connect(stdioTarget(), AbortSignal.timeout(15_000));
    const pid = session.childPid as number;
    expect(pidAlive(pid)).toBe(true);
    await quiesceMcpConnections();
    await expectGone(pid);
    // Idempotent and side-effect-free with nothing live.
    await expect(quiesceMcpConnections()).resolves.toBeUndefined();
  }, 40_000);
});

/**
 * Connection routes test/discover wired against the real fixtures. This
 * block deliberately never calls `setMcpTransportProvider` and never passes
 * a `transport` option to `configureConnectionService`: it proves the
 * production seam defaults compose the real SDK transports.
 */
describe("connection routes against the real fixtures", () => {
  const ownerAuth = { authorization: `Bearer ${signToken({ userId: ACCOUNT_ID, email: "owner@example.test" })}` };

  async function buildRouteApp(): Promise<FastifyInstance> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-mcp-routes-"));
    tempDirectories.push(root);
    const runtime = await initializeStorageRuntime({
      sqlitePath: path.join(root, "ledger.sqlite"),
      lanceDirectory: path.join(root, "lancedb"),
      embeddingDimension: 3,
    });
    await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
      ACCOUNT_ID,
      "owner@example.test",
      "hash",
    ]);
    configureConnectionService({
      // Only custody is redirected into the temp directory; the transport
      // seam intentionally keeps its production (SDK) default.
      secrets: () =>
        new FileConnectionSecretStore({
          directory: path.join(root, "secrets"),
          custody: new FileKeyCustody(path.join(root, "connections.key")),
        }),
    });
    const app = Fastify();
    installHttpBoundary(app);
    await app.register(connectionRoutes);
    await app.ready();
    cleanups.push(async () => {
      await app.close();
      closeConnectionService();
      await closeStorageRuntime();
    });
    return app;
  }

  async function createConnection(app: FastifyInstance, body: Record<string, unknown>): Promise<Record<string, any>> {
    const response = await app.inject({ method: "POST", url: "/api/connections", headers: ownerAuth, body });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as Record<string, any>;
  }

  it("tests real HTTP and stdio connections, publishing bounded discovery", async () => {
    const bearer = "route-bearer-token";
    const fixture = await startHttpFixture({ E2E_MCP_BEARER: bearer });
    cleanups.push(() => fixture.stop());
    const app = await buildRouteApp();

    const secured = await createConnection(app, {
      name: "Live HTTP",
      kind: "mcp_http",
      config: { url: fixture.url },
      credentials: { headers: { authorization: `Bearer ${bearer}` } },
    });
    const tested = await app.inject({
      method: "POST",
      url: `/api/connections/${secured.id}/test`,
      headers: ownerAuth,
    });
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json()).toMatchObject({ status: "ready", status_code: null });

    const discovered = await app.inject({
      method: "POST",
      url: `/api/connections/${secured.id}/discover`,
      headers: ownerAuth,
    });
    expect(discovered.statusCode, discovered.body).toBe(200);
    expect(discovered.json()).toMatchObject({ discovery_revision: 1 });
    expect(discovered.json().tools.map((tool: { name: string }) => tool.name)).toContain("echo_query");
    expect(JSON.stringify(discovered.json())).not.toContain(bearer);

    const stdio = await createConnection(app, {
      name: "Live stdio",
      kind: "mcp_stdio",
      config: { command: process.execPath, args: [STDIO_FIXTURE], cwd: null },
    });
    const stdioDiscovered = await app.inject({
      method: "POST",
      url: `/api/connections/${stdio.id}/discover`,
      headers: ownerAuth,
    });
    expect(stdioDiscovered.statusCode, stdioDiscovered.body).toBe(200);
    expect(stdioDiscovered.json().tools).toHaveLength(6);

    const detail = await app.inject({ method: "GET", url: `/api/connections/${stdio.id}`, headers: ownerAuth });
    expect(detail.json().tools).toHaveLength(6);
  }, 60_000);

  it("reports an uncredentialed fixture as an actionable disconnected connection", async () => {
    const fixture = await startHttpFixture({ E2E_MCP_BEARER: "some-required-token" });
    cleanups.push(() => fixture.stop());
    const app = await buildRouteApp();
    const created = await createConnection(app, {
      name: "Needs sign-in",
      kind: "mcp_http",
      config: { url: fixture.url },
    });
    const tested = await app.inject({
      method: "POST",
      url: `/api/connections/${created.id}/test`,
      headers: ownerAuth,
    });
    expect(tested.statusCode).toBe(409);
    expect(tested.json()).toMatchObject({ code: "CONNECTION_AUTH_REQUIRED" });
    const detail = await app.inject({ method: "GET", url: `/api/connections/${created.id}`, headers: ownerAuth });
    expect(detail.json()).toMatchObject({
      status: "disconnected",
      status_code: "CONNECTION_AUTH_REQUIRED",
    });
  }, 60_000);

  it("surfaces the real over-limit catalog as CONNECTION_DISCOVERY_OVER_LIMIT", async () => {
    const app = await buildRouteApp();
    const created = await createConnection(app, {
      name: "Bulk",
      kind: "mcp_stdio",
      config: { command: process.execPath, args: [STDIO_FIXTURE], cwd: null },
      // Explicit env entries are the only channel to the child.
      credentials: { env: { E2E_MCP_BULK_TOOLS: "195" } },
    });
    const discovered = await app.inject({
      method: "POST",
      url: `/api/connections/${created.id}/discover`,
      headers: ownerAuth,
    });
    expect(discovered.statusCode).toBe(502);
    expect(discovered.json()).toMatchObject({ code: "CONNECTION_DISCOVERY_OVER_LIMIT" });
    const detail = await app.inject({ method: "GET", url: `/api/connections/${created.id}`, headers: ownerAuth });
    expect(detail.json()).toMatchObject({
      status: "error",
      status_code: "CONNECTION_DISCOVERY_OVER_LIMIT",
    });
  }, 60_000);
});
