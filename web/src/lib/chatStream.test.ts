import { applyAgentEvent, createStreamState, streamsByChatReducer } from "@/lib/chatStream";

describe("chat stream state", () => {
  it("stores run identity and safe execution summaries without retaining raw arguments or reasoning", () => {
    const initial = { ...createStreamState("model"), running: true };
    const started = applyAgentEvent(initial, { type: "run-started", run_id: "run-1" }, 0);
    const withStep = applyAgentEvent(
      started,
      {
        type: "step-start",
        name: "query_data",
        summary: "Checking 12 rows",
        args: { sql: "SELECT private_value FROM private_table", token: "must-not-survive" },
      },
      1,
    );
    const afterReasoning = applyAgentEvent(withStep, { type: "reasoning", text: "private chain of thought" }, 2);

    expect(afterReasoning).toBe(withStep);
    expect(afterReasoning.runId).toBe("run-1");
    expect(afterReasoning.steps[0]).toEqual({
      key: 1,
      name: "query_data",
      summary: "Checking 12 rows",
      status: "running",
    });
    const serialized = JSON.stringify(afterReasoning);
    expect(serialized).not.toContain("private_value");
    expect(serialized).not.toContain("must-not-survive");
    expect(serialized).not.toContain("chain of thought");
  });

  it("marks a legacy failed tool result without exposing its raw error", () => {
    const running = applyAgentEvent(
      createStreamState(),
      { type: "step-start", name: "fetch_url", args: { url: "https://private.test" } },
      1,
    );
    const failed = applyAgentEvent(
      running,
      { type: "step-end", name: "fetch_url", result: { error: "sensitive upstream response" } },
      2,
    );

    expect(failed.steps[0].status).toBe("error");
    expect(failed.steps[0].resultSummary).toBeUndefined();
    expect(JSON.stringify(failed)).not.toContain("sensitive upstream response");
  });

  it("keeps per-chat optimistic streams isolated and clears completed selected streams", () => {
    const state = streamsByChatReducer(
      {},
      {
        type: "replace",
        chatId: "chat-a",
        state: { ...createStreamState(), text: "draft" },
      },
    );
    const withOther = streamsByChatReducer(state, {
      type: "replace",
      chatId: "chat-b",
      state: { ...createStreamState(), running: true },
    });
    const selected = streamsByChatReducer(withOther, { type: "select-chat", chatId: "chat-a" });

    expect(selected["chat-a"]).toBeUndefined();
    expect(selected["chat-b"].running).toBe(true);
  });

  it("accepts only typed terminal events for the owned run and treats cancellation as non-error", () => {
    const running = applyAgentEvent(
      { ...createStreamState(), running: true, stopping: true },
      { type: "run-started", run_id: "run-1" },
      0,
    );
    const wrongRun = applyAgentEvent(running, { type: "run-ended", run_id: "run-2", status: "cancelled" }, 1);
    const wrongStatus = applyAgentEvent(running, { type: "run-ended", run_id: "run-1", status: "stopped" }, 2);
    const cancelled = applyAgentEvent(
      { ...running, error: "legacy cancellation error" },
      { type: "run-ended", run_id: "run-1", status: "cancelled" },
      3,
    );

    expect(wrongRun).toBe(running);
    expect(wrongStatus).toBe(running);
    expect(cancelled).toMatchObject({
      running: false,
      stopping: false,
      terminalStatus: "cancelled",
      error: null,
    });
  });

  it("rehydrates a different durable run without retaining stale partial output", () => {
    const stale = streamsByChatReducer(
      {},
      {
        type: "replace",
        chatId: "chat-a",
        state: { ...createStreamState("old-model"), runId: "old-run", text: "stale partial" },
      },
    );
    const rehydrated = streamsByChatReducer(stale, {
      type: "rehydrate",
      chatId: "chat-a",
      runId: "new-run",
      status: "cancelling",
      model: "new-model",
    });

    expect(rehydrated["chat-a"]).toMatchObject({
      running: true,
      stopping: true,
      runId: "new-run",
      model: "new-model",
      text: "",
      terminalStatus: null,
    });
  });

  it("clears only a stranded running stream when detail proves there is no active run", () => {
    const running = {
      "chat-a": { ...createStreamState(), running: true, text: "stale partial", error: "connection interrupted" },
    };
    const cleared = streamsByChatReducer(running, { type: "reconcile-no-active-run", chatId: "chat-a" });

    expect(cleared["chat-a"]).toBeUndefined();

    const failed = {
      "chat-a": { ...createStreamState(), terminalStatus: "failed" as const, error: "Generation failed" },
    };
    expect(streamsByChatReducer(failed, { type: "reconcile-no-active-run", chatId: "chat-a" })).toBe(failed);
  });
});
