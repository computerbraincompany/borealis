import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  q: vi.fn(),
  pool: { connect: vi.fn() },
}));
vi.mock("../llm.js", () => ({ embed: vi.fn() }));
vi.mock("../storageArtifacts.js", () => ({
  resolveSourceArtifact: vi.fn(async ({ filePath }: { filePath: string }) => filePath),
}));
vi.mock("../pythonClient.js", () => ({
  PythonServiceError: class PythonServiceError extends Error {},
  py: {
    registerDataset: vi.fn(),
    extractDataset: vi.fn(),
    extractPreparedDataset: vi.fn(),
    activateDatasetRefresh: vi.fn(),
    abortDatasetRefresh: vi.fn(),
    cleanupDatasetCache: vi.fn(),
    deactivateDatasetLocation: vi.fn(),
  },
}));

import { pool, q } from "../db.js";
import { extractText, ingestSource, preflightDocxArchive } from "../ingest.js";
import { embed } from "../llm.js";
import { py } from "../pythonClient.js";
import { resolveSourceArtifact } from "../storageArtifacts.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const qMock = vi.mocked(q);
const connectMock = vi.mocked(pool.connect);
const embedMock = vi.mocked(embed);
const registerMock = vi.mocked(py.registerDataset);
const extractDatasetMock = vi.mocked(py.extractDataset);
const resolveSourceArtifactMock = vi.mocked(resolveSourceArtifact);
const temporaryDirectories: string[] = [];

beforeEach(() => {
  qMock.mockReset();
  connectMock.mockReset();
  embedMock.mockReset();
  registerMock.mockReset();
  extractDatasetMock.mockReset();
  extractDatasetMock.mockResolvedValue({
    columns: ["category", "amount"],
    rows: [["Food", 42]],
    total_row_count: 1,
    returned_row_count: 1,
    truncated: false,
  });
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
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: SOURCE }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(client as any);
    qMock.mockResolvedValue([]);
    registerMock.mockResolvedValue({} as any);
    embedMock.mockImplementation(async (texts) => texts.map(() => Array(768).fill(0.1)));

    await ingestSource({
      accountId: ACCOUNT,
      sourceId: SOURCE,
      name: "ledger",
      filePath,
      mime: "text/csv",
      kind: "tabular",
      displayName: "Ledger.csv",
    });

    expect(resolveSourceArtifactMock).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      sourceId: SOURCE,
      name: "ledger",
      filePath,
      connector: undefined,
    });
    expect(registerMock).toHaveBeenCalledWith(ACCOUNT, "ledger", {
      location: filePath,
      kind: "path",
      originalName: "Ledger.csv",
      sourceId: SOURCE,
    });
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("FOR UPDATE"),
      expect.stringContaining("DELETE FROM chunks"),
      expect.stringContaining("INSERT INTO chunks"),
      expect.stringContaining("DELETE FROM ingestion_chunk_staging"),
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
      query: vi
        .fn()
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
    embedMock.mockImplementation(async (texts) => texts.map(() => Array(768).fill(0.1)));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      ingestSource({
        accountId: ACCOUNT,
        sourceId: SOURCE,
        name: "ledger",
        filePath,
        mime: "text/csv",
        kind: "tabular",
        displayName: "Ledger.csv",
      })
    ).rejects.toThrow("chunk insert failed");

    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
    expect(qMock).toHaveBeenCalledWith(expect.stringContaining("UPDATE sources"), [
      SOURCE,
      ACCOUNT,
      "Ingestion failed. Retry after checking the service logs.",
      0,
      null,
    ]);
  });

  it("marks an empty document as an extraction error instead of embedding a placeholder", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ingest-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "empty.txt");
    await fs.writeFile(filePath, "   \n");
    qMock.mockResolvedValue([]);

    await expect(
      ingestSource({
        accountId: ACCOUNT,
        sourceId: SOURCE,
        name: "empty",
        filePath,
        mime: "text/plain",
        kind: "document",
        displayName: "empty.txt",
      })
    ).rejects.toThrow("no readable text extracted");

    expect(embedMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
    expect(qMock).toHaveBeenCalledWith(expect.stringContaining("UPDATE sources"), [
      SOURCE,
      ACCOUNT,
      "No readable text could be extracted.",
      0,
      null,
    ]);
  });

  it("fails closed before reading or registering an artifact whose tenant path cannot be proven", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ingest-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "outside.csv");
    await fs.writeFile(filePath, "category,amount\nFood,42\n");
    resolveSourceArtifactMock.mockResolvedValueOnce(undefined);
    qMock.mockResolvedValue([]);

    await expect(
      ingestSource({
        accountId: ACCOUNT,
        sourceId: SOURCE,
        name: "ledger",
        filePath,
        mime: "text/csv",
        kind: "tabular",
        displayName: "Ledger.csv",
      })
    ).rejects.toThrow("source artifact is unavailable");

    expect(registerMock).not.toHaveBeenCalled();
    expect(extractDatasetMock).not.toHaveBeenCalled();
    expect(embedMock).not.toHaveBeenCalled();
    expect(qMock).toHaveBeenCalledWith(expect.stringContaining("UPDATE sources"), [
      SOURCE,
      ACCOUNT,
      "Ingestion failed. Retry after checking the service logs.",
      0,
      null,
    ]);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a non-number", "0.1"],
  ])("rejects %s embedding coordinates before constructing pgvector literals", async (_label, coordinate) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ingest-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "ledger.csv");
    await fs.writeFile(filePath, "category,amount\nFood,42\n");
    qMock.mockResolvedValue([]);
    registerMock.mockResolvedValue({} as any);
    const vector: unknown[] = Array(768).fill(0.1);
    vector[17] = coordinate;
    embedMock.mockResolvedValue([vector as number[]]);

    await expect(
      ingestSource({
        accountId: ACCOUNT,
        sourceId: SOURCE,
        name: "ledger",
        filePath,
        mime: "text/csv",
        kind: "tabular",
        displayName: "Ledger.csv",
      })
    ).rejects.toThrow("embedding response shape mismatch");

    expect(connectMock).not.toHaveBeenCalled();
    expect(qMock.mock.calls.some(([sql]) => String(sql).includes("::vector[]"))).toBe(false);
  });

  it("generation-scopes connector failure state so a superseded worker cannot corrupt a newer run", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ingest-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "ledger.csv");
    await fs.writeFile(filePath, "category,amount\nFood,42\n");
    qMock.mockImplementation(async (sql) =>
      String(sql).includes("SELECT 1 FROM ingestion_jobs") ? ([{ ok: true }] as any) : ([] as any)
    );
    registerMock.mockResolvedValue({} as any);
    embedMock.mockRejectedValueOnce(new Error("embedding service unavailable"));

    await expect(
      ingestSource({
        accountId: ACCOUNT,
        sourceId: SOURCE,
        name: "ledger",
        filePath,
        mime: "text/csv",
        kind: "tabular",
        displayName: "Ledger.csv",
        connector: "connector-1",
        url: "https://example.invalid/ledger.csv",
        generation: 7,
      })
    ).rejects.toThrow("embedding service unavailable");

    const connectorFailure = qMock.mock.calls.find(([sql]) => String(sql).includes("Connector indexing failed"));
    expect(connectorFailure?.[0]).toContain("j.generation=$3");
    expect(connectorFailure?.[0]).toContain("j.status='running'");
    expect(connectorFailure?.[1]).toEqual(["connector-1", ACCOUNT, 7, SOURCE, null]);
  });

  it("rejects legacy .doc instead of claiming DOCX parser support", async () => {
    await expect(extractText("/does/not/need/to/exist.doc", "application/msword")).rejects.toThrow(
      "legacy .doc files are not supported"
    );
  });

  it("does not let an ambiguous Word MIME override a supported text extension", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ingest-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "renamed.txt");
    await fs.writeFile(filePath, "plain text");
    await expect(extractText(filePath, "application/msword")).resolves.toBe("plain text");
  });

  it("rejects a DOCX central directory that claims bomb-scale expansion", () => {
    const names = ["[Content_Types].xml", "word/document.xml"];
    const centralParts = names.map((name, index) => {
      const filename = Buffer.from(name);
      const entry = Buffer.alloc(46 + filename.length);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(8, 10);
      entry.writeUInt32LE(1, 20);
      entry.writeUInt32LE(index === 0 ? 60 * 1024 * 1024 : 1, 24);
      entry.writeUInt16LE(filename.length, 28);
      filename.copy(entry, 46);
      return entry;
    });
    const central = Buffer.concat(centralParts);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(names.length, 8);
    eocd.writeUInt16LE(names.length, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(0, 16);
    expect(() => preflightDocxArchive(Buffer.concat([central, eocd]))).toThrow("safe limits");
  });

  it("rejects DOCX members whose actual expansion exceeds their declared size", () => {
    const members = [
      { name: "[Content_Types].xml", body: Buffer.from("<Types />"), declaredSize: 9 },
      { name: "word/document.xml", body: Buffer.alloc(256 * 1024, 0x41), declaredSize: 1 },
    ];
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let localOffset = 0;
    for (const member of members) {
      const filename = Buffer.from(member.name);
      const compressed = deflateRawSync(member.body);
      const local = Buffer.alloc(30 + filename.length + compressed.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(member.declaredSize, 22);
      local.writeUInt16LE(filename.length, 26);
      filename.copy(local, 30);
      compressed.copy(local, 30 + filename.length);
      locals.push(local);

      const central = Buffer.alloc(46 + filename.length);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(8, 10);
      central.writeUInt32LE(compressed.length, 20);
      central.writeUInt32LE(member.declaredSize, 24);
      central.writeUInt16LE(filename.length, 28);
      central.writeUInt32LE(localOffset, 42);
      filename.copy(central, 46);
      centrals.push(central);
      localOffset += local.length;
    }
    const localBytes = Buffer.concat(locals);
    const centralBytes = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(members.length, 8);
    eocd.writeUInt16LE(members.length, 10);
    eocd.writeUInt32LE(centralBytes.length, 12);
    eocd.writeUInt32LE(localBytes.length, 16);

    expect(() => preflightDocxArchive(Buffer.concat([localBytes, centralBytes, eocd]))).toThrow("safe limits");
  });
});
