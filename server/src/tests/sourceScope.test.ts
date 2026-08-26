import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSourceScope: vi.fn(),
  replaceSourceScope: vi.fn(),
}));

vi.mock("../storageRuntime.js", () => ({
  storageRuntime: () => ({
    chats: {
      resolveSourceScope: mocks.resolveSourceScope,
      replaceSourceScope: mocks.replaceSourceScope,
    },
  }),
}));

import { SourceScopeUnavailableError, StoreNotFoundError } from "../db/stores/chatStore.js";
import {
  parseSourceScopeInput,
  replaceChatSourceScope,
  resolveChatSourceScope,
  SourceScopeError,
} from "../sourceScope.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  mocks.resolveSourceScope.mockReset();
  mocks.replaceSourceScope.mockReset();
});

describe("parseSourceScopeInput", () => {
  it("accepts all and stable-dedupes selected UUIDs, including selected-empty", () => {
    expect(parseSourceScopeInput({ source_mode: "all" })).toEqual({ source_mode: "all" });
    expect(parseSourceScopeInput({ source_mode: "selected", source_ids: [A, B, A.toUpperCase()] })).toEqual({
      source_mode: "selected",
      source_ids: [A, B],
    });
    expect(parseSourceScopeInput({ source_mode: "selected", source_ids: [] })).toEqual({
      source_mode: "selected",
      source_ids: [],
    });
  });

  it.each([
    null,
    [],
    {},
    { source_ids: [] },
    { source_mode: "all", source_ids: [] },
    { source_mode: "selected" },
    { source_mode: "selected", source_ids: "not-an-array" },
    { source_mode: "selected", source_ids: ["not-a-uuid"] },
    { source_mode: "selected", source_ids: [], extra: true },
    { source_mode: "unknown" },
    { source_mode: "selected", source_ids: Array.from({ length: 101 }, () => A) },
  ])("rejects an invalid or ambiguous shape", (value) => {
    expect(() => parseSourceScopeInput(value)).toThrow(SourceScopeError);
  });
});

describe("SQLite source-scope boundary", () => {
  it("delegates exact account and chat ownership to ChatStore", async () => {
    const scope = Object.freeze({
      mode: "selected" as const,
      attached: Object.freeze([]),
      readySourceIds: Object.freeze([]),
      readyTableNames: Object.freeze([]),
    });
    mocks.resolveSourceScope.mockResolvedValueOnce(scope);

    await expect(resolveChatSourceScope("account", "chat")).resolves.toBe(scope);
    expect(mocks.resolveSourceScope).toHaveBeenCalledWith("account", "chat");
  });

  it("keeps foreign and missing chats indistinguishable", async () => {
    mocks.resolveSourceScope.mockRejectedValueOnce(new StoreNotFoundError("chat"));
    await expect(resolveChatSourceScope("account", "chat")).rejects.toMatchObject({
      statusCode: 404,
      message: "chat not found",
    });
  });

  it("maps a dynamic all-scope overflow to conflict", async () => {
    mocks.resolveSourceScope.mockRejectedValueOnce(
      new SourceScopeUnavailableError("chat source scope exceeds 100 sources; select a smaller set", {
        reason: "scope_limit",
      })
    );
    await expect(resolveChatSourceScope("account", "chat")).rejects.toMatchObject({
      statusCode: 409,
      message: "chat source scope exceeds 100 sources; select a smaller set",
    });
  });

  it("preserves selected-empty and maps unavailable replacement ids to bad request", async () => {
    const empty = Object.freeze({
      mode: "selected" as const,
      attached: Object.freeze([]),
      readySourceIds: Object.freeze([]),
      readyTableNames: Object.freeze([]),
    });
    mocks.replaceSourceScope.mockResolvedValueOnce(empty);
    await expect(replaceChatSourceScope("account", "chat", { source_mode: "selected", source_ids: [] })).resolves.toBe(
      empty
    );
    expect(mocks.replaceSourceScope).toHaveBeenCalledWith(
      "account",
      "chat",
      { source_mode: "selected", source_ids: [] },
      {}
    );

    mocks.replaceSourceScope.mockRejectedValueOnce(new SourceScopeUnavailableError());
    await expect(
      replaceChatSourceScope("account", "chat", { source_mode: "selected", source_ids: [A] })
    ).rejects.toMatchObject({ statusCode: 400, message: "one or more sources are unavailable" });
  });
});
