import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { initDb, pool } from "../db.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat schema migrations", () => {
  it("keeps model, activity, and manual-title migrations idempotent and ordered", async () => {
    const query = vi.spyOn(pool, "query").mockResolvedValue({ rows: [] } as any);

    await initDb();

    expect(query).toHaveBeenCalledTimes(3);
    const schema = String(query.mock.calls[0][0]);
    expect(schema).toContain("model TEXT");
    expect(schema).toContain("ALTER TABLE chats ADD COLUMN IF NOT EXISTS model TEXT");
    expect(schema).toContain("updated_at TIMESTAMPTZ NOT NULL DEFAULT now()");
    expect(schema).toContain("title_is_manual BOOLEAN NOT NULL DEFAULT false");
    expect(schema).toContain("ALTER TABLE chats ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ");
    expect(schema).toContain("UPDATE chats SET updated_at=created_at WHERE updated_at IS NULL");
    expect(schema).toContain("ALTER TABLE chats ALTER COLUMN updated_at SET DEFAULT now()");
    expect(schema).toContain("ALTER TABLE chats ALTER COLUMN updated_at SET NOT NULL");
    expect(schema).toContain("ALTER TABLE chats ADD COLUMN IF NOT EXISTS title_is_manual BOOLEAN");
    expect(schema).toContain("UPDATE chats SET title_is_manual=false WHERE title_is_manual IS NULL");
    expect(schema).toContain("ALTER TABLE chats ALTER COLUMN title_is_manual SET DEFAULT false");
    expect(schema).toContain("ALTER TABLE chats ALTER COLUMN title_is_manual SET NOT NULL");
    expect(schema).toContain(
      "CREATE INDEX IF NOT EXISTS chats_account_activity_idx ON chats (account_id, updated_at DESC, id DESC)"
    );
    expect(schema.indexOf("ALTER TABLE chats ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ")).toBeLessThan(
      schema.indexOf("UPDATE chats SET updated_at=created_at WHERE updated_at IS NULL")
    );
    expect(schema.indexOf("UPDATE chats SET updated_at=created_at WHERE updated_at IS NULL")).toBeLessThan(
      schema.indexOf("ALTER TABLE chats ALTER COLUMN updated_at SET NOT NULL")
    );
    expect(schema.indexOf("ALTER TABLE chats ADD COLUMN IF NOT EXISTS title_is_manual BOOLEAN")).toBeLessThan(
      schema.indexOf("UPDATE chats SET title_is_manual=false WHERE title_is_manual IS NULL")
    );
    expect(schema.indexOf("UPDATE chats SET title_is_manual=false WHERE title_is_manual IS NULL")).toBeLessThan(
      schema.indexOf("ALTER TABLE chats ALTER COLUMN title_is_manual SET NOT NULL")
    );
    expect(query.mock.calls[1]).toEqual(["UPDATE chats SET model=$1 WHERE model IS NULL", [config.chatModel]]);
    expect(query.mock.calls[2][0]).toBe("ALTER TABLE chats ALTER COLUMN model SET NOT NULL");
  });
});
