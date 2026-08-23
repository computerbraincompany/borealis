import { describe, expect, it, vi } from "vitest";
import {
  parseSourceScopeInput,
  resolveChatSourceScope,
  SourceScopeError,
  type ScopeQueryable,
} from "../sourceScope.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("parseSourceScopeInput", () => {
  it("accepts all and stable-dedupes selected UUIDs", () => {
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

describe("resolveChatSourceScope", () => {
  it("keeps attached non-ready rows but derives ready ids and tabular names", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ source_mode: "selected" }] })
      .mockResolvedValueOnce({
        rows: [
          { id: A, name: "accounts", display_name: "Accounts.csv", kind: "tabular", status: "ready" },
          { id: B, name: "notes", display_name: "Notes.pdf", kind: "document", status: "index" },
        ],
      });

    const scope = await resolveChatSourceScope({ query } as unknown as ScopeQueryable, "account", "chat");

    expect(scope).toEqual({
      mode: "selected",
      attached: [
        { id: A, name: "accounts", display_name: "Accounts.csv", kind: "tabular", status: "ready" },
        { id: B, name: "notes", display_name: "Notes.pdf", kind: "document", status: "index" },
      ],
      readySourceIds: [A],
      readyTableNames: ["accounts"],
    });
    expect(query.mock.calls[1][0]).toContain("FROM chat_sources");
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.attached)).toBe(true);
    expect(Object.isFrozen(scope.attached[0])).toBe(true);
    expect(Object.isFrozen(scope.readySourceIds)).toBe(true);
  });

  it("resolves all dynamically from account-owned sources", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ source_mode: "all" }] })
      .mockResolvedValueOnce({ rows: [] });

    const scope = await resolveChatSourceScope({ query } as unknown as ScopeQueryable, "account", "chat");

    expect(scope.mode).toBe("all");
    expect(query.mock.calls[1][0]).toContain("WHERE s.account_id=$1");
    expect(query.mock.calls[1][1]).toEqual(["account"]);
  });

  it("rejects an all-mode scope beyond the shared 100-source boundary", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ source_mode: "all" }] })
      .mockResolvedValueOnce({
        rows: Array.from({ length: 101 }, (_, index) => ({
          id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
          name: `source_${index}`,
          display_name: `Source ${index}`,
          kind: "tabular",
          status: "ready",
        })),
      });

    await expect(
      resolveChatSourceScope({ query } as unknown as ScopeQueryable, "account", "chat")
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "chat source scope exceeds 100 sources; select a smaller set",
    });
    expect(query.mock.calls[1][0]).toContain("LIMIT 101");
  });

  it("does not reveal whether a foreign or missing chat exists", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    await expect(
      resolveChatSourceScope({ query } as unknown as ScopeQueryable, "account", "chat")
    ).rejects.toMatchObject({ statusCode: 404, message: "chat not found" });
  });
});
