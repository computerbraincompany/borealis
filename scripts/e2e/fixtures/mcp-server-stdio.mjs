#!/usr/bin/env node
/**
 * Standalone MCP server fixture over stdio, using the pinned
 * @modelcontextprotocol/sdk from the workspace (resolved via lib/mcp-tools.mjs).
 *
 * IMPORTANT: stdout carries MCP JSON-RPC bytes only — this fixture prints no
 * ready line (there is no port; the initialize response is the ready signal).
 * Diagnostics go to stderr as content-free lines.
 *
 * Tool inventory and env toggles are documented in lib/mcp-tools.mjs:
 *   E2E_MCP_BULK_TOOLS=N   append N filler tools (tools/list > 200 total)
 *   E2E_MCP_SLOW_MS=N      override the slow_snooze sleep (default 31000 > 30s)
 *
 * Clean shutdown: closing stdin tears down the transport and exits 0; SIGTERM
 * also exits 0. This process never spawns children.
 */
import { loadSdk, listTools, callTool } from "./lib/mcp-tools.mjs";

const sdk = await loadSdk();
const { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema } = sdk;

const bulkCount = clampInt(process.env.E2E_MCP_BULK_TOOLS, 0, 500, 0);
const slowMs = clampInt(process.env.E2E_MCP_SLOW_MS, 10, 120_000, 31_000);

function clampInt(raw, min, max, fallback) {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

const server = new Server(
  { name: "borealis-e2e-mcp-stdio", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools({ bulkCount }) }));
server.setRequestHandler(CallToolRequestSchema, async (request) =>
  callTool(request.params?.name, request.params?.arguments, { slowMs })
);

const transport = new StdioServerTransport();
transport.onclose = () => {
  process.exit(0);
};
process.stderr.write(`${JSON.stringify({ fixture: "mcp-server-stdio", phase: "starting", sdk_resolution: sdk.sdkResolution })}\n`);
await server.connect(transport);

const bye = () => process.exit(0);
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
