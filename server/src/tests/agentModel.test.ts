import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ q: vi.fn() }));
vi.mock("../llm.js", () => ({ chatOnce: vi.fn(), streamingChat: vi.fn() }));
vi.mock("../pythonClient.js", () => ({ py: { listDatasets: vi.fn() } }));
vi.mock("../tools.js", () => ({ TOOL_DEFS: [], executeTool: vi.fn() }));

import { buildSystemPrompt, runAgent, runToolRound } from "../agent.js";
import { q } from "../db.js";
import { chatOnce, streamingChat } from "../llm.js";
import { py } from "../pythonClient.js";
import { executeTool } from "../tools.js";

const qMock = vi.mocked(q);
const chatOnceMock = vi.mocked(chatOnce);
const streamingChatMock = vi.mocked(streamingChat);
const listDatasetsMock = vi.mocked(py.listDatasets);
const executeToolMock = vi.mocked(executeTool);
const emptyScope = Object.freeze({
  mode: "selected" as const,
  attached: Object.freeze([]),
  readySourceIds: Object.freeze([]),
  readyTableNames: Object.freeze([]),
});

describe("runAgent model snapshot", () => {
  beforeEach(() => {
    qMock.mockReset();
    chatOnceMock.mockReset();
    streamingChatMock.mockReset();
    listDatasetsMock.mockReset();
    executeToolMock.mockReset();
  });

  it("uses one immutable model and records it on the assistant message", async () => {
    qMock.mockResolvedValue([]);
    listDatasetsMock.mockResolvedValue([]);
    chatOnceMock.mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "draft", tool_calls: [] } }],
    } as any);
    streamingChatMock.mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "final answer", tool_calls: [] } }],
    } as any);
    const emitted: any[] = [];

    await runAgent({
      accountId: "account-1",
      chatId: "chat-1",
      content: "question",
      model: "selected-chat-model",
      sourceScope: emptyScope,
      emit: (event) => {
        emitted.push(event);
      },
    });

    expect(chatOnceMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ model: "selected-chat-model" })
    );
    expect(streamingChatMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ model: "selected-chat-model" }),
      expect.any(Function)
    );
    const insert = qMock.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO messages"));
    expect(insert).toBeDefined();
    expect(JSON.parse(String(insert?.[1]?.[2]))).toEqual({
      charts: [],
      report: null,
      model: "selected-chat-model",
      source_mode: "selected",
      source_ids: [],
      evidence: [],
      query_results: [],
    });
    expect(emitted).toContainEqual({
      type: "message",
      roles: [],
      content: "final answer",
      meta: {
        charts: [],
        report: null,
        model: "selected-chat-model",
        source_mode: "selected",
        source_ids: [],
        evidence: [],
        query_results: [],
      },
    });
  });

  it("persists and emits the evidence captured by a retrieval turn", async () => {
    const evidence = [{
      source_id: "11111111-1111-4111-8111-111111111111",
      chunk_id: "42",
      source: "Allowed.pdf",
      excerpt: "A grounded passage",
      score: 0.91,
    }];
    qMock.mockResolvedValue([]);
    listDatasetsMock.mockResolvedValue([]);
    chatOnceMock
      .mockResolvedValueOnce({
        choices: [{ message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "retrieve-1", type: "function", function: { name: "retrieve", arguments: '{"query":"grounding"}' } }],
        } }],
      } as any)
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "draft", tool_calls: [] } }] } as any);
    executeToolMock.mockImplementationOnce(async (_accountId, name, _args, context) => {
      expect(name).toBe("retrieve");
      context.evidence = evidence;
      return { passages: [] };
    });
    streamingChatMock.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "grounded answer", tool_calls: [] } }],
    } as any);
    const emitted: any[] = [];

    await runAgent({
      accountId: "account-1",
      chatId: "chat-1",
      content: "question",
      model: "selected-chat-model",
      sourceScope: emptyScope,
      emit: (event) => {
        emitted.push(event);
      },
    });

    const insert = qMock.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO messages"));
    const persistedMeta = JSON.parse(String(insert?.[1]?.[2]));
    expect(persistedMeta.evidence).toEqual(evidence);
    expect(persistedMeta.query_results).toEqual([]);
    expect(emitted).toContainEqual(expect.objectContaining({
      type: "message",
      content: "grounded answer",
      meta: persistedMeta,
    }));
  });

  it("persists and emits query artifacts without dropping prior evidence metadata", async () => {
    const evidence = [{
      source_id: "11111111-1111-4111-8111-111111111111",
      chunk_id: "42",
      source: "Allowed.pdf",
      excerpt: "A grounded passage",
      score: 0.91,
    }];
    const queryResults = [{
      id: "query-1",
      sql: "SELECT category, sum(amount) FROM ledger GROUP BY category",
      columns: ["category", "amount"],
      rows: [["Food", 42]],
      row_count: 1,
      truncated: false,
    }];
    qMock.mockResolvedValue([]);
    listDatasetsMock.mockResolvedValue([]);
    chatOnceMock
      .mockResolvedValueOnce({
        choices: [{ message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "retrieve-1", type: "function", function: { name: "retrieve", arguments: '{"query":"grounding"}' } },
            { id: "query-1", type: "function", function: { name: "query_data", arguments: '{"sql":"SELECT 42"}' } },
          ],
        } }],
      } as any)
      .mockResolvedValueOnce({ choices: [{ message: { role: "assistant", content: "draft", tool_calls: [] } }] } as any);
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
    streamingChatMock.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "grounded data answer", tool_calls: [] } }],
    } as any);
    const emitted: any[] = [];

    await runAgent({
      accountId: "account-1",
      chatId: "chat-1",
      content: "question",
      model: "selected-chat-model",
      sourceScope: emptyScope,
      emit: (event) => {
        emitted.push(event);
      },
    });

    const insert = qMock.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO messages"));
    const persistedMeta = JSON.parse(String(insert?.[1]?.[2]));
    expect(persistedMeta).toEqual({
      charts: [],
      report: null,
      model: "selected-chat-model",
      source_mode: "selected",
      source_ids: [],
      evidence,
      query_results: queryResults,
    });
    expect(emitted).toContainEqual(expect.objectContaining({
      type: "message",
      content: "grounded data answer",
      meta: persistedMeta,
    }));
  });

  it("uses the same evidence metadata contract when the iteration guard is exhausted", async () => {
    const evidence = [{
      source_id: "11111111-1111-4111-8111-111111111111",
      chunk_id: "42",
      source: "Allowed.pdf",
      excerpt: "A grounded passage",
      score: 0.91,
    }];
    qMock.mockResolvedValue([]);
    listDatasetsMock.mockResolvedValue([]);
    for (let index = 0; index < 8; index += 1) {
      chatOnceMock.mockResolvedValueOnce({
        choices: [{ message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: `retrieve-${index}`, type: "function", function: { name: "retrieve", arguments: "{}" } }],
        } }],
      } as any);
    }
    chatOnceMock.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "guard answer", tool_calls: [] } }],
    } as any);
    executeToolMock.mockImplementation(async (_accountId, _name, _args, context) => {
      context.evidence = evidence;
      return { passages: [] };
    });
    const emitted: any[] = [];

    await runAgent({
      accountId: "account-1",
      chatId: "chat-1",
      content: "question",
      model: "selected-chat-model",
      sourceScope: emptyScope,
      emit: (event) => {
        emitted.push(event);
      },
    });

    const insert = qMock.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO messages"));
    const persistedMeta = JSON.parse(String(insert?.[1]?.[2]));
    expect(persistedMeta).toEqual({
      charts: [],
      report: null,
      model: "selected-chat-model",
      source_mode: "selected",
      source_ids: [],
      evidence,
      query_results: [],
    });
    expect(emitted).toContainEqual(expect.objectContaining({ type: "message", meta: persistedMeta }));
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
      model: "selected-chat-model",
      sourceScope: emptyScope,
      readySourceIds: emptyScope.readySourceIds,
      readyTableNames: emptyScope.readyTableNames,
    };
    let completeLateRetrieval: (() => void) | undefined;
    executeToolMock.mockImplementationOnce((_accountId, _name, _args, isolatedContext) => (
      new Promise((resolve) => {
        completeLateRetrieval = () => {
          isolatedContext.evidence = [...isolatedContext.evidence, lateEvidence];
          resolve({ passages: [] });
        };
      })
    ));
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
    expect(emitted).toContainEqual({ type: "step-end", name: "retrieve", result: { error: "tool timed out" } });
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
      model: "selected-chat-model",
      sourceScope: emptyScope,
      readySourceIds: emptyScope.readySourceIds,
      readyTableNames: emptyScope.readyTableNames,
    };
    let completeLateQuery: (() => void) | undefined;
    executeToolMock.mockImplementationOnce((_accountId, _name, _args, isolatedContext) => (
      new Promise((resolve) => {
        completeLateQuery = () => {
          isolatedContext.queryResults = [...isolatedContext.queryResults, lateQuery];
          resolve({ columns: ["n"], rows: [[2]], row_count: 1 });
        };
      })
    ));
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
    expect(emitted).toContainEqual({ type: "step-end", name: "query_data", result: { error: "tool timed out" } });
    expect(completeLateQuery).toBeTypeOf("function");
    completeLateQuery?.();
    await Promise.resolve();
    expect(context.queryResults).toEqual([priorQuery]);
  });

  it("builds the catalog only from selected tables and names attached unready sources", async () => {
    listDatasetsMock.mockResolvedValueOnce([
      { table: "allowed_table", original_name: "Allowed.csv", rows: 2, columns: [{ name: "amount", type: "DOUBLE" }] },
      { table: "unselected_canary", original_name: "SECRET CANARY", rows: 1, columns: [] },
    ]);
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
    expect(listDatasetsMock).not.toHaveBeenCalled();
  });
});
