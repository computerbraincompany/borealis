import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ q: vi.fn() }));
vi.mock("../llm.js", () => ({ chatOnce: vi.fn(), streamingChat: vi.fn() }));
vi.mock("../pythonClient.js", () => ({ py: { listDatasets: vi.fn() } }));
vi.mock("../tools.js", () => ({ TOOL_DEFS: [], executeTool: vi.fn() }));

import { buildSystemPrompt, runAgent } from "../agent.js";
import { q } from "../db.js";
import { chatOnce, streamingChat } from "../llm.js";
import { py } from "../pythonClient.js";

const qMock = vi.mocked(q);
const chatOnceMock = vi.mocked(chatOnce);
const streamingChatMock = vi.mocked(streamingChat);
const listDatasetsMock = vi.mocked(py.listDatasets);
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
      },
    });
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
