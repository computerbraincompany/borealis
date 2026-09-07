/** Test-owned stdio tool with a durable, content-free dispatch/PID receipt. */
import fs from "node:fs";
import { loadSdk } from "./lib/mcp-tools.mjs";
const {
  Server,
  StdioServerTransport,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = await loadSdk();
const receipt = process.env.E2E_LIFECYCLE_RECEIPT;
if (!receipt || !receipt.startsWith("/")) process.exit(2);
const server = new Server(
  { name: "lifecycle-dispatch", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "read_slow",
      description: "Bounded synthetic read",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async () => {
  fs.appendFileSync(
    receipt,
    `${JSON.stringify({ pid: process.pid, phase: "dispatched" })}\n`,
    { mode: 0o600 },
  );
  await new Promise((resolve) => setTimeout(resolve, 120_000));
  return { content: [{ type: "text", text: "Synthetic result" }] };
});
const transport = new StdioServerTransport();
transport.onclose = () => process.exit(0);
process.on("SIGTERM", () => process.exit(0));
await server.connect(transport);
