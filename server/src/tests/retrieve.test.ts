import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ q: vi.fn() }));
vi.mock("../llm.js", () => ({ embed: vi.fn() }));

import { q } from "../db.js";
import { embed } from "../llm.js";
import { retrieve } from "../retrieve.js";

const qMock = vi.mocked(q);
const embedMock = vi.mocked(embed);

describe("scoped retrieval", () => {
  beforeEach(() => {
    qMock.mockReset();
    embedMock.mockReset();
  });

  it("returns before embedding when no ready source is allowed", async () => {
    await expect(retrieve("account", "canary", [])).resolves.toEqual([]);
    expect(embedMock).not.toHaveBeenCalled();
    expect(qMock).not.toHaveBeenCalled();
  });

  it("filters vector search by both account and the server-derived source ids", async () => {
    embedMock.mockResolvedValueOnce([[0.25, 0.75]]);
    qMock.mockResolvedValueOnce([
      {
        chunk_id: "42",
        source_id: "11111111-1111-4111-8111-111111111111",
        source: "Allowed.pdf",
        content: "allowed",
        score: 0.9,
        file_path: "/private/not-returned.pdf",
        url: "https://not-returned.invalid",
      },
    ]);
    const allowed = ["11111111-1111-4111-8111-111111111111"];

    const result = await retrieve("account", "canary", allowed, 4);

    expect(result).toEqual([
      {
        chunk_id: "42",
        source_id: allowed[0],
        source: "Allowed.pdf",
        content: "allowed",
        score: 0.9,
      },
    ]);
    const sql = String(qMock.mock.calls[0][0]);
    expect(sql).toContain("chunks.id::text AS chunk_id");
    expect(sql).toContain("chunks.source_id::text AS source_id");
    expect(sql).toContain("COALESCE(NULLIF(sources.display_name, ''), chunks.source_name, 'Source') AS source");
    expect(sql).toContain("sources.id = chunks.source_id");
    expect(sql).toContain("sources.account_id = chunks.account_id");
    expect(sql).toContain("chunks.account_id = $1");
    expect(sql).toContain("chunks.source_id = ANY($3::uuid[])");
    expect(qMock.mock.calls[0][1]).toEqual(["account", "[0.25,0.75]", allowed, 4]);
  });

  it("omits malformed rows and non-finite scores", async () => {
    embedMock.mockResolvedValueOnce([[0.25, 0.75]]);
    qMock.mockResolvedValueOnce([
      { chunk_id: "", source_id: "source", source: "A", content: "text", score: 0.9 },
      { chunk_id: "2", source_id: "source", source: "A", content: "text", score: Number.NaN },
    ]);

    await expect(retrieve("account", "canary", ["11111111-1111-4111-8111-111111111111"])).resolves.toEqual([]);
  });
});
