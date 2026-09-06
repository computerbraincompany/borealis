/**
 * Connected-agents stage 4 — MCP tool execution inside durable agent turns.
 *
 * The one suite that drives the complete MCP turn path without module mocks:
 * the real HTTP chat route, durable turn acceptance with the frozen
 * `chat_runs.agent_mcp_tools` snapshot, the real agent streaming loop and tool
 * dispatch through `ConnectionService.callToolForTurn`, and the committed
 * stdio MCP protocol fixture (`scripts/e2e/fixtures/mcp-server-stdio.mjs`)
 * spawned as a real child through the real SDK client. The scripted provider
 * (`scriptedOpenAiServer.ts`) supplies model turns; its `onCall` hook is the
 * only way state mutates mid-run, so revocation/disable/edit/refresh
 * boundaries are exact.
 *
 * Proven here (spec "Transport and execution" enforcement list):
 * - an allowed selected-tool call works end-to-end in a vertical turn;
 * - a removed tool fails at acceptance; disabled/revoked tools fail the NEXT
 *   call mid-run with sanitized fixed summaries;
 * - a running turn keeps its frozen alias -> (connection/tool/revision/
 *   schema/description) mapping across agent edits and discovery refreshes,
 *   and arguments validate against the frozen schema, not the live one;
 * - restart never replays an external tool side effect (durable per-call
 *   receipts from the fixture's `E2E_MCP_CALL_LOG`);
 * - no credential material ever reaches `chat_runs` or `messages` (byte scan
 *   over the raw durable rows and the delivered SSE stream);
 * - acceptance is atomic: a failing connected-tool resolution leaves no
 *   message, run, or run-source rows behind;
 * - selection-time validation matrix (unsupported schema, write policy,
 *   foreign/unknown tool and connection ids, disabled connection).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { signToken } from "../auth.js";
import { routes } from "../routes.js";
import { AgentConfigurationError, decodeRunMcpSnapshot, mcpToolAlias } from "../agentConfiguration.js";
import { closeConnectionService, configureConnectionService, connectionService } from "../connections/service.js";
import { FileConnectionSecretStore, FileKeyCustody } from "../connections/secrets.js";
import { recoverInterruptedRuns } from "../chatRuns.js";
import { closeRuntimeSettings, initializeRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import {
  assistantTextChunks,
  assistantToolCallChunks,
  startScriptedOpenAiServer,
  type ScriptedOpenAiServer,
} from "./scriptedOpenAiServer.js";

const REPO_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const STDIO_FIXTURE = path.join(REPO_ROOT, "scripts/e2e/fixtures/mcp-server-stdio.mjs");

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_MODEL = "mcp-vertical-chat";
const EMBED_MODEL = "mcp-vertical-embed";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER_ID, email: "owner@example.test" })}` };

const apps: FastifyInstance[] = [];
const providers: ScriptedOpenAiServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  await Promise.all(providers.splice(0).map((provider) => provider.close().catch(() => undefined)));
  closeConnectionService();
  closeRuntimeSettings();
  await closeStorageRuntime();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 4 }))
  );
});

function parseSseEvents(body: string): Record<string, any>[] {
  const events: Record<string, any>[] = [];
  for (const frame of body.split("\n\n")) {
    const dataLines = frame.split("\n").filter((line) => line.startsWith("data:"));
    if (!dataLines.length) continue;
    events.push(JSON.parse(dataLines.map((line) => line.slice("data:".length).replace(/^ /, "")).join("\n")));
  }
  return events;
}

interface Scenario {
  readonly directory: string;
  readonly secrets: FileConnectionSecretStore;
  readonly app: FastifyInstance;
  readonly provider: ScriptedOpenAiServer;
  readonly connectionId: string;
  readonly toolIds: Readonly<Record<string, string>>;
  readonly agentId: string;
  readonly chatId: string;
  readonly callLog: string;
}

/**
 * One isolated workspace: real durable runtime, a stdio connection discovered
 * through the real SDK client against the committed fixture, an agent with
 * frozen read-tool selections, and a chat bound to it. Credential custody is
 * the browser-development file store in the scenario's own directory. The
 * provider starts with an empty script; `rescript` installs the real turn
 * plan once the deterministic alias is known.
 */
async function startScenario(
  options: { credentials?: Record<string, string>; bindings?: "echo+finance" | "echo-only" } = {}
): Promise<Scenario> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-mcp-turn-"));
  directories.push(directory);
  const runtime = await initializeStorageRuntime({
    sqlitePath: path.join(directory, "ledger.sqlite"),
    lanceDirectory: path.join(directory, "lancedb"),
    embeddingDimension: 3,
  });
  await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    OWNER_ID,
    "owner@example.test",
    "test-password-hash",
  ]);
  await initializeRuntimeSettings({ settingsFile: path.join(directory, "settings.json"), env: {} });
  const provider = await startScriptedOpenAiServer(CHAT_MODEL, []);
  providers.push(provider);
  await runtimeSettingsStore().patch({
    llmBaseUrl: provider.origin,
    chatModel: CHAT_MODEL,
    embedModel: EMBED_MODEL,
  });

  const callLog = path.join(directory, "mcp-calls.log");
  const secrets = new FileConnectionSecretStore({
    directory: path.join(directory, "secrets"),
    custody: new FileKeyCustody(path.join(directory, "connection-key")),
  });
  configureConnectionService({ store: () => storageRuntime().connections, secrets: () => secrets });

  const connection = await storageRuntime().connections.createConnection(OWNER_ID, {
    name: "Stdio fixture",
    kind: "mcp_stdio",
    // The operator-approved absolute Node executable running the checked-in
    // fixture — the documented initial stdio integration.
    config: { command: process.execPath, args: [STDIO_FIXTURE], cwd: null },
  });
  // The fixture's per-call receipt log travels as explicit connection
  // environment custody (exactly how operator env secrets reach the child).
  await secrets.put(OWNER_ID, connection.id, {
    headers: {},
    env: { E2E_MCP_CALL_LOG: callLog, ...(options.credentials ?? {}) },
  });
  const discovered = await connectionService().discover(OWNER_ID, connection.id);
  const toolIds: Record<string, string> = {};
  for (const tool of discovered.tools) toolIds[tool.name] = tool.tool_id;

  const selected = ["echo_query", ...(options.bindings === "echo-only" ? [] : ["finance_sum"])];
  const agent = await storageRuntime().agents.createAgent(
    OWNER_ID,
    "Connected analyst",
    "Use the connected tools when asked.",
    {
      mcp_tools: selected.map((name) => ({
        connection_id: connection.id,
        tool_id: toolIds[name],
        discovery_revision: discovered.discovery_revision,
        allow_write: false,
      })),
      job_setup: {
        starter_prompts: ["Echo the word canary through the connection."],
        output_template: { kind: "instruction", instruction: "Answer briefly." },
        library_ids: [],
      },
    }
  );
  const chat = await storageRuntime().chats.createChat({
    accountId: OWNER_ID,
    title: "Connected turn",
    titleIsManual: true,
    model: CHAT_MODEL,
    sourceScope: { source_mode: "selected", source_ids: [] },
    agentId: agent.id,
  });

  const app = Fastify();
  apps.push(app);
  await routes(app, { desktop: false, automationScheduler: { isRunning: () => false } });
  await app.ready();

  return {
    directory,
    secrets,
    app,
    provider,
    connectionId: connection.id,
    toolIds: Object.freeze(toolIds),
    agentId: agent.id,
    chatId: chat.id,
    callLog,
  };
}

/** Replace the scripted provider plan (and optionally a mid-run hook). */
async function rescript(
  scenario: Scenario,
  responses: readonly (readonly Record<string, unknown>[])[],
  onCall?: (index: number, body: Readonly<Record<string, unknown>>) => Promise<void> | void
): Promise<ScriptedOpenAiServer> {
  const index = providers.indexOf(scenario.provider);
  if (index >= 0) providers.splice(index, 1);
  await scenario.provider.close();
  const replacement = await startScriptedOpenAiServer(CHAT_MODEL, responses, { onCall });
  providers.push(replacement);
  await runtimeSettingsStore().patch({
    llmBaseUrl: replacement.origin,
    chatModel: CHAT_MODEL,
    embedModel: EMBED_MODEL,
  });
  // Keep the scenario reference current for cleanup.
  (scenario as { provider: ScriptedOpenAiServer }).provider = replacement;
  return replacement;
}

function echoCall(id: string, alias: string, text: string): readonly Record<string, unknown>[] {
  return assistantToolCallChunks(CHAT_MODEL, id, [alias.slice(0, 8), alias.slice(8)], ['{"text":"', `${text}"}`]);
}

async function readCallLog(scenario: Scenario): Promise<string[]> {
  try {
    return (await fs.readFile(scenario.callLog, "utf8")).split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

async function postMessage(scenario: Scenario, content: string) {
  return scenario.app.inject({
    method: "POST",
    url: `/api/chats/${scenario.chatId}/messages`,
    headers: ownerAuth,
    payload: { content },
  });
}

describe("MCP agent turn", () => {
  it(
    "runs an allowed selected-tool call end to end and freezes the run mapping durably",
    { timeout: 90_000 },
    async () => {
      const canary = `TOKEN-CANARY-${randomUUID()}`;
      const scenario = await startScenario({ credentials: { ECHO_STATIC_TOKEN: canary } });
      const echoAlias = mcpToolAlias(scenario.connectionId, scenario.toolIds.echo_query);
      const financeAlias = mcpToolAlias(scenario.connectionId, scenario.toolIds.finance_sum);
      await rescript(scenario, [
        echoCall("call-mcp-echo-1", echoAlias, "result-canary"),
        assistantTextChunks(CHAT_MODEL, ["Echo returned ", "result-canary."]),
      ]);

      const response = await postMessage(scenario, "Echo result-canary through the connection.");
      expect(response.statusCode).toBe(200);

      const events = parseSseEvents(response.body);
      expect(events.map((event) => event.type)).toEqual([
        "run-started",
        "user-saved",
        "step-start",
        "step-end",
        "delta",
        "message",
        "done",
        "run-ended",
      ]);
      // SSE only ever sees the opaque alias and fixed summaries.
      expect(events[2]).toMatchObject({ name: echoAlias, summary: "Running a connected tool action." });
      expect(events[3]).toMatchObject({
        name: echoAlias,
        summary: "Completed the connected tool action.",
        status: "ok",
      });
      expect(events[7]).toMatchObject({ status: "completed" });
      expect(response.body).not.toContain(canary);

      // The real stdio fixture executed exactly once and returned its text.
      expect(await readCallLog(scenario)).toEqual(["echo_query"]);
      const calls = scenario.provider.calls;
      expect(calls).toHaveLength(2);
      const secondMessages = (calls[1]!.messages as Record<string, any>[]) ?? [];
      const toolMessage = secondMessages.find((entry) => entry.role === "tool");
      expect(toolMessage).toBeDefined();
      const toolResult = JSON.parse(String(toolMessage!.content));
      expect(toolResult).toMatchObject({ ok: true, text: "result: result-canary" });
      expect(toolResult.trust).toBe("untrusted_external_content");
      expect(String(toolMessage!.content)).not.toContain(canary);

      // The durable run row carries the frozen mapping: aliases, canonical
      // descriptors, discovery revision, and a non-secret custody reference.
      const runRow = await storageRuntime().ledger.get<{ status: string; agent_mcp_tools: string | null }>(
        "SELECT status,agent_mcp_tools FROM chat_runs WHERE chat_id=? AND account_id=?",
        [scenario.chatId, OWNER_ID]
      );
      expect(runRow?.status).toBe("completed");
      const frozen = decodeRunMcpSnapshot(runRow?.agent_mcp_tools);
      expect(frozen.map((binding) => binding.alias).sort()).toEqual([financeAlias, echoAlias].sort());
      const echoBinding = frozen.find((binding) => binding.name === "echo_query")!;
      expect(echoBinding).toMatchObject({
        alias: echoAlias,
        connection_id: scenario.connectionId,
        tool_id: scenario.toolIds.echo_query,
        discovery_revision: 1,
      });
      expect(echoBinding.input_schema).toMatchObject({ required: ["text"] });
      // Non-secret grant identity: a digest reference, never the token.
      expect(echoBinding.authorization_reference).toMatch(/^secret:[0-9a-f]{32}$/);
      expect(echoBinding.authorization_reference).not.toContain(canary);

      // Byte scan of the raw durable rows: no credential material anywhere.
      const runRows = await storageRuntime().ledger.all<Record<string, unknown>>(
        "SELECT * FROM chat_runs WHERE chat_id=?",
        [scenario.chatId]
      );
      const messageRows = await storageRuntime().ledger.all<Record<string, unknown>>(
        "SELECT * FROM messages WHERE chat_id=?",
        [scenario.chatId]
      );
      const scanned = JSON.stringify([runRows, messageRows], (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      );
      expect(scanned).not.toContain(canary);
      expect(scanned).not.toContain("ECHO_STATIC_TOKEN");
    }
  );

  it(
    "keeps the frozen mapping across agent edits and discovery refreshes, validating against the frozen schema",
    { timeout: 120_000 },
    async () => {
      const scenario = await startScenario();
      const echoAlias = mcpToolAlias(scenario.connectionId, scenario.toolIds.echo_query);
      await rescript(
        scenario,
        [
          echoCall("call-frozen-1", echoAlias, "first"),
          echoCall("call-frozen-2", echoAlias, "second"),
          assistantTextChunks(CHAT_MODEL, ["Both echoes completed."]),
        ],
        async (index) => {
          if (index !== 1) return;
          // Mid-run: strip the bindings from the agent (next-turn semantics
          // only) and republish a discovery that changes echo_query's schema
          // and description. The running turn must ignore both.
          await storageRuntime().agents.updateAgent(OWNER_ID, scenario.agentId, {
            instructions: "Updated instructions must not reach the running turn.",
            mcp_tools: [],
          });
          await storageRuntime().connections.publishDiscovery(OWNER_ID, scenario.connectionId, [
            {
              name: "echo_query",
              description: "Refreshed description with a schema requiring a different field.",
              input_schema: { type: "object", properties: { other: { type: "string" } }, required: ["other"] },
            },
            {
              name: "finance_sum",
              description: "Add two numbers and return the sum.",
              input_schema: {
                type: "object",
                properties: { x: { type: "number" }, y: { type: "number" } },
                required: ["x", "y"],
              },
            },
          ]);
        }
      );

      const response = await postMessage(scenario, "Echo first, then second.");
      expect(response.statusCode).toBe(200);
      const events = parseSseEvents(response.body);
      const stepEnds = events.filter((event) => event.type === "step-end");
      expect(stepEnds).toHaveLength(2);
      expect(stepEnds.map((event) => event.status)).toEqual(["ok", "ok"]);
      expect(events.at(-2)).toMatchObject({ type: "done" });
      expect(events.at(-1)).toMatchObject({ type: "run-ended", status: "completed" });

      // The second call still used the FROZEN schema: `text` is valid even
      // though the live snapshot now requires `other`.
      expect(await readCallLog(scenario)).toEqual(["echo_query", "echo_query"]);
      const runRow = await storageRuntime().ledger.get<{ agent_instructions: string; agent_mcp_tools: string }>(
        "SELECT agent_instructions,agent_mcp_tools FROM chat_runs WHERE chat_id=?",
        [scenario.chatId]
      );
      expect(runRow?.agent_instructions).toBe("Use the connected tools when asked.");
      const frozen = decodeRunMcpSnapshot(runRow?.agent_mcp_tools);
      expect(frozen).toHaveLength(2);
      const echoBinding = frozen.find((binding) => binding.name === "echo_query")!;
      expect(echoBinding.discovery_revision).toBe(1);
      expect(echoBinding.input_schema).toMatchObject({ required: ["text"] });

      // The edit only applies to the NEXT accepted turn.
      const nextTurn = await storageRuntime().chats.acceptChatTurn(
        OWNER_ID,
        scenario.chatId,
        "next",
        {},
        { mcpAuthorizationReferences: {} }
      );
      expect(nextTurn.agent?.instructions).toBe("Updated instructions must not reach the running turn.");
      expect(nextTurn.agent?.mcp).toEqual([]);
    }
  );

  it(
    "blocks the next call mid-run after credential revocation with a sanitized error",
    { timeout: 120_000 },
    async () => {
      const canary = `REVOKE-CANARY-${randomUUID()}`;
      const scenario = await startScenario({ credentials: { REVOKE_STATIC_TOKEN: canary } });
      const echoAlias = mcpToolAlias(scenario.connectionId, scenario.toolIds.echo_query);
      const provider = await rescript(
        scenario,
        [
          echoCall("call-rev-1", echoAlias, "one"),
          echoCall("call-rev-2", echoAlias, "two"),
          assistantTextChunks(CHAT_MODEL, ["Done despite the revoked call."]),
        ],
        async (index) => {
          // Revocation between the two rounds: local credentials removed.
          if (index === 1) await scenario.secrets.remove(OWNER_ID, scenario.connectionId);
        }
      );

      const response = await postMessage(scenario, "Echo one, then two.");
      expect(response.statusCode).toBe(200);
      const events = parseSseEvents(response.body);
      const stepEnds = events.filter((event) => event.type === "step-end");
      expect(stepEnds).toHaveLength(2);
      expect(stepEnds[0]).toMatchObject({ status: "ok" });
      expect(stepEnds[1]).toMatchObject({ status: "error", name: echoAlias });
      expect(stepEnds[1].summary).toMatch(/sign-in or stored credentials/i);
      expect(stepEnds[1].summary).not.toContain(canary);
      // The turn survives the failed call and finishes normally.
      expect(events.at(-1)).toMatchObject({ type: "run-ended", status: "completed" });
      // The failing round's stable code is what the model sees on the NEXT
      // provider call; the payload carries only that code.
      expect(provider.calls).toHaveLength(3);
      const lastCallMessages = (provider.calls[2]!.messages as Record<string, any>[]) ?? [];
      const failedToolMessage = lastCallMessages.filter((entry) => entry.role === "tool").at(-1);
      expect(failedToolMessage).toBeDefined();
      expect(JSON.parse(String(failedToolMessage!.content))).toEqual({ error: "CONNECTION_AUTH_REQUIRED" });
      // Only the first call reached the external fixture.
      expect(await readCallLog(scenario)).toEqual(["echo_query"]);
      expect(response.body).not.toContain(canary);
    }
  );

  it("blocks the next call mid-run when the connection is disabled", { timeout: 120_000 }, async () => {
    const scenario = await startScenario({ bindings: "echo-only" });
    const echoAlias = mcpToolAlias(scenario.connectionId, scenario.toolIds.echo_query);
    await rescript(
      scenario,
      [
        echoCall("call-dis-1", echoAlias, "alpha"),
        echoCall("call-dis-2", echoAlias, "beta"),
        assistantTextChunks(CHAT_MODEL, ["Finished after one disabled call."]),
      ],
      async (index) => {
        if (index !== 1) return;
        const live = await storageRuntime().connections.requireConnection(OWNER_ID, scenario.connectionId);
        await storageRuntime().connections.updateConnection(OWNER_ID, scenario.connectionId, {
          expected_revision: live.revision,
          enabled: false,
        });
      }
    );

    const response = await postMessage(scenario, "Echo alpha, then beta.");
    expect(response.statusCode).toBe(200);
    const events = parseSseEvents(response.body);
    const stepEnds = events.filter((event) => event.type === "step-end");
    expect(stepEnds.map((event) => event.status)).toEqual(["ok", "error"]);
    expect(stepEnds[1].summary).toMatch(/currently unavailable/i);
    expect(await readCallLog(scenario)).toEqual(["echo_query"]);
    expect(events.at(-1)).toMatchObject({ status: "completed" });
  });

  it("does not replay external tool calls across restart", { timeout: 120_000 }, async () => {
    const scenario = await startScenario({ bindings: "echo-only" });
    const echoAlias = mcpToolAlias(scenario.connectionId, scenario.toolIds.echo_query);
    const provider = await rescript(scenario, [
      echoCall("call-restart-1", echoAlias, "once"),
      assistantTextChunks(CHAT_MODEL, ["Echoed once."]),
    ]);

    const response = await postMessage(scenario, "Echo once.");
    expect(response.statusCode).toBe(200);
    expect(await readCallLog(scenario)).toEqual(["echo_query"]);
    const runRow = await storageRuntime().ledger.get<{ status: string }>(
      "SELECT status FROM chat_runs WHERE chat_id=?",
      [scenario.chatId]
    );
    expect(runRow?.status).toBe("completed");

    // Restart: close everything durable, reopen the same ledger, and run
    // the startup recovery the application runtime performs.
    await apps
      .splice(0)[0]!
      .close()
      .catch(() => undefined);
    closeConnectionService();
    closeRuntimeSettings();
    await closeStorageRuntime();
    const runtime = await initializeStorageRuntime({
      sqlitePath: path.join(scenario.directory, "ledger.sqlite"),
      lanceDirectory: path.join(scenario.directory, "lancedb"),
      embeddingDimension: 3,
    });
    await initializeRuntimeSettings({
      settingsFile: path.join(scenario.directory, "settings.json"),
      env: {},
    });
    configureConnectionService({ store: () => runtime.connections, secrets: () => scenario.secrets });
    const recovered = await recoverInterruptedRuns();
    expect(recovered).toBe(0);
    const runAfter = await runtime.ledger.get<{ status: string }>("SELECT status FROM chat_runs WHERE chat_id=?", [
      scenario.chatId,
    ]);
    expect(runAfter?.status).toBe("completed");
    // No new model calls and no new external side effects: the completed
    // run is durable history, never a replay queue.
    expect(provider.calls).toHaveLength(2);
    expect(await readCallLog(scenario)).toEqual(["echo_query"]);
  });

  it("refuses acceptance when a selected tool was removed from the current snapshot, atomically", async () => {
    const scenario = await startScenario({ bindings: "echo-only" });
    // Discovery refresh drops echo_query entirely (a real removal: the stable
    // tool id disappears from the new snapshot).
    await storageRuntime().connections.publishDiscovery(OWNER_ID, scenario.connectionId, [
      {
        name: "finance_sum",
        description: "Add two numbers and return the sum.",
        input_schema: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
          required: ["x", "y"],
        },
      },
    ]);

    const response = await postMessage(scenario, "Echo still selected.");
    expect(response.statusCode).toBe(409);
    expect(String(response.body)).toMatch(/no longer published|connected tools/i);
    // Acceptance left no trace: the transaction is all-or-nothing.
    expect(
      await storageRuntime().ledger.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM chat_runs WHERE chat_id=?", [
        scenario.chatId,
      ])
    ).toMatchObject({ n: 0n });
    expect(
      await storageRuntime().ledger.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM messages WHERE chat_id=?", [
        scenario.chatId,
      ])
    ).toMatchObject({ n: 0n });
    // The fixture was never contacted.
    expect(await readCallLog(scenario)).toEqual([]);
  });

  it("fails acceptance closed when the custody reference is missing or the connection is disabled", async () => {
    const scenario = await startScenario({ bindings: "echo-only" });

    await expect(
      storageRuntime().chats.acceptChatTurn(OWNER_ID, scenario.chatId, "no reference captured", {}, {})
    ).rejects.toBeInstanceOf(AgentConfigurationError);

    const connection = await storageRuntime().connections.requireConnection(OWNER_ID, scenario.connectionId);
    await storageRuntime().connections.updateConnection(OWNER_ID, scenario.connectionId, {
      expected_revision: connection.revision,
      enabled: false,
    });
    await expect(
      storageRuntime().chats.acceptChatTurn(
        OWNER_ID,
        scenario.chatId,
        "disabled",
        {},
        {
          mcpAuthorizationReferences: { [scenario.connectionId]: "absent" },
        }
      )
    ).rejects.toBeInstanceOf(AgentConfigurationError);

    expect(await storageRuntime().ledger.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM messages")).toMatchObject({
      n: 0n,
    });
    expect(await storageRuntime().ledger.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM chat_runs")).toMatchObject({
      n: 0n,
    });
  });

  it("validates connected-tool selections at agent create/edit time against the current snapshots", async () => {
    const scenario = await startScenario({ bindings: "echo-only" });
    const connectionId = scenario.connectionId;
    const revision = 1;

    // Unsupported schema is refused at selection, not treated as callable.
    await expect(
      storageRuntime().agents.createAgent(OWNER_ID, "Unsupported pick", "x", {
        mcp_tools: [
          { connection_id: connectionId, tool_id: scenario.toolIds.weird_schema, discovery_revision: revision },
        ],
      })
    ).rejects.toBeInstanceOf(AgentConfigurationError);

    // Write-oriented tools are excluded by default.
    await expect(
      storageRuntime().agents.createAgent(OWNER_ID, "Write pick", "x", {
        mcp_tools: [
          { connection_id: connectionId, tool_id: scenario.toolIds.record_note, discovery_revision: revision },
        ],
      })
    ).rejects.toBeInstanceOf(AgentConfigurationError);
    // The explicit operator acknowledgement admits the same tool.
    const writeAgent = await storageRuntime().agents.createAgent(OWNER_ID, "Write acknowledged", "x", {
      mcp_tools: [
        {
          connection_id: connectionId,
          tool_id: scenario.toolIds.record_note,
          discovery_revision: revision,
          allow_write: true,
        },
      ],
    });
    expect(writeAgent.mcp_tools).toHaveLength(1);
    expect(writeAgent.mcp_tools[0]).toMatchObject({ allow_write: true });

    // Unknown or foreign tool ids and unknown connections fail closed.
    await expect(
      storageRuntime().agents.createAgent(OWNER_ID, "Ghost tool", "x", {
        mcp_tools: [{ connection_id: connectionId, tool_id: randomUUID(), discovery_revision: revision }],
      })
    ).rejects.toBeInstanceOf(AgentConfigurationError);
    await expect(
      storageRuntime().agents.createAgent(OWNER_ID, "Ghost connection", "x", {
        mcp_tools: [
          { connection_id: randomUUID(), tool_id: scenario.toolIds.echo_query, discovery_revision: revision },
        ],
      })
    ).rejects.toBeInstanceOf(AgentConfigurationError);

    // Disabled connections cannot be selected either, and the edit path
    // revalidates on any re-save.
    const connection = await storageRuntime().connections.requireConnection(OWNER_ID, connectionId);
    await storageRuntime().connections.updateConnection(OWNER_ID, connectionId, {
      expected_revision: connection.revision,
      enabled: false,
    });
    await expect(
      storageRuntime().agents.createAgent(OWNER_ID, "Disabled pick", "x", {
        mcp_tools: [
          { connection_id: connectionId, tool_id: scenario.toolIds.echo_query, discovery_revision: revision },
        ],
      })
    ).rejects.toBeInstanceOf(AgentConfigurationError);
    await expect(
      storageRuntime().agents.updateAgent(OWNER_ID, scenario.agentId, { instructions: "touch" })
    ).rejects.toBeInstanceOf(AgentConfigurationError);
  });
});
