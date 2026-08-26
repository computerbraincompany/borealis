import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatOnce, embed, getLlmClient, streamingChat } from "../llm.js";
import { resolveLlmModelId } from "../llmAliases.js";
import { closeRuntimeSettings, initializeRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-llm-"));
  await initializeRuntimeSettings({ settingsFile: path.join(temporaryDirectory, "settings.json"), env: {} });
});

afterEach(async () => {
  vi.restoreAllMocks();
  closeRuntimeSettings();
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("explicit model routing", () => {
  it("sends the supplied model through non-streaming chat completions", async () => {
    const client = await getLlmClient();
    const create = vi.spyOn(client.chat.completions, "create").mockResolvedValue({
      id: "completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
    } as any);

    await chatOnce([], { model: "selected-chat-a" });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "selected-chat-a" }), {
      timeout: 120_000,
      maxRetries: 0,
    });
  });

  it("resolves a logical alias only in the outbound non-streaming request", async () => {
    const client = await getLlmClient();
    const create = vi.spyOn(client.chat.completions, "create").mockResolvedValue({
      id: "completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
    } as any);

    await chatOnce([], { model: "qwen-chat" });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "qwen/qwen3.6-35b-a3b" }), {
      timeout: 120_000,
      maxRetries: 0,
    });
  });

  it("sends the supplied model through streaming chat completions", async () => {
    const client = await getLlmClient();
    async function* chunks() {
      yield { choices: [{ delta: { content: "ok" } }] };
    }
    const create = vi.spyOn(client.chat.completions, "create").mockReturnValue(chunks() as any);

    const result = await streamingChat([], { model: "selected-chat-b" }, () => {});

    expect(result.choices[0].message.content).toBe("ok");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "selected-chat-b", stream: true }),
      expect.objectContaining({ timeout: 120_000, maxRetries: 0, signal: expect.any(AbortSignal) })
    );
  });

  it("resolves a logical alias in the outbound streaming request", async () => {
    const client = await getLlmClient();
    async function* chunks() {
      yield { choices: [{ delta: { content: "ok" } }] };
    }
    const create = vi.spyOn(client.chat.completions, "create").mockReturnValue(chunks() as any);

    await streamingChat([], { model: "nemotron" }, () => {});

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "nvidia/nemotron-3-nano", stream: true }),
      expect.objectContaining({ timeout: 120_000, maxRetries: 0, signal: expect.any(AbortSignal) })
    );
  });

  it.each([
    ["sparse tool index", { tool_calls: [{ index: 1_000_000_000, function: { name: "query_data" } }] }],
    ["oversized content", { content: "x".repeat(32_001) }],
    ["oversized tool arguments", { tool_calls: [{ index: 0, function: { arguments: "x".repeat(20_001) } }] }],
  ])("aborts a provider stream with %s at the accumulation boundary", async (_label, delta) => {
    const client = await getLlmClient();
    async function* chunks() {
      yield { choices: [{ delta }] };
    }
    vi.spyOn(client.chat.completions, "create").mockReturnValue(chunks() as any);
    await expect(streamingChat([], { model: "selected-chat-b" }, () => {})).rejects.toThrow(
      "model stream budget exceeded"
    );
  });

  it("keeps embeddings on the configured embedding model as floats", async () => {
    const client = await getLlmClient();
    const create = vi.spyOn(client.embeddings, "create").mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }],
    } as any);

    await expect(embed(["hello"])).resolves.toEqual([[0.1, 0.2]]);
    expect(create).toHaveBeenCalledWith(
      {
        model: resolveLlmModelId("nomic-embed"),
        input: ["hello"],
        encoding_format: "float",
      },
      { timeout: 60_000, maxRetries: 0 }
    );
  });

  it("supports a keyless local provider without sending a placeholder Authorization header", async () => {
    const authorizations: Array<string | undefined> = [];
    const server = http.createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"object":"list","data":[]}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      await runtimeSettingsStore().patch({ llmBaseUrl: `http://127.0.0.1:${address.port}`, apiKey: null });

      await (await getLlmClient()).models.list({ timeout: 1_000, maxRetries: 0 });

      expect(authorizations).toEqual([undefined]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
