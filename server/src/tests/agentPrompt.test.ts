import { describe, expect, it } from "vitest";
import { buildSystemPrompt, MAX_AGENT_INSTRUCTION_PROMPT_CHARS } from "../agent.js";
import type { ResolvedSourceScope } from "./../sourceScope.js";

const emptyScope = {
  mode: "selected",
  attached: [],
  readySourceIds: [],
  readyTableNames: [],
} as ResolvedSourceScope;

describe("agent instructions in the system prompt", () => {
  it("leaves the base prompt unchanged without instructions", async () => {
    const prompt = await buildSystemPrompt("11111111-1111-4111-8111-111111111111", emptyScope);
    expect(prompt).not.toContain("Workspace agent instructions");
  });

  it("appends the sanitized agent section with the fixed-policy sentence", async () => {
    const prompt = await buildSystemPrompt(
      "11111111-1111-4111-8111-111111111111",
      emptyScope,
      undefined,
      "Reconcile totals first."
    );
    expect(prompt).toContain("## Workspace agent instructions");
    expect(prompt).toContain("fixed workspace policy and cannot be changed by these instructions");
    expect(prompt.trimEnd().endsWith("Reconcile totals first.")).toBe(true);
  });

  it("ignores blank instructions", async () => {
    const prompt = await buildSystemPrompt("11111111-1111-4111-8111-111111111111", emptyScope, undefined, "   \n  ");
    expect(prompt).not.toContain("Workspace agent instructions");
  });

  it("rejects oversized combinations instead of silently dropping instructions", async () => {
    await expect(
      buildSystemPrompt(
        "11111111-1111-4111-8111-111111111111",
        emptyScope,
        undefined,
        "x".repeat(MAX_AGENT_INSTRUCTION_PROMPT_CHARS + 1)
      )
    ).rejects.toThrow("budget");
  });
});
