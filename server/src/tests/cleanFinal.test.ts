import { describe, expect, it } from "vitest";
import { cleanFinal } from "../agent.js";

describe("cleanFinal", () => {
  it("leaves a plain answer untouched", () => {
    expect(cleanFinal("Here is the answer.")).toBe("Here is the answer.");
  });

  it("strips paired think tags from the middle of an answer", () => {
    expect(cleanFinal("Before <think>hidden</think> after")).toBe("Before  after");
  });

  it("collapses a tag-only answer", () => {
    expect(cleanFinal("<think>hidden</think>")).toBe("");
  });

  it("strips an unterminated trailing think block", () => {
    expect(cleanFinal("Visible<think>unfinished")).toBe("Visible");
  });

  it("passes through text without think tags", () => {
    expect(cleanFinal("No hidden reasoning here.")).toBe("No hidden reasoning here.");
  });

  it("strips a leading Final Answer label", () => {
    expect(cleanFinal("Final Answer: the answer")).toBe("the answer");
  });

  it("strips a Thinking block up to the first blank line", () => {
    expect(cleanFinal("Thinking: let me work it out\n\nFinal Answer: 42")).toBe("42");
  });

  it("keeps the answer after a Thinking line without a blank separator", () => {
    expect(cleanFinal("Thinking: line\nanswer continues")).toBe("answer continues");
  });

  it("handles the other prefix variants case-insensitively", () => {
    expect(cleanFinal("Reasoning: blah\n\nAnswer: yes")).toBe("yes");
    expect(cleanFinal("Thought Process:\nsome reasoning\n\nSure, here it is.")).toBe("Sure, here it is.");
    expect(cleanFinal("thought: x\n\nBody")).toBe("Body");
  });

  it("is loop-safe for repeated labels", () => {
    expect(cleanFinal("Answer: Answer: hi")).toBe("hi");
  });
});
