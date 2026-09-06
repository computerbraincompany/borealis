/**
 * Vertical agent-turn integration test.
 *
 * This is deliberately the one suite that crosses every seam without module
 * mocks: the real HTTP chat route, durable turn acceptance and run ledger, the
 * real agent streaming loop and tool round, the real immutable source scope,
 * the real OpenAI-compatible SSE client, and the terminal SQLite transaction.
 * The only stand-in is a protocol-minimal scripted provider on a loopback
 * port (`scriptedOpenAiServer.ts`). Request bodies are inspected in memory
 * only; prompts, bodies, and headers are never logged or snapshotted here.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { signToken } from "../auth.js";
import { routes } from "../routes.js";
import { closeRuntimeSettings, initializeRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import {
  assistantTextChunks,
  assistantToolCallChunks,
  startScriptedOpenAiServer,
  type ScriptedOpenAiServer,
} from "./scriptedOpenAiServer.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const CHAT_MODEL = "vertical-chat-model";
const EMBED_MODEL = "vertical-embed-model";
const TOOL_CALL_ID = "call-vertical-list-sources-1";
const FINAL_ANSWER = "One source is attached: Field Notes, and it is ready.";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER_ID, email: "owner@example.test" })}` };

const apps: FastifyInstance[] = [];
const providers: ScriptedOpenAiServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  await Promise.all(providers.splice(0).map((provider) => provider.close().catch(() => undefined)));
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
    // SSE comment blocks (such as route heartbeats) carry no event payload.
    if (!dataLines.length) continue;
    events.push(JSON.parse(dataLines.map((line) => line.slice("data:".length).replace(/^ /, "")).join("\n")));
  }
  return events;
}

async function createReadyDocumentSource(accountId: string, displayName: string): Promise<string> {
  const id = randomUUID();
  await storageRuntime().sources.createSource(accountId, {
    id,
    name: displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    kind: "document",
    displayName,
    mime: "text/plain",
    status: "ready",
    readyGeneration: 1,
  });
  return id;
}

describe("vertical agent turn", () => {
  it(
    "runs one durable turn across route, agent, tool, scripted provider, and ledger layers",
    { timeout: 60_000 },
    async () => {
      // The scripted provider answers exactly two calls: one streamed
      // list_sources tool call with split name/argument frames, then one
      // final answer. Any third call receives an error and fails the test.
      const provider = await startScriptedOpenAiServer(CHAT_MODEL, [
        assistantToolCallChunks(CHAT_MODEL, TOOL_CALL_ID, ["list_", "sources"], ["{", "}"]),
        assistantTextChunks(CHAT_MODEL, ["One source is attached: ", "Field Notes, and it is ready."]),
      ]);
      providers.push(provider);

      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-vertical-agent-"));
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
      await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
        OTHER_ID,
        "other@example.test",
        "test-password-hash",
      ]);
      await initializeRuntimeSettings({ settingsFile: path.join(directory, "settings.json"), env: {} });
      await runtimeSettingsStore().patch({
        llmBaseUrl: provider.origin,
        chatModel: CHAT_MODEL,
        embedModel: EMBED_MODEL,
      });

      // One ready document source per account through the production store.
      const ownerSourceId = await createReadyDocumentSource(OWNER_ID, "Field Notes");
      const otherSourceId = await createReadyDocumentSource(OTHER_ID, "Foreign Private Notes");

      const app = Fastify();
      apps.push(app);
      // Composition-only update for the plan 007 authority gate: this vertical
      // test runs in browser mode, so no token here can control contained
      // processes. Provider, agent, tool, persistence, and SSE assertions and
      // the operator claim stay exactly as plan 004 specified (never minted).
      await routes(app, { desktop: false });
      await app.ready();

      // An explicit manual title keeps the automatic titling model call out of
      // this seam, so the scripted provider sees exactly two requests.
      const chatResponse = await app.inject({
        method: "POST",
        url: "/api/chats",
        headers: ownerAuth,
        payload: { title: "Vertical turn", model: CHAT_MODEL, source_mode: "selected", source_ids: [ownerSourceId] },
      });
      expect(chatResponse.statusCode).toBe(200);
      const chatId = String(chatResponse.json().id);

      const response = await app.inject({
        method: "POST",
        url: `/api/chats/${chatId}/messages`,
        headers: ownerAuth,
        payload: { content: "Which sources are attached to this chat?" },
      });
      expect(response.statusCode).toBe(200);

      // 1. SSE order across the whole turn: run acceptance, the real tool
      // round, the complete delta only after persistence, then the terminal.
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
      const [runStarted, userSaved, stepStart, stepEnd, delta, message, , runEnded] = events;
      const runId = String(runStarted.run_id);
      expect(typeof userSaved.message_id).toBe("number");
      expect(stepStart).toMatchObject({ name: "list_sources" });
      expect(stepEnd).toMatchObject({ name: "list_sources", status: "ok" });
      expect(delta.text).toBe(FINAL_ANSWER);
      expect(message).toMatchObject({ content: FINAL_ANSWER, roles: [] });
      expect(message.meta).toMatchObject({ source_mode: "selected", source_ids: [ownerSourceId], model: CHAT_MODEL });
      expect(runEnded).toMatchObject({ run_id: runId, status: "completed" });
      expect(response.body).not.toContain('"type":"error"');

      // 2. Exactly two scripted provider calls; the second request carries the
      // reconstructed streamed call and the scope-enforced tool result.
      const calls = provider.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ model: CHAT_MODEL, stream: true });
      expect(calls[1]).toMatchObject({ model: CHAT_MODEL, stream: true });
      const secondMessages = (calls[1]!.messages as Record<string, any>[]) ?? [];
      const assistantToolCall = secondMessages.find((entry) => entry.role === "assistant" && entry.tool_calls);
      expect(assistantToolCall?.tool_calls).toEqual([
        { id: TOOL_CALL_ID, type: "function", function: { name: "list_sources", arguments: "{}" } },
      ]);
      const toolMessages = secondMessages.filter((entry) => entry.role === "tool");
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0].tool_call_id).toBe(TOOL_CALL_ID);
      const toolResult = JSON.parse(String(toolMessages[0].content));
      expect(toolResult).toMatchObject({ source_mode: "selected", source_total_count: 1 });
      expect(toolResult.sources.map((source: { id: string }) => source.id)).toEqual([ownerSourceId]);
      expect(String(toolMessages[0].content)).not.toContain(otherSourceId);

      // 3. The durable ledger agrees with the delivered stream.
      const historyMessages = await storageRuntime()
        .chats.getChatSnapshot(OWNER_ID, chatId, { limit: 10 })
        .then((snapshot) => snapshot.messages);
      expect(historyMessages.map((entry) => entry.role)).toEqual(["user", "assistant"]);
      const [storedUser, storedAssistant] = historyMessages;
      expect(storedUser.content).toBe("Which sources are attached to this chat?");
      expect(storedAssistant.content).toBe(FINAL_ANSWER);
      expect(storedAssistant.meta).toMatchObject({ source_mode: "selected", source_ids: [ownerSourceId] });

      const ledger = storageRuntime().ledger;
      const runRow = await ledger.get<{ status: string; finished_at: string | null; error_code: string | null }>(
        "SELECT status,finished_at,error_code FROM chat_runs WHERE id=? AND account_id=? AND chat_id=?",
        [runId, OWNER_ID, chatId]
      );
      expect(runRow?.status).toBe("completed");
      expect(runRow?.finished_at).not.toBeNull();
      expect(runRow?.error_code).toBeNull();

      const runSources = await ledger.all<{ source_id: string }>(
        "SELECT source_id FROM chat_run_sources WHERE run_id=? AND account_id=?",
        [runId, OWNER_ID]
      );
      expect(runSources.map((row) => row.source_id)).toEqual([ownerSourceId]);
    }
  );
});
