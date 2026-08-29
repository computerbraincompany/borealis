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

  it("truncates oversized instructions to the prompt budget", async () => {
    const oversized = "x".repeat(MAX_AGENT_INSTRUCTION_PROMPT_CHARS + 5_000);
    const prompt = await buildSystemPrompt("11111111-1111-4111-8111-111111111111", emptyScope, undefined, oversized);
    const section = prompt.slice(prompt.indexOf("## Workspace agent instructions"));
    const instructions = section.slice(section.indexOf("\n\n") + 2);
    expect(instructions.length).toBe(MAX_AGENT_INSTRUCTION_PROMPT_CHARS);
  });
});
