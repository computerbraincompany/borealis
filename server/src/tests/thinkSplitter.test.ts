import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThinkSplitter, getLlmClient, streamingChat } from "../llm.js";
import { closeRuntimeSettings, initializeRuntimeSettings } from "../runtimeSettings.js";

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-think-splitter-"));
  await initializeRuntimeSettings({ settingsFile: path.join(temporaryDirectory, "settings.json"), env: {} });
});

afterEach(async () => {
  vi.restoreAllMocks();
  closeRuntimeSettings();
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

function split(chunks: string[], includeReasoning = true) {
  const content: string[] = [];
  const reasoning: string[] = [];
  const splitter = createThinkSplitter(
    (text) => content.push(text),
    includeReasoning ? (text) => reasoning.push(text) : undefined
  );
  for (const chunk of chunks) splitter.push(chunk);
  splitter.flush();
  return { content: content.join(""), reasoning: reasoning.join("") };
}

describe("createThinkSplitter", () => {
  it("handles opening and closing tags split across chunks", () => {
    expect(split(["<thi", "nk>hidden </thin", "k>visible"])).toEqual({
      content: "visible",
      reasoning: "hidden ",
    });
  });

  it("passes through content without tags", () => {
    expect(split(["no tags"])).toEqual({ content: "no tags", reasoning: "" });
  });

  it("routes an unterminated think block to reasoning", () => {
    expect(split(["<think>only"])).toEqual({ content: "", reasoning: "only" });
  });

  it("drops think content when no reasoning callback is supplied", () => {
    expect(split(["before<think>hidden</think>after"], false)).toEqual({
      content: "beforeafter",
      reasoning: "",
    });
  });

  it("flushes literal partial tag prefixes as content", () => {
    expect(split(["value <thi"])).toEqual({ content: "value <thi", reasoning: "" });
  });
});

describe("streamingChat tool-call merge", () => {
  it("compacts sparse indices and avoids repeated full function names", async () => {
    const client = await getLlmClient();
    async function* chunks() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 2, id: "chart-call", type: "function", function: { name: "render_", arguments: "{" } },
              ],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "query-call", type: "function", function: { name: "query_data", arguments: "{}" } },
                { index: 2, function: { name: "chart", arguments: "}" } },
              ],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: "query_data" } },
                { index: 2, function: { name: "render_chart" } },
              ],
            },
          },
        ],
      };
    }
    vi.spyOn(client.chat.completions, "create").mockReturnValue(chunks() as any);

    const result = await streamingChat([], { model: "test-chat-model" }, () => {});
    const toolCalls = result.choices[0].message.tool_calls as any[];

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map((call) => call.function.name)).toEqual(["query_data", "render_chart"]);
    expect(toolCalls.every(Boolean)).toBe(true);
  });
});
