/**
 * Shared tool registry for the two MCP fixtures (stdio + Streamable HTTP).
 *
 * Tool inventory (stable across transports):
 *   echo_query   — read-only, echo_query(text) -> "result: <text>"
 *   finance_sum  — read-only, finance_sum(x, y) -> numeric text
 *   record_note  — deliberately write-flagged (readOnlyHint: false)
 *   big_result   — returns text larger than 64 KiB (over M15's result cap)
 *   weird_schema — declares an unsupported/invalid input-schema shape
 *   slow_snooze  — sleeps past the 30 s tool deadline (default 31 s)
 *
 * With E2E_MCP_BULK_TOOLS=N the tools/list response additionally carries N
 * filler tools, so the total exceeds the 200-tool discovery cap.
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";

/** Resolve the pinned @modelcontextprotocol/sdk from the workspace server package. */
export async function loadSdk() {
  const localCandidates = [
    "@modelcontextprotocol/sdk/server/index.js",
    "@modelcontextprotocol/sdk/types.js",
  ];
  try {
    const serverMod = await import(localCandidates[0]);
    const typesMod = await import(localCandidates[1]);
    return {
      Server: serverMod.Server,
      ...(await import("@modelcontextprotocol/sdk/server/stdio.js")),
      ...(await import("@modelcontextprotocol/sdk/server/streamableHttp.js")),
      ...typesMod,
      sdkResolution: "bare-import",
    };
  } catch {
    // Fall back to the physical workspace location.
  }
  const serverDir = fileURLToPath(new URL("../../../../server/", import.meta.url));
  const esmDir = join(serverDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
  if (!existsSync(esmDir)) {
    throw new Error("mcp-sdk-unresolved: run pnpm install at the repository root");
  }
  const url = (rel) => new URL(`file://${join(esmDir, rel)}`).href;
  const serverMod = await import(url("server/index.js"));
  const stdioMod = await import(url("server/stdio.js"));
  const httpMod = await import(url("server/streamableHttp.js"));
  const typesMod = await import(url("types.js"));
  return {
    Server: serverMod.Server,
    StdioServerTransport: stdioMod.StdioServerTransport,
    StreamableHTTPServerTransport: httpMod.StreamableHTTPServerTransport,
    ListToolsRequestSchema: typesMod.ListToolsRequestSchema,
    CallToolRequestSchema: typesMod.CallToolRequestSchema,
    sdkResolution: "workspace-path",
  };
}

export const BIG_RESULT_BYTES = 70 * 1024;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic filler descriptor for bulk discovery toggles. */
function bulkTool(index) {
  const id = String(index).padStart(3, "0");
  return {
    name: `bulk_tool_${id}`,
    description: `Filler tool ${id} used to push tools/list over the discovery cap.`,
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  };
}

/**
 * tools/list payload. `bulkCount` comes from E2E_MCP_BULK_TOOLS; with the
 * default 0 the response holds the six core tools.
 */
export function listTools({ bulkCount = 0 } = {}) {
  const tools = [
    {
      name: "echo_query",
      description: "Echo the provided text back as the tool result.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "Text to echo back." } },
        required: ["text"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "finance_sum",
      description: "Add two numbers and return the sum.",
      inputSchema: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "record_note",
      description: "Record a note; deliberately flagged as a writing (non read-only) tool.",
      inputSchema: {
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "big_result",
      description: `Return a text result larger than 64 KiB (${BIG_RESULT_BYTES} bytes).`,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "weird_schema",
      description: "Advertises an unsupported JSON-schema property shape for rejection-at-selection tests.",
      inputSchema: {
        type: "object",
        properties: {
          matrix: { type: "hypercube" },
          either: { type: "union", anyOf: [{ type: "string" }, { type: "number" }] },
        },
        required: ["matrix"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "slow_snooze",
      description: "Sleep past the 30-second tool deadline before answering.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
  for (let index = 0; index < bulkCount; index += 1) tools.push(bulkTool(index));
  return tools;
}

/**
 * Execute a tool call. `slowMs` overrides the sleep duration so a self-test
 * can exercise the sleeping path without a real 31 s wait.
 */
export async function callTool(name, args, { slowMs = 31_000 } = {}) {
  switch (name) {
    case "echo_query": {
      const text = typeof args?.text === "string" ? args.text : "";
      return { content: [{ type: "text", text: `result: ${text}` }] };
    }
    case "finance_sum": {
      const x = Number(args?.x);
      const y = Number(args?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { isError: true, content: [{ type: "text", text: "finance_sum needs two finite numbers" }] };
      }
      return { content: [{ type: "text", text: String(x + y) }] };
    }
    case "record_note": {
      const note = typeof args?.note === "string" ? args.note : "";
      return { content: [{ type: "text", text: `recorded ${note.length} characters` }] };
    }
    case "big_result": {
      return { content: [{ type: "text", text: "x".repeat(BIG_RESULT_BYTES) }] };
    }
    case "weird_schema": {
      return { content: [{ type: "text", text: "weird_schema executed" }] };
    }
    case "slow_snooze": {
      await sleep(slowMs);
      return { content: [{ type: "text", text: "slept" }] };
    }
    default:
      return { isError: true, content: [{ type: "text", text: `unknown tool: ${String(name).slice(0, 64)}` }] };
  }
}
