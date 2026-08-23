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
    qMock.mockResolvedValueOnce([{ content: "allowed", source_name: "A", score: 0.9 }]);
    const allowed = ["11111111-1111-4111-8111-111111111111"];

    const result = await retrieve("account", "canary", allowed, 4);

    expect(result).toEqual([{ content: "allowed", source_name: "A", score: "0.9000" }]);
    expect(qMock.mock.calls[0][0]).toContain("account_id = $1");
    expect(qMock.mock.calls[0][0]).toContain("source_id = ANY($3::uuid[])");
    expect(qMock.mock.calls[0][1]).toEqual(["account", "[0.25,0.75]", allowed, 4]);
  });
});
