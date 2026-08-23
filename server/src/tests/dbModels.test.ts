import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { initDb, pool } from "../db.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat model schema migration", () => {
  it("adds the column, parameterizes the one-time backfill, then enforces not-null", async () => {
    const query = vi.spyOn(pool, "query").mockResolvedValue({ rows: [] } as any);

    await initDb();

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0][0]).toContain("model TEXT");
    expect(query.mock.calls[0][0]).toContain("ALTER TABLE chats ADD COLUMN IF NOT EXISTS model TEXT");
    expect(query.mock.calls[1]).toEqual([
      "UPDATE chats SET model=$1 WHERE model IS NULL",
      [config.chatModel],
    ]);
    expect(query.mock.calls[2][0]).toBe("ALTER TABLE chats ALTER COLUMN model SET NOT NULL");
  });
});
