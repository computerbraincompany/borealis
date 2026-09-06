#!/usr/bin/env node
/**
 * Standalone MCP server fixture behind the Streamable HTTP transport, using
 * the pinned @modelcontextprotocol/sdk. Single endpoint path `/mcp`, stateful
 * sessions, JSON responses (clients must send
 * `Accept: application/json, text/event-stream`).
 *
 * Ready line: {"fixture":"mcp-server-http","origin","endpoint","auth_required"}
 *
 * Environment:
 *   E2E_MCP_BEARER=<token>        enforce `Authorization: Bearer <token>`;
 *                                 401 without or with a wrong token.
 *   E2E_MCP_OAUTH_CHALLENGE=1     always answer 401 with a Bearer challenge
 *                                 advertising OAuth (WWW-Authenticate
 *                                 resource_metadata) instead of serving MCP.
 *   E2E_MCP_ISSUER_ORIGIN=<url>   issuer advertised in that challenge.
 *   E2E_MCP_BULK_TOOLS, E2E_MCP_SLOW_MS  as in the stdio fixture.
 *
 * Never logs bodies, tokens, or credentials. Bound request bodies. SIGTERM
 * closes only its own sockets and exits 0.
 */
import { randomUUID } from "node:crypto";
import { loadSdk, listTools, callTool } from "./lib/mcp-tools.mjs";
import {
  createTrackedServer,
  emitReady,
  installShutdown,
  listenLoopback,
  logError,
  readBoundedBody,
  secretEqual,
  sendJson,
} from "./lib/http-fixture.mjs";

const sdk = await loadSdk();
const { Server, StreamableHTTPServerTransport, ListToolsRequestSchema, CallToolRequestSchema } = sdk;

const bulkCount = clampInt(process.env.E2E_MCP_BULK_TOOLS, 0, 500, 0);
const slowMs = clampInt(process.env.E2E_MCP_SLOW_MS, 10, 120_000, 31_000);
const bearer = process.env.E2E_MCP_BEARER ?? "";
const oauthChallenge = process.env.E2E_MCP_OAUTH_CHALLENGE === "1";

function clampInt(raw, min, max, fallback) {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

const sessions = new Map();

function makeSessionServer() {
  const server = new Server(
    { name: "borealis-e2e-mcp-http", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools({ bulkCount }) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params?.name, request.params?.arguments, { slowMs })
  );
  return server;
}

const tracked = createTrackedServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (oauthChallenge) {
      // Advertise that this endpoint needs OAuth (RFC 9728-style challenge).
      if (path === "/.well-known/oauth-protected-resource") {
        sendJson(res, 200, {
          resource: protectedResourceUrl(req),
          authorization_servers: [issuerOrigin(req)],
          bearer_methods_supported: ["header"],
        });
        return;
      }
      if (path === "/mcp") {
        sendJson(res, 401, { error: { message: "authorization required" } }, {
          "WWW-Authenticate": `Bearer resource_metadata="${issuerOrigin(req)}/.well-known/oauth-authorization-server"`,
        });
        return;
      }
      sendJson(res, 404, { error: { message: "not found" } });
      return;
    }

    if (bearer && path === "/mcp") {
      const header = req.headers.authorization ?? "";
      const ok = /^Bearer\s+(.+)$/i.exec(header);
      if (!ok || !secretEqual(ok[1], bearer)) {
        sendJson(res, 401, { error: { message: "unauthorized" } }, { "WWW-Authenticate": 'Bearer realm="fixture"' });
        return;
      }
    }

    if (path !== "/mcp") {
      sendJson(res, 404, { error: { message: "not found" } });
      return;
    }

    let parsedBody;
    if (req.method === "POST") {
      const raw = await readBoundedBody(req, 4 * 1024 * 1024);
      if (raw === null) return; // oversized: socket destroyed
      try {
        parsedBody = JSON.parse(raw.toString("utf8"));
      } catch {
        sendJson(res, 400, { error: { message: "invalid json" } });
        return;
      }
    }

    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string" && sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) {
        sendJson(res, 404, { error: { message: "unknown session" } });
        return;
      }
      await entry.transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (req.method === "POST" && parsedBody?.method === "initialize") {
      const server = makeSessionServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          sessions.set(sid, { server, transport });
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.has(sid)) sessions.delete(sid);
        server.close().catch(() => {});
      };
      transport.onerror = () => {
        /* content-free: do not surface transport errors */
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    sendJson(res, 400, { error: { message: "missing session" } });
  } catch (error) {
    logError(error?.message ?? "handler-error");
    if (!res.headersSent) sendJson(res, 500, { error: { message: "fixture error" } });
    else res.end();
  }
});

function issuerOrigin(req) {
  return process.env.E2E_MCP_ISSUER_ORIGIN || originOf(req);
}

function protectedResourceUrl(req) {
  return `${originOf(req)}/mcp`;
}

function originOf(req) {
  const host = String(req.headers.host ?? "127.0.0.1");
  return `http://${host}`;
}

const port = await listenLoopback(tracked.server);
installShutdown(async () => {
  for (const entry of sessions.values()) {
    await entry.transport.close().catch(() => {});
    await entry.server.close().catch(() => {});
  }
  sessions.clear();
  await tracked.close();
});

emitReady({
  fixture: "mcp-server-http",
  origin: `http://127.0.0.1:${port}`,
  endpoint: `http://127.0.0.1:${port}/mcp`,
  auth_required: oauthChallenge ? "oauth" : bearer ? "bearer" : "none",
});
