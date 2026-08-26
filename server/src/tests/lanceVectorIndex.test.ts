import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LanceVectorClosedError,
  LanceVectorIdentityError,
  LanceVectorIndex,
  LanceVectorInputError,
  LanceVectorSchemaError,
  type LanceVectorRow,
} from "../vector/lance.js";

const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
const SOURCE_1 = "source-1";
const SOURCE_2 = "source-2";

function vectorRow(
  chunkId: string,
  accountId: string,
  sourceId: string,
  generation: number,
  vector: readonly number[]
): LanceVectorRow {
  return { chunkId, accountId, sourceId, generation, vector };
}

describe("LanceVectorIndex", () => {
  const directories: string[] = [];
  const indexes: LanceVectorIndex[] = [];

  async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "borealis-vector-index-"));
    directories.push(directory);
    return directory;
  }

  async function openIndex(dimension = 3): Promise<LanceVectorIndex> {
    const index = await LanceVectorIndex.open({ directory: await temporaryDirectory(), dimension });
    indexes.push(index);
    return index;
  }

  afterEach(async () => {
    await Promise.all(indexes.splice(0).map((index) => index.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("prefilters account and source inside LanceDB before cosine KNN", async () => {
    const index = await openIndex();
    await index.upsert([
      vectorRow("allowed", ACCOUNT_A, SOURCE_1, 1, [0.6, 0.4, 0]),
      vectorRow("closer-wrong-source", ACCOUNT_A, SOURCE_2, 1, [1, 0, 0]),
      vectorRow("closer-wrong-account", ACCOUNT_B, SOURCE_1, 1, [1, 0, 0]),
      vectorRow("closer-foreign", ACCOUNT_B, "source-3", 1, [0.99, 0.01, 0]),
      vectorRow("closer-staged-generation", ACCOUNT_A, SOURCE_1, 2, [1, 0, 0]),
    ]);

    const input = {
      accountId: ACCOUNT_A,
      sourceIds: [SOURCE_1],
      sourceGenerations: [{ sourceId: SOURCE_1, generation: 1 }],
      vector: [1, 0, 0],
      limit: 1,
    };
    const plan = await index.__explainSearchPlanForTests(input);
    const knnPosition = plan.indexOf("KNNVectorDistance");
    const scopeFilterPosition = plan.indexOf("FilterExec: account_id");
    expect(knnPosition).toBeGreaterThanOrEqual(0);
    // The indented input below KNN executes first, proving this is not a JS/postfilter scope check.
    expect(scopeFilterPosition).toBeGreaterThan(knnPosition);
    expect(plan).toContain("full_filter=account_id");
    expect(plan).toContain("source_id");
    expect(plan).toContain("generation");

    await expect(index.search(input)).resolves.toEqual([{ chunkId: "allowed", distance: expect.any(Number) }]);
  });

  it("quotes injection-shaped account, source, and chunk ids in every predicate", async () => {
    const index = await openIndex();
    const accountId = "account-' OR account_id <> '";
    const sourceId = "source-') OR true --";
    const chunkId = "chunk-'; DELETE FROM chunk_vectors; --";
    await index.upsert([
      vectorRow(chunkId, accountId, sourceId, 7, [0.5, 0.5, 0]),
      vectorRow("foreign", ACCOUNT_B, SOURCE_2, 7, [1, 0, 0]),
    ]);

    await expect(index.search({ accountId, sourceIds: [sourceId], vector: [1, 0, 0], limit: 1 })).resolves.toEqual([
      { chunkId, distance: expect.any(Number) },
    ]);
    await expect(index.hasAll([chunkId], sourceId, 7)).resolves.toBe(true);
    await expect(index.hasAll([chunkId], "different-source", 7)).resolves.toBe(false);
    await expect(index.deleteMissing(["missing-' OR true --"])).resolves.toBe(0);
    await expect(index.deleteGeneration(sourceId, 7)).resolves.toBe(1);
    await expect(index.scanRows()).resolves.toEqual([
      { chunkId: "foreign", accountId: ACCOUNT_B, sourceId: SOURCE_2, generation: 7 },
    ]);
  });

  it("accepts exactly 100 allowlisted sources and rejects a larger predicate", async () => {
    const index = await openIndex();
    const sourceIds = Array.from({ length: 100 }, (_, index) => `allowed-source-${index + 1}`);
    await index.upsert([
      vectorRow("allowed-at-boundary", ACCOUNT_A, sourceIds[99], 1, [0.6, 0.4, 0]),
      vectorRow("excluded-101", ACCOUNT_A, "allowed-source-101", 1, [1, 0, 0]),
    ]);

    await expect(index.search({ accountId: ACCOUNT_A, sourceIds, vector: [1, 0, 0], limit: 1 })).resolves.toEqual([
      { chunkId: "allowed-at-boundary", distance: expect.any(Number) },
    ]);
    await expect(
      index.search({
        accountId: ACCOUNT_A,
        sourceIds: [...sourceIds, "allowed-source-101"],
        vector: [1, 0, 0],
        limit: 1,
      })
    ).rejects.toBeInstanceOf(LanceVectorInputError);
  });

  it("upserts stable chunk ids idempotently with immediate exact hasAll visibility", async () => {
    const index = await openIndex();
    const first = vectorRow("chunk-1", ACCOUNT_A, SOURCE_1, 4, [0, 1, 0]);
    const second = vectorRow("chunk-2", ACCOUNT_A, SOURCE_1, 4, [0, 0, 1]);
    await index.upsert([first, second]);
    await expect(index.hasAll([first.chunkId, second.chunkId], SOURCE_1, 4)).resolves.toBe(true);

    await index.upsert([{ ...first, vector: [1, 0, 0] }]);
    await expect(index.hasAll([first.chunkId, second.chunkId], SOURCE_1, 4)).resolves.toBe(true);
    await expect(index.scanRows()).resolves.toHaveLength(2);
    await expect(
      index.search({ accountId: ACCOUNT_A, sourceIds: [SOURCE_1], vector: [1, 0, 0], limit: 1 })
    ).resolves.toEqual([{ chunkId: first.chunkId, distance: 0 }]);

    await expect(index.hasAll([first.chunkId, "missing"], SOURCE_1, 4)).resolves.toBe(false);
    await expect(index.hasAll([first.chunkId], SOURCE_2, 4)).resolves.toBe(false);
    await expect(index.hasAll([first.chunkId], SOURCE_1, 5)).resolves.toBe(false);
    await expect(index.upsert([{ ...first, accountId: ACCOUNT_B }])).rejects.toBeInstanceOf(LanceVectorIdentityError);
    await expect(index.upsert([first, first])).rejects.toBeInstanceOf(LanceVectorInputError);
    await expect(index.scanRows()).resolves.toHaveLength(2);
  });

  it("deletes exact generations, sources, and ledger-proven missing chunk ids", async () => {
    const index = await openIndex();
    await index.upsert([
      vectorRow("s1-live-a", ACCOUNT_A, SOURCE_1, 1, [1, 0, 0]),
      vectorRow("s1-live-b", ACCOUNT_A, SOURCE_1, 1, [0, 1, 0]),
      vectorRow("s1-stale", ACCOUNT_A, SOURCE_1, 2, [0, 0, 1]),
      vectorRow("s2-live", ACCOUNT_A, SOURCE_2, 2, [1, 1, 0]),
      vectorRow("s3-live", ACCOUNT_A, "source-3", 3, [1, 0, 1]),
    ]);

    await expect(index.deleteGeneration(SOURCE_1, 2)).resolves.toBe(1);
    await expect(index.deleteGeneration(SOURCE_1, 2)).resolves.toBe(0);
    await expect(index.deleteMissing(["s1-live-a", "not-present"])).resolves.toBe(1);
    await expect(index.deleteSource(SOURCE_2)).resolves.toBe(1);
    await expect(index.deleteSource(SOURCE_2)).resolves.toBe(0);
    const remaining = await index.scanRows();
    expect(remaining).toEqual(
      expect.arrayContaining([
        { chunkId: "s1-live-b", accountId: ACCOUNT_A, sourceId: SOURCE_1, generation: 1 },
        { chunkId: "s3-live", accountId: ACCOUNT_A, sourceId: "source-3", generation: 3 },
      ])
    );
    expect(remaining).toHaveLength(2);
  });

  it("prunes only non-live generations for the exact source", async () => {
    const index = await openIndex();
    await index.upsert([
      vectorRow("s1-generation-1", ACCOUNT_A, SOURCE_1, 1, [1, 0, 0]),
      vectorRow("s1-generation-2", ACCOUNT_A, SOURCE_1, 2, [0, 1, 0]),
      vectorRow("s1-generation-3", ACCOUNT_A, SOURCE_1, 3, [0, 0, 1]),
      vectorRow("s2-generation-1", ACCOUNT_A, SOURCE_2, 1, [1, 1, 0]),
    ]);

    await expect(index.prune(SOURCE_1, [2])).resolves.toBe(2);
    await expect(index.hasAll(["s1-generation-2"], SOURCE_1, 2)).resolves.toBe(true);
    await expect(index.hasAll(["s2-generation-1"], SOURCE_2, 1)).resolves.toBe(true);
    await expect(index.prune(SOURCE_1, [])).resolves.toBe(1);
    await expect(index.scanRows()).resolves.toEqual([
      { chunkId: "s2-generation-1", accountId: ACCOUNT_A, sourceId: SOURCE_2, generation: 1 },
    ]);
  });

  it("rejects an existing table whose vector dimension does not match", async () => {
    const directory = await temporaryDirectory();
    const original = await LanceVectorIndex.open({ directory, dimension: 3 });
    indexes.push(original);
    await expect(original.upsert([vectorRow("short", ACCOUNT_A, SOURCE_1, 1, [1, 0])])).rejects.toBeInstanceOf(
      LanceVectorInputError
    );
    await expect(
      original.upsert([vectorRow("non-finite", ACCOUNT_A, SOURCE_1, 1, [1, Number.NaN, 0])])
    ).rejects.toBeInstanceOf(LanceVectorInputError);
    await expect(
      original.upsert([vectorRow("bad-generation", ACCOUNT_A, SOURCE_1, 1.5, [1, 0, 0])])
    ).rejects.toBeInstanceOf(LanceVectorInputError);
    await original.upsert([vectorRow("chunk", ACCOUNT_A, SOURCE_1, 1, [1, 0, 0])]);
    await original.close();

    await expect(LanceVectorIndex.open({ directory, dimension: 4 })).rejects.toBeInstanceOf(LanceVectorSchemaError);
    const reopened = await LanceVectorIndex.open({ directory, dimension: 3 });
    indexes.push(reopened);
    await expect(reopened.hasAll(["chunk"], SOURCE_1, 1)).resolves.toBe(true);
  });

  it("closes idempotently while empty operations remain no-call identities", async () => {
    const index = await openIndex();
    expect(index.isOpen()).toBe(true);
    await index.close();
    await index.close();
    expect(index.isOpen()).toBe(false);

    await expect(index.search({ accountId: ACCOUNT_A, sourceIds: [], vector: [], limit: 1 })).resolves.toEqual([]);
    await expect(index.hasAll([], SOURCE_1, 1)).resolves.toBe(true);
    await expect(index.deleteMissing([])).resolves.toBe(0);
    await expect(index.upsert([])).resolves.toBeUndefined();
    await expect(
      index.search({ accountId: ACCOUNT_A, sourceIds: [SOURCE_1], vector: [1, 0, 0], limit: 1 })
    ).rejects.toBeInstanceOf(LanceVectorClosedError);
    await expect(index.scanRows()).rejects.toBeInstanceOf(LanceVectorClosedError);

    await index.init();
    expect(index.isOpen()).toBe(true);
  });
});
