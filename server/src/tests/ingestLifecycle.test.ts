import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  q: vi.fn(),
  pool: { connect: vi.fn() },
}));
vi.mock("../llm.js", () => ({ embed: vi.fn() }));
vi.mock("../pythonClient.js", () => ({
  py: { registerDataset: vi.fn() },
}));

import { pool, q } from "../db.js";
import { ingestSource } from "../ingest.js";
import { embed } from "../llm.js";
import { py } from "../pythonClient.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const qMock = vi.mocked(q);
const connectMock = vi.mocked(pool.connect);
const embedMock = vi.mocked(embed);
const registerMock = vi.mocked(py.registerDataset);
const temporaryDirectories: string[] = [];

beforeEach(() => {
  qMock.mockReset();
  connectMock.mockReset();
  embedMock.mockReset();
  registerMock.mockReset();
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe("ingest lifecycle", () => {
  it("atomically replaces prior chunks and marks the source ready", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ingest-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "ledger.csv");
    await fs.writeFile(filePath, "category,amount\nFood,42\n");

    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: SOURCE }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(client as any);
    qMock.mockResolvedValue([]);
    registerMock.mockResolvedValue({} as any);
    embedMock.mockImplementation(async (texts) => texts.map(() => [0.1, 0.2]));

    await ingestSource({
      accountId: ACCOUNT,
      sourceId: SOURCE,
      name: "ledger",
      filePath,
      mime: "text/csv",
      kind: "tabular",
      displayName: "Ledger.csv",
    });

    expect(registerMock).toHaveBeenCalledWith(ACCOUNT, "ledger", {
      location: filePath,
      kind: "path",
      originalName: "Ledger.csv",
    });
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("FOR UPDATE"),
      expect.stringContaining("DELETE FROM chunks"),
      expect.stringContaining("INSERT INTO chunks"),
      expect.stringContaining("UPDATE sources"),
      "COMMIT",
    ]);
    expect(client.query.mock.calls[2][1]).toEqual([SOURCE, ACCOUNT]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back chunk replacement and persists an ingest error", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ingest-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "ledger.csv");
    await fs.writeFile(filePath, "category,amount\nFood,42\n");

    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: SOURCE }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error("chunk insert failed"))
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(client as any);
    qMock.mockResolvedValue([]);
    registerMock.mockResolvedValue({} as any);
    embedMock.mockImplementation(async (texts) => texts.map(() => [0.1, 0.2]));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(ingestSource({
      accountId: ACCOUNT,
      sourceId: SOURCE,
      name: "ledger",
      filePath,
      mime: "text/csv",
      kind: "tabular",
      displayName: "Ledger.csv",
    })).rejects.toThrow("chunk insert failed");

    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
    expect(qMock).toHaveBeenLastCalledWith(
      expect.stringContaining("status='error'"),
      [SOURCE, "chunk insert failed"]
    );
  });
});
