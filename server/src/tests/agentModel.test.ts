import { beforeEach, describe, expect, it, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({ listAgentHistoryForRun: vi.fn() }));

vi.mock("../storageRuntime.js", () => ({
  storageRuntime: () => ({ chats: { listAgentHistoryForRun: storageMocks.listAgentHistoryForRun } }),
}));
vi.mock("../llm.js", () => ({ chatOnce: vi.fn(), streamingChat: vi.fn() }));
vi.mock("../dataService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dataService.js")>()),
  dataService: { listDatasetCatalog: vi.fn() },
}));
vi.mock("../tools.js", () => ({ TOOL_DEFS: [], executeTool: vi.fn() }));

import {
  buildSystemPrompt,
  runAgent,
  safeToolFailure,
  runToolRound,
  selectRecentHistory,
  serializedAgentCharacterCount,
} from "../agent.js";
import { chatOnce, streamingChat } from "../llm.js";
import { dataService, DataServiceError } from "../dataService.js";
import { executeTool } from "../tools.js";

const historyMock = storageMocks.listAgentHistoryForRun;
const chatOnceMock = vi.mocked(chatOnce);
const streamingChatMock = vi.mocked(streamingChat);
const listDatasetCatalogMock = vi.mocked(dataService.listDatasetCatalog);
const executeToolMock = vi.mocked(executeTool);
const emptyScope = Object.freeze({
  mode: "selected" as const,
  attached: Object.freeze([]),
  readySourceIds: Object.freeze([]),
  readyTableNames: Object.freeze([]),
});

describe("runAgent model snapshot", () => {
  beforeEach(() => {
    historyMock.mockReset();
    historyMock.mockResolvedValue([]);
    chatOnceMock.mockReset();
    streamingChatMock.mockReset();
    listDatasetCatalogMock.mockReset();
    executeToolMock.mockReset();
  });

  it("uses one immutable model and records it on the assistant message", async () => {
    listDatasetCatalogMock.mockResolvedValue({ datasets: [], total: 0, returned: 0, omitted: 0, truncated: false });
    streamingChatMock.mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "final answer", tool_calls: [] } }],
    } as any);
    const emitted: any[] = [];

    const completion = await runAgent({
      accountId: "account-1",
      chatId: "chat-1",
      runId: "11111111-1111-4111-8111-111111111111",
      content: "question",
      model: "selected-chat-model",
      sourceScope: emptyScope,
      emit: (event) => {
        emitted.push(event);
      },
    });

    expect(chatOnceMock).not.toHaveBeenCalled();
    expect(streamingChatMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ model: "selected-chat-model" }),
      expect.any(Function)
    );
    expect(completion).toEqual({
      content: "final answer",
      meta: {
        charts: [],
        report: null,
        model: "selected-chat-model",
        source_mode: "selected",
        source_ids: [],
        citations: [],
        evidence: [],
        query_results: [],
      },
    });
    expect(emitted).toEqual([]);
  });

  it("persists and emits the evidence captured by a retrieval turn", async () => {
    const evidence = [
      {
        source_id: "11111111-1111-4111-8111-111111111111",
        chunk_id: "42",
        source: "Allowed.pdf",
        excerpt: "A grounded passage",
        score: 0.91,
      },
    ];
    listDatasetCatalogMock.mockResolvedValue({ datasets: [], total: 0, returned: 0, omitted: 0, truncated: false });
    streamingChatMock
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "retrieve-1",
                  type: "function",
                  function: { name: "retrieve", arguments: '{"query":"grounding"}' },
                },
              ],
            },
          },
        ],
      } as any)
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "grounded answer", tool_calls: [] } }],
      } as any);
    executeToolMock.mockImplementationOnce(async (_accountId, name, _args, context) => {
      expect(name).toBe("retrieve");
      context.evidence = evidence;
      return { passages: [] };
    });
    const emitted: any[] = [];

    const completion = await runAgent({
      accountId: "account-1",
      chatId: "chat-1",
      runId: "11111111-1111-4111-8111-111111111111",
      content: "question",
      model: "selected-chat-model",
      sourceScope: emptyScope,
      emit: (event) => {
        emitted.push(event);
      },
    });

    expect(completion.content).toBe("grounded answer");
    expect(completion.meta.evidence).toEqual(evidence);
    expect(completion.meta.query_results).toEqual([]);
    expect(emitted.every((event) => event.type !== "message" && event.type !== "delta")).toBe(true);
  });

  it("resolves cited markers into citation metadata derived from the run's own evidence", async () => {
    const evidence = [
      {
        source_id: "11111111-1111-4111-8111-111111111111",
        chunk_id: "41",
        source: "Allowed.pdf",
        excerpt: "A grounded passage",
        score: 0.91,
      },
      {
        source_id: "22222222-2222-4222-8222-222222222222",
        chunk_id: "42",
        source: "Other.pdf",
        excerpt: "Another passage",
        score: 0.81,
      },
    ];
    listDatasetCatalogMock.mockResolvedValue({ datasets: [], total: 0, returned: 0, omitted: 0, truncated: false });
    streamingChatMock
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "retrieve-1",
                  type: "function",
                  function: { name: "retrieve", arguments: '{"query":"grounding"}' },
                },
              ],
            },
          },
        ],
      } as any)
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Grounded claim [2] with unresolved [5], invalid [0], and repeated [2].",
              tool_calls: [],
            },
          },
        ],
      } as any);
    executeToolMock.mockImplementationOnce(async (_accountId, _name, _args, context) => {
      context.evidence = evidence;
      return { passages: [] };
    });

    const completion = await runAgent({
      accountId: "account-1",
      chatId: "chat-1",
      runId: "11111111-1111-4111-8111-111111111111",
      content: "question",
      model: "selected-chat-model",
      sourceScope: emptyScope,
      emit: () => {},
    });

    expect(completion.meta.citations).toEqual([
      { n: 2, source_id: "22222222-2222-4222-8222-222222222222", chunk_id: "42", source: "Other.pdf" },
    ]);
  });

  it("persists and emits query artifacts without dropping prior evidence metadata", async () => {
    const evidence = [
      {
        source_id: "11111111-1111-4111-8111-111111111111",
        chunk_id: "42",
        source: "Allowed.pdf",
        excerpt: "A grounded passage",
        score: 0.91,
      },
    ];
    const queryResults = [
      {
        id: "query-1",
        sql: "SELECT category, sum(amount) FROM ledger GROUP BY category",
        columns: ["category", "amount"],
        rows: [["Food", 42]],
        row_count: 1,
        truncated: false,
      },
    ];
    listDatasetCatalogMock.mockResolvedValue({ datasets: [], total: 0, returned: 0, omitted: 0, truncated: false });
    streamingChatMock
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "retrieve-1",
                  type: "function",
                  function: { name: "retrieve", arguments: '{"query":"grounding"}' },
                },
                { id: "query-1", type: "function", function: { name: "query_data", arguments: '{"sql":"SELECT 42"}' } },
              ],
            },
          },
        ],
      } as any)
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "grounded data answer", tool_calls: [] } }],
      } as any);
    executeToolMock.mockImplementation(async (_accountId, name, _args, context) => {
      if (name === "retrieve") {
        context.evidence = evidence;
        return { passages: [] };
      }
      if (name === "query_data") {
        context.queryResults = queryResults;
        return { columns: ["category", "amount"], rows: [["Food", 42]], row_count: 1 };
      }
      throw new Error(`unexpected tool ${name}`);
    });
    const emitted: any[] = [];

    const completion = await runAgent({
      accountId: "account-1",
      chatId: "chat-1",
      runId: "11111111-1111-4111-8111-111111111111",
      content: "question",
      model: "selected-chat-model",
      sourceScope: emptyScope,
      emit: (event) => {
        emitted.push(event);
      },
    });

    expect(completion.meta).toEqual({
      charts: [],
      report: null,
      model: "selected-chat-model",
      source_mode: "selected",
      source_ids: [],
      citations: [],
      evidence,
      query_results: queryResults,
    });
    expect(completion.content).toBe("grounded data answer");
    expect(emitted.every((event) => event.type !== "message" && event.type !== "delta")).toBe(true);
  });

  it("gives actionable query feedback without exposing native exception details", () => {
    const failure = new DataServiceError(422, "/datasets/query");
    expect(safeToolFailure("query_data", failure)).toContain("describe_data");
    expect(safeToolFailure("query_data", new DataServiceError(504, "query"))).toContain("timed out");
    const privateFailure = new Error("SELECT private_amount FROM private_account: secret token");
    expect(safeToolFailure("query_data", privateFailure)).not.toMatch(/private_amount|private_account|secret token/);
  });

  it.each(["failure", "empty"])(
    "recovers a provider %s after tools with a bounded final synthesis request",
    async (mode) => {
      streamingChatMock.mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "query-1", function: { name: "query_data", arguments: "{}" } }],
            },
          },
        ],
      } as any);
      executeToolMock.mockImplementationOnce(async (_a, _n, _args, context) => {
        context.queryResults = [
          { id: "query-1", sql: "SELECT 1", columns: ["n"], rows: [[1]], row_count: 1, truncated: false },
        ];
        return { rows: [[1]] };
      });
      if (mode === "failure") streamingChatMock.mockRejectedValueOnce(new Error("private provider payload"));
      else
        streamingChatMock.mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "" } }] } as any);
      streamingChatMock.mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "The verified count is one." } }],
      } as any);
      const result = await runAgent({
        accountId: "account-1",
        chatId: "chat-1",
        runId: "run-1",
        content: "Analyze",
        model: "model",
        sourceScope: emptyScope,
        emit: () => {},
      });
      expect(result.content).toBe("The verified count is one.");
      expect(result.meta.query_results).toHaveLength(1);
      expect(streamingChatMock).toHaveBeenCalledTimes(3);
      expect(streamingChatMock.mock.calls.at(-1)?.[1]?.tools).toEqual([]);
      expect(JSON.stringify(streamingChatMock.mock.calls.at(-1)?.[0])).not.toContain("private provider payload");
    }
  );

  it("uses the same evidence metadata contract when the iteration guard is exhausted", async () => {
    const evidence = [
      {
        source_id: "11111111-1111-4111-8111-111111111111",
        chunk_id: "42",
        source: "Allowed.pdf",
        excerpt: "A grounded passage",
        score: 0.91,
      },
    ];
    listDatasetCatalogMock.mockResolvedValue({ datasets: [], total: 0, returned: 0, omitted: 0, truncated: false });
    for (let index = 0; index < 16; index += 1) {
      streamingChatMock.mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: `retrieve-${index}`, type: "function", function: { name: "retrieve", arguments: "{}" } },
              ],
            },
          },
        ],
      } as any);
    }
    streamingChatMock.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "Here is the analysis from the collected evidence." } }],
    } as any);
    executeToolMock.mockImplementation(async (_accountId, _name, _args, context) => {
      context.evidence = evidence;
      return { passages: [] };
    });
    const emitted: any[] = [];

    const completion = await runAgent({
      accountId: "account-1",
      chatId: "chat-1",
      runId: "11111111-1111-4111-8111-111111111111",
      content: "question",
      model: "selected-chat-model",
      sourceScope: emptyScope,
      emit: (event) => {
        emitted.push(event);
      },
    });

    expect(completion.meta).toEqual({
      charts: [],
      report: null,
      model: "selected-chat-model",
      source_mode: "selected",
      source_ids: [],
      citations: [],
      evidence,
      query_results: [],
    });
    expect(completion.content).toContain("analysis from the collected evidence");
    expect(streamingChatMock.mock.calls.at(-1)?.[1]?.tools).toEqual([]);
    expect(streamingChatMock).toHaveBeenCalledTimes(17);
    for (const [messages] of streamingChatMock.mock.calls) {
      expect(messages[0].role).toBe("system");
      expect(messages.slice(1).some((message) => message.role === "system")).toBe(false);
    }
    expect(emitted.every((event) => event.type !== "message" && event.type !== "delta")).toBe(true);
  });

  it("does not accept evidence from a retrieval that resolves after its timeout", async () => {
    const priorEvidence = {
      source_id: "11111111-1111-4111-8111-111111111111",
      chunk_id: "accepted",
      source: "Accepted.pdf",
      excerpt: "Previously accepted evidence",
      score: 0.95,
    };
    const lateEvidence = {
      source_id: "22222222-2222-4222-8222-222222222222",
      chunk_id: "late",
      source: "Late.pdf",
      excerpt: "This retrieval lost the timeout race",
      score: 0.9,
    };
    const context = {
      chartIds: [],
      evidence: [priorEvidence],
      queryResults: [],
      chatId: "chat-1",
      runId: "run-1",
      model: "selected-chat-model",
      sourceScope: emptyScope,
      readySourceIds: emptyScope.readySourceIds,
      readyTableNames: emptyScope.readyTableNames,
    };
    let completeLateRetrieval: (() => void) | undefined;
    executeToolMock.mockImplementationOnce(
      (_accountId, _name, _args, isolatedContext) =>
        new Promise((resolve) => {
          completeLateRetrieval = () => {
            isolatedContext.evidence = [...isolatedContext.evidence, lateEvidence];
            resolve({ passages: [] });
          };
        })
    );
    const messages: any[] = [];
    const emitted: any[] = [];

    await runToolRound(
      "account-1",
      "chat-1",
      { id: "retrieve-timeout", function: { name: "retrieve", arguments: '{"query":"slow"}' } },
      messages,
      context,
      (event) => emitted.push(event),
      0
    );

    expect(context.evidence).toEqual([priorEvidence]);
    expect(emitted).toContainEqual({
      type: "step-end",
      name: "retrieve",
      summary: "This operation took too long. Try a smaller query or a simpler operation.",
      status: "error",
    });
    expect(completeLateRetrieval).toBeTypeOf("function");
    completeLateRetrieval?.();
    await Promise.resolve();
    expect(context.evidence).toEqual([priorEvidence]);
  });

  it("does not accept query artifacts from a query that resolves after its timeout", async () => {
    const priorQuery = {
      id: "query-1",
      sql: "SELECT 1",
      columns: ["n"],
      rows: [[1]],
      row_count: 1,
      truncated: false,
    };
    const lateQuery = {
      id: "query-2",
      sql: "SELECT 2",
      columns: ["n"],
      rows: [[2]],
      row_count: 1,
      truncated: false,
    };
    const context = {
      chartIds: [],
      evidence: [],
      queryResults: [priorQuery],
      chatId: "chat-1",
      runId: "run-1",
      model: "selected-chat-model",
      sourceScope: emptyScope,
      readySourceIds: emptyScope.readySourceIds,
      readyTableNames: emptyScope.readyTableNames,
    };
    let completeLateQuery: (() => void) | undefined;
    executeToolMock.mockImplementationOnce(
      (_accountId, _name, _args, isolatedContext) =>
        new Promise((resolve) => {
          completeLateQuery = () => {
            isolatedContext.queryResults = [...isolatedContext.queryResults, lateQuery];
            resolve({ columns: ["n"], rows: [[2]], row_count: 1 });
          };
        })
    );
    const emitted: any[] = [];

    await runToolRound(
      "account-1",
      "chat-1",
      { id: "query-timeout", function: { name: "query_data", arguments: '{"sql":"SELECT 2"}' } },
      [],
      context,
      (event) => emitted.push(event),
      0
    );

    expect(context.queryResults).toEqual([priorQuery]);
    expect(emitted).toContainEqual({
      type: "step-end",
      name: "query_data",
      summary: "This operation took too long. Try a smaller query or a simpler operation.",
      status: "error",
    });
    expect(completeLateQuery).toBeTypeOf("function");
    completeLateQuery?.();
    await Promise.resolve();
    expect(context.queryResults).toEqual([priorQuery]);
  });

  it("never emits raw tool arguments or results in execution events", async () => {
    executeToolMock.mockResolvedValueOnce({ secret: "result-canary" });
    const emitted: any[] = [];
    await runToolRound(
      "account-1",
      "chat-1",
      { id: "call-1", function: { name: "query_data", arguments: '{"sql":"argument-canary"}' } },
      [],
      {
        chartIds: [],
        evidence: [],
        queryResults: [],
        chatId: "chat-1",
        runId: "run-1",
        model: "model",
        sourceScope: emptyScope,
        readySourceIds: [],
        readyTableNames: [],
      },
      (event) => emitted.push(event)
    );
    expect(JSON.stringify(emitted)).not.toContain("argument-canary");
    expect(JSON.stringify(emitted)).not.toContain("result-canary");
    expect(emitted).toEqual([
      { type: "step-start", name: "query_data", summary: "Running a scoped data query." },
      { type: "step-end", name: "query_data", summary: "Completed the scoped data query.", status: "ok" },
    ]);
  });

  it("selects the newest complete history messages within the character budget", () => {
    const rows = [{ content: "old" }, { content: "middle" }, { content: "new" }];
    const newestPairBudget = serializedAgentCharacterCount(rows[1]) + serializedAgentCharacterCount(rows[2]);
    expect(selectRecentHistory(rows, newestPairBudget)).toEqual([{ content: "middle" }, { content: "new" }]);
    expect(selectRecentHistory(rows, serializedAgentCharacterCount(rows[2]) - 1)).toEqual([]);
  });

  it("charges history JSON escapes without charging astral characters as two", () => {
    const controls = [
      { role: "user", content: "\u0001".repeat(32_000) },
      { role: "assistant", content: "\u0001".repeat(32_000) },
    ];
    expect(selectRecentHistory(controls, 120_000)).toEqual([]);

    const astral = [{ role: "assistant", content: "😀".repeat(100_000) }];
    expect(selectRecentHistory(astral, 136_000)).toEqual(astral);
  });

  it("runs with repeated control-heavy legal history without exceeding the provider budget", async () => {
    historyMock.mockResolvedValueOnce([
      { role: "user", content: "\u0001".repeat(32_000) },
      { role: "assistant", content: "\u0001".repeat(32_000) },
    ]);
    listDatasetCatalogMock.mockResolvedValue({
      datasets: [],
      total: 0,
      returned: 0,
      omitted: 0,
      truncated: false,
    });
    streamingChatMock.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "bounded answer", tool_calls: [] } }],
    } as any);

    await expect(
      runAgent({
        accountId: "account-1",
        chatId: "chat-1",
        runId: "11111111-1111-4111-8111-111111111111",
        content: "question",
        model: "selected-chat-model",
        sourceScope: emptyScope,
        emit: () => {},
      })
    ).resolves.toMatchObject({ content: "bounded answer" });
    const providerMessages = streamingChatMock.mock.calls[0][0];
    expect(providerMessages).toHaveLength(2);
    expect(providerMessages[1]).toEqual({ role: "user", content: "question" });
  });

  it("preserves repeated legal astral history under the same serialized budget", async () => {
    const emoji = "😀".repeat(32_000);
    historyMock.mockResolvedValueOnce([
      { role: "user", content: emoji },
      { role: "assistant", content: emoji },
      { role: "user", content: emoji },
    ]);
    listDatasetCatalogMock.mockResolvedValue({
      datasets: [],
      total: 0,
      returned: 0,
      omitted: 0,
      truncated: false,
    });
    streamingChatMock.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "astral answer", tool_calls: [] } }],
    } as any);

    await expect(
      runAgent({
        accountId: "account-1",
        chatId: "chat-1",
        runId: "11111111-1111-4111-8111-111111111111",
        content: "question",
        model: "selected-chat-model",
        sourceScope: emptyScope,
        emit: () => {},
      })
    ).resolves.toMatchObject({ content: "astral answer" });
    expect(streamingChatMock.mock.calls[0][0]).toHaveLength(5);
  });

  it("builds the catalog only from selected tables and names attached unready sources", async () => {
    listDatasetCatalogMock.mockResolvedValueOnce({
      datasets: [
        {
          table: "allowed_table",
          original_name: "Allowed.csv",
          rows: 2,
          columns: [{ name: "amount", type: "DOUBLE" }],
        },
      ],
      total: 1,
      returned: 1,
      omitted: 0,
      truncated: false,
    });
    const sourceScope = Object.freeze({
      mode: "selected" as const,
      attached: Object.freeze([
        Object.freeze({
          id: "11111111-1111-4111-8111-111111111111",
          name: "allowed_table",
          display_name: "Allowed.csv",
          kind: "tabular",
          status: "ready",
        }),
        Object.freeze({
          id: "22222222-2222-4222-8222-222222222222",
          name: "pending_table",
          display_name: "Pending.csv",
          kind: "tabular",
          status: "index",
        }),
      ]),
      readySourceIds: Object.freeze(["11111111-1111-4111-8111-111111111111"]),
      readyTableNames: Object.freeze(["allowed_table"]),
    });

    const prompt = await buildSystemPrompt("account-1", sourceScope);

    expect(prompt).toContain('table "allowed_table"');
    expect(prompt).toContain("Pending.csv (tabular): index");
    expect(prompt).not.toContain("unselected_canary");
    expect(prompt).not.toContain("SECRET CANARY");
  });

  it("does not call the account-wide catalog for explicit none", async () => {
    const prompt = await buildSystemPrompt("account-1", emptyScope);
    expect(prompt).toContain("No stored sources are attached to this chat.");
    expect(listDatasetCatalogMock).not.toHaveBeenCalled();
  });
});
