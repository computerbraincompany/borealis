import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../llm.js", () => ({ embed: vi.fn() }));
vi.mock("../storageRuntime.js", () => ({ storageRuntime: vi.fn() }));
vi.mock("../vector/retrieve.js", () => ({ retrieveWithVector: vi.fn() }));

import { embed } from "../llm.js";
import { retrieve } from "../retrieve.js";
import { storageRuntime } from "../storageRuntime.js";
import { retrieveWithVector } from "../vector/retrieve.js";

const embedMock = vi.mocked(embed);
const runtimeMock = vi.mocked(storageRuntime);
const retrieveWithVectorMock = vi.mocked(retrieveWithVector);

describe("scoped retrieval", () => {
  beforeEach(() => {
    embedMock.mockReset();
    runtimeMock.mockReset();
    retrieveWithVectorMock.mockReset();
  });

  it("returns before embedding when no ready source is allowed", async () => {
    await expect(retrieve("account", "canary", [])).resolves.toEqual([]);
    expect(embedMock).not.toHaveBeenCalled();
    expect(runtimeMock).not.toHaveBeenCalled();
    expect(retrieveWithVectorMock).not.toHaveBeenCalled();
  });

  it("passes the embedding and immutable server-derived scope to the two-store retriever", async () => {
    embedMock.mockResolvedValueOnce([[0.25, 0.75]]);
    const runtime = { ingestion: {}, vectors: {} };
    runtimeMock.mockReturnValue(runtime as never);
    retrieveWithVectorMock.mockResolvedValueOnce([
      {
        chunk_id: "42",
        source_id: "11111111-1111-4111-8111-111111111111",
        source: "Allowed.pdf",
        content: "allowed",
        score: 0.9,
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
    expect(retrieveWithVectorMock).toHaveBeenCalledWith(runtime.ingestion, runtime.vectors, {
      accountId: "account",
      allowedSourceIds: allowed,
      vector: [0.25, 0.75],
      topK: 4,
    });
  });

  it("does not enter storage after the caller aborts during embedding", async () => {
    const controller = new AbortController();
    embedMock.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"));
      return [[0.25, 0.75]];
    });
    await expect(
      retrieve("account", "canary", ["11111111-1111-4111-8111-111111111111"], 6, controller.signal)
    ).rejects.toThrow("cancelled");
    expect(runtimeMock).not.toHaveBeenCalled();
  });
});
