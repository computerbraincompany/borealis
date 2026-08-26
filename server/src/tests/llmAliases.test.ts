import { describe, expect, it } from "vitest";
import { LLM_MODEL_ALIASES, publicLlmModelId, resolveLlmModelId, sameLlmModel } from "../llmAliases.js";

describe("LM Studio model aliases", () => {
  it("preserves the former public aliases without LiteLLM's provider prefix", () => {
    expect(LLM_MODEL_ALIASES).toEqual({
      "qwen-chat": "qwen/qwen3.6-35b-a3b",
      "qwen-27b": "qwen3.8-27b-obliterated",
      nemotron: "nvidia/nemotron-3-nano",
      "nomic-embed": "text-embedding-nomic-embed-text-v1.5",
    });
    expect(new Set(Object.values(LLM_MODEL_ALIASES)).size).toBe(Object.keys(LLM_MODEL_ALIASES).length);
  });

  it("resolves exact aliases and leaves unknown remote ids untouched", () => {
    expect(resolveLlmModelId("qwen-chat")).toBe("qwen/qwen3.6-35b-a3b");
    expect(resolveLlmModelId("cloud/model-a")).toBe("cloud/model-a");
    expect(resolveLlmModelId(" qwen-chat ")).toBe(" qwen-chat ");
  });

  it("maps known targets back to their stable public aliases", () => {
    expect(publicLlmModelId("qwen/qwen3.6-35b-a3b")).toBe("qwen-chat");
    expect(publicLlmModelId("cloud/model-a")).toBe("cloud/model-a");
  });

  it("recognizes logical and physical forms as the same model", () => {
    expect(sameLlmModel("nomic-embed", "text-embedding-nomic-embed-text-v1.5")).toBe(true);
    expect(sameLlmModel("nomic-embed", "cloud/embed")).toBe(false);
  });
});
